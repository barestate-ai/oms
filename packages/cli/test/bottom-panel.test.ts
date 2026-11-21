import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { dispatchMouseEvent } from '@earendil-works/pi-tui/dist/tui.js';
import { getLayoutBoxesAt, renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import { ChangesStore, type FileChange } from '../src/tui/changes.ts';
import { BottomPanel, type PanelTab } from '../src/tui/bottom-panel.ts';
import { TerminalPane } from '../src/tui/terminal-pane.ts';
import { getTheme } from '../src/tui/theme.ts';

const theme = getTheme('gruvbox')!;
const change = (path: string, extra: Partial<FileChange> = {}): FileChange => ({
  path,
  status: 'M',
  added: 6,
  removed: 1,
  hunks: [],
  patch: `patch ${path}`,
  ...extra,
});
async function fixture(
  changes: FileChange[] = [change('src/lib.rs'), change('new.ts', { status: 'U', added: 0, removed: 0, patch: '' })],
) {
  const log: string[] = [];
  const store = new ChangesStore(
    async () => ({ changes }),
    () => {},
  );
  await store.refresh();
  const shell = new TerminalPane(
    {
      startTerminal: async () => {
        throw new Error('no shell in this test');
      },
    },
    { theme: () => theme, columns: () => 80, rows: () => 10, render() {}, notice() {} },
  );
  const panel = new BottomPanel({
    theme: () => theme,
    render() {},
    terminal: shell,
    changes: store,
    touched: () => new Set(['src/lib.rs']),
    openFile: (path, line, column) => log.push(`open ${path}${line ? `:${line}` : ''}${column ? `:${column}` : ''}`),
    openDiff: (item) => log.push(`diff ${item.path}`),
    openOutput: (entry) => log.push(`output ${entry.title}`),
    runCommand: (command) => log.push(`run ${command}`),
    revert: (item) => log.push(`revert ${item.path}`),
    requestFocus: (tab: PanelTab) => {
      panel.show(tab);
      log.push(`focus ${tab}`);
    },
    hide: () => log.push('hide'),
    leave: () => log.push('leave'),
  });
  panel.focus.focused = true;
  const screen = (width = 80, height = 8) =>
    renderLayoutFrame(panel.body, width, height, () => {}).lines.map((line) => stripTerminalSequences(line));
  const click = (x: number, y: number, width = 80, height = 8) => {
    const frame = renderLayoutFrame(panel.body, width, height, () => {});
    for (const type of ['press', 'release', 'click'] as const) {
      const event: TuiMouseEvent = {
        type,
        button: 'left',
        x,
        y,
        screenX: x,
        screenY: y,
        width,
        height,
        shift: false,
        alt: false,
        ctrl: false,
      };
      for (const box of getLayoutBoxesAt(frame, x, y)) {
        const result = dispatchMouseEvent(box.component, {
          ...event,
          x: x - box.rect.x,
          y: y - box.rect.y,
          width: box.rect.width,
          height: box.rect.height,
        });
        if (result) break;
      }
    }
  };
  return { panel, log, screen, click, store };
}

test('the header shows the tabs with counts and a start control; narrow widths drop inactive tabs first, never the controls', async () => {
  const { panel, screen } = await fixture();
  panel.setProblems([{ severity: 'error', message: 'bad', path: 'a.rs', line: 1 }]);
  const wide = screen(80)[0]!;
  assert.match(wide, /^─ terminal {3}problems 1 {3}output {3}changes 2 {3}─+▸ start {2}▾ hide ─$/);
  for (const width of [30, 40, 50]) {
    const header = screen(width)[0]!;
    assert.ok(visibleWidth(header) <= width);
    assert.match(header, /terminal/);
    assert.match(header, /▸ start {2}▾ hide/);
  }
  assert.doesNotMatch(screen(30)[0]!, /output/);
});

test('clicking a tab switches to it and asks for focus; clicking hide hides; the start control belongs to the terminal tab', async () => {
  const { panel, click, log, screen } = await fixture();
  const header = screen(80)[0]!;
  click(header.indexOf('changes'), 0);
  assert.equal(panel.tab, 'changes');
  assert.deepEqual(log, ['focus changes']);
  assert.doesNotMatch(screen(80)[0]!, /start/);
  click(header.indexOf('▾ hide') - 0, 0);
  assert.equal(log.at(-1), 'hide');
});

test('problems: Enter opens the file at the line and column, or runs the command for a row with no file', async () => {
  const { panel, log, screen } = await fixture();
  panel.setProblems([
    { severity: 'error', code: 'E0433', message: 'unresolved', path: 'src/lib.rs', line: 9, column: 38 },
    { severity: 'warning', message: 'unused', path: 'src/b.rs', line: 2 },
    { severity: 'error', message: 'Program error 0x1770', code: '0x1770', command: '/error 0x1770' },
  ]);
  panel.show('problems');
  const rows = screen(80);
  assert.match(rows[1]!, /× src\/lib\.rs:9:38 {2}E0433 unresolved/);
  assert.match(rows[2]!, /! src\/b\.rs:2 {2}unused/);
  panel.focus.handleInput!('\r');
  panel.focus.handleInput!('\x1b[B');
  panel.focus.handleInput!('\r');
  panel.focus.handleInput!('\x1b[B');
  panel.focus.handleInput!('\r');
  assert.deepEqual(log, ['open src/lib.rs:9:38', 'open src/b.rs:2', 'run /error 0x1770']);
});

test('output keeps the latest results, newest first: scroll, switch with the arrows, and Enter opens the text in the editor', async () => {
  const { panel, log, screen } = await fixture();
  panel.show('output');
  assert.match(screen(80).join('\n'), /No output yet\./);
  panel.pushOutput({ command: 'test', title: 'tests', text: '$ cargo test\nExit: 0\nok' });
  panel.pushOutput({ command: 'run', title: 'sandbox command', text: 'line\n'.repeat(30) + 'LAST', failed: true });
  let rows = screen(80, 6);
  assert.match(rows[1]!, /sandbox command {2}failed {2}\d\d:\d\d · 1 of 2/);
  assert.equal(rows[2]!.trim(), 'line');
  panel.focus.handleInput!('\x1b[F');
  rows = screen(80, 6);
  assert.match(rows.join('\n'), /LAST/);
  panel.focus.handleInput!('\x1b[C');
  rows = screen(80, 6);
  assert.match(rows[1]!, /tests {2}ok .* 2 of 2/);
  assert.match(rows[2]!, /\$ cargo test/);
  panel.focus.handleInput!('\r');
  assert.deepEqual(log, ['output tests']);
  for (let index = 0; index < 60; index++) panel.pushOutput({ command: 'x', title: `t${index}`, text: 'x' });
  assert.equal(panel.outputEntries.length, 50);
});

test('changes: rows show status, counts and agent edits; Enter diffs, o opens, a marks reviewed, R asks to revert', async () => {
  const { panel, log, screen, store } = await fixture();
  panel.show('changes');
  const rows = screen(80);
  assert.match(rows[1]!, /M {2}src\/lib\.rs +\+6 −1 {2}● agent/);
  assert.match(rows[2]!, /U {2}new\.ts +new/);
  panel.focus.handleInput!('\r');
  panel.focus.handleInput!('o');
  panel.focus.handleInput!('R');
  panel.focus.handleInput!('a');
  assert.deepEqual(log, ['diff src/lib.rs', 'open src/lib.rs', 'revert src/lib.rs']);
  assert.equal(store.unreviewed, 1);
  assert.match(screen(80)[1]!, /✓/);
  panel.focus.handleInput!('\x1b[B');
  panel.focus.handleInput!('R');
  assert.equal(log.at(-1), 'revert new.ts');
});

test('numbers switch tabs, Escape leaves, and an empty changes list says why', async () => {
  const { panel, log, screen } = await fixture([]);
  panel.focus.handleInput!('4');
  assert.equal(panel.tab, 'changes');
  assert.match(screen(80).join('\n'), /No changes yet\./);
  panel.focus.handleInput!('2');
  assert.equal(panel.tab, 'problems');
  assert.match(screen(80).join('\n'), /No problems found\./);
  panel.focus.handleInput!('\x1b');
  assert.equal(log.at(-1), 'leave');
});
