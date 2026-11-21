import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { TabStrip, type TabItem } from '../src/tui/tabs.ts';
import { getTheme } from '../src/tui/theme.ts';
import { friendlyError, parsePathLine, tabLabels } from '../src/tui/workbench-text.ts';

const theme = getTheme('gruvbox')!;
function strip(items: TabItem[]) {
  return new TabStrip(() => items, { theme: () => theme, render() {} });
}
const tab = (id: string, extra: Partial<TabItem> = {}): TabItem => ({
  id,
  label: id,
  active: false,
  onSelect() {},
  ...extra,
});
const text = (strip: TabStrip, width: number) => stripTerminalSequences(strip.render(width)[0]!);
function mouse(type: TuiMouseEvent['type'], x: number, width: number): TuiMouseEvent {
  return {
    type,
    button: 'left',
    x,
    y: 0,
    screenX: x,
    screenY: 0,
    width,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
  };
}
const click = (strip: TabStrip, x: number, width: number) => {
  for (const type of ['press', 'release', 'click'] as const) strip.handleMouse(mouse(type, x, width));
};

test('the active tab is on the surface color, with a dot for unsaved changes and a cross to close', () => {
  const tabs = strip([
    tab('a.rs', { active: true, dirty: true, onClose() {} }),
    tab('b.rs', { onClose() {} }),
    tab('c.rs'),
  ]);
  const rendered = tabs.render(60)[0]!;
  assert.match(stripTerminalSequences(rendered), /^ a\.rs ● × +b\.rs × +c\.rs/);
  assert.ok(rendered.includes(`\x1b[${theme.sgr.bg.surface}m`));
  assert.ok(rendered.includes(`\x1b[${theme.sgr.fg.warning}m ●`));
});

test('tabs that do not fit scroll so the active one shows, with a count of what is hidden on each side', () => {
  const names = Array.from({ length: 8 }, (_, n) => `file${n}.rs`);
  const shown = (active: number, width: number) =>
    text(strip(names.map((name, index) => tab(name, { active: index === active, onClose() {} }))), width);
  const first = shown(0, 40);
  assert.match(first, /file0\.rs/);
  assert.match(first, /\d+›\s*$/);
  const last = shown(7, 40);
  assert.match(last, /^‹\d+/);
  assert.match(last, /file7\.rs/);
  for (const width of [1, 5, 12, 40])
    for (const active of [0, 4, 7]) assert.ok(visibleWidth(shown(active, width)) <= width);
});

test('clicking a tab selects it, clicking its cross closes it, and a drag does neither', () => {
  const log: string[] = [];
  const items = [
    tab('a.rs', { active: true, onSelect: () => log.push('select a'), onClose: () => log.push('close a') }),
    tab('b.rs', { onSelect: () => log.push('select b'), onClose: () => log.push('close b') }),
  ];
  const strip = new TabStrip(() => items, { theme: () => theme, render() {} });
  const width = 40;
  const line = stripTerminalSequences(strip.render(width)[0]!);
  const b = line.indexOf('b.rs');
  click(strip, b, width);
  assert.deepEqual(log, ['select b']);
  click(strip, line.indexOf('×', b), width);
  assert.deepEqual(log, ['select b', 'close b']);
  strip.handleMouse(mouse('press', b, width));
  strip.handleMouse(mouse('drag', b + 3, width));
  strip.handleMouse(mouse('click', b + 3, width));
  assert.equal(log.length, 2);
  assert.equal(strip.handleMouse(mouse('press', 3, 99)), undefined);
});

test('same-named files are told apart by their folder; paths and positions parse', () => {
  assert.deepEqual(
    [...tabLabels(['a/mod.rs', 'b/mod.rs', 'lib.rs', 'x/y/mod.rs'])],
    [
      ['a/mod.rs', 'a/mod.rs'],
      ['b/mod.rs', 'b/mod.rs'],
      ['lib.rs', 'lib.rs'],
      ['x/y/mod.rs', 'y/mod.rs'],
    ],
  );
  assert.deepEqual(parsePathLine('src/lib.rs:20:5'), { path: 'src/lib.rs', line: 20, column: 5 });
  assert.deepEqual(parsePathLine('src/lib.rs:20'), { path: 'src/lib.rs', line: 20 });
  assert.deepEqual(parsePathLine('lib.rs'), { path: 'lib.rs' });
  assert.deepEqual(parsePathLine(':12'), { path: ':12' });
});

test('engine errors become short wording that never shows a host path', () => {
  const root = '/Users/dev/secret-project';
  const cases: Array<[string, RegExp]> = [
    ['Binary task files are unavailable in this text editor', /logo\.png is a binary file/],
    ['read requires a regular file no larger than 64 KiB', /larger than 64 KiB/],
    ['Task file requires valid UTF-8', /isn't valid UTF-8/],
    ['Directory exceeds the 512-entry listing limit; open a file by path', /more than 512 entries/],
    ['Stop the host terminal before running task tools', /\/terminal stop/],
    ['file changed after the edit read; read it again', /changed on disk.*Ctrl\+R/],
    ['File already exists; open it or choose a different new-file path', /already exists/],
    ['pinned verifier files are not writable', /part of the task's checks/],
    ['path is outside the admitted task files', /outside the project/],
    [`ENOENT: no such file or directory, open '${root}/src/lib.rs'`, /doesn't exist/],
    [`EACCES: permission denied, open '${root}/x'`, /isn't readable or writable/],
    [
      `Something odd happened at ${root}/src/lib.rs and /private/var/folders/zz/abc`,
      /^Something odd happened at src\/lib\.rs and a file$/,
    ],
  ];
  for (const [message, pattern] of cases) {
    const result = friendlyError(new Error(message), { path: 'assets/logo.png', root });
    assert.match(result, pattern, message);
    assert.doesNotMatch(result, /secret-project|\/Users|\/private/);
  }
  assert.ok(friendlyError(new Error('x'.repeat(500))).length <= 160);
  assert.equal(friendlyError('plain string', {}), 'plain string');
});
