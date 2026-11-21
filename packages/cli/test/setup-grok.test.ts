import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createProviderControls } from '@oms/engine';
import { SetupPane } from '../src/tui/setup.ts';
import { getTheme } from '../src/tui/theme.ts';

const credentials: CredentialStore = {
  async read() {
    return undefined;
  },
  async list() {
    return [];
  },
  async modify() {
    throw new Error('no credential writes in this test');
  },
  async delete() {},
};

async function pane(t: TestContext, mode: 'connect' | 'model') {
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: mode === 'model',
    allowModelNetwork: false,
  });
  const controller = new AbortController();
  const controls = createProviderControls({
    modelRuntime: runtime,
    session: { async setModel() {} },
    maxOutputTokens: 4096,
    signal: controller.signal,
    checkAuthFile() {},
    async withUserOperation(action) {
      return action();
    },
    loginOptions: { agentName: 'OMS' },
  });
  const setup = new SetupPane(controls, {
    mode,
    theme: () => getTheme('gruvbox')!,
    rows: () => 40,
    render() {},
    close() {},
    notice() {},
    selectTheme: () => false,
  });
  t.after(() => {
    setup.dispose();
    controller.abort();
  });
  return {
    setup,
    rows: () =>
      stripVTControlCharacters([...setup.body.render(120)].join('\n'))
        .split('\n')
        .map((row) => row.replace(/^[\s→>›]+/, '').trim())
        .filter(Boolean),
  };
}

test('/connect lists Grok second, after Codex, ahead of other subscriptions and every API key', async (t) => {
  const { setup, rows } = await pane(t, 'connect');
  const labels = rows()
    .filter((row) => /\(.*\)/.test(row))
    .map((row) => row.replace(/\s{2,}.*/, ''));
  assert.deepEqual(labels.slice(0, 2), ['Codex (ChatGPT subscription)', 'Grok (SuperGrok or X Premium)']);
  setup.handleInput('grok');
  assert.deepEqual(
    rows()
      .filter((row) => row.startsWith('Grok'))
      .map((row) => row.replace(/\s{2,}.*/, '')),
    ['Grok (SuperGrok or X Premium)', 'Grok (xAI API key)'],
  );
});

test('/connect puts Claude Code between Codex and Grok', (t) => {
  const provider = (id: string, name: string, oauth: boolean, apiKey: boolean) => ({
    id,
    name,
    configured: false,
    apiKey,
    oauth,
    ...(oauth ? { oauthName: `${name} subscription` } : {}),
  });
  const setup = new SetupPane(
    {
      listProviders: () => [
        provider('zai', 'Z AI', true, false),
        provider('xai', 'xAI', true, true),
        provider('claude-code', 'Claude Code', true, false),
        provider('openai-codex', 'OpenAI Codex', true, false),
      ],
      listModels: () => [],
      async selectModel() {},
      async loginProvider() {},
      async importEnvironment(): Promise<never> {
        throw new Error('not used');
      },
    },
    {
      mode: 'connect',
      theme: () => getTheme('gruvbox')!,
      rows: () => 40,
      render() {},
      close() {},
      notice() {},
      selectTheme: () => false,
    },
  );
  t.after(() => setup.dispose());
  const initial = stripVTControlCharacters(setup.body.render(120).join('\n'));
  assert.match(initial, /Other providers \(2 more\)/);
  assert.ok(initial.indexOf('Codex (ChatGPT') < initial.indexOf('Claude Code (Claude'));
  assert.ok(initial.indexOf('Claude Code (Claude') < initial.indexOf('Grok (SuperGrok'));
  for (let index = 0; index < 3; index++) setup.handleInput('\x1b[B');
  setup.handleInput('\r');
  const screen = stripVTControlCharacters(setup.body.render(120).join('\n'));
  const order = ['Codex (ChatGPT', 'Claude Code (Claude', 'Grok (SuperGrok', 'Z AI subscription', 'Grok (xAI API'].map(
    (label) => screen.indexOf(label),
  );
  assert.ok(
    order.every((at) => at >= 0),
    screen,
  );
  assert.deepEqual(
    [...order].sort((x, y) => x - y),
    order,
  );
});

test('typing grok or xai in /connect finds both Grok rows', async (t) => {
  for (const query of ['grok', 'xai']) {
    const { setup, rows } = await pane(t, 'connect');
    setup.handleInput(query);
    const found = rows().join('\n');
    assert.match(found, /Grok \(SuperGrok or X Premium\)/, query);
    assert.match(found, /Grok \(xAI API key\)/, query);
  }
});

test('with an xAI key in the environment /model offers the Grok models as ready', async (t) => {
  const saved = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test-0000000000000000';
  t.after(() => {
    if (saved === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = saved;
  });
  const { setup, rows } = await pane(t, 'model');
  assert.match(rows().join('\n'), /Grok models/);
  setup.handleInput('grok');
  setup.handleInput('\r');
  const models = rows().join('\n');
  assert.match(models, /xai\/grok/);
  assert.doesNotMatch(models, /Unavailable|Needs setup/);
});
