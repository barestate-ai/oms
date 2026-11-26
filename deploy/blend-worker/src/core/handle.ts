import { callUpstream, estimatedInput } from './adapters.ts';
import { parseInput } from './input.ts';
import { executePolicy, sessionKey } from './policies.ts';
import { costUsd, modelSpec } from './pricing.ts';
import { BlendError, UpstreamError } from './types.ts';
import type { Call, Completion, Dependencies, PolicyEvent, Usage } from './types.ts';

export async function handle(request: Request, deps: Dependencies): Promise<Response> {
  const now = deps.now ?? Date.now;
  const ts = new Date(now()).toISOString();
  const calls: Call[] = [];
  const events: PolicyEvent[] = [];
  const origins = new WeakMap<Completion, string>();
  let profile: string | null = null;
  let completionModel: string | undefined;
  let response: Response;
  const total = () => calls.reduce((sum, c) => sum + c.usd, 0);
  const headers = () => ({
    'x-blend-model': completionModel ?? calls.at(-1)?.model ?? '',
    'x-blend-cost-usd': String(total()),
    'x-blend-receipt': 'settled',
    'x-blend-usage': JSON.stringify({
      input: calls.reduce((sum, c) => sum + c.in, 0),
      cached: calls.reduce((sum, c) => sum + c.cached, 0),
      output: calls.reduce((sum, c) => sum + c.out, 0),
    }),
  });
  try {
    const path = new URL(request.url).pathname;
    if (path === '/v1/models' && request.method === 'GET') {
      response = Response.json({
        object: 'list',
        data: Object.keys(deps.profiles).map((id) => ({ id, object: 'model', created: 0, owned_by: 'blend' })),
      });
    } else if (path !== '/v1/chat/completions') {
      throw new BlendError(404, 'Not found.', 'invalid_request_error');
    } else if (request.method !== 'POST') {
      throw new BlendError(405, 'Method not allowed.', 'invalid_request_error');
    } else {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        throw new BlendError(400, 'Invalid JSON request.', 'invalid_request_error');
      }
      const input = parseInput(raw);
      if (!Object.hasOwn(deps.profiles, input.model))
        throw new BlendError(400, 'Unknown Blend profile.', 'invalid_request_error');
      profile = input.model;
      const key = await sessionKey(request, input);
      const invoke = async (model: string, body: typeof input): Promise<Completion> => {
        for (let attempt = 1; ; attempt++) {
          const start = now();
          let dispatchedAt = start;
          let usage: Usage | undefined;
          let reservation: unknown;
          let admitted = false;
          let error: unknown, completion: Completion | undefined, upstreamStatus: number | undefined;
          try {
            reservation = await deps.beforeCall?.(model, body);
            admitted = true;
            dispatchedAt = now();
            completion = await callUpstream(model, body, {
              fetch: deps.fetch,
              key: deps.keys[modelSpec(model).provider],
              session: key,
              signal: AbortSignal.any([request.signal, AbortSignal.timeout(deps.upstreamTimeoutMs ?? 180_000)]),
              onUsage: (value) => {
                usage = value;
              },
              onStatus: (value) => {
                upstreamStatus = value;
              },
            });
            origins.set(completion, model);
            return completion;
          } catch (cause) {
            error = cause;
          } finally {
            const dispatched =
              admitted &&
              !(error instanceof UpstreamError && ['budget', 'not_configured'].includes(error.statusClass)) &&
              !(error instanceof BlendError && !(error instanceof UpstreamError));
            const usageSource = usage ? 'reported' : dispatched ? 'estimated' : 'none';
            usage ??= { input: dispatched ? estimatedInput(model, body) : 0, cached: 0, output: 0, cacheWrite: 0 };
            const call: Call = {
              model,
              in: usage.input,
              cached: usage.cached,
              out: usage.output,
              ms: Math.max(0, now() - start),
              usd: costUsd(model, usage, dispatchedAt),
              attempt,
              status_class: error instanceof UpstreamError ? error.statusClass : error ? 'parse_error' : 'ok',
              ...(upstreamStatus !== undefined ? { upstream_status: upstreamStatus } : {}),
              usage_source: usageSource,
              dispatched,
              ...(completion
                ? {
                    finish_reason: ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(
                      completion.finishReason,
                    )
                      ? completion.finishReason
                      : 'other',
                    tool_calls: completion.message.tool_calls?.length ?? 0,
                    text_chars: completion.message.content?.length ?? 0,
                    reasoning_chars: completion.reasoningChars ?? 0,
                  }
                : {}),
            };
            calls.push(call);
            if (admitted) await deps.afterCall?.(call, reservation);
          }
          if (attempt >= 2 || !(error instanceof UpstreamError) || !error.retryable || request.signal.aborted)
            throw error;
          await new Promise<void>((accept) => setTimeout(accept, deps.retryDelayMs ?? 250));
          if (request.signal.aborted) throw error;
        }
      };
      const completion = await deps.sessions.run(`${profile}:${key}`, (state) =>
        executePolicy(deps.profiles[profile!]!, state, input, invoke, 'root', (e) => events.push(e)),
      );
      const model = origins.get(completion) ?? calls.at(-1)!.model;
      completionModel = model;
      const blend = { model, cost_usd: total(), calls };
      const usage = {
        prompt_tokens: calls.reduce((n, c) => n + c.in, 0),
        completion_tokens: calls.reduce((n, c) => n + c.out, 0),
        total_tokens: calls.reduce((n, c) => n + c.in + c.out, 0),
        prompt_tokens_details: { cached_tokens: calls.reduce((n, c) => n + c.cached, 0) },
      };
      const envelope = { id: `chatcmpl-${crypto.randomUUID()}`, created: Math.floor(now() / 1000), model };
      if (!input.stream)
        response = Response.json(
          {
            ...envelope,
            object: 'chat.completion',
            choices: [{ index: 0, message: completion.message, finish_reason: completion.finishReason }],
            usage,
            blend,
          },
          { headers: headers() },
        );
      else {
        const chunk = (value: Record<string, unknown>) =>
          `data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', ...value })}\n\n`;
        let events = chunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
        for (const delta of completion.deltas) events += chunk({ choices: [{ index: 0, delta, finish_reason: null }] });
        events += chunk({ choices: [{ index: 0, delta: {}, finish_reason: completion.finishReason }] });
        events += chunk({ choices: [], usage, blend }) + 'data: [DONE]\n\n';
        response = new Response(events, {
          headers: { ...headers(), 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
        });
      }
    }
  } catch (error) {
    const safe = error instanceof BlendError ? error : new BlendError(500, 'Blend request failed.', 'server_error');
    response = Response.json(
      { error: { message: safe.message, type: safe.type, code: safe.status } },
      { status: safe.status, headers: headers() },
    );
  }
  try {
    await deps.log({
      ts,
      profile,
      calls,
      total_usd: total(),
      status: response.status,
      ...(events.length ? { events } : {}),
    });
  } catch {
    return Response.json(
      { error: { message: 'Cost logging unavailable.', type: 'server_error', code: 503 } },
      { status: 503, headers: headers() },
    );
  }
  return response;
}
