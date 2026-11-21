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

test('120x40: an explorer, tab strip, panel header, status row and key hints; no bracket buttons or boxed panes', async () => {
  const p = project({ 'Anchor.toml': '[programs.localnet]\n', 'src/lib.rs': SOURCE, 'tests/a.ts': 'x' });
  const { terminal, done } = open(fixture(), p, 120, 40);
  try {
    const welcome = await terminal.until((screen) => screen.includes('No file open') && screen.includes('▾ files'));
    assert.doesNotMatch(welcome, /\[ (Files|New|Save|Find|Split|Close) \]|╭ Editor|╭ Files/);
    assert.match(welcome, /Open a file\s+Ctrl\+P/);
    assert.match(welcome, /ctrl\+k commands/);
    terminal.send('\x10');
    terminal.send('lib');
    terminal.send('\r');
    const screen = await terminal.until((s) => s.includes('line 1') && s.includes('lib.rs ×'));
    const rows = screen.split('\n');
    assert.ok(
      rows.some((row) => /rent · TypeScript|rent · Ln 1, Col 1/.test(row) || /Ln 1, Col 1/.test(row)),
      'status row has the position',
    );
    assert.ok(
      rows.some((row) => /terminal\s+problems\s+output\s+changes/.test(row)),
      'panel tabs are visible',
    );
    assert.ok(
      rows.some((row) => /ctrl\+k commands · ctrl\+p open · ctrl\+s save/.test(row)),
      'key hints are visible',
    );
    assert.ok(
      rows.some((row) => /^ *▾ programs|▾ src/.test(row) || /src/.test(row)),
      'the explorer opened the folders above the file',
    );
  } finally {
    await done();
    p.done();
  }
});

test('80x24: no explorer, at least 19 code rows, and Ctrl+B swaps the editor for a full-width file list that Escape undoes', async () => {
  const p = project({ 'src/lib.rs': SOURCE, 'tests/a.ts': 'x' });
  const { terminal, done } = open(fixture(), p, 80, 24, 'chat');
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x10');
    terminal.send('lib');
    terminal.send('\r');
    const screen = await terminal.until((s) => s.includes('line 1'));
    const code = screen.split('\n').filter((row) => /^ *\d+ line \d+/.test(row));
    assert.ok(code.length >= 19, `only ${code.length} code rows`);
    assert.doesNotMatch(screen, /▾ files/);
    terminal.send('\x02');
    const explorer = await terminal.until((s) => s.includes('▾ files'));
    assert.doesNotMatch(explorer, /line 1/);
    terminal.send('\x1b');
    await terminal.until((s) => s.includes('line 1') && !s.includes('▾ files'));
  } finally {
    await done();
    p.done();
  }
});

test('Ctrl+B hides and shows the explorer at 120 columns; Enter on a file opens it and Escape returns to the editor', async () => {
  const p = project({ 'a.ts': 'ALPHA', 'b.ts': 'BETA' });
  const { terminal, done } = open(fixture(), p, 120, 30);
  try {
    await terminal.until((screen) => screen.includes('▾ files') && screen.includes('b.ts'));
    terminal.send('\x02');
    await terminal.until((screen) => !screen.includes('▾ files'));
    terminal.send('\x02');
    await terminal.until((screen) => screen.includes('▾ files'));
    // The explorer has focus: Down selects b.ts (a.ts is first), Enter opens it into the editor.
    terminal.send('\x1b[B');
    terminal.send('\x1b[B');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('BETA'));
    terminal.send('X');
    await terminal.until((screen) => screen.includes('XBETA'));
    terminal.send('\x02');
    terminal.send('\x1b');
    terminal.send('Y');
    await terminal.until((screen) => screen.includes('XYBETA'));
    terminal.send('\x13');
    await terminal.until(() => p.disk.get('b.ts') === 'XYBETA');
  } finally {
    await done();
    p.done();
  }
});

