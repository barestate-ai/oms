import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui';
import {
  createFileEditorPane,
  type ChangeMark,
  type EditorClipboard,
  type FileEditorPane,
} from '../src/tui/file-editor.ts';
import { getTheme } from '../src/tui/theme.ts';
import type { Language } from '../src/tui/syntax.ts';

const theme = getTheme('gruvbox')!;
function code(
  text: string,
  options: {
    language?: Language;
    marks?: Map<number, ChangeMark>;
    clipboard?: EditorClipboard;
    notices?: string[];
    numbers?: boolean;
    readOnly?: boolean;
  } = {},
): FileEditorPane {
  const pane = createFileEditorPane(text, () => {}, {
    lineNumbers: options.numbers ?? true,
    readOnly: options.readOnly,
    code: {
      theme: () => theme,
      language: () => options.language,
      marks: () => options.marks,
      clipboard: options.clipboard,
      notice: (message) => options.notices?.push(message),
    },
  });
  pane.focus.focused = true;
  return pane;
}
const input = (pane: FileEditorPane, data: string): void => pane.focus.handleInput!(data);
function frame(pane: FileEditorPane, width = 40, height = 8): string[] {
  const lines = pane.focus.render(width);
  pane.view.updateLayout(lines.length, height, () => {});
  return pane.focus.render(width);
}
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));
function mouse(type: TuiMouseEvent['type'], x: number, y: number, clickCount = 1): TuiMouseEvent {
  return {
    type,
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width: 40,
    height: 8,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount,
  };
}
const clipboardFake = (): EditorClipboard & { value: string | undefined } => {
  const fake = {
    value: undefined as string | undefined,
    write(text: string) {
      fake.value = text;
    },
    async read() {
      return fake.value;
    },
  };
  return fake;
};

test('syntax colors, the themed gutter and the caret line are drawn from theme roles, not raw SGR dimming', () => {
  const pane = code('let x = "a";\nfn go() {}', { language: 'rust' });
  pane.document.select(12, 12);
  const lines = frame(pane);
  const keyword = `\x1b[${theme.sgr.fg.syntaxKeyword}m`;
  assert.ok(lines[0]!.includes(keyword + 'let'), 'keyword colored');
  assert.ok(lines[0]!.includes(`\x1b[${theme.sgr.fg.syntaxString}m"a";`.slice(0, -2)), 'string colored');
  assert.ok(lines[0]!.includes(`\x1b[${theme.sgr.bg.surface}m`), 'caret line sits on the surface color');
  assert.ok(!lines[1]!.includes(`\x1b[${theme.sgr.bg.surface}m`));
  assert.ok(!lines.join('').includes('\x1b[2m'), 'no raw dim');
  assert.deepEqual(
    plain(lines)
      .slice(0, 2)
      .map((line) => line.trimEnd()),
    [' 1 let x = "a";', ' 2 fn go() {}'],
  );
  // Every line fills its width exactly, so the surface color reaches the right edge.
  assert.ok(lines.every((line) => visibleWidth(line) <= 40));
  assert.equal(visibleWidth(lines[0]!), 40);
});

test('an unfocused editor has no caret line or cursor, a selection keeps its color under syntax colors', () => {
  const pane = code('let x = 1;', { language: 'rust' });
  pane.focus.focused = false;
  assert.ok(!frame(pane)[0]!.includes(`\x1b[${theme.sgr.bg.surface}m`));
  assert.ok(!frame(pane)[0]!.includes(CURSOR_MARKER));
  pane.focus.focused = true;
  pane.document.select(0, 3);
  const [line] = frame(pane);
  assert.ok(line!.includes(`\x1b[${theme.sgr.bg.selection}m`));
  assert.ok(line!.includes('let'));
});

test('change marks draw a colored bar in the gutter', () => {
  const pane = code('a\nb\nc', {
    marks: new Map<number, ChangeMark>([
      [0, 'add'],
      [1, 'mod'],
      [2, 'del'],
    ]),
  });
  const lines = frame(pane);
  assert.ok(lines[0]!.includes(`\x1b[${theme.sgr.fg.success}m▎`));
  assert.ok(lines[1]!.includes(`\x1b[${theme.sgr.fg.warning}m▎`));
  assert.ok(lines[2]!.includes(`\x1b[${theme.sgr.fg.error}m▎`));
});

