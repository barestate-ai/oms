import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TaskFileAccess } from '@oms/engine';
import { chatFixture, fixture, type FakeSession } from '../test-support/fake-session.ts';
import { runOmsInterface } from '../src/tui/interface.ts';
import { InterfaceTerminal } from '../test-support/interface-terminal.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
/** A project on disk (a real folder, so quick open and search can use git and ripgrep) behind the task-files interface. */
function project(initial: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'oms-ide-'));
  const disk = new Map<string, string>();
  const put = (name: string, text: string) => {
    disk.set(name, text);
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  };
  for (const [name, text] of Object.entries(initial)) put(name, text);
  const listed: string[] = [];
  const files: TaskFileAccess = {
    async list(path = '.') {
      listed.push(path);
      const prefix = path === '.' ? '' : path + '/';
      const entries = new Map<string, 'file' | 'directory'>();
      for (const key of disk.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        entries.set(prefix + rest.split('/')[0]!, rest.includes('/') ? 'directory' : 'file');
      }
      return [...entries].map(([path, kind]) => ({ path, kind }));
    },
    async read(path) {
      const text = disk.get(path);
      if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${root}/${path}'`);
      return { bytes: Buffer.from(text), revision: digest(text) };
    },
    async write(path, bytes, revision) {
      if (revision !== digest(disk.get(path) ?? '')) throw new Error('file changed after the edit read');
      const text = Buffer.from(bytes).toString('utf8');
      put(path, text);
      return digest(text);
    },
    async create(path, bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      put(path, text);
      return digest(text);
    },
    async access() {},
    async makeDirectory() {},
  };
  return { root, disk, put, files, listed, done: () => rmSync(root, { recursive: true, force: true }) };
}
function open(
  f: FakeSession,
  p: ReturnType<typeof project>,
  columns: number,
  rows: number,
  kind: 'task' | 'chat' = 'task',
) {
  const session = kind === 'chat' ? chatFixture() : f;
  Object.assign(session.harness, { files: p.files, root: p.root });
  if (kind === 'task') Object.assign((session.harness as unknown as { task: object }).task, { codeRoot: p.root });
  const terminal = new InterfaceTerminal(columns, rows);
  const run = runOmsInterface(session.harness, { terminal, view: 'workbench' });
  // A failing test may leave unsaved files: the second Ctrl+Q confirms the discard so the run always ends.
  const done = async () => {
    terminal.send('\x11');
    const timer = setTimeout(() => terminal.send('\x11'), 300);
    try {
      await run;
    } finally {
      clearTimeout(timer);
      terminal.vt.dispose();
    }
  };
  return { session, terminal, run, done };
}
const SOURCE = Array.from({ length: 60 }, (_, n) => `line ${n + 1}`).join('\n');
const key = { f6: '\x1b[17~', ctrlB: '\x02', altJ: '\x1bj' };

test('80 columns: with the explorer over the editor, F6 and typing never reach the hidden editor', async () => {
  const p = project({ 'README.md': 'hello', 'src/lib.rs': SOURCE });
  const { terminal, done } = open(fixture(), p, 80, 30, 'chat');
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x10');
    terminal.send('README');
    terminal.send('\r');
    await terminal.until((s) => s.includes('hello'));
    terminal.send(key.ctrlB);
    await terminal.until((s) => s.includes('▾ files'));
    terminal.send(key.f6);
    // The only other place for keys is the composer, which is drawn: the editor underneath is skipped.
    terminal.send('zzz');
    const screen = await terminal.until((s) => s.includes('❯ zzz'));
    assert.doesNotMatch(screen, /●/, 'nothing in the open list is marked unsaved');
    terminal.send('\x01');
    terminal.send('\x7f');
    terminal.send(key.f6);
    terminal.send(key.ctrlB);
    const back = await terminal.until((s) => s.includes('hello') && !s.includes('▾ files'));
    assert.doesNotMatch(back, /zzz|●/, 'the editor was not edited while it was hidden');
    assert.equal(p.disk.get('README.md'), 'hello');
  } finally {
    await done();
    p.done();
  }
});