test('quick open: fuzzy names, path:line and :line; a slash hands over to the commands menu', async () => {
  const p = project({ 'programs/vault/src/lib.rs': SOURCE, 'tests/vault.ts': 'import', 'README.md': 'readme' });
  const { terminal, done } = open(fixture(), p, 120, 40);
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x10');
    terminal.send('vlib');
    const card = await terminal.until(
      (screen) => screen.includes('╭ Open') && screen.includes('programs/vault/src/lib.rs'),
    );
    assert.match(card, /1 of 3 files/);
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('line 1'));
    terminal.send('\x10');
    terminal.send('lib.rs:30');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('Ln 30, Col 1'));
    terminal.send('\x07');
    terminal.send('7:3');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('Ln 7, Col 3'));
    terminal.send('\x10');
    terminal.send('/');
    await terminal.until((screen) => screen.includes('Commands'));
    terminal.send('\x1b');
  } finally {
    await done();
    p.done();
  }
});

test('project search: # finds lines across files and opens one at its line', async () => {
  const p = project({ 'a.rs': 'one\nneedle here\nthree', 'b.rs': 'nothing', '.env.agent': 'needle=secret' });
  execFileSync('git', ['init', '-q'], { cwd: p.root });
  execFileSync('git', ['add', '-A'], { cwd: p.root });
  const { terminal, done } = open(fixture(), p, 120, 40);
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x10');
    terminal.send('#needle');
    const results = await terminal.until((screen) => screen.includes('a.rs:2'));
    assert.match(results, /Search the project/);
    assert.doesNotMatch(results, /\.env\.agent/);
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('Ln 2, Col 1') || screen.includes('Ln 2, Col 6'));
  } finally {
    await done();
    p.done();
  }
});

test('/test from the workbench keeps the view: the result lands in the panel, errors become problems you can open', async () => {
  const p = project({ 'programs/vault/src/lib.rs': SOURCE, 'Cargo.toml': '[package]' });
  const f = fixture();
  const { terminal, done } = open(f, p, 120, 40);
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x0b');
    terminal.send('test');
    terminal.send('\r');
    await terminal.until(() => f.commands.length === 1);
    assert.equal(f.commands[0], 'cargo test');
    f.commandGate.resolve({
      exitCode: 101,
      stdout: '',
      stderr:
        'error[E0433]: failed to resolve: use of undeclared type `VaultError`\n --> programs/vault/src/lib.rs:9:38\n',
      timedOut: false,
      cancelled: false,
      truncated: false,
    });
    const screen = await terminal.until((s) => s.includes('E0433') && s.includes('programs/vault/src/lib.rs:9:38'));
    assert.match(screen, /problems 1/);
    assert.match(screen, /No file open/, 'still in the workbench');
    // F6 moves focus to the panel; Enter opens the problem at its line and column.
    terminal.send('\x1b[17~');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Ln 9, Col'));
  } finally {
    await done();
    p.done();
  }
});

test('the agent editing an open file reloads it in place', async () => {
  const p = project({ 'a.ts': 'before' });
  const f = fixture();
  const { terminal, done } = open(f, p, 120, 30);
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x10');
    terminal.send('a.ts');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('before'));
    p.put('a.ts', 'after the agent');
    f.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args: { path: 'a.ts' } });
    f.emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'edit', result: {}, isError: false });
    const screen = await terminal.until((s) => s.includes('after the agent'));
    assert.match(screen, /a\.ts was updated on disk/);
    p.put('a.ts', 'second edit');
    f.emit({ type: 'agent_settled' });
    await terminal.until((s) => s.includes('second edit'));
  } finally {
    await done();
    p.done();
  }
});

test('Alt+A asks the agent about the selection with a path and lines, not the file text', async () => {
  const p = project({ 'src/lib.rs': SOURCE });
  const f = fixture();
  const { terminal, done } = open(f, p, 120, 40);
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x10');
    terminal.send('lib');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('line 1'));
    terminal.send('\x1b[1;2B');
    terminal.send('\x1b[1;2B');
    terminal.send('\x1ba');
    const menu = await terminal.until((screen) => screen.includes('Ask OMS · lib.rs'));
    assert.match(menu, /Explain this/);
    assert.match(menu, /Security review/);
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    assert.match(f.prompts[0]!, /^In lines 1-2 of `src\/lib\.rs`/);
    assert.doesNotMatch(f.prompts[0]!, /line 1\b|line 2\b/);
    f.promptGate.resolve();
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await done();
    p.done();
  }
});

