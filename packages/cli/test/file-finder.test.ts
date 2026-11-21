import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import { FileFinder } from '../src/tui/file-finder.ts';
import type { ProjectIndex } from '../src/tui/search.ts';
import { getTheme } from '../src/tui/theme.ts';

const FILES = [
  'Anchor.toml',
  'programs/vault/src/lib.rs',
  'programs/vault/Cargo.toml',
  'src/lib.rs',
  'tests/vault.ts',
  'README.md',
];
function finder(
  options: {
    search?: (
      query: string,
    ) => Promise<{ matches: Array<{ path: string; line: number; column: number; text: string }>; note?: string }>;
  } = {},
) {
  const log: string[] = [];
  const searches: string[] = [];
  const index = {
    list: async () => FILES,
    search: async (query: string) => {
      searches.push(query);
      return options.search ? options.search(query) : { matches: [] };
    },
  } as unknown as ProjectIndex;
  let lines: number | undefined = 120;
  const f = new FileFinder({
    theme: () => getTheme('gruvbox')!,
    render() {},
    index,
    marks: () => new Map([['src/lib.rs', 'M']]),
    recent: () => ['tests/vault.ts'],
    openFile: (path, line, column) => log.push(`open ${path}${line ? `:${line}` : ''}${column ? `:${column}` : ''}`),
    goToLine: (line, column) => {
      log.push(`goto ${line}${column ? `:${column}` : ''}`);
      return true;
    },
    lineCount: () => lines,
    commands: () => log.push('commands'),
    closed: () => log.push('closed'),
    rows: () => 30,
  });
  const screen = (width = 80) => stripTerminalSequences((f.view.render(width) as string[]).join('\n'));
  const type = (text: string) => [...text].forEach((character) => f.handleInput(character));
  return { f, log, searches, screen, type, setLines: (value: number | undefined) => (lines = value) };
}

test('an empty field lists recent files first, then the rest; the card stays inside its width', async () => {
  const { f, screen } = finder();
  f.show();
  await setImmediate();
  const shown = screen(60);
  const rows = shown.split('\n');
  assert.match(rows[0]!, /^╭ Open /);
  assert.match(rows[1]!, /^│ ❯ /);
  assert.match(rows[2]!, /› tests\/vault\.ts\s+recent/);
  assert.match(rows.at(-1)!, /╯$/);
  assert.match(rows.at(-1)!, /6 of 6 files/);
  assert.ok(rows.every((row) => visibleWidth(row) <= 60));
  assert.deepEqual(f.view.render(5), [], 'too narrow to draw');
});

test('typing ranks files fuzzily, shows change marks, and Enter opens the highlighted file', async () => {
  const { f, log, screen, type } = finder();
  f.show();
  await setImmediate();
  type('lib');
  const rows = screen().split('\n');
  assert.match(rows[2]!, /› src\/lib\.rs\s+M/);
  assert.match(rows[3]!, /programs\/vault\/src\/lib\.rs/);
  f.handleInput('\x1b[B');
  f.handleInput('\r');
  assert.deepEqual(log, ['closed', 'open programs/vault/src/lib.rs']);
  assert.equal(f.open, false);
});

test('path:line opens the file at that line', async () => {
  const { f, log, type } = finder();
  f.show();
  await setImmediate();
  type('vault.ts:41:7');
  f.handleInput('\r');
  assert.deepEqual(log, ['closed', 'open tests/vault.ts:41:7']);
});

test(': jumps to a line of the active file, and says so when no file is open', async () => {
  const { f, log, screen, type, setLines } = finder();
  f.show();
  await setImmediate();
  type(':42');
  assert.match(screen(), /^╭ Go to line /);
  assert.match(screen(), /› Go to line 42 of 120/);
  f.handleInput('\r');
  assert.deepEqual(log, ['closed', 'goto 42']);
  f.show(':7:3');
  assert.match(screen(), /Go to line 7, column 3/);
  setLines(undefined);
  assert.match(screen(), /open a file first/);
});

test('# searches the project after a short pause, aborting the previous query', async () => {
  const { f, log, searches, screen, type } = finder({
    search: async (query) => ({ matches: [{ path: 'src/lib.rs', line: 9, column: 5, text: `found ${query}` }] }),
  });
  f.show();
  await setImmediate();
  type('#req');
  type('uire');
  assert.deepEqual(searches, [], 'nothing runs while typing');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(searches, ['require']);
  assert.match(screen(), /src\/lib\.rs:9\s+found require/);
  assert.match(screen(), /1 match/);
  f.handleInput('\r');
  assert.deepEqual(log, ['closed', 'open src/lib.rs:9:5']);
});

test('a search that cannot run says why; no matches say so', async () => {
  const { f, screen, type } = finder({
    search: async () => ({ matches: [], note: 'Project search needs ripgrep or a git repository.' }),
  });
  f.show();
  await setImmediate();
  type('#x');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.match(screen(), /needs ripgrep or a git repository/);
  const files = finder();
  files.f.show();
  await setImmediate();
  files.type('zzzzqq');
  assert.match(files.screen(), /No file matches/);
});

test('a leading slash or Ctrl+K hands over to the command palette; Escape closes', async () => {
  const slash = finder();
  slash.f.show();
  await setImmediate();
  slash.f.handleInput('/');
  assert.deepEqual(slash.log, ['closed', 'commands']);
  const key = finder();
  key.f.show();
  key.f.handleInput('\x0b');
  assert.deepEqual(key.log, ['closed', 'commands']);
  const escape = finder();
  escape.f.show();
  escape.f.handleInput('\x1b');
  assert.deepEqual(escape.log, ['closed']);
  assert.equal(escape.f.open, false);
});

test('the card fits a short terminal and the field holds one line', async () => {
  const tall = finder();
  tall.f.show();
  await setImmediate();
  assert.ok(tall.screen().split('\n').length <= 13);
  tall.f.handleInput('\x1b[200~a\nb\x1b[201~');
  assert.ok(!tall.f.input.getValue().includes('\n'));
  assert.ok(renderLayoutFrame(tall.f.view, 40, 20, () => {}).lines.every((line) => visibleWidth(line) <= 40));
});
