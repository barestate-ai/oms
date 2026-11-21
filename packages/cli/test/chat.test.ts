import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { DEFAULT_BUDGET_CAPS } from '@oms/core';
import { defaultHarnessEnvironment, openBudgetJournal, resolveChatFolder, type ChatSession } from '@oms/engine';
import { chooseChatSession, runInteractiveChat } from '../src/chat.ts';
import { parseLaunchOptions } from '../src/harness.ts';
import { YOLO_NOTICE } from '../src/tui/ui-commands.ts';

function setup(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-chat-cli-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const stateRoot = join(base, 'state');
  const project = join(base, 'my-project');
  mkdirSync(stateRoot);
  mkdirSync(project);
  const folder = resolveChatFolder(project, { stateRoot });
  const sessions = join(stateRoot, 'folders', folder.key, 'sessions');
  mkdirSync(join(stateRoot, 'folders', folder.key), { recursive: true, mode: 0o700 });
  mkdirSync(sessions, { mode: 0o700 });
  return { base, stateRoot, project, folder, sessions };
}

/** A saved conversation with its budget journal, as a closed chat leaves them. */
function saveConversation(f: ReturnType<typeof setup>, caps = DEFAULT_BUDGET_CAPS) {
  const manager = SessionManager.create(f.folder.path, f.sessions);
  manager.appendMessage({ role: 'user', content: 'Remember this.', timestamp: 1 });
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'Noted.' }],
    api: 'openai-completions',
    provider: 'p',
    model: 'm',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 2,
  });
  const id = manager.getSessionId();
  const journal = join(f.sessions, `${id}.budget.jsonl`);
  openBudgetJournal({ path: journal, caps, clock: Date.now }).close();
  return { id, journal };
}

const launch = parseLaunchOptions([]);

test('a folder with no saved conversation opens a new one without asking', async (t) => {
  const f = setup(t);
  const selected = await chooseChatSession(f.folder, f.stateRoot, launch, async () => assert.fail('no question'));
  assert.deepEqual(selected, {});
});

test('a saved conversation with a usable budget is resumed without asking', async (t) => {
  const f = setup(t);
  const saved = saveConversation(f);
  const before = readFileSync(saved.journal, 'utf8');
  const selected = await chooseChatSession(f.folder, f.stateRoot, launch, async () => assert.fail('no question'));
  assert.deepEqual(selected, { sessionId: saved.id });
  assert.equal(readFileSync(saved.journal, 'utf8'), before);
});

test('an unusable saved budget needs explicit consent for a new session and is never reset', async (t) => {
  const f = setup(t);
  const saved = saveConversation(f);
  writeFileSync(saved.journal, '{"type":"budget_open"', { mode: 0o600 });
  assert.equal(await chooseChatSession(f.folder, f.stateRoot, launch, async () => undefined), undefined);
  const asked: string[] = [];
  const renewed = await chooseChatSession(f.folder, f.stateRoot, launch, async (message) => {
    asked.push(message);
    return 'new';
  });
  assert.deepEqual(renewed, {});
  assert.match(asked[0]!, /hit its usage limit or has unconfirmed charges/);
  assert.match(asked[0]!, /Your history is kept/);
  assert.doesNotMatch(asked[0]!, /admit|reconcil|journal|accounting/i);
  assert.equal(readFileSync(saved.journal, 'utf8'), '{"type":"budget_open"');
});

function fakeChat(folder: ChatSession['folder'], log: string[]): ChatSession {
  return {
    kind: 'chat',
    folder,
    root: folder.path,
    async close() {
      log.push('close');
    },
  } as unknown as ChatSession;
}