test('diff lines are tinted across the whole line', () => {
  const pane = code('@@ -1 +1 @@\n-old\n+new', { language: 'diff', numbers: false });
  pane.focus.focused = false;
  const lines = frame(pane, 20);
  assert.ok(lines[1]!.includes(`\x1b[${theme.sgr.bg.diffRemoved}m`));
  assert.ok(lines[2]!.includes(`\x1b[${theme.sgr.bg.diffAdded}m`));
  assert.equal(visibleWidth(lines[2]!), 20);
});

test('goTo clamps, centers and keeps the caret on a real column', () => {
  const pane = code(Array.from({ length: 100 }, (_, n) => `line ${n + 1}`).join('\n'));
  frame(pane, 30, 10);
  pane.goTo(50, 3);
  frame(pane, 30, 10);
  assert.deepEqual(pane.position, { line: 50, column: 3 });
  assert.equal(pane.view.scrollTop, 44);
  pane.goTo(9999, 9999);
  assert.equal(pane.position.line, 100);
  pane.goTo(-4);
  assert.deepEqual(pane.position, { line: 1, column: 1 });
});

test('selectedLines reports the touched lines, leaving out one the selection only reaches the start of', () => {
  const pane = code('one\ntwo\nthree\nfour');
  pane.document.select(5, 5);
  assert.deepEqual(pane.selectedLines(), { from: 2, to: 2 });
  pane.document.select(1, 10);
  assert.deepEqual(pane.selectedLines(), { from: 1, to: 3 });
  pane.document.select(0, 8);
  assert.deepEqual(pane.selectedLines(), { from: 1, to: 2 });
});

test('Tab inserts the file indentation; on a selection it indents the lines; Shift+Tab outdents', () => {
  const pane = code('fn a() {\n    x();\n    y();\n}', { language: 'rust' });
  pane.document.select(0, 0);
  input(pane, '\t');
  assert.equal(pane.document.text.slice(0, 12), '    fn a() {');
  input(pane, '\x1b[Z');
  assert.equal(pane.document.text.slice(0, 8), 'fn a() {');
  pane.document.select(9, 25);
  input(pane, '\t');
  assert.equal(pane.document.text, 'fn a() {\n        x();\n        y();\n}');
  input(pane, '\x1b[Z');
  input(pane, '\x1a');
  input(pane, '\x1a');
  assert.equal(pane.document.text, 'fn a() {\n    x();\n    y();\n}');
  const tabs = code('a {\n\tb\n\tc {\n\t\td\n\t}\n}', { language: 'rust' });
  tabs.document.select(0, 0);
  input(tabs, '\t');
  assert.equal(tabs.document.text[0], '\t');
});

test('Enter keeps indentation and opens a block; a closing bracket outdents', () => {
  const pane = code('fn a() {\n    if x {', { language: 'rust' });
  pane.document.select(pane.document.text.length, pane.document.text.length);
  input(pane, '\r');
  assert.equal(pane.document.text, 'fn a() {\n    if x {\n        ');
  input(pane, '}');
  assert.equal(pane.document.text, 'fn a() {\n    if x {\n    }');
  input(pane, '\r');
  input(pane, 'y');
  assert.ok((pane.document.text as string).endsWith('}\n    y'));
  input(pane, '\x1a');
  input(pane, '\x1a');
  assert.ok((pane.document.text as string).endsWith('    }'));
  const pair = code('call({})', { language: 'ts' });
  pair.document.select(6, 6);
  input(pair, '\r');
  assert.equal(pair.document.text, 'call({\n  \n})');
  assert.equal(pair.position.line, 2);
  const plainText = code('  keep', {});
  plainText.document.select(plainText.document.text.length, plainText.document.text.length);
  input(plainText, '\r');
  assert.equal(plainText.document.text, '  keep\n  ');
});

