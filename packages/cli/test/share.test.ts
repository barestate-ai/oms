import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createChatSession, type ChatSession } from '@oms/engine';
import { createChatFixture } from '../../engine/test-support/chat-fixture.ts';
import { joinSession } from '../src/join.ts';
import { collectItems, exportEntries, syncNote, writeJoinedSession } from '../src/remote/share.ts';
import { createSyncTool, SYNC_TOOL } from '../src/remote/sync-tool.ts';
import { createRemoteHost } from '../src/tui/remote-commands.ts';
import { Conversation } from '../src/tui/transcript.ts';
import { chatFixture, start } from '../test-support/fake-session.ts';

const surfpool = process.env.SURFPOOL_BINARY ?? join(homedir(), '.local/bin/surfpool');
const live = { skip: !existsSync(surfpool) && 'needs Surfpool', timeout: 120_000 };
const me = userInfo().username;
const json = { 'content-type': 'application/json' };

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

test('/share lets a guest watch and talk in a browser, never while approvals are off, and /share stop removes them', async () => {
  const f = chatFixture();
  const { terminal, close } = start(f.harness, 120, 46);
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('/share');
    terminal.send('\r');
    const shown = await terminal.until((s) => s.includes('This session is shared') && /oms join '/.test(s));
    const link = /oms join '(http:\/\/[^']+)'/.exec(shown)![1]!;
    const { origin, hash } = new URL(link);
    const secret = 'akshat'.padEnd(40, 'x');
    const auth = { authorization: `Bearer ${secret}`, ...json };

    const hello = fetch(`${origin}/api/hello`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ client: secret, code: hash.slice(1), name: 'akshat' }),
    });
    await terminal.until((s) => s.includes('Let akshat join this session?'));
    terminal.send('y');
    assert.deepEqual(await (await hello).json(), { role: 'guest', name: 'akshat' });

    const send = (text: string) =>
      fetch(`${origin}/api/send`, { method: 'POST', headers: auth, body: JSON.stringify({ text }) });
    assert.equal((await send('try the other parser')).status, 200);
    await terminal.until(() => f.prompts.length === 1);
    assert.deepEqual(f.prompts, ['[akshat] try the other parser'], 'the agent is told who is speaking');
    f.promptGate.resolve();
    await terminal.until((s) => !s.includes('esc to'));

    (f.harness as unknown as ChatSession).yolo.set(true);
    const refused = await send('now delete everything');
    assert.deepEqual(
      [refused.status, ((await refused.json()) as { error: string }).error],
      [409, 'The host has approvals off, so guests can only watch.'],
    );
    assert.equal(f.prompts.length, 1);

    terminal.send('/share stop');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Sharing is off'));
    assert.equal((await send('still there?')).status, 401);
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await close();
  }
});