async function capture(action: () => Promise<void>): Promise<string> {
  const write = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array) => (
    (out += String(chunk)),
    true
  )) as typeof process.stdout.write;
  try {
    await action();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

test('the chat opens the given folder, names it in the header, and tells the user how to continue', async (t) => {
  const f = setup(t);
  const saved = saveConversation(f);
  const log: string[] = [];
  const opened: Array<Record<string, unknown>> = [];
  const out = await capture(() =>
    runInteractiveChat({
      folder: f.project,
      stateRoot: f.stateRoot,
      environment: defaultHarnessEnvironment(),
      launch,
      start: async (options) => {
        opened.push(options as unknown as Record<string, unknown>);
        return fakeChat(options.folder, log);
      },
      run: async (chat) => {
        log.push(`run ${chat.kind}`);
      },
    }),
  );
  assert.equal((opened[0]!.folder as { path: string }).path, f.project);
  assert.equal(opened[0]!.stateRoot, f.stateRoot);
  assert.equal(opened[0]!.sessionId, saved.id);
  assert.deepEqual(log, ['run chat', 'close']);
  assert.equal(out, 'Run oms in this folder to continue.\n');
});

test('opening a saved conversation says so once, with its message count; a new one does not', async (t) => {
  const f = setup(t);
  const notes: Array<string | undefined> = [];
  const open = () =>
    capture(() =>
      runInteractiveChat({
        folder: f.project,
        stateRoot: f.stateRoot,
        environment: defaultHarnessEnvironment(),
        launch,
        start: async (options) =>
          ({
            ...fakeChat(options.folder, []),
            session: { messages: options.sessionId ? [{}, {}, {}] : [] },
          }) as unknown as ChatSession,
        run: async (_chat, interfaceOptions) => {
          notes.push(interfaceOptions?.startNote);
        },
      }),
    );
  await open();
  saveConversation(f);
  await open();
  assert.deepEqual(notes, [undefined, 'resumed · 3 messages · /clear for new']);
});

test('an npx chat prints an npx continuation command after closing', async (t) => {
  const previous = process.env.npm_command;
  process.env.npm_command = 'exec';
  t.after(() => {
    if (previous === undefined) delete process.env.npm_command;
    else process.env.npm_command = previous;
  });
  const f = setup(t);
  const log: string[] = [];
  const out = await capture(() =>
    runInteractiveChat({
      folder: f.project,
      stateRoot: f.stateRoot,
      environment: defaultHarnessEnvironment(),
      launch,
      start: async (options) => fakeChat(options.folder, log),
      run: async () => {
        log.push('run');
      },
    }),
  );
  assert.deepEqual(log, ['run', 'close']);
  assert.equal(out, 'Run npx @barestate/oms in this folder to continue.\n');
});

test('--yolo reaches the session, and without it YOLO is off', async (t) => {
  const f = setup(t);
  const opened: Array<Record<string, unknown>> = [];
  const notes: Array<string | undefined> = [];
  for (const yolo of [true, undefined]) {
    await capture(() =>
      runInteractiveChat({
        folder: f.project,
        stateRoot: f.stateRoot,
        environment: defaultHarnessEnvironment(),
        launch,
        yolo,
        start: async (options) => {
          opened.push(options as unknown as Record<string, unknown>);
          return fakeChat(options.folder, []);
        },
        run: async (_chat, interfaceOptions) => {
          notes.push(interfaceOptions?.startNote);
        },
      }),
    );
  }
  assert.equal(opened[0]!.yolo, true);
  assert.equal(opened[1]!.yolo, undefined);
  assert.deepEqual(notes, [YOLO_NOTICE, undefined]);
  assert.equal(YOLO_NOTICE, 'YOLO on · commands run without approval or sandbox · /yolo to turn off');
});

test('a folder that holds personal files opens a scratch folder and says so in the interface', async (t) => {
  const f = setup(t);
  const log: string[] = [];
  let scratch = '';
  let note: string | undefined;
  await capture(() =>
    runInteractiveChat({
      folder: f.stateRoot,
      stateRoot: f.stateRoot,
      environment: defaultHarnessEnvironment(),
      launch,
      start: async (options) => {
        scratch = options.folder.path;
        return fakeChat(options.folder, log);
      },
      run: async (_chat, options) => {
        note = options?.startNote;
      },
    }),
  );
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  assert.equal(
    note,
    `No project here, so this chat uses a scratch folder (${scratch}). cd into a project folder and run oms to work on it.`,
  );
});

test('the chat starts with the saved theme and art and saves each change for the next launch', async (t) => {
  const f = setup(t);
  writeFileSync(join(f.stateRoot, 'tui.json'), JSON.stringify({ theme: 'nord', startupArt: '256' }));
  const seen: Array<Record<string, unknown>> = [];
  const open = () =>
    capture(() =>
      runInteractiveChat({
        folder: f.project,
        stateRoot: f.stateRoot,
        environment: defaultHarnessEnvironment(),
        launch,
        start: async (options) => fakeChat(options.folder, []),
        run: async (_chat, options) => {
          seen.push({ theme: options?.theme, background: options?.background, startupArt: options?.startupArt });
          options?.onThemeChange?.('dracula');
          options?.onStartupArtChange?.('off');
        },
      }),
    );
  await open();
  await open();
  assert.deepEqual(seen, [
    { theme: 'nord', background: 'theme', startupArt: '256' },
    { theme: 'dracula', background: 'theme', startupArt: 'off' },
  ]);
});
