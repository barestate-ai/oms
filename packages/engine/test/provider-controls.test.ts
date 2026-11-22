import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createFauxCore, type AuthInteraction, type Credential, type CredentialStore } from '@earendil-works/pi-ai';
import { createProviderControls } from '../src/runtime/provider-controls.ts';

async function fixture() {
  const stored = new Map<string, Credential>();
  const credentials: CredentialStore = {
    async read(id) {
      return stored.get(id);
    },
    async list() {
      return [...stored].map(([providerId, value]) => ({ providerId, type: value.type }));
    },
    async modify(id, fn) {
      const value = await fn(stored.get(id));
      if (value) stored.set(id, value);
      return value;
    },
    async delete(id) {
      stored.delete(id);
    },
  };
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const faux = createFauxCore({
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    models: [
      {
        id: 'controlled',
        contextWindow: 1_000,
        maxTokens: 100,
        cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
      },
    ],
  });
  const original = runtime.getProvider('openai-codex')!;
  const prompts: string[] = [];
  runtime.registerNativeProvider({
    ...original,
    getModels: () => faux.models,
    getAllModels: () => faux.models.map((model) => ({ ...model, type: 'chat' as const })),
    auth: {
      oauth: {
        name: 'Controlled subscription',
        isSubscription: true,
        async login(interaction) {
          prompts.push(
            await interaction.prompt({
              type: 'select',
              message: 'Method',
              options: [{ id: 'manual', label: 'Manual' }],
            }),
          );
          interaction.notify({ type: 'auth_url', url: 'https://example.invalid/authorize' });
          prompts.push(await interaction.prompt({ type: 'manual_code', message: 'Code', signal: interaction.signal }));
          interaction.signal.throwIfAborted();
          return {
            type: 'oauth',
            access: 'synthetic-access',
            refresh: 'synthetic-refresh',
            expires: Date.now() + 3_600_000,
          };
        },
        async refresh(value) {
          return value;
        },
        async toAuth() {
          return { apiKey: 'synthetic-access' };
        },
      },
    },
  });
  const controller = new AbortController();
  let checks = 0;
  let operations = 0;
  let selected = '';
  const controls = createProviderControls({
    modelRuntime: runtime,
    session: {
      async setModel(model) {
        selected = model.id;
      },
    },
    maxOutputTokens: 50,
    signal: controller.signal,
    checkAuthFile() {
      checks++;
    },
    async withUserOperation(action) {
      operations++;
      return action();
    },
  });
  return {
    controls,
    runtime,
    controller,
    prompts,
    stored,
    checks: () => checks,
    operations: () => operations,
    selected: () => selected,
  };
}

test('catalog distinguishes API credentials, Codex subscription and unavailable Claude subscription', async () => {
  const f = await fixture();
  const providers = f.controls.listProviders();
  assert.equal(providers.find((p) => p.id === 'openai')?.apiKey, true);
  assert.equal(providers.find((p) => p.id === 'openai-codex')?.apiKey, false);
  assert.equal(providers.find((p) => p.id === 'openai-codex')?.oauth, true);
  assert.equal(providers.find((p) => p.id === 'anthropic')?.oauth, false);
  assert.match(providers.find((p) => p.id === 'anthropic')?.oauthUnavailable ?? '', /third-party/i);
  for (const id of ['opencode', 'opencode-go']) assert.equal(providers.find((p) => p.id === id)?.apiKey, true);
  assert.ok(f.controls.listModels().some((model) => model.provider === 'openai-codex' && model.id === 'controlled'));
});

test('Groq picker defaults to GPT OSS 20B and rejects retired catalog models', async () => {
  const f = await fixture();
  const groq = f.controls.listModels().filter((model) => model.provider === 'groq');
  assert.deepEqual(
    groq.map((model) => model.id),
    [
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-safeguard-20b',
      'qwen/qwen3.6-27b',
      'qwen/qwen3.8-27b',
    ],
  );
  f.stored.set('groq', { type: 'api_key', key: 'synthetic-key' });
  await f.runtime.refresh({ allowNetwork: false });
  await f.controls.selectModel('groq', groq[0]!.id);
  assert.equal(f.selected(), 'openai/gpt-oss-20b');
  for (const id of ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']) {
    await assert.rejects(f.controls.selectModel('groq', id), /Select a supported model/);
  }
});

test('Groq picker handles an empty provider catalog', async () => {
  const f = await fixture();
  f.runtime.registerNativeProvider({ ...f.runtime.getProvider('groq')!, getModels: () => [], getAllModels: () => [] });
  assert.deepEqual(
    f.controls.listModels().filter((model) => model.provider === 'groq'),
    [],
  );
  assert.equal(
    f.controls.listProviders().some((provider) => provider.id === 'groq'),
    false,
  );
});

