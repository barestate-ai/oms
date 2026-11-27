import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from '@earendil-works/pi-coding-agent';
import type { RuntimeEnvironment } from '../src/runtime/session-environment.ts';
import { createSessionHooks } from '../src/runtime/session-hooks.ts';
import type { SessionLifecycle } from '../src/runtime/session-lifecycle.ts';
import type { SessionTools } from '../src/runtime/session-tools.ts';
import type { CommonSessionOptions } from '../src/runtime/session-types.ts';
import { CLAUDE_CAPPED_WORK, CLAUDE_DEPLOYMENT_KNOWLEDGE, CO_AUTHOR_TRAILER } from '../src/runtime/system-prompt.ts';

async function beforeStart(contract: boolean) {
  const hooks = createSessionHooks(
    {} as CommonSessionOptions,
    {} as SessionLifecycle,
    { executionMode: 'bounded', ...(contract ? { contract: {} } : {}) } as RuntimeEnvironment,
    { taskRoot: '/work', toolchainSummary: 'ok' } as SessionTools,
  );
  let handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> | undefined;
  await hooks.policy({
    on(name: string, registered: unknown) {
      if (name === 'before_agent_start') handler = registered as typeof handler;
      return () => {};
    },
    registerTool() {},
  } as unknown as ExtensionAPI);
  const before = handler;
  assert.ok(before);
  return async (provider: string | undefined, systemPrompt = hooks.promptFor(undefined)) => {
    const event = {
      type: 'before_agent_start',
      messageType: 'user',
      prompt: 'Complete the selected task',
      systemPrompt,
      systemPromptOptions: { cwd: '/original' },
    } as BeforeAgentStartEvent;
    const result = await before(event, { model: provider ? { provider } : undefined } as ExtensionContext);
    assert.equal(event.systemPromptOptions.cwd, '/work');
    return result?.systemPrompt ?? systemPrompt;
  };
}

test('switching a folder conversation tells npx users how to resume without changing prompts', async (t) => {
  const previous = process.env.npm_command;
  process.env.npm_command = 'exec';
  t.after(() => {
    if (previous === undefined) delete process.env.npm_command;
    else process.env.npm_command = previous;
  });
  const hooks = createSessionHooks(
    {} as CommonSessionOptions,
    {} as SessionLifecycle,
    { executionMode: 'interactive' } as RuntimeEnvironment,
    { taskRoot: '/work', toolchainSummary: 'ok' } as SessionTools,
  );
  let switchSession: ((_event: unknown, ctx: ExtensionContext) => unknown) | undefined;
  await hooks.policy({
    on(name: string, handler: unknown) {
      if (name === 'session_before_switch') switchSession = handler as typeof switchSession;
      return () => {};
    },
    registerTool() {},
  } as unknown as ExtensionAPI);
  assert.ok(switchSession);
  const notices: string[] = [];
  assert.deepEqual(
    switchSession({}, { ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext),
    { cancel: true },
  );
  assert.deepEqual(notices, [
    'Run npx @barestate/oms again in this folder to resume a conversation. This chat keeps its folder fixed.',
  ]);
});

for (const contract of [false, true]) {
  for (const provider of ['claude-code', 'anthropic', 'openai', undefined]) {
    test(`capped-work guidance is ${contract && provider === 'claude-code' ? 'present' : 'absent'} for ${provider ?? 'no model'} with contract=${contract}`, async () => {
      const start = await beforeStart(contract);
      const text = await start(provider);
      assert.equal(text.includes('Capped Solana work procedure:'), contract && provider === 'claude-code');
      assert.equal(text.includes('Solana deployment knowledge:'), contract && provider === 'claude-code');
      if (contract && provider === 'claude-code') {
        assert.match(text, /1\. Before the first capped action, write a ledger file/);
        assert.match(text, /at least five candidate families/);
        assert.match(text, /5\. If the cap would run out/);
      }
    });
  }
}

for (const contract of [false, true]) {
  test(`co-author trailer rule is present by default and absent when off (${contract ? 'task' : 'chat'})`, () => {
    const hooks = (options: CommonSessionOptions) =>
      createSessionHooks(
        options,
        {} as SessionLifecycle,
        { executionMode: 'interactive', ...(contract ? { contract: {} } : {}) } as RuntimeEnvironment,
        { taskRoot: '/work', toolchainSummary: 'ok' } as SessionTools,
      );
    const on = hooks({} as CommonSessionOptions).promptFor(undefined);
    assert.equal(on.split(CO_AUTHOR_TRAILER).length - 1, 1);
    assert.match(on, /never add it to a commit the user made/);
    const off = hooks({ coAuthorTrailer: false } as CommonSessionOptions).promptFor(undefined);
    assert.ok(!off.includes('Co-Authored-By'));
  });
}

test('capped-work guidance is appended once across turns and follows the current provider', async () => {
  const start = await beforeStart(true);
  const first = await start('claude-code', 'Trusted prompt');
  assert.ok(first.startsWith('Trusted prompt\n\nCapped Solana work procedure:'));
  assert.equal(await start('claude-code', first), first);
  assert.equal(first.split(CLAUDE_DEPLOYMENT_KNOWLEDGE).length - 1, 1);
  assert.equal(await start('claude-code', 'Trusted prompt'), first);
  assert.equal(await start('openai', 'Trusted prompt'), 'Trusted prompt');
  assert.equal(
    await start('claude-code', 'Updated trusted prompt'),
    first.replace('Trusted prompt', 'Updated trusted prompt'),
  );
});

test('each Claude guidance block is appended when only the other block is already present', async () => {
  const start = await beforeStart(true);
  for (const existing of [CLAUDE_CAPPED_WORK, CLAUDE_DEPLOYMENT_KNOWLEDGE]) {
    const text = await start('claude-code', `Trusted prompt\n\n${existing}`);
    for (const block of [CLAUDE_CAPPED_WORK, CLAUDE_DEPLOYMENT_KNOWLEDGE])
      assert.equal(text.split(block).length - 1, 1);
    assert.equal(await start('claude-code', text), text);
  }
});
