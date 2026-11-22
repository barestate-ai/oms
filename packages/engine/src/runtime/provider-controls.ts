import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Api, Model, AuthInteraction, AuthPrompt, LoginOptions } from '@earendil-works/pi-ai';
import { modelReservationBound } from '@oms/core/usage';
import { importProviderEnvironment, type ImportSummary } from './provider-import.ts';
import {
  readInferencePreferences,
  writeInferencePreferences,
  TOKEN_PLAN_PROVIDERS,
  type MimoProvider,
} from './inference-preferences.ts';
import { CLAUDE_CODE_PROVIDER, getClaudeCodeStatus, inspectClaudeCode, type ClaudeCodeStatus } from './claude-code.ts';

// https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use
const CLAUDE_SUBSCRIPTION_UNAVAILABLE =
  'Direct third-party Claude subscription OAuth is unavailable. In /connect choose the local Claude Code login, or use an Anthropic API key for direct API access.';

export interface ProviderChoice {
  id: string;
  name: string;
  configured: boolean;
  apiKey: boolean;
  oauth: boolean;
  apiKeyLabel?: string;
  oauthLabel?: string;
  /** The subscription's own name, such as "GitHub Copilot", for lists. */
  oauthName?: string;
  oauthUnavailable?: string;
}
export interface ProviderModelChoice {
  provider: string;
  id: string;
  name: string;
  configured: boolean;
  selectable?: boolean;
  detail?: string;
}
export interface ProviderControls {
  listModels(): readonly ProviderModelChoice[];
  listProviders(): readonly ProviderChoice[];
  selectModel(provider: string, id: string): Promise<void>;
  connectProvider(provider: string, key: string): Promise<void>;
  loginProvider(provider: string, method: 'api_key' | 'oauth', interaction: AuthInteraction): Promise<void>;
  importEnvironment(path: string, interaction: AuthInteraction): Promise<ImportSummary>;
}
interface ProviderControlsOptions {
  modelRuntime: ModelRuntime;
  session: Pick<AgentSession, 'setModel'>;
  maxOutputTokens: number;
  signal: AbortSignal;
  loginOptions?: LoginOptions;
  flushSettings?(): Promise<void>;
  inferencePreferencesPath?: string;
  modelReadiness?(model: Model<Api>): { ready: boolean; detail: string };
  claudeCodeAccess?: { status(): ClaudeCodeStatus; inspect(signal?: AbortSignal): Promise<ClaudeCodeStatus> };
  withUserOperation<T>(action: () => Promise<T>): Promise<T>;
  checkAuthFile(): void;
}

function literalKey(key: string): string {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > 16_384 ||
    /[\s\p{Cc}\p{Cf}$]/u.test(key) ||
    key.startsWith('!')
  ) {
    throw new Error('Enter a nonempty literal API key without whitespace, controls or configuration expressions');
  }
  return key;
}

function literalConfig(value: string): string {
  // SDK API-key storage resolves leading ! as a command and $ references as environment values.
  // Text fields may contain spaces or be an empty "continue" answer; the provider owns semantics.
  if (value.length > 16_384 || /[\p{Cc}\p{Cf}$]/u.test(value) || value.startsWith('!')) {
    throw new Error('Enter literal configuration without controls or configuration expressions');
  }
  return value;
}

async function promptWithCancellation(
  interaction: AuthInteraction,
  prompt: AuthPrompt,
  signal: AbortSignal,
): Promise<string> {
  const combined = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
  combined.throwIfAborted();
  let abort: (() => void) | undefined;
  // ES2023 baseline does not include Promise.withResolvers.
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Provider setup cancelled'));
    combined.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([interaction.prompt({ ...prompt, signal: combined }), cancelled]);
  } finally {
    if (abort) combined.removeEventListener('abort', abort);
  }
}