test('controlled OAuth persists locally and selects in the same session through the action gate', async () => {
  const f = await fixture();
  const urls: string[] = [];
  await f.controls.loginProvider('openai-codex', 'oauth', {
    async prompt(prompt) {
      return prompt.type === 'select' ? 'manual' : 'synthetic-code';
    },
    notify(event) {
      if (event.type === 'auth_url') urls.push(event.url);
    },
  });
  assert.deepEqual(f.prompts, ['manual', 'synthetic-code']);
  assert.deepEqual(urls, ['https://example.invalid/authorize']);
  assert.equal(f.stored.get('openai-codex')?.type, 'oauth');
  assert.equal(f.checks(), 2);
  assert.equal(f.selected(), '', 'login must not silently choose a model');
  await f.controls.selectModel('openai-codex', 'controlled');
  assert.equal(f.selected(), 'controlled');
  assert.equal(f.operations(), 2);
});

test('OAuth abort cancels a pending prompt and never projects credential-bearing causes', async () => {
  const f = await fixture();
  const cancellation = new AbortController();
  let promptStarted!: () => void;
  const entered = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  const interaction: AuthInteraction = {
    signal: cancellation.signal,
    notify() {},
    async prompt() {
      promptStarted();
      return new Promise<string>(() => {});
    },
  };
  const pending = f.controls.loginProvider('openai-codex', 'oauth', interaction);
  await entered;
  cancellation.abort(new Error('synthetic-secret-must-not-escape'));
  await assert.rejects(
    pending,
    (error) =>
      error instanceof Error && !JSON.stringify(error).includes('synthetic-secret') && error.cause === undefined,
  );
  assert.equal(f.stored.size, 0);
});

test('subscription cannot be entered as an API key and Claude policy refusal never starts auth', async () => {
  const f = await fixture();
  let prompted = false;
  const interaction: AuthInteraction = {
    async prompt() {
      prompted = true;
      return 'synthetic-key';
    },
    notify() {},
  };
  await assert.rejects(f.controls.connectProvider('openai-codex', 'synthetic-key'), /literal API-key/);
  await assert.rejects(f.controls.loginProvider('anthropic', 'oauth', interaction), /third-party/);
  assert.equal(prompted, false);
  assert.equal(f.stored.size, 0);
});

test('API-key setup retains literal validation and never exposes provider errors', async () => {
  const f = await fixture();
  for (const key of ['!command', '$KEY', 'contains space', '']) {
    await assert.rejects(f.controls.connectProvider('openai', key), /literal API key/);
  }
  await f.controls.connectProvider('opencode', 'synthetic-opencode-key');
  assert.deepEqual(f.stored.get('opencode'), { type: 'api_key', key: 'synthetic-opencode-key' });
});

test('provider-owned labels, multiple fields and choices are not restricted to an OMS allowlist', async () => {
  const f = await fixture();
  const original = f.runtime.getProvider('openai')!;
  const answered: string[] = [];
  f.runtime.registerNativeProvider({
    ...original,
    name: 'Canonical provider',
    auth: {
      apiKey: {
        name: 'Canonical multi-field setup',
        async login(interaction) {
          interaction.notify({ type: 'info', message: 'Provider-owned guidance' });
          answered.push(
            await interaction.prompt({
              type: 'select',
              message: 'Account type',
              options: [{ id: 'team', label: 'Team' }],
            }),
          );
          const key = await interaction.prompt({ type: 'secret', message: 'Token' });
          const account = await interaction.prompt({ type: 'text', message: 'Account name' });
          answered.push(key, account);
          return { type: 'api_key', key, env: { ACCOUNT: account } };
        },
        async resolve({ credential }) {
          return credential?.key ? { auth: { apiKey: credential.key } } : undefined;
        },
      },
      oauth: {
        ...f.runtime.getProvider('openai-codex')!.auth.oauth!,
        name: 'Canonical subscription',
        loginLabel: 'Canonical sign-in',
      },
    },
  });
  const entry = f.controls.listProviders().find((provider) => provider.id === 'openai')!;
  assert.equal(entry.name, 'Canonical provider');
  assert.equal(entry.apiKeyLabel, 'Canonical multi-field setup');
  assert.equal(entry.oauthLabel, 'Canonical sign-in');
  assert.equal(entry.oauth, true);
  const notices: string[] = [];
  await f.controls.loginProvider('openai', 'api_key', {
    async prompt(prompt) {
      return prompt.type === 'select' ? 'team' : prompt.type === 'secret' ? 'synthetic-key' : 'Team account';
    },
    notify(event) {
      if (event.type === 'info') notices.push(event.message);
    },
  });
  assert.deepEqual(answered, ['team', 'synthetic-key', 'Team account']);
  assert.deepEqual(notices, ['Provider-owned guidance']);
  assert.deepEqual(f.stored.get('openai'), { type: 'api_key', key: 'synthetic-key', env: { ACCOUNT: 'Team account' } });
});

