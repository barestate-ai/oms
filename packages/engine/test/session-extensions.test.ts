import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { createChatFixture } from '../test-support/chat-fixture.ts';
import { createChatSession } from '../src/runtime/chat-session.ts';
import type { ChatSession } from '../src/runtime/session-types.ts';

async function open(t: TestContext) {
  const f = await createChatFixture();
  const sessions: ChatSession[] = [];
  const start = async (extra: Partial<typeof f.options> = {}) => {
    const chat = await createChatSession({ ...f.options, ...extra });
    sessions.push(chat);
    return chat;
  };
  t.after(async () => {
    for (const chat of sessions) await chat.close();
    rmSync(f.base, { recursive: true, force: true });
  });
  return { ...f, start };
}

/** One tool the host injects; `ran` records what the tool was asked. */
function hostTool(ran: unknown[] = []): ExtensionFactory {
  return (pi) =>
    pi.registerTool({
      name: 'host_ping',
      label: 'host_ping',
      description: 'Answers pong.',
      parameters: Type.Object({ note: Type.String() }),
      async execute(_id, params) {
        ran.push(params);
        return { content: [{ type: 'text', text: 'pong' }], details: undefined };
      },
    });
}

/** What the model is shown by a chat opened with `extra`; a folder holds one live chat, so it is closed again. */
async function shape(f: Awaited<ReturnType<typeof open>>, extra: Partial<typeof f.options> = {}) {
  const chat = await f.start(extra);
  const names = chat.session.getActiveToolNames().sort();
  const seen = {
    names,
    definitions: names.map((name) => chat.session.getToolDefinition(name)),
    prompt: chat.session.systemPrompt,
  };
  await chat.close();
  return seen;
}

test(
  'without extensions the tools, their definitions and the prompt are the ones a chat always had',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    const plain = await shape(f);
    const empty = await shape(f, { extensions: [], extensionTools: [] });
    assert.deepEqual(empty.names, plain.names);
    assert.equal(JSON.stringify(empty.definitions), JSON.stringify(plain.definitions));
    assert.equal(empty.prompt, plain.prompt);
    assert.ok(!plain.names.includes('host_ping'));
  },
);

test(
  'an injected tool is declared to the model and leaves every other tool and definition alone',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    const plain = await shape(f);
    const injected = await shape(f, { extensions: [hostTool()], extensionTools: ['host_ping'] });
    assert.deepEqual(injected.names, [...plain.names, 'host_ping'].sort());
    for (const [index, name] of plain.names.entries()) {
      const at = injected.names.indexOf(name);
      assert.equal(JSON.stringify(injected.definitions[at]), JSON.stringify(plain.definitions[index]), name);
    }
  },
);

test('an injected tool is not registered unless the host names it', { timeout: 60_000 }, async (t) => {
  const f = await open(t);
  const chat = await f.start({ extensions: [hostTool()] });
  assert.ok(!chat.session.getActiveToolNames().includes('host_ping'));
});

test(
  'an injected tool runs when the model calls it, and its call and result reach the trace',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    const ran: unknown[] = [];
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('host_ping', { note: 'hello' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ]);
    const chat = await f.start({ extensions: [hostTool(ran)], extensionTools: ['host_ping'] });
    await chat.session.prompt('Ping.');
    assert.deepEqual(ran, [{ note: 'hello' }]);
    const result = chat.session.messages.find((message) => message.role === 'toolResult');
    assert.equal(result?.isError, false);
    assert.ok(JSON.stringify(result).includes('pong'));
    await chat.close();
    const sessions = join(f.stateRoot, 'folders', f.folder.key, 'sessions');
    const trace = readdirSync(sessions).find((name) => name.endsWith('.trace.jsonl'))!;
    const events = readFileSync(join(sessions, trace), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; toolName?: string });
    for (const type of ['tool_call', 'tool_result'])
      assert.ok(
        events.some((event) => event.type === type && event.toolName === 'host_ping'),
        type,
      );
  },
);

test(
  'the guards still see an injected tool: a call repeated until the guard stops it never runs',
  { timeout: 60_000 },
  async (t) => {
    const f = await open(t);
    const ran: unknown[] = [];
    const call = () => fauxAssistantMessage(fauxToolCall('host_ping', { note: 'same' }), { stopReason: 'toolUse' });
    f.faux.setResponses([call(), call(), call(), call(), fauxAssistantMessage('Done.')]);
    const chat = await f.start({ extensions: [hostTool(ran)], extensionTools: ['host_ping'] });
    await chat.session.prompt('Ping until told to stop.');
    const results = chat.session.messages.filter((message) => message.role === 'toolResult');
    assert.equal(results.length, 4);
    assert.ok(ran.length < 4);
    assert.ok(results.some((result) => result.isError && JSON.stringify(result).includes('repetition')));
  },
);