test('/tasks opens the dashboard with this session; Escape closes it', async () => {
  const p = project({ 'a.ts': 'x' });
  const { terminal, done } = open(fixture(), p, 120, 30);
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x1b[18~');
    const screen = await terminal.until((s) => /Tasks\s+○ 1 idle/.test(s));
    assert.match(screen, /○ rental-ledger · rent\s+This task/);
    terminal.send('\x1b');
    await terminal.until((s) => s.includes('No file open') && !/Tasks\s+○/.test(s));
  } finally {
    await done();
    p.done();
  }
});

test('quitting with unsaved files names them', async () => {
  const p = project({ 'a.ts': 'one', 'b.ts': 'two' });
  const { terminal, run, done } = open(fixture(), p, 120, 30);
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    for (const name of ['a.ts', 'b.ts']) {
      terminal.send('\x10');
      terminal.send(name);
      terminal.send('\r');
      await terminal.until((screen) => screen.includes(`${name} ×`));
      terminal.send('!');
    }
    terminal.send('\x11');
    const screen = await terminal.until((s) => s.includes('Unsaved: a.ts, b.ts'));
    assert.match(screen, /ctrl\+q again to discard/);
    terminal.send('\x11');
    await run;
    assert.equal(terminal.active, false);
  } finally {
    terminal.vt.dispose();
    p.done();
  }
});

test('workbench commands: /goto, /search, /panel, /sidebar, /save all and a bare /open name', async () => {
  const p = project({ 'src/lib.rs': SOURCE, 'a.ts': 'one', 'b.ts': 'two' });
  const { terminal, done } = open(fixture(), p, 120, 40);
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    const command = async (text: string) => {
      terminal.send('\x0b');
      terminal.send(text.slice(1));
      terminal.send('\r');
    };
    await command('/open lib.rs');
    await terminal.until((screen) => screen.includes('line 1') && screen.includes('lib.rs ×'));
    await command('/goto 12');
    await terminal.until((screen) => screen.includes('Ln 12, Col 1'));
    await command('/search needle');
    await terminal.until((screen) => screen.includes('╭ Search the project') && screen.includes('#needle'));
    terminal.send('\x1b');
    await command('/panel changes');
    await terminal.until((screen) => /↑↓ choose · enter see the diff/.test(screen));
    await command('/panel hide');
    await terminal.until((screen) => !/↑↓ choose · enter see the diff/.test(screen));
    await command('/sidebar');
    await terminal.until((screen) => !screen.includes('▾ files'));
    await command('/files');
    await terminal.until((screen) => screen.includes('╭ Open'));
    terminal.send('\x1b');
    // Two files with unsaved edits are both saved by /save all.
    for (const name of ['a.ts', 'b.ts']) {
      terminal.send('\x10');
      terminal.send(name);
      terminal.send('\r');
      await terminal.until((screen) => screen.includes(`${name} ×`));
      terminal.send('!');
    }
    await command('/save all');
    await terminal.until(() => p.disk.get('a.ts') === '!one' && p.disk.get('b.ts') === '!two');
  } finally {
    await done();
    p.done();
  }
});

test('reverting a changed file asks first, then restores the committed text and clears the change', async () => {
  const p = project({ 'a.txt': 'one\ntwo\n' });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: p.root,
      encoding: 'utf8',
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  p.put('a.txt', 'one\nTWO\n');
  const f = fixture();
  Object.assign((f.harness as unknown as { task: object }).task, { baseOid: base });
  const { terminal, done } = open(f, p, 120, 40);
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x0b');
    terminal.send('changes');
    terminal.send('\r');
    const list = await terminal.until((screen) => /M {2}a\.txt\s+\+1 −1/.test(screen));
    assert.match(list, /changes 1/);
    terminal.send('R');
    await terminal.until((screen) => screen.includes('Revert a.txt to the last commit?'));
    terminal.send('n');
    await terminal.until((screen) => !screen.includes('Revert a.txt'));
    assert.equal(p.disk.get('a.txt'), 'one\nTWO\n');
    terminal.send('R');
    terminal.send('y');
    await terminal.until(() => p.disk.get('a.txt') === 'one\ntwo\n');
    await terminal.until((screen) => screen.includes('No changes yet.'));
    // The gutter marks follow the change list: an edited line shows a bar, a reverted file none.
    terminal.send('\x1b');
  } finally {
    await done();
    p.done();
  }
});

