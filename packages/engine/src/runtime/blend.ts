import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type Api, type Model, type ProviderStreams } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { OmsAccountControls } from './oms-account.ts';

export const BLEND_SIGN_IN =
  'Blend needs a signed-in invited OMS account. Use /login to sign in, or set OMS_BLEND_TOKEN for local/bench use.';
export const BLEND_PROFILES = ['blend-auto', 'blend-pro', 'blend-flash'] as const;
export const BLEND_SETTLED_ERROR = 'blend-settled-error';

export function blendBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(env.OMS_BLEND_URL ?? 'https://barestate.xyz/oms/blend/v1');
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Blend requires HTTPS or a loopback URL.');
  if (url.pathname === '/') url.pathname = '/v1';
  return url.href.replace(/\/+$/, '');
}
export function blendToken(
  account: Pick<OmsAccountControls, 'searchCredential'>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.OMS_BLEND_TOKEN || account.searchCredential()?.token;
}
export function blendModel(id: string, baseUrl: string): Model<'openai-completions'> {
  const flash = id === 'mimo-v2.6-flash';
  return {
    id,
    name: BLEND_PROFILES.includes(id as (typeof BLEND_PROFILES)[number]) ? `Blend ${id.slice(6)} (provisional)` : id,
    provider: 'blend',
    api: 'openai-completions',
    baseUrl,
    input: ['text'],
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 32_000,
    cost: flash
      ? { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.175 }
      : { input: 8, output: 40, cacheRead: 8, cacheWrite: 16 },
    compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_completion_tokens' },
  };
}

export function registerBlend(
  runtime: ModelRuntime,
  account: Pick<OmsAccountControls, 'searchCredential'>,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): { ensureProfile(id: string): Promise<void> } {
  const baseUrl = blendBaseUrl(env);
  const models = new Map<string, Model<Api>>(BLEND_PROFILES.map((id) => [id, blendModel(id, baseUrl)]));
  const token = () => blendToken(account, env);
  const stream: ProviderStreams['stream'] = (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let cost: number | undefined;
      let settled = false;
      let counts = { input: 0, cached: 0, output: 0 };
      const receiptUsage = () => ({
        input: counts.input - counts.cached,
        cacheRead: counts.cached,
        cacheWrite: 0,
        output: counts.output,
        totalTokens: counts.input + counts.output,
        cost: { input: cost ?? 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost ?? 0 },
      });
      try {
        const key = token();
        if (!key) throw new Error(BLEND_SIGN_IN);
        const transport = options?.fetch ?? fetch;
        const source = streamSimple(model as Model<'openai-completions'>, context, {
          ...options,
          apiKey: key,
          onPayload: async (payload, selected) => ({
            ...(((await options?.onPayload?.(payload, selected)) ?? payload) as object),
            oms_failed_tool_calls: context.messages.flatMap((message) =>
              message.role === 'toolResult' && message.isError ? [message.toolCallId] : [],
            ),
          }),
          fetch: async (input, init) => {
            cost = undefined;
            settled = false;
            counts = { input: 0, cached: 0, output: 0 };
            const headers = new Headers(input instanceof Request ? input.headers : undefined);
            new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
            headers.set('authorization', `Bearer ${key}`);
            headers.set('x-blend-session', sessionId);
            const response = await transport(input, { ...init, headers, redirect: 'error' });
            const raw = response.headers.get('x-blend-cost-usd');
            if (response.headers.get('x-blend-receipt') === 'settled') {
              try {
                const value = JSON.parse(response.headers.get('x-blend-usage') ?? 'null');
                if (
                  value &&
                  [value.input, value.cached, value.output, value.input + value.output].every(
                    (n) => Number.isSafeInteger(n) && n >= 0,
                  ) &&
                  value.cached <= value.input
                ) {
                  counts = value;
                  settled = true;
                }
              } catch {}
            }
            if (raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0)
              cost = Number(raw);
            return response;
          },
        });
        for await (const event of source) {
          if (event.type === 'done') {
            if (cost === undefined) throw new Error('Blend did not return a valid cost receipt.');
            output.push({
              ...event,
              message: {
                ...event.message,
                responseModel: model.id,
                usage: {
                  ...event.message.usage,
                  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
                },
              },
            });
          } else if (event.type === 'error' && settled && cost !== undefined) {
            output.push({
              ...event,
              error: {
                ...event.error,
                responseModel: model.id,
                rawStopReason: BLEND_SETTLED_ERROR,
                usage: receiptUsage(),
              },
            });
          } else output.push(event);
        }
      } catch (error) {
        output.push({
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            content: [],
            api: model.api,
            provider: 'blend',
            model: model.id,
            timestamp: Date.now(),
            stopReason: 'error',
            ...(settled && cost !== undefined ? { responseModel: model.id, rawStopReason: BLEND_SETTLED_ERROR } : {}),
            errorMessage:
              error instanceof Error && error.message === BLEND_SIGN_IN
                ? BLEND_SIGN_IN
                : 'Blend did not return a valid response and cost receipt.',
            usage: settled
              ? receiptUsage()
              : {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
          },
        });
      } finally {
        output.end();
      }
    })();
    return output;
  };
  runtime.registerNativeProvider({
    id: 'blend',
    name: 'Blend',
    baseUrl,
    auth: {
      apiKey: {
        name: 'OMS account',
        async check() {
          return token() ? { type: 'api_key', source: 'OMS account' } : undefined;
        },
        async resolve() {
          const key = token();
          return key ? { auth: { apiKey: key }, source: 'OMS account' } : undefined;
        },
      },
    },
    getModels: () => [...models.values()],
    stream,
    streamSimple: stream,
  });
  return {
    async ensureProfile(id) {
      if (models.has(id)) return;
      const key = token();
      if (!key) throw new Error(BLEND_SIGN_IN);
      const response = await fetch(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${key}`, 'x-blend-session': sessionId },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Unable to list Blend profiles.');
      const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
      for (const entry of body.data ?? [])
        if (typeof entry.id === 'string' && /^[\w.-]{1,128}$/.test(entry.id))
          models.set(entry.id, blendModel(entry.id, baseUrl));
      if (!models.has(id)) throw new Error('Unknown Blend profile.');
      await runtime.refresh({ allowNetwork: false });
    },
  };
}