test('narrowing the window below 100 columns while the editor has focus does not leave typing in a hidden buffer', async () => {
  const p = project({ 'README.md': 'hello', 'src/lib.rs': SOURCE });
  const { terminal, done } = open(fixture(), p, 120, 30, 'chat');
  try {
    await terminal.until((screen) => screen.includes('▾ files'));
    terminal.send(key.ctrlB);
    await terminal.until((s) => !s.includes('▾ files'));
    terminal.send(key.ctrlB);
    await terminal.until((s) => s.includes('▾ files'));
    terminal.send('\x10');
    terminal.send('README');
    terminal.send('\r');
    await terminal.until((s) => s.includes('hello'));
    terminal.setSize(90, 30);
    // At 90 columns the explorer (pinned open) covers the whole editor area.
    await terminal.until((s) => s.includes('▾ files') && !s.includes('1 hello'));
    terminal.send('QQQ');
    await terminal.screen();
    terminal.setSize(120, 30);
    const screen = await terminal.until((s) => s.includes('hello'));
    assert.doesNotMatch(screen, /QQQ/, 'the keys did not go to the editor while the explorer covered it');
  } finally {
    await done();
    p.done();
  }
});

test('on a 15-row terminal an open panel takes the body, and F6 stays on what is drawn', async () => {
  const p = project({ 'README.md': 'hello' });
  const { terminal, done } = open(fixture(), p, 100, 15, 'chat');
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send(key.altJ);
    await terminal.until((s) => /terminal\s+problems\s+output/.test(s) && !s.includes('No file open'));
    for (let press = 0; press < 4; press++) {
      terminal.send(key.f6);
      const screen = await terminal.screen();
      const hints = screen.split('\n').at(-1)!;
      assert.doesNotMatch(screen, /No file open/);
      assert.doesNotMatch(
        hints,
        /↑↓ move · enter open|ctrl\+s save|space preview|^ *ctrl\+k commands · ctrl\+p open/,
        `F6 ${press + 1} stopped on a hidden area`,
      );
    }
  } finally {
    await done();
    p.done();
  }
});

test('the tasks dashboard follows the session: working while a turn runs, idle when it settles', async () => {
  const p = project({ 'a.ts': 'x' });
  const f = fixture();
  const { terminal, done } = open(f, p, 120, 30);
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x1b[18~'); // F7
    await terminal.until((s) => /Tasks\s+○ 1 idle/.test(s));
    f.emit({ type: 'agent_start' });
    const working = await terminal.until((s) => /Tasks\s+● 1 working/.test(s) || /Agent working/.test(s));
    assert.match(working, /Agent working/);
    f.emit({ type: 'agent_settled', aborted: false });
    const settled = await terminal.until((s) => /Tasks\s+○ 1 idle/.test(s));
    assert.doesNotMatch(settled, /Agent working/);
  } finally {
    await done();
    p.done();
  }
});

test('80x24 workbench: with no header the key hints say how to get back to the chat', async () => {
  const p = project({ 'README.md': 'hello' });
  const { terminal, done } = open(fixture(), p, 80, 24, 'chat');
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    assert.match((await terminal.screen()).split('\n').at(-1)!, /^ *ctrl\+l chat · ctrl\+k commands/);
    terminal.send('\x10');
    terminal.send('README');
    terminal.send('\r');
    const screen = await terminal.until((s) => s.includes('hello'));
    assert.match(screen.split('\n').at(-1)!, /ctrl\+l chat/, 'and with a file open');
    terminal.send('\x0c');
    await terminal.until((s) => /❯/.test(s));
  } finally {
    await done();
    p.done();
  }
});

test('with the header on screen the hints do not repeat the chat tab', async () => {
  const p = project({ 'README.md': 'hello' });
  const { terminal, done } = open(fixture(), p, 120, 40, 'chat');
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    assert.doesNotMatch((await terminal.screen()).split('\n').at(-1)!, /ctrl\+l chat/);
  } finally {
    await done();
    p.done();
  }
});

test('/help and ? open at their first line, and the keys list says how to add a line', async () => {
  const { chatFixture, start } = await import('../test-support/fake-session.ts');
  for (const [columns, rows] of [
    [80, 24],
    [140, 42],
  ] as const) {
    const f = chatFixture();
    const { terminal, close } = start(f.harness, columns, rows);
    try {
      await terminal.until((s) => s.includes('/ commands'));
      terminal.send('?');
      const keys = await terminal.until((s) => /shift\+enter/.test(s));
      const rowsOf = keys.split('\n');
      assert.match(rowsOf.slice(0, 6).join('\n'), /Keys/i, `the list starts at its first line at ${columns}x${rows}`);
      terminal.send('/help');
      terminal.send('\r');
      const help = await terminal.until((s) => /\/model/.test(s) && /\/cancel|\/connect/.test(s));
      assert.match(
        help.split('\n').slice(0, 5).join('\n'),
        /⎿ +help[^\n]*\n +\/connect/,
        `help starts at the top at ${columns}x${rows}`,
      );
    } finally {
      await close();
    }
  }
});

