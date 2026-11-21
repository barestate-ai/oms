import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CURSOR_MARKER, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { getLayoutBoxesAt, getScrollViewBox, renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import { ActionBar, PaneFrame, type ActionItem } from '../src/tui/chrome.ts';
import { createFileEditorPane } from '../src/tui/file-editor.ts';
import { getTheme } from '../src/tui/theme.ts';

const theme = () => getTheme('gruvbox')!;
function mouse(type: TuiMouseEvent['type'], x: number, width = 80, y = 0): TuiMouseEvent {
  return {
    type,
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
  };
}
function click(bar: ActionBar, x: number, width = 80): void {
  bar.handleMouse(mouse('press', x, width));
  bar.handleMouse(mouse('release', x, width));
  bar.handleMouse(mouse('click', x, width));
}

test('action widths and hitboxes track Unicode cells and never activate clipped labels', () => {
  for (const width of [1, 8, 40, 80]) {
    const calls: string[] = [];
    const bar = new ActionBar(
      () => [
        { id: 'a', label: '界é', onPress: () => calls.push('a') },
        { id: 'b', label: 'Run', onPress: () => calls.push('b') },
      ],
      { theme, render() {} },
    );
    const frame = renderLayoutFrame(bar, width, 1, () => {});
    assert.ok(frame.lines.every((line) => visibleWidth(line) <= width));
    click(bar, 1, width);
    assert.deepEqual(calls, width >= 7 ? ['a'] : []);
    click(bar, 7, width); // separator, not an action
    assert.equal(calls.length, width >= 7 ? 1 : 0);
  }
});

test('focus, active state, disabled actions and Escape have keyboard equivalents', () => {
  const calls: string[] = [];
  let escaped = 0;
  const items: ActionItem[] = [
    { id: 'a', label: 'Open', active: true, onPress: () => calls.push('a') },
    { id: 'b', label: 'Save', disabled: true, onPress: () => calls.push('b') },
    { id: 'c', label: 'Close', onPress: () => calls.push('c') },
  ];
  const bar = new ActionBar(() => items, {
    theme,
    render() {},
    onEscape() {
      escaped++;
    },
  });
  bar.render(80);
  bar.handleInput('\r');
  assert.deepEqual(calls, []);
  bar.focused = true;
  // Keyboard focus is the raised-surface background; underline is for links only.
  assert.match(bar.render(80)[0]!, /\x1b\[48;/);
  assert.doesNotMatch(bar.render(80)[0]!, /\x1b\[4m/);
  bar.handleInput('\t');
  bar.render(80);
  bar.handleInput(' ');
  bar.handleInput('\x1b');
  assert.deepEqual(calls, ['c']);
  assert.equal(escaped, 1);
  click(bar, 11);
  assert.deepEqual(calls, ['c']);
});

test('pointer activation occurs once after click, cancels drag and stale resize gestures', () => {
  let count = 0;
  const bar = new ActionBar(
    () => [
      {
        id: 'a',
        label: 'Open',
        onPress() {
          count++;
        },
      },
    ],
    { theme, render() {} },
  );
  bar.render(80);
  assert.equal(bar.handleMouse(mouse('press', 2))?.focus, false);
  assert.equal(bar.focused, false);
  assert.equal(count, 0);
  bar.handleMouse(mouse('release', 2));
  assert.equal(count, 0);
  bar.handleMouse(mouse('click', 2));
  bar.handleMouse(mouse('click', 2));
  assert.equal(count, 1);
  bar.handleMouse(mouse('press', 2));
  bar.handleMouse(mouse('drag', 3));
  bar.handleMouse(mouse('release', 2));
  bar.handleMouse(mouse('click', 2));
  assert.equal(count, 1);
  bar.handleMouse(mouse('press', 2));
  bar.render(1);
  bar.handleMouse(mouse('release', 2, 1));
  bar.handleMouse(mouse('click', 2, 1));
  assert.equal(count, 1);
  bar.render(80);
  click(bar, 2, 1); // event bounds already changed before next render
  assert.equal(count, 1);
});

test('overflowing tabs keep their viewport through press and render until successful activation', () => {
  const calls: string[] = [];
  let active = 'd';
  const bar = new ActionBar(
    () =>
      ['a', 'b', 'c', 'd'].map((id) => ({
        id,
        label: `Tab ${id}`,
        active: id === active,
        onPress() {
          calls.push(id);
          active = id;
        },
      })),
    { theme, render() {} },
  );
  const before = bar.render(19);
  assert.match(before[0]!, /Tab c.*Tab d/);
  bar.handleMouse(mouse('press', 2, 19));
  assert.deepEqual(bar.render(19), before, 'press must not scroll the tab under the pointer');
  bar.handleMouse(mouse('release', 2, 19));
  assert.deepEqual(bar.render(19), before, 'release alone must not change the viewport');
  bar.handleMouse(mouse('click', 2, 19));
  assert.deepEqual(calls, ['c']);
  assert.match(bar.render(19)[0]!, /Tab b.*Tab c/);
});

test('active tabs stay visible and unsafe labels cannot add lines, OSC or backgrounds', () => {
  let active = false;
  const bar = new ActionBar(
    () => [
      { id: 'a', label: 'First tab', onPress() {} },
      { id: 'b', label: '界\n\x1b]52;c;secret\x07', active, onPress() {} },
    ],
    { theme, render() {} },
  );
  bar.render(40);
  active = true;
  const rows = bar.render(8);
  assert.equal(rows.length, 1);
  assert.match(rows[0]!, /界/);
  assert.doesNotMatch(rows[0]!, /\x1b\]|\x1b\[48[;:]|[\r\n]/);
  assert.ok(visibleWidth(rows[0]!) <= 8);
});

test('pane frames preserve actual scroll layout, cursor and compact content at every width', () => {
  for (const width of [1, 8, 40, 80]) {
    let rows = 20;
    let focused = true;
    let currentTheme = theme();
    let focusedByPointer = 0;
    const editor = createFileEditorPane('first\n' + 'text\n'.repeat(30), () => {});
    editor.focus.focused = true;
    const pane = new PaneFrame(editor.view, {
      theme: () => currentTheme,
      title: () => '界 Editor',
      focused: () => focused,
      rows: () => rows,
      compact: () => rows <= 12,
      onFocus() {
        focusedByPointer++;
      },
    });
    let frame = renderLayoutFrame(pane, width, rows, () => {});
    const box = getScrollViewBox(frame, editor.view);
    assert.ok(box);
    assert.ok(box.rect.width >= 1);
    assert.ok(frame.lines.every((line) => visibleWidth(line) <= width));
    assert.ok(frame.lines.some((line) => line.includes(CURSOR_MARKER)));
    if (width >= 8) {
      assert.match(frame.lines[0]!, /╭/);
      const titleBox = getLayoutBoxesAt(frame, 1, 0)[0]!;
      titleBox.component.handleMouse?.(mouse('click', 1, titleBox.rect.width));
      assert.equal(focusedByPointer, 1);
      focused = false;
      currentTheme = getTheme('nord')!;
      const next = renderLayoutFrame(pane, width, rows, () => {});
      assert.notEqual(next.lines[0], frame.lines[0]);
    }
    editor.view.scrollTo(3);
    frame = renderLayoutFrame(pane, width, rows, () => {});
    assert.equal(editor.view.scrollTop, 3);
    rows = 12;
    frame = renderLayoutFrame(pane, width, rows, () => {});
    assert.equal(getScrollViewBox(frame, editor.view)!.rect.height, 12);
    assert.equal(getScrollViewBox(frame, editor.view)!.rect.width, width);
    assert.doesNotMatch(frame.lines.join(''), /[╭╮╰╯│]|\x1b\[48[;:]/);
  }
});