test(
  'a teammate joins with their own copy, both see who is live, and a sync trades what is new after the other agrees',
  live,
  async (t) => {
    const HOST = await createChatFixture();
    const GUEST = await createChatFixture();
    // Closed in this order when the test ends, however it ends: the links, the sessions, then their folders.
    const open: { close(): Promise<void> | void }[] = [];
    t.after(async () => {
      for (const item of open.reverse()) await item.close();
      rmSync(HOST.base, { recursive: true, force: true });
      rmSync(GUEST.base, { recursive: true, force: true });
    });
    const side = (chat: ChatSession, syncTool?: ReturnType<typeof createSyncTool>) => {
      const asked: string[] = [];
      const toasts: string[] = [];
      const state = { allow: true };
      const remote = createRemoteHost({
        harness: chat,
        conversation: new Conversation([], (message) => message, {}),
        busy: () => false,
        send: () => undefined,
        cancel() {},
        approval: () => undefined,
        async ask(question) {
          asked.push(question.title);
          return state.allow;
        },
        toast: (text) => void toasts.push(text),
        render() {},
        syncTool,
      });
      return { remote, asked, toasts, state };
    };
    const notes = (chat: ChatSession): string =>
      chat.session.messages
        .filter((message) => (message as { role: string }).role === 'custom')
        .map((message) => JSON.stringify((message as { content: unknown }).content))
        .join('\n');

    // The host works, then shares.
    const hostChat = await createChatSession(HOST.options);
    open.push(hostChat);
    HOST.faux.setResponses([fauxAssistantMessage('Fixed the parser.')]);
    await hostChat.session.prompt(`fix the parser. The key is sk-${'a'.repeat(24)}`);
    const host = side(hostChat);
    open.push(host.remote);
    const link = /oms join '([^']+)'/.exec(await host.remote.share(''))![1]!;
    assert.deepEqual(host.remote.chips(), [{ text: 'shared', dot: 'info' }]);

    // The teammate takes a copy into their own folder.
    const said: string[] = [];
    const sessionId = await joinSession([link.replace(/:\d+/, (port) => port), '--name', 'akshat'], {
      folder: GUEST.project,
      stateRoot: GUEST.stateRoot,
      name: 'unused',
      log: (line) => void said.push(line),
      error: (line) => void said.push(line),
    });
    assert.ok(sessionId, said.join('\n'));
    assert.deepEqual(host.asked, ['Give akshat a copy of this session?']);
    const sessions = join(GUEST.stateRoot, 'folders', GUEST.folder.key, 'sessions');
    const saved = readFileSync(
      join(
        sessions,
        readdirSync(sessions).find((name) => name.endsWith('.jsonl'))!,
      ),
      'utf8',
    );
    assert.match(saved, /Fixed the parser\./);
    assert.equal(saved.includes('sk-aaaa'), false, 'secrets are masked in what the teammate receives');
    assert.match(saved, new RegExp(`This conversation was shared by ${me}`));

    // Their OMS opens it as a normal conversation, with the history and the agent's sync tool.
    const syncTool = createSyncTool();
    const guestChat = await createChatSession({
      ...GUEST.options,
      sessionId,
      extensions: [syncTool.extension],
      extensionTools: [SYNC_TOOL],
    });
    open.push(guestChat);
    assert.match(JSON.stringify(guestChat.session.messages), /Fixed the parser\./);
    const guest = side(guestChat, syncTool);
    open.push(guest.remote);
    await until(() => host.remote.chips().some((chip) => chip.text === 'shared · 1'), 'the host to see the teammate');
    await until(
      () => guest.remote.chips().some((chip) => chip.text === me && chip.dot === 'success'),
      'the teammate to see the host',
    );
    assert.ok(guest.toasts.includes(`${me} is live`));
    assert.ok(guestChat.session.getActiveToolNames().includes(SYNC_TOOL));
    assert.equal(hostChat.session.getActiveToolNames().includes(SYNC_TOOL), false);

    // The teammate works on, then syncs: the host is asked, and gets their work as one note the agent reads.
    GUEST.faux.setResponses([fauxAssistantMessage('Added tests.')]);
    await guestChat.session.prompt('add tests');
    assert.equal(await guest.remote.syncNow(), `Synced with ${me} · sent 2 new messages, received 0 new messages.`);
    assert.deepEqual(host.asked.slice(1), ['Sync this session with akshat?']);
    await until(() => notes(hostChat).includes("akshat's agent: Added tests."), 'the note on the host');
    assert.match(notes(hostChat), /akshat: add tests/);
    let context = '';
    HOST.faux.setResponses([
      (request) => {
        context = JSON.stringify(request.messages);
        return fauxAssistantMessage('Deployed.');
      },
    ]);
    await hostChat.session.prompt('deploy it');
    assert.match(context, /akshat's agent: Added tests\./, 'the host agent sees what the teammate did');

    // The host syncs back: the teammate is asked, and nothing they sent comes back to them.
    assert.equal(await host.remote.syncNow(), 'Synced with akshat · sent 2 new messages, received 0 new messages.');
    assert.deepEqual(guest.asked, [`Sync this session with ${me}?`]);
    await until(() => notes(guestChat).includes(`${me}'s agent: Deployed.`), 'the note on the teammate side');
    assert.equal(notes(guestChat).includes('Added tests.'), false);

    // "Sync the session" asked of the agent goes the same way.
    let toolResult = '';
    GUEST.faux.setResponses([
      fauxAssistantMessage(fauxToolCall(SYNC_TOOL, {}), { stopReason: 'toolUse' }),
      (request) => {
        toolResult = JSON.stringify(request.messages.at(-1));
        return fauxAssistantMessage('Synced.');
      },
    ]);
    await guestChat.session.prompt('sync the session');
    assert.match(toolResult, new RegExp(`Synced with ${me} · sent 1 new message, received 0 new messages\\.`));

    // Either side may say no, and then nothing moves.
    guest.state.allow = false;
    assert.equal(await host.remote.syncNow(), 'akshat said no.');

    // Ending the sharing removes the teammate.
    assert.match(await host.remote.share('stop'), /Sharing is off/);
    await until(() => guest.toasts.includes(`${me} ended the sharing`), 'the teammate to hear it ended', 20_000);
    assert.deepEqual(guest.remote.chips(), []);
    assert.equal(await host.remote.syncNow(), 'This session is not shared. /share invites a teammate.');
  },
);

