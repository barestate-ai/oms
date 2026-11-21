import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatFixture, start } from '../test-support/fake-session.ts';
import { createFileEditorPane } from '../src/tui/file-editor.ts';

const lines = (screen: string) => screen.split('\n');
const isRule = (row: string) => /^─{20,}( .* ─)?\s*$/.test(row);
const rules = (screen: string) =>
  lines(screen)
    .map((row, index) => (isRule(row) ? index : -1))
    .filter((index) => index >= 0);

const LONG =
  'Add a withdraw instruction that lets the vault owner pull funds back out. Write a test for the happy path and for the unauthorized path, and run them on the local chain until they pass. Also update the README with usage.';

test('a long draft wraps in the composer so none of it is hidden', async () => {
  const f = chatFixture();
  const { terminal, close } = start(f.harness, 80, 30);
  try {
    await terminal.until((screen) => screen.includes('/ commands'));
    terminal.send(LONG);
    const screen = await terminal.until((s) => s.includes('usage.'));
    const [top, bottom] = rules(screen).slice(-2) as [number, number];
    assert.ok(bottom - top - 1 >= 3, 'the composer grew to hold the wrapped text');
    const rows = lines(screen).slice(top + 1, bottom);
    assert.match(rows[0]!, /^❯ Add a withdraw instruction/);
    assert.match(rows[1]!, /^ {2}\S/, 'continuation rows hang under the text');
    assert.equal(
      rows
        .map((row) => row.slice(2).trim())
        .join(' ')
        .replace(/\s+/g, ' '),
      LONG,
      'every word of the draft is on screen, in order',
    );
  } finally {
    await close();
  }
});

test('up and down move by wrapped row, and Home and End stay on the row', () => {
  const pane = createFileEditorPane(LONG, () => {}, { wrap: true });
  assert.equal(pane.rows(40) > 5, true);
  assert.equal(pane.rows(400), 1, 'a wide composer needs one row');
  pane.view.updateLayout(pane.rows(40), 8, () => {});
  pane.focus.render(40);
  pane.document.select(0, 0);
  pane.focus.handleInput?.('\x1b[B'); // down: the next wrapped row
  assert.ok(pane.document.cursor > 0 && pane.document.cursor < 40, 'moved to the second row');
  pane.focus.handleInput?.('\x1b[F'); // end: last character of that row, not the start of the third
  const end = pane.document.cursor;
  pane.focus.render(40);
  pane.focus.handleInput?.('\x1b[B');
  assert.ok(pane.document.cursor > end, 'down from the end goes to the third row');
  pane.focus.handleInput?.('\x1b[H'); // home
  assert.ok(pane.document.cursor > end);
});

test('a draft taller than the composer says how many rows are scrolled out above it', async () => {
  const f = chatFixture();
  const { terminal, close } = start(f.harness, 60, 24);
  try {
    await terminal.until((screen) => screen.includes('/ commands'));
    terminal.send(Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ') + ' end.');
    const screen = await terminal.until((s) => /─ ↑ \d+ more ─/.test(s) && s.includes('end.'));
    assert.match(screen, /─ ↑ \d+ more ─/);
    assert.doesNotMatch(screen, /❯ word0 /, 'the head is scrolled out');
  } finally {
    await close();
  }
});

test('Up on the first row recalls earlier messages and Down walks back to the draft', async () => {
  const f = chatFixture();
  const { terminal, close } = start(f.harness, 100, 30);
  try {
    await terminal.until((screen) => screen.includes('/ commands'));
    for (const text of ['first message', 'second message']) {
      terminal.send(text);
      terminal.send('\r');
      await terminal.until(() => f.prompts.includes(text));
      f.promptGate.resolve();
      await terminal.until((screen) => !/[⠁-⣿] /.test(screen));
    }
    terminal.send('half typed');
    terminal.send('\x1b[A');
    await terminal.until((screen) => screen.includes('❯ second message'));
    terminal.send('\x1b[A');
    await terminal.until((screen) => screen.includes('❯ first message'));
    terminal.send('\x1b[A');
    await terminal.until((screen) => screen.includes('❯ first message'));
    terminal.send('\x1b[B');
    await terminal.until((screen) => screen.includes('❯ second message'));
    terminal.send('\x1b[B');
    await terminal.until((screen) => screen.includes('❯ half typed'), 2000);
  } finally {
    await close();
  }
});