test('typing in the composer shows how to send and how to add a line', async () => {
  const { chatFixture, start } = await import('../test-support/fake-session.ts');
  const f = chatFixture();
  const { terminal, close } = start(f.harness, 100, 30);
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('fix the bug');
    const screen = await terminal.until((s) => s.includes('shift+enter new line'));
    assert.match(screen.split('\n').at(-1)!, /enter send · shift\+enter new line/);
    terminal.send('\x01');
    terminal.send('\x7f');
    await terminal.until((s) => s.includes('/ commands · ? shortcuts'));
  } finally {
    await close();
  }
});

test('a closed panel strip offers ▴ show, and clicking it opens the panel', async () => {
  const { clickText } = await import('../test-support/fake-session.ts');
  const p = project({ 'README.md': 'hello' });
  const { terminal, done } = open(fixture(), p, 120, 40, 'chat');
  try {
    let screen = await terminal.until((s) => /terminal\s+problems\s+output\s+changes/.test(s));
    assert.match(screen, /▴ show/);
    assert.doesNotMatch(screen, /▾ hide/);
    clickText(terminal, screen, '▴ show');
    screen = await terminal.until((s) => /▾ hide/.test(s));
    assert.doesNotMatch(screen, /▴ show/);
    clickText(terminal, screen, '▾ hide');
    await terminal.until((s) => /▴ show/.test(s));
  } finally {
    await done();
    p.done();
  }
});

test('Ctrl+Q with a running terminal asks first, like unsaved files do', async () => {
  const p = project({ 'README.md': 'hello' });
  const f = fixture();
  let started = 0;
  Object.assign(f.harness, {
    async startTerminal() {
      started++;
      return {
        write() {},
        resize() {},
        onData: () => () => {},
        onExit: () => () => {},
        async close() {},
        kill() {},
      };
    },
  });
  const { terminal, done, run } = open(f, p, 120, 40);
  try {
    await terminal.until((s) => s.includes('No file open'));
    terminal.send('\x1bj'); // Alt+J: the panel
    terminal.send('\r'); // Enter starts the shell
    for (let wait = 0; wait < 30 && !started; wait++) await new Promise((done) => setTimeout(done, 20));
    assert.equal(started, 1, 'the shell was started');
    await terminal.screen();
    terminal.send('\x11');
    const screen = await terminal.until((s) => /Shell is running · ctrl\+q again to stop it and quit/.test(s), 3000);
    assert.match(screen, /Shell is running/);
    assert.equal(terminal.active, true, 'it did not quit on the first press');
    terminal.send('\x11');
    await run;
  } finally {
    await done().catch(() => undefined);
    p.done();
  }
});

test('Ctrl+K in the workbench floats the palette: no pane moves, no current-view command, a ❯ prompt', async () => {
  const p = project({ 'README.md': 'hello' });
  const { terminal, done } = open(fixture(), p, 140, 42, 'chat');
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    const before = (await terminal.screen()).split('\n');
    const editorRow = before.findIndex((row) => row.includes('No file open'));
    assert.ok(editorRow >= 0);
    terminal.send('\x0b');
    const screen = await terminal.until((s) => /❯ \//.test(s) && /commands · esc to close/.test(s));
    const rows = screen.split('\n');
    assert.equal(
      rows.findIndex((row) => row.includes('No file open')),
      editorRow,
      'the editor did not move',
    );
    assert.doesNotMatch(screen, /^[› ] \/workbench/m, 'the workbench is where you are');
    assert.match(screen, /\/harness +Back to chat/);
    assert.doesNotMatch(screen, /^> \//m, 'the prompt is the same ❯ as the composer');
    terminal.send('\x1b');
    await terminal.until((s) => !/commands · esc to close/.test(s));
    const after = (await terminal.screen()).split('\n');
    assert.equal(
      after.findIndex((row) => row.includes('No file open')),
      editorRow,
    );
    assert.ok(
      after.some((row) => /terminal\s+problems\s+output/.test(row)),
      'the panel strip is back',
    );
  } finally {
    await done();
    p.done();
  }
});