/** Operator-only controls over the existing runtime; credentials never enter session messages. */
export function createProviderControls(options: ProviderControlsOptions): ProviderControls {
  const { modelRuntime, session, maxOutputTokens, signal, withUserOperation, checkAuthFile } = options;
  const claudeCode = options.claudeCodeAccess ?? { status: getClaudeCodeStatus, inspect: inspectClaudeCode };
  const configured = (provider: string) =>
    provider === CLAUDE_CODE_PROVIDER ? claudeCode.status().configured : modelRuntime.hasConfiguredAuth(provider);
  const supportedModels = () => {
    const models = modelRuntime
      .getModels()
      .filter(
        (model) =>
          !(model.provider === 'groq' && ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'].includes(model.id)) &&
          modelReservationBound(model, maxOutputTokens) !== null,
      );
    const preferred = models.findIndex((model) => model.provider === 'groq' && model.id === 'openai/gpt-oss-20b');
    if (preferred !== -1) {
      const first = models.findIndex((model) => model.provider === 'groq');
      const [model] = models.splice(preferred, 1);
      models.splice(first, 0, model!);
    }
    return models;
  };
  const modelChoice = (model: Model<Api>): ProviderModelChoice => {
    const connected = configured(model.provider);
    // An unchecked native login is not a failed one: keep the model usable and let first use verify it.
    const unchecked = model.provider === CLAUDE_CODE_PROVIDER && !claudeCode.status().checked;
    const readiness =
      connected || unchecked
        ? (options.modelReadiness?.(model) ?? { ready: true, detail: 'Connected' })
        : {
            ready: false,
            detail:
              model.provider === CLAUDE_CODE_PROVIDER
                ? claudeCode.status().detail
                : 'Needs setup · /connect this provider first',
          };
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      configured: connected,
      selectable: readiness.ready,
      detail: unchecked ? claudeCode.status().detail : readiness.detail,
    };
  };
  const listModels: ProviderControls['listModels'] = () => supportedModels().map(modelChoice);
  const listProviders: ProviderControls['listProviders'] = () => {
    const supported = new Set(supportedModels().map((model) => model.provider));
    return modelRuntime
      .getProviders()
      .filter((provider) => supported.has(provider.id))
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        configured: configured(provider.id),
        apiKey: provider.id !== CLAUDE_CODE_PROVIDER && typeof provider.auth.apiKey?.login === 'function',
        oauth:
          provider.id === CLAUDE_CODE_PROVIDER ||
          (provider.id !== 'anthropic' && typeof provider.auth.oauth?.login === 'function'),
        ...(provider.auth.apiKey ? { apiKeyLabel: provider.auth.apiKey.name } : {}),
        ...(provider.auth.oauth
          ? {
              oauthLabel: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
              oauthName: provider.auth.oauth.name,
            }
          : {}),
        ...(provider.id === CLAUDE_CODE_PROVIDER ? { oauthLabel: 'Check local Claude Code subscription login' } : {}),
        ...(provider.id === 'anthropic' ? { oauthUnavailable: CLAUDE_SUBSCRIPTION_UNAVAILABLE } : {}),
      }));
  };
  const selectModel: ProviderControls['selectModel'] = (provider, id) =>
    withUserOperation(async () => {
      signal.throwIfAborted();
      const model = supportedModels().find((candidate) => candidate.provider === provider && candidate.id === id);
      if (!model) throw new Error('Select a supported model from the installed catalog');
      if (provider === CLAUDE_CODE_PROVIDER) {
        const status = await claudeCode.inspect(signal);
        signal.throwIfAborted();
        if (!status.configured) throw new Error(status.detail);
      } else if (!configured(provider)) throw new Error('This provider is not configured; connect it first');
      const choice = modelChoice(model);
      if (!choice.selectable) throw new Error(choice.detail);
      try {
        await session.setModel(model, { persist: true });
        await options.flushSettings?.();
      } catch {
        throw new Error("Model selection failed; check the provider's local configuration");
      }
    });
  const loginProvider: ProviderControls['loginProvider'] = (provider, method, interaction) =>
    withUserOperation(async () => {
      if (signal.aborted || interaction.signal?.aborted) throw new Error('Provider setup cancelled');
      const entry = listProviders().find((candidate) => candidate.id === provider);
      if (!entry) throw new Error('Select a provider from the supported installed catalog');
      if (method === 'oauth' && entry.oauthUnavailable) throw new Error(entry.oauthUnavailable);
      if (method === 'api_key' ? !entry.apiKey : method !== 'oauth' || !entry.oauth) {
        throw new Error(
          method === 'api_key'
            ? 'This provider does not support literal API-key setup'
            : 'This provider does not support OAuth setup in OMS',
        );
      }
      const loginSignal = interaction.signal ? AbortSignal.any([signal, interaction.signal]) : signal;
      if (provider === CLAUDE_CODE_PROVIDER) {
        interaction.notify({
          type: 'info',
          message:
            'Authentication stays in Claude Code. Install the official CLI and run claude auth login in another terminal, then return here. OMS checks the existing subscription login without copying credentials or sending a model request.',
          links: [{ label: 'Install Claude Code', url: 'https://code.claude.com/docs/en/setup' }],
        });
        const status = await claudeCode.inspect(loginSignal);
        loginSignal.throwIfAborted();
        if (!status.configured) throw new Error(status.detail);
        return;
      }
      try {
        loginSignal.throwIfAborted();
        checkAuthFile();
        await modelRuntime.login(
          provider,
          method,
          {
            signal: loginSignal,
            async prompt(prompt) {
              const value = await promptWithCancellation(interaction, prompt, loginSignal);
              loginSignal.throwIfAborted();
              prompt.signal?.throwIfAborted();
              if (prompt.type === 'select') {
                if (!prompt.options.some((option) => option.id === value)) throw new Error('Select an offered option');
                return value;
              }
              return method === 'api_key' ? literalConfig(value) : value;
            },
            notify(event) {
              if (!loginSignal.aborted) interaction.notify(event);
            },
          },
          options.loginOptions ?? { agentName: 'OMS' },
        );
        loginSignal.throwIfAborted();
        if (!modelRuntime.hasConfiguredAuth(provider)) throw new Error('Provider is not locally configured');
        checkAuthFile();
        await options.flushSettings?.();
        if (
          options.inferencePreferencesPath &&
          (provider === 'xiaomi' || TOKEN_PLAN_PROVIDERS.includes(provider as (typeof TOKEN_PLAN_PROVIDERS)[number]))
        ) {
          const preferences = readInferencePreferences(options.inferencePreferencesPath);
          writeInferencePreferences(options.inferencePreferencesPath, {
            ...preferences,
            mimoProvider: provider as MimoProvider,
          });
        }
      } catch {
        // SDK synchronization errors may contain a persisted credential. Never expose them or promise rollback.
        throw new Error(
          'Provider setup did not complete; local credentials may have been saved. Check configuration before retrying',
        );
      }
    });
  const connectProvider: ProviderControls['connectProvider'] = async (provider, key) => {
    literalKey(key);
    let supplied = false;
    return loginProvider(provider, 'api_key', {
      async prompt(prompt) {
        if (supplied || prompt.type !== 'secret') throw new Error('Use interactive provider setup for this method');
        supplied = true;
        return key;
      },
      notify() {},
    });
  };
  const importEnvironment: ProviderControls['importEnvironment'] = (path, interaction) =>
    withUserOperation(() =>
      importProviderEnvironment(
        path,
        modelRuntime,
        interaction.signal ? AbortSignal.any([signal, interaction.signal]) : signal,
        {
          interaction,
          checkAuthFile,
          flushSettings: options.flushSettings,
          loginOptions: options.loginOptions,
          preferencesPath: options.inferencePreferencesPath,
        },
      ),
    );
  return { listModels, listProviders, selectModel, connectProvider, loginProvider, importEnvironment };
}