test('generic API setup rejects executable configuration and unknown choices before persistence', async () => {
  const f = await fixture();
  const original = f.runtime.getProvider('openai')!;
  f.runtime.registerNativeProvider({
    ...original,
    auth: {
      apiKey: {
        name: 'Configuration',
        async login(interaction) {
          const key = await interaction.prompt({ type: 'secret', message: 'Token' });
          const account = await interaction.prompt({ type: 'text', message: 'Account' });
          return { type: 'api_key', key, env: { ACCOUNT: account } };
        },
        async resolve({ credential }) {
          return credential?.key ? { auth: { apiKey: credential.key } } : undefined;
        },
      },
    },
  });
  for (const value of ['!synthetic-command', '$PRIVATE_VALUE', 'bad\u001bvalue']) {
    await assert.rejects(
      f.controls.loginProvider('openai', 'api_key', {
        async prompt(prompt) {
          return prompt.type === 'secret' ? 'synthetic-key' : value;
        },
        notify() {},
      }),
      /setup did not complete/,
    );
    assert.equal(f.stored.size, 0);
  }
  await assert.rejects(f.controls.connectProvider('openai', 'synthetic-key'), /setup did not complete/);
  assert.equal(f.stored.size, 0);
  await assert.rejects(
    f.controls.loginProvider('openai-codex', 'oauth', {
      async prompt() {
        return 'not-an-offered-option';
      },
      notify() {},
    }),
    /setup did not complete/,
  );
  assert.equal(f.stored.size, 0);
});

test('canonical LoginOptions and persisted model selection use the owner settings manager', async () => {
  const f = await fixture();
  let deviceId = '';
  let agentName = '';
  let persist: boolean | undefined;
  let flushes = 0;
  const original = f.runtime.getProvider('openai-codex')!;
  f.runtime.registerNativeProvider({
    ...original,
    auth: {
      oauth: {
        ...original.auth.oauth!,
        async login(_interaction, options) {
          deviceId = options?.getDeviceId?.() ?? '';
          agentName = options?.agentName ?? '';
          return { type: 'oauth', access: 'synthetic', refresh: 'synthetic', expires: Date.now() + 60_000 };
        },
      },
    },
  });
  const controls = createProviderControls({
    modelRuntime: f.runtime,
    session: {
      async setModel(_model, options) {
        persist = options?.persist;
      },
    },
    maxOutputTokens: 50,
    signal: f.controller.signal,
    checkAuthFile() {},
    async withUserOperation(action) {
      return action();
    },
    loginOptions: { agentName: 'OMS', getDeviceId: () => 'synthetic-installation' },
    async flushSettings() {
      flushes++;
    },
  });
  await controls.loginProvider('openai-codex', 'oauth', {
    async prompt() {
      return '';
    },
    notify() {},
  });
  await controls.selectModel('openai-codex', 'controlled');
  assert.equal(deviceId, 'synthetic-installation');
  assert.equal(agentName, 'OMS');
  assert.equal(persist, true);
  assert.equal(flushes, 2);
});

test('direct admission readiness gates explicit selection without replacing the live session', async () => {
  const f = await fixture();
  await f.controls.loginProvider('openai-codex', 'oauth', {
    async prompt(prompt) {
      return prompt.type === 'select' ? 'manual' : 'synthetic-code';
    },
    notify() {},
  });
  let selected = 'controlled-previous';
  let ready = false;
  const session = {
    async setModel(model: { id: string }) {
      selected = model.id;
    },
  };
  const controls = createProviderControls({
    modelRuntime: f.runtime,
    session,
    maxOutputTokens: 50,
    signal: f.controller.signal,
    checkAuthFile() {},
    withUserOperation: (action) => action(),
    modelReadiness: () => ({
      ready,
      detail: ready ? 'Connected · direct Codex' : 'Insufficient remaining spend allowance · /status',
    }),
  });
  assert.equal(selected, 'controlled-previous');
  const direct = controls.listModels().find((model) => model.id === 'controlled')!;
  assert.equal(direct.configured, true);
  assert.equal(direct.selectable, false);
  assert.match(direct.detail!, /spend allowance/);
  await assert.rejects(controls.selectModel('openai-codex', 'controlled'), /spend allowance/);
  ready = true;
  await controls.selectModel('openai-codex', 'controlled');
  assert.equal(selected, 'controlled');
});