test('oms join says what is wrong with a bad link and asks nothing of anyone', async () => {
  const said: string[] = [];
  const deps = {
    folder: '/',
    stateRoot: '/nowhere',
    name: 'akshat',
    log() {},
    error: (line: string) => void said.push(line),
  };
  for (const args of [[], ['not a link'], ['http://127.0.0.1:9'], ['ftp://x/#CODE']])
    assert.equal(await joinSession(args, deps), undefined);
  assert.equal(said.filter((line) => /Usage: .* join <link>/.test(line)).length, 4);
  assert.equal(await joinSession(['http://127.0.0.1:9/#CODE'], deps), undefined);
  assert.match(said.at(-1)!, /could not be reached/);
});

test('what a teammate receives is the current conversation with secrets and env files masked', () => {
  const entry = (id: string, parentId: string | null, message: unknown) =>
    ({ type: 'message', id, parentId, timestamp: 't', message }) as never;
  const branch = [
    entry('1', null, { role: 'user', content: 'deploy with GITHUB_TOKEN=ghp_' + 'b'.repeat(24) }),
    entry('2', '1', {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan', thinkingSignature: 'sig==' },
        { type: 'text', text: 'Reading the env file.' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/project/.env' } },
      ],
    }),
    entry('3', '2', {
      role: 'toolResult',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'DATABASE_URL=postgres://user:hunter2@db/prod\nPORT=8080' }],
    }),
    entry('4', '3', { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }),
  ];
  const manager = { getBranch: () => branch, getCwd: () => '/project' };
  const shared = JSON.stringify(exportEntries(manager));
  assert.equal(/ghp_b|hunter2|8080/.test(shared), false);
  assert.match(shared, /DATABASE_URL=••••/);
  assert.match(shared, /"thinkingSignature":"sig=="/, 'thinking is left exactly as it was');

  assert.deepEqual(collectItems(manager, '2'), { items: [{ who: 'agent', text: 'Done.' }], leaf: '4' });
  assert.equal(collectItems(manager, 'gone').items.length, 3, 'an unknown marker means nothing was seen');
  assert.match(syncNote('akshat', [{ who: 'user', text: 'hi' }]), /^Session sync: what akshat[\s\S]*\n\nakshat: hi$/);
  assert.throws(() =>
    writeJoinedSession('/nowhere', '/x', { entries: [{ type: 'session', id: 'x', parentId: null }], host: 'h' }),
  );
  assert.throws(() => writeJoinedSession('/nowhere', '/x', { entries: 'nope', host: 'h' }));
});
