import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  closerOutdent,
  detectIndent,
  newlineEdit,
  selectedLineRange,
  shiftLines,
  softBackspace,
  toggleComment,
  type Edit,
  type Indent,
} from '../src/tui/editing.ts';

const four: Indent = { kind: 'spaces', size: 4 };
const apply = (text: string, edit: Edit | undefined): string =>
  edit ? text.slice(0, edit.from) + edit.text + text.slice(edit.to) : text;

test('indent is detected from the file: tabs, two or four spaces, else the fallback', () => {
  assert.deepEqual(detectIndent('fn a() {\n    let x = 1;\n    if x {\n        y();\n    }\n}\n'), four);
  assert.deepEqual(detectIndent('const a = {\n  b: 1,\n  c: {\n    d: 2,\n  },\n};\n'), { kind: 'spaces', size: 2 });
  assert.deepEqual(detectIndent('a {\n\tb\n\tc {\n\t\td\n\t}\n}\n'), { kind: 'tab' });
  assert.deepEqual(detectIndent('no indentation\nat all\n'), four);
  assert.deepEqual(detectIndent('no indentation\n', { kind: 'spaces', size: 2 }), { kind: 'spaces', size: 2 });
});

test('selected lines are whole lines; a selection ending at a line start leaves that line out', () => {
  const text = 'one\ntwo\nthree';
  assert.deepEqual(selectedLineRange(text, 5, 5), { from: 4, to: 7 });
  assert.deepEqual(selectedLineRange(text, 1, 6), { from: 0, to: 7 });
  assert.deepEqual(selectedLineRange(text, 0, 4), { from: 0, to: 3 });
});

test('Tab indents every selected non-blank line and Shift+Tab outdents by one unit', () => {
  const text = 'a\n\n  b\nc';
  const indented = apply(text, shiftLines(text, 0, text.length, four, false));
  assert.equal(indented, '    a\n\n      b\n    c');
  assert.equal(apply(indented, shiftLines(indented, 0, indented.length, four, true)), text);
  assert.equal(apply('\tx', shiftLines('\tx', 0, 0, { kind: 'tab' }, true)), 'x');
  assert.equal(shiftLines('x', 0, 0, four, true), undefined);
  assert.equal(apply('  x', shiftLines('  x', 0, 0, four, true)), 'x');
});

test('toggle comment adds the marker at the shallowest depth and removes it only when every line has it', () => {
  const text = '    a\n      b\n\n    c';
  const commented = apply(text, toggleComment(text, 0, text.length, '//'));
  assert.equal(commented, '    // a\n    //   b\n\n    // c');
  assert.equal(apply(commented, toggleComment(commented, 0, commented.length, '//')), text);
  const mixed = '// a\nb';
  assert.equal(apply(mixed, toggleComment(mixed, 0, mixed.length, '//')), '// // a\n// b');
  assert.equal(toggleComment('\n\n', 0, 2, '#'), undefined);
  assert.equal(apply('x = 1', toggleComment('x = 1', 0, 0, '#')), '# x = 1');
});

test('Enter keeps the indentation, adds one level after an opener and splits an empty pair', () => {
  const rust = 'fn a() {';
  assert.equal(apply(rust, newlineEdit(rust, rust.length, '\n', four)), 'fn a() {\n    ');
  const indented = '    let x = 1;';
  assert.equal(apply(indented, newlineEdit(indented, indented.length, '\n', four)), '    let x = 1;\n    ');
  const pair = 'if x {}';
  const edit = newlineEdit(pair, pair.length - 1, '\r\n', four);
  assert.equal(apply(pair, edit), 'if x {\r\n    \r\n}');
  assert.equal(edit.cursor, 'if x {\r\n    '.length);
  const trailing = 'x   ';
  assert.equal(apply(trailing, newlineEdit(trailing, trailing.length, '\n', four)), 'x\n');
  const arrow = 'const f = () =>';
  assert.equal(
    apply(arrow, newlineEdit(arrow, arrow.length, '\n', { kind: 'spaces', size: 2 })),
    'const f = () =>\n  ',
  );
});

test('a closing bracket on a blank indented line outdents; Backspace in leading spaces steps back one unit', () => {
  assert.deepEqual(closerOutdent('    ', 4, four), { from: 0, to: 4 });
  assert.deepEqual(closerOutdent('    x', 5, four), undefined);
  assert.deepEqual(closerOutdent('\t\t', 2, { kind: 'tab' }), { from: 1, to: 2 });
  assert.deepEqual(softBackspace('      ', 6, four), { from: 4, to: 6 });
  assert.deepEqual(softBackspace('    ', 4, four), { from: 0, to: 4 });
  assert.deepEqual(softBackspace('  x', 2, { kind: 'spaces', size: 2 }), { from: 0, to: 2 });
  assert.equal(softBackspace(' x', 1, four), undefined);
  assert.equal(softBackspace('a    ', 5, four), undefined);
});