test('local Claude Code setup checks native access without storing credentials or changing the selected model', async () => {
  const f = await fixture();
  const faux = createFauxCore({
    api: 'anthropic-messages',
    provider: 'claude-code',
    models: [
      {
        id: 'sonnet',
        contextWindow: 1_000,
        maxTokens: 100,
        cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
      },
    ],
  });
  f.runtime.registerNativeProvider({
    ...f.runtime.getProvider('anthropic')!,
    id: 'claude-code',
    name: 'Claude Code',
    auth: {},
    getModels: () => faux.models,
    getAllModels: () => faux.models.map((model) => ({ ...model, type: 'chat' as const })),
  });
  let status = {
    installed: false,
    configured: false,
    checked: true,
    detail: 'Install Claude Code, then run claude auth login.',
  };
  let inspections = 0;
  let authChecks = 0;
  let selected = '';
  const controls = createProviderControls({
    modelRuntime: f.runtime,
    session: {
      async setModel(model) {
        selected = model.id;
      },
    },
    maxOutputTokens: 50,
    signal: f.controller.signal,
    checkAuthFile() {
      authChecks++;
    },
    withUserOperation: (action) => action(),
    claudeCodeAccess: {
      status: () => status,
      async inspect(signal) {
        signal?.throwIfAborted();
        inspections++;
        return status;
      },
    },
  });
  const provider = controls.listProviders().find((provider) => provider.id === 'claude-code')!;
  assert.equal(provider.apiKey, false);
  assert.equal(provider.oauth, true);
  assert.equal(provider.configured, false);
  assert.match(provider.oauthLabel!, /local Claude Code/);
  assert.equal(controls.listModels().find((model) => model.provider === 'claude-code')?.selectable, false);
  const guidance: string[] = [];
  const interaction: AuthInteraction = {
    async prompt() {
      throw new Error('Native setup must not ask for a credential');
    },
    notify(event) {
      if (event.type === 'info') guidance.push(event.message);
    },
  };
  await assert.rejects(controls.loginProvider('claude-code', 'oauth', interaction), /claude auth login/);
  await assert.rejects(controls.connectProvider('claude-code', 'synthetic-key'), /literal API-key/);
  assert.match(guidance.join(' '), /without copying credentials or sending a model request/);
  status = { installed: true, configured: true, checked: true, detail: 'Claude Code subscription ready.' };
  await controls.loginProvider('claude-code', 'oauth', interaction);
  assert.equal(selected, '', 'a successful access check must not silently select a model');
  assert.equal(controls.listProviders().find((provider) => provider.id === 'claude-code')?.configured, true);
  await controls.selectModel('claude-code', 'sonnet');
  assert.equal(selected, 'sonnet');
  assert.equal(inspections, 3, 'selection refreshes native status rather than trusting cached readiness');
  assert.equal(authChecks, 0, 'native auth never opens the OMS credential file');
  assert.equal(f.stored.size, 0);
  status = { installed: true, configured: false, checked: true, detail: 'Run claude auth login again.' };
  await assert.rejects(controls.selectModel('claude-code', 'sonnet'), /claude auth login/);
  assert.equal(selected, 'sonnet');
});

test('an unchecked Claude Code login stays selectable until the first native check', async () => {
  const f = await fixture();
  const faux = createFauxCore({
    api: 'anthropic-messages',
    provider: 'claude-code',
    models: [
      {
        id: 'sonnet',
        contextWindow: 1_000,
        maxTokens: 100,
        cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
      },
    ],
  });
  f.runtime.registerNativeProvider({
    ...f.runtime.getProvider('anthropic')!,
    id: 'claude-code',
    name: 'Claude Code',
    auth: {},
    getModels: () => faux.models,
    getAllModels: () => faux.models.map((model) => ({ ...model, type: 'chat' as const })),
  });
  let status = {
    installed: false,
    configured: false,
    checked: false,
    detail: 'The local Claude Code login has not been checked yet.',
  };
  const controls = createProviderControls({
    modelRuntime: f.runtime,
    session: {
      async setModel() {},
    },
    maxOutputTokens: 50,
    signal: f.controller.signal,
    checkAuthFile() {},
    async withUserOperation(action) {
      return action();
    },
    claudeCodeAccess: {
      status: () => status,
      async inspect(signal) {
        signal?.throwIfAborted();
        return status;
      },
    },
  });
  const choice = () => controls.listModels().find((model) => model.provider === 'claude-code')!;
  assert.equal(choice().configured, false);
  assert.equal(choice().selectable, true, 'an unchecked login must not gate a resumed native model');
  status = { ...status, checked: true, detail: 'Sign in with claude auth login.' };
  assert.equal(choice().selectable, false, 'a failed check still blocks selection');
  assert.equal(choice().detail, 'Sign in with claude auth login.');
  status = { ...status, configured: true };
  assert.equal(choice().configured, true);
  assert.equal(choice().selectable, true);
});