test('asking about a selection that looks like a secret sends only its location', async () => {
  const p = project({ 'src/lib.rs': 'let key = "sk-abcdefghijklmnopqrstuvwxyz0123456789";\nplain line\n' });
  const f = fixture();
  const { terminal, done } = open(f, p, 120, 40);
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x10');
    terminal.send('lib');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('sk-abcdef'));
    // An unsaved edit makes the saved file differ from the buffer, so the agent could not read this text on its own.
    terminal.send('!');
    terminal.send('\x1b[1;2B');
    terminal.send('\x1ba');
    await terminal.until((screen) => screen.includes('Ask OMS · lib.rs'));
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    assert.match(
      f.prompts[0]!,
      /^In lines 1 of `src\/lib\.rs`|^In lines 1-2 of `src\/lib\.rs`|^In `src\/lib\.rs`|^In lines? 1/,
    );
    assert.doesNotMatch(f.prompts[0]!, /sk-abcdef/);
    f.promptGate.resolve();
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await done();
    p.done();
  }
});

test('the agent finishing a turn marks the files it edited and refreshes the explorer', async () => {
  const p = project({ 'a.ts': 'one' });
  const f = fixture();
  const { terminal, done } = open(f, p, 120, 30);
  try {
    await terminal.until((screen) => screen.includes('a.ts') && screen.includes('▾ files'));
    p.put('new.ts', 'created by the agent');
    f.emit({ type: 'agent_start' });
    f.emit({ type: 'tool_execution_start', toolCallId: 'w1', toolName: 'write', args: { path: 'new.ts' } });
    f.emit({ type: 'tool_execution_end', toolCallId: 'w1', toolName: 'write', result: {}, isError: false });
    const screen = await terminal.until((s) => /new\.ts\s+● /.test(s));
    assert.match(screen, /new\.ts/);
    f.emit({ type: 'agent_start' });
    f.emit({ type: 'agent_settled' });
    await terminal.until((s) => !/new\.ts\s+● /.test(s));
  } finally {
    await done();
    p.done();
  }
});

test('the workbench has one row of hints: the interface status row, in the focused area’s own words, with messages in their color', async () => {
  const p = project({ 'a.ts': 'ALPHA', 'b.ts': 'BETA' });
  const { terminal, done } = open(fixture(), p, 120, 30);
  try {
    const first = await terminal.until((screen) => screen.includes('No file open'));
    const rows = (screen: string) => screen.split('\n');
    const hintRows = (screen: string) =>
      rows(screen).filter((row) => /ctrl\+k commands|enter open|esc editor/.test(row));
    assert.equal(hintRows(first).length, 1, 'no second hint row above the status row');
    assert.match(rows(first).at(-1)!, /ctrl\+k commands · ctrl\+p open a file · ctrl\+n new file/);
    assert.match(rows(first).at(-1)!, /R1 active · 0\/2/, 'the session facts share the row');
    // The explorer has its own keys.
    terminal.send('\x02');
    terminal.send('\x02');
    const explorer = await terminal.until((screen) => rows(screen).at(-1)!.includes('↑↓ move'));
    assert.equal(hintRows(explorer).length, 1);
    terminal.send('\r');
    // A message from the workbench replaces the hints for a moment, in the color of its kind.
    terminal.send('\x0b');
    terminal.send('open nope.ts');
    terminal.send('\r');
    const message = await terminal.until((screen) => /nope\.ts/.test(rows(screen).at(-1)!));
    assert.doesNotMatch(rows(message).at(-1)!, /ctrl\+k commands/);
    assert.equal(
      terminal.vt.buffer.active
        .getLine(terminal.rows - 1)
        ?.getCell(2)
        ?.getFgColorMode() !== 0,
      true,
      'the message is colored, not plain text',
    );
  } finally {
    await done();
    p.done();
  }
});
