import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CURSOR_MARKER, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { createFileEditorPane, type FileEditorPane } from '../src/tui/file-editor.ts';

function input(pane: FileEditorPane, data: string): void {
  pane.focus.handleInput!(data);
}
function layout(pane: FileEditorPane, width: number, height: number): string[] {
  const lines = pane.focus.render(width);
  pane.view.updateLayout(lines.length, height, () => {});
  return pane.focus.render(width);
}
function mouse(type: TuiMouseEvent['type'], x: number, y: number): TuiMouseEvent {
  return {
    type,
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width: 20,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

test('bracketed multiline paste is literal, lossless and one undo transaction', () => {
  const pane = createFileEditorPane('', () => {});
  const paste = '\t[Paste #1]\r\n' + '界  \n'.repeat(12) + 'z'.repeat(1100);
  input(pane, '\x1b[200~' + paste + '\x1b[201~');
  assert.equal(pane.document.text, paste);
  input(pane, '\x1a');
  assert.equal(pane.document.text, '');
  input(pane, '\x19');
  assert.equal(pane.document.text, paste);
});

test('keyboard selection, tab, line ending and split surrogate input remain exact', () => {
  const pane = createFileEditorPane('a\r\nb', () => {});
  input(pane, '\x1b[C');
  input(pane, '\x1b[1;2C');
  assert.equal(pane.document.selectedText, '\r\n');
  input(pane, '\t');
  assert.equal(pane.document.text, 'a\tb');
  input(pane, '\r');
  input(pane, '\ud83c');
  assert.equal(pane.document.text, 'a\t\r\nb');
  input(pane, '\udf31');
  assert.equal(pane.document.text, 'a\t\r\n🌱b');
  input(pane, '\x7f');
  assert.equal(pane.document.text, 'a\t\r\nb');
});

test('vertical navigation follows display cells through tabs and wide graphemes', () => {
  const pane = createFileEditorPane('\t界x\n123456z\ne\u0301👩🏽‍💻', () => {});
  input(pane, '\x1b[C');
  input(pane, '\x1b[C');
  input(pane, '\x1b[B');
  assert.equal(pane.document.cursor, pane.document.text.indexOf('z'));
  input(pane, '\x1b[B');
  assert.equal(pane.document.cursor, pane.document.text.length);
  input(pane, '\x1b[A');
  assert.equal(pane.document.cursor, pane.document.text.indexOf('z'));
});

test('mouse selection replaces source ranges rather than expanded display spaces', () => {
  const pane = createFileEditorPane('\t界xy\r\nlast', () => {});
  layout(pane, 20, 4);
  pane.focus.handleMouse!(mouse('press', 4, 0));
  pane.focus.handleMouse!(mouse('drag', 7, 0));
  pane.focus.handleMouse!(mouse('release', 7, 0));
  assert.equal(pane.document.selectedText, '界x');
  input(pane, 'Z');
  assert.equal(pane.document.text, '\tZy\r\nlast');
});

test('pointer focus callback precedes selection and can keep a modal editor inert', () => {
  let allowed = false;
  let requests = 0;
  const pane = createFileEditorPane('alpha', () => {}, {
    requestFocus: () => {
      requests++;
      return allowed;
    },
  });
  layout(pane, 20, 4);
  pane.focus.handleMouse!(mouse('press', 3, 0));
  assert.equal(pane.document.cursor, 0);
  assert.equal(requests, 1);
  allowed = true;
  pane.focus.handleMouse!(mouse('press', 3, 0));
  assert.equal(pane.document.cursor, 3);
  input(pane, '\t');
  input(pane, '/');
  assert.equal(pane.document.text, 'alp\t/ha');
  assert.equal(requests, 2);
});

test('editing and resize reveal cursor, but intentional scrolling survives a render', () => {
  const pane = createFileEditorPane(Array.from({ length: 30 }, (_, n) => `line${n}`).join('\n'), () => {});
  pane.focus.focused = true;
  layout(pane, 12, 5);
  for (let i = 0; i < 20; i++) input(pane, '\x1b[B');
  layout(pane, 12, 5);
  assert.ok(pane.view.scrollTop <= 20 && pane.view.scrollTop + pane.view.viewportHeight > 20);
  pane.view.scrollTo(2);
  layout(pane, 12, 5);
  assert.equal(pane.view.scrollTop, 2);
  input(pane, 'x');
  layout(pane, 12, 5);
  assert.ok(pane.view.scrollTop <= 20 && pane.view.scrollTop + pane.view.viewportHeight > 20);
  layout(pane, 8, 2);
  assert.ok(pane.view.scrollTop <= 20 && pane.view.scrollTop + pane.view.viewportHeight > 20);
});

test('horizontal reveal clips safely and file escape sequences never execute', () => {
  const original = '\t界e\u0301👩🏽‍💻123456789\x1b]52;c;secret\x07';
  const pane = createFileEditorPane(original, () => {});
  pane.focus.focused = true;
  pane.document.select(original.length, original.length);
  const lines = layout(pane, 7, 2);
  assert.equal(lines.filter((line) => line.includes(CURSOR_MARKER)).length, 1);
  assert.ok(lines.every((line) => visibleWidth(line) <= 7));
  assert.ok(lines.every((line) => !line.includes('\x1b]52')));
  assert.equal(pane.document.text, original);
  pane.focus.focused = false;
  assert.ok(layout(pane, 7, 2).every((line) => !line.includes(CURSOR_MARKER)));
});

test('an oversized paste preserves the buffer, selection and existing undo history', () => {
  const pane = createFileEditorPane('original', () => {});
  input(pane, 'x');
  pane.document.select(1, 4);
  input(pane, '\x1b[200~' + '界'.repeat(64 * 1024) + '\x1b[201~');
  assert.equal(pane.document.text, 'xoriginal');
  assert.equal(pane.document.selectedText, 'ori');
  assert.match(layout(pane, 70, 3)[0]!, /Edit refused:/);
  input(pane, '\x1a');
  assert.equal(pane.document.text, 'original');
});

test('one-cell panes retain exactly one safe focused cursor over a wide glyph', () => {
  const pane = createFileEditorPane('界x', () => {});
  pane.focus.focused = true;
  const lines = layout(pane, 1, 1);
  assert.equal(lines.filter((line) => line.includes(CURSOR_MARKER)).length, 1);
  assert.ok(lines.every((line) => visibleWidth(line) <= 1));
  assert.equal(pane.document.text, '界x');
});

test('document home/end with shift selects exact mixed-delimiter source', () => {
  const pane = createFileEditorPane('one\r\ntwo\nlast', () => {});
  input(pane, '\x1b[1;5F');
  assert.equal(pane.document.cursor, pane.document.text.length);
  input(pane, '\x1b[1;6H');
  assert.equal(pane.document.selectedText, 'one\r\ntwo\nlast');
  input(pane, 'replacement');
  assert.equal(pane.document.text, 'replacement');
  input(pane, '\x1a');
  assert.equal(pane.document.text, 'one\r\ntwo\nlast');
});

test('numbered editor views share one document while keeping separate scroll state', () => {
  const first = createFileEditorPane('one\r\n界🌱', () => {}, { lineNumbers: true });
  const second = createFileEditorPane(first.document, () => {}, { lineNumbers: true });
  first.focus.focused = true;
  input(first, '\x1b[B');
  input(first, '\x1b[C');
  assert.deepEqual(first.position, { line: 2, column: 3 });
  input(first, '!');
  assert.equal(second.document.text, 'one\r\n界!🌱');
  assert.match(layout(second, 30, 4)[1]!, /2.*界!🌱/);
  assert.equal(
    layout(second, 30, 4).some((line) => line.includes(CURSOR_MARKER)),
    false,
  );
  assert.notEqual(first.view, second.view);
  for (const width of [1, 2, 8]) assert.ok(layout(first, width, 2).every((line) => visibleWidth(line) <= width));
});

test('a resize that reveals a far cursor or grows the viewport draws the rows it shows', () => {
  const pane = createFileEditorPane(Array.from({ length: 500 }, (_, n) => `line ${n}`).join('\n'), () => {});
  layout(pane, 20, 10);
  pane.view.scrollTo(200);
  layout(pane, 20, 10);
  // Taller viewport: the resize reveals the cursor on line 1 after this frame was drawn.
  const lines = pane.focus.render(20);
  pane.view.updateLayout(lines.length, 40, () => {});
  const shown = lines.slice(pane.view.scrollTop, pane.view.scrollTop + 40);
  assert.equal(pane.view.scrollTop, 0);
  assert.deepEqual(
    shown,
    Array.from({ length: 40 }, (_, n) => `line ${n}`),
  );

  const far = createFileEditorPane(Array.from({ length: 500 }, (_, n) => `line ${n}`).join('\n'), () => {});
  layout(far, 20, 5);
  for (let i = 0; i < 300; i++) input(far, '\x1b[B');
  layout(far, 20, 5);
  const before = far.focus.render(20);
  far.view.updateLayout(before.length, 40, () => {});
  const visible = before.slice(far.view.scrollTop, far.view.scrollTop + 40);
  assert.equal(visible.filter((line) => !line.trim()).length, 0);
});
