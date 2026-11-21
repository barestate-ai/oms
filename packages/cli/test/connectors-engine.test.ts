/** The connectors in a real OMS folder chat (the engine's own session, a scripted model, no network). Needs SURFPOOL_BINARY. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createChatSession, type ChatSession } from '@oms/engine';
import { createChatFixture } from '../../engine/test-support/chat-fixture.ts';
import { createConnectors } from '../src/connectors/runtime.ts';
import type { HostRun } from '../src/connectors/host.ts';

const skip =
  !process.env.SURFPOOL_BINARY || !existsSync(process.env.SURFPOOL_BINARY) ? 'set SURFPOOL_BINARY to run' : false;

async function open(t: TestContext, config: Record<string, { enabled: boolean; access: string }>) {
  const f = await createChatFixture();
  mkdirSync(f.stateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(f.stateRoot, 'connectors.json'), JSON.stringify({ version: 1, connectors: config }));
  const ran: Array<{ file: string; args: readonly string[]; cwd?: string }> = [];
  const run: HostRun = async (file, args, options) => {
    ran.push({ file, args, cwd: options?.cwd });
    return { code: 0, stdout: '{"title":"Add vault"}', stderr: '' };
  };
  const connectors = createConnectors({ stateRoot: f.stateRoot, folder: f.project, env: {}, run });
  const sessions: ChatSession[] = [];
  const start = async () => {
    const chat = await createChatSession({
      ...f.options,
      extensions: connectors.extensions,
      extensionTools: connectors.extensionTools,
    });
    sessions.push(chat);
    return chat;
  };
  t.after(async () => {
    for (const chat of sessions) await chat.close();
    rmSync(f.base, { recursive: true, force: true });
  });
  return { ...f, connectors, ran, start };
}

test('a chat without connectors on is the chat it always was', { skip, timeout: 60_000 }, async (t) => {
  const f = await open(t, {});
  const chat = await f.start();
  const names = chat.session.getActiveToolNames();
  for (const name of ['github', 'gitlab', 'docker', 'aws', 'solana_rpc']) assert.ok(!names.includes(name), name);
  assert.ok(!names.some((name) => name.startsWith('mcp__')));
});

test(
  'with GitHub on, the agent reads through the host and a write waits for the approval row',
  { skip, timeout: 60_000 },
  async (t) => {
    const f = await open(t, { github: { enabled: true, access: 'ask' } });
    const asked: string[] = [];
    f.connectors.setApprover(async (request) => {
      asked.push(`${request.connector}:${request.action}`);
      return false;
    });
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('github', { action: 'pr_view', number: '5' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('github', { action: 'pr_comment', number: '5', body: 'hello' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Done.'),
    ]);
    const chat = await f.start();
    assert.ok(chat.session.getActiveToolNames().includes('github'));
    await chat.session.prompt('Look at pull request 5 and comment.');
    assert.equal(f.ran.length, 1, 'only the read ran');
    assert.deepEqual(f.ran[0]!.args.slice(0, 3), ['pr', 'view', '5']);
    assert.equal(f.ran[0]!.cwd, f.project);
    assert.deepEqual(asked, ['github:pr_comment']);
    const results = chat.session.messages.filter((message) => message.role === 'toolResult');
    assert.equal(results.length, 2);
    assert.match(JSON.stringify(results[0]), /Untrusted reference data from GitHub through gh/);
    assert.equal(results[1]!.isError, true);
  },
);

test(
  'turning GitHub off in the middle of a chat takes the tool away, and on again brings it back',
  { skip, timeout: 60_000 },
  async (t) => {
    const f = await open(t, { github: { enabled: true, access: 'read' } });
    const chat = await f.start();
    assert.ok(chat.session.getActiveToolNames().includes('github'));
    f.connectors.setEnabled('github', false);
    assert.ok(!chat.session.getActiveToolNames().includes('github'));
    f.connectors.setEnabled('docker', true);
    assert.ok(chat.session.getActiveToolNames().includes('docker'));
    assert.ok(
      !chat.session.getActiveToolNames().includes('github'),
      'a later change does not bring a hidden tool back',
    );
    f.connectors.setEnabled('github', true);
    assert.ok(chat.session.getActiveToolNames().includes('github'));
  },
);

test('YOLO does not skip a connector approval', { skip, timeout: 60_000 }, async (t) => {
  const f = await open(t, { github: { enabled: true, access: 'ask' } });
  const asked: string[] = [];
  f.connectors.setApprover(async (request) => {
    asked.push(request.action);
    return true;
  });
  const chat = await f.start();
  chat.yolo.set(true);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('github', { action: 'issue_create', title: 'x' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done.'),
  ]);
  await chat.session.prompt('File an issue.');
  assert.deepEqual(asked, ['issue_create']);
  assert.equal(f.ran.length, 1);
});