test('Ctrl+/ comments and uncomments the lines as one undo step, per language', () => {
  const notices: string[] = [];
  const rust = code('a();\nb();', { language: 'rust', notices });
  rust.document.select(0, rust.document.text.length);
  input(rust, '\x1f');
  assert.equal(rust.document.text, '// a();\n// b();');
  input(rust, '\x1f');
  assert.equal(rust.document.text, 'a();\nb();');
  input(rust, '\x1f');
  input(rust, '\x1a');
  assert.equal(rust.document.text, 'a();\nb();');
  const toml = code('x = 1', { language: 'toml' });
  input(toml, '\x1f');
  assert.equal(toml.document.text, '# x = 1');
  const none = code('x', { language: 'diff', notices });
  input(none, '\x1f');
  assert.equal(none.document.text, 'x');
  assert.match(notices.at(-1)!, /no line comment/);
});

test('word movement and deletion work with Alt and Ctrl and select with Shift', () => {
  const pane = code('foo_bar baz.qux', { language: 'rust' });
  pane.document.select(0, 0);
  input(pane, '\x1b[1;5C');
  assert.equal(pane.document.cursor, 7);
  input(pane, '\x1bf');
  assert.equal(pane.document.cursor, 11);
  input(pane, '\x1b[1;6C');
  assert.equal(pane.document.selectedText, '.');
  input(pane, '\x1b[1;3D');
  input(pane, '\x1b[1;3D');
  assert.equal(pane.document.cursor, 8);
  input(pane, '\x1b\x7f');
  assert.equal(pane.document.text, 'baz.qux');
});

test('copy, cut and paste use the clipboard, a bare Ctrl+C copies the line, and read-only buffers still copy', async () => {
  const clipboard = clipboardFake();
  const notices: string[] = [];
  const pane = code('alpha\nbeta\ngamma', { clipboard, notices });
  pane.document.select(0, 5);
  input(pane, '\x03');
  assert.equal(clipboard.value, 'alpha');
  pane.document.select(7, 7);
  input(pane, '\x03');
  assert.equal(clipboard.value, 'beta\n');
  input(pane, '\x18');
  assert.equal(pane.document.text, 'alpha\ngamma');
  pane.document.select(0, 0);
  input(pane, '\x16');
  await setImmediate();
  assert.equal(pane.document.text, 'beta\nalpha\ngamma');
  await setImmediate();
  assert.ok(notices.some((message) => /Copied line/.test(message)));
  assert.ok(notices.some((message) => /Cut line/.test(message)));
  const locked = code('read only', { clipboard, readOnly: true });
  locked.document.select(0, 4);
  input(locked, '\x03');
  input(locked, '\x18');
  input(locked, '\x16');
  await setImmediate();
  assert.equal(clipboard.value, 'read');
  assert.equal(locked.document.text, 'read only');
});

test('typing a word is one undo step in a code editor', () => {
  const pane = code('', { language: 'ts' });
  for (const character of 'const value') input(pane, character);
  input(pane, '\x1a');
  assert.equal(pane.document.text, 'const');
  input(pane, '\x1a');
  assert.equal(pane.document.text, '');
});

test('a short line after a long one is never scrolled out of view', () => {
  const pane = code(`${'x'.repeat(300)}\nshort line`, { language: 'ts', numbers: true });
  frame(pane, 40, 4);
  input(pane, '\x1b[F');
  frame(pane, 40, 4);
  input(pane, '\x1b[B');
  const lines = plain(frame(pane, 40, 4));
  assert.match(lines[1]!, /short line/);
  // The caret keeps some context to its right while typing near the edge.
  const edge = code('y'.repeat(100), { numbers: false });
  frame(edge, 20, 2);
  input(edge, '\x1b[F');
  const drawn = frame(edge, 20, 2)[0]!;
  assert.ok(drawn.includes(CURSOR_MARKER));
  assert.ok(visibleWidth(drawn) <= 20);
});

test('double click selects a word and triple click selects the line', () => {
  const pane = code('alpha beta\ngamma', { numbers: false });
  frame(pane, 40, 4);
  pane.focus.handleMouse!(mouse('press', 7, 0, 2));
  assert.equal(pane.document.selectedText, 'beta');
  pane.focus.handleMouse!(mouse('press', 7, 0, 3));
  assert.equal(pane.document.selectedText, 'alpha beta\n');
});
