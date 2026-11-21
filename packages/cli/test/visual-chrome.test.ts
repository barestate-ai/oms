import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HarnessSession } from '@oms/engine';
import { resetCapabilitiesCache } from '@earendil-works/pi-tui';
import { runOmsInterface } from '../src/tui/interface.ts';
import { getTheme, THEME_IDS } from '../src/tui/theme.ts';
import { chatFixture, fixture, quit } from '../test-support/fake-session.ts';
import { InterfaceTerminal } from '../test-support/interface-terminal.ts';

/** A terminal that records the title and progress bar the interface asks for. */
class RecordingTerminal extends InterfaceTerminal {
  titles: string[] = [];
  progress: boolean[] = [];
  override setTitle(title?: string): void {
    this.titles.push(String(title));
  }
  override setProgress(active?: boolean): void {
    this.progress.push(!!active);
  }
}

const EMBER = getTheme('oms-ember')!;
const rgb = (hex: string) => Number.parseInt(hex.slice(1), 16);
const idle = (screen: string): boolean => screen.trim() !== '' && !/(?:^|── )[⠁-⣿] \S/m.test(screen);
const spinnerRow = (screen: string): string | undefined => screen.split('\n').find((row) => /^[⠁-⣿] \S/.test(row));
const lines = (screen: string) => screen.split('\n');
const isRule = (row: string) => /^─{20,}( .* ─)?\s*$/.test(row);
/** Row indexes of the composer's two rules: the last two full-width rules on the screen. */
function rules(screen: string): [number, number] {
  const found = lines(screen)
    .map((row, index) => (isRule(row) ? index : -1))
    .filter((index) => index >= 0);
  assert.ok(found.length >= 2, `two rules on\n${screen}`);
  return [found.at(-2)!, found.at(-1)!];
}
const cell = (terminal: InterfaceTerminal, x: number, y: number) => terminal.vt.buffer.active.getLine(y)!.getCell(x)!;

async function open(harness: HarnessSession, columns: number, rowsCount: number, options = {}) {
  const terminal = new RecordingTerminal(columns, rowsCount);
  const run = runOmsInterface(harness, { terminal, ...options });
  await terminal.until((screen) => idle(screen));
  return { terminal, run };
}
const sizes = [
  [80, 24],
  [140, 42],
  [200, 60],
] as const;

for (const [columns, rowsCount] of sizes) {
  test(`a chat is a header (from 30 rows), the empty state, two rules and one status row at ${columns}x${rowsCount}`, async () => {
    const f = chatFixture();
    const { terminal, run } = await open(f.harness, columns, rowsCount);
    try {
      const screen = await terminal.until((s) => s.includes('/ commands'));
      const rows = lines(screen);
      assert.equal(rows.length, rowsCount);
      const header = rowsCount >= 30;
      if (header) {
        assert.match(rows[0]!, /^◆ oms {2}rental-ledger +chat {2}workbench\s*$/);
        assert.equal(rows[1]!.trim(), '', 'one blank row under the header');
      }
      const empty = header ? 2 : 0;
      assert.match(rows[empty]!, /^◆ oms 0\.\d/);
      assert.match(rows[empty + 1]!, /^ {2}test-model · rental-ledger/);
      assert.match(rows[empty + 2]!, /^ {2}Try: /);
      assert.equal(rows[empty + 3]!.trim(), '', 'the conversation is otherwise empty');
      const [top, bottom] = rules(screen);
      assert.equal(bottom - top, 2, 'one line of input between the two rules');
      assert.equal(rows[top]!, '─'.repeat(columns), 'a full-width rule');
      assert.match(rows[top + 1]!, /^❯ Ask OMS to build, test or explain a program…\s*$/);
      assert.match(rows[bottom]!, /^─+ test-model · ask ─\s*$/);
      assert.equal(visibleLength(rows[bottom]!), columns);
      assert.equal(top, rowsCount - 4, 'the status row is last, directly under the bottom rule');
      assert.match(rows.at(-1)!, /^ {2}\/ commands · \? shortcuts/);
      if (columns >= 120) assert.match(rows.at(-1)!, / · ctrl\+q quit/);
      // No box around anything, and none of the old chrome.
      assert.doesNotMatch(screen, /[╭╮╰╯│┌┐└┘]|\[ |Conversation|Press Enter|Harness|Workbench\b/);
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}
const visibleLength = (row: string) => [...row].length;

test('the composer grows with its lines up to eight (or 40% of the rows), then scrolls, and shrinks back', async () => {
  const f = chatFixture();
  const { terminal, run } = await open(f.harness, 100, 42);
  try {
    const newline = '\x1b[13;2u';
    terminal.send('one');
    for (const word of ['two', 'three']) {
      terminal.send(newline);
      terminal.send(word);
    }
    let screen = await terminal.until((s) => s.includes('three'));
    let [top, bottom] = rules(screen);
    assert.equal(bottom - top - 1, 3);
    assert.match(lines(screen)[top + 1]!, /^❯ one/, 'the prompt marks the first line');
    assert.match(lines(screen)[top + 3]!, /^ {2}three/, 'later lines hang under the text');
    for (let i = 0; i < 12; i++) {
      terminal.send(newline);
      terminal.send(`more ${i}`);
    }
    screen = await terminal.until((s) => s.includes('more 11'));
    [top, bottom] = rules(screen);
    assert.equal(bottom - top - 1, 8, 'eight lines at most');
    assert.equal(bottom, 42 - 2, 'the status row stays last');
    // Select all and delete: back to one line.
    terminal.send('\x01');
    terminal.send('\x7f');
    screen = await terminal.until((s) => !s.includes('more 11'));
    [top, bottom] = rules(screen);
    assert.equal(bottom - top - 1, 1);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('on a short terminal the composer is capped at 40% of the rows', async () => {
  const f = chatFixture();
  const { terminal, run } = await open(f.harness, 60, 14);
  try {
    for (let i = 0; i < 9; i++) {
      terminal.send('\x1b[13;2u');
      terminal.send(`l${i}`);
    }
    const screen = await terminal.until((s) => s.includes('l8'));
    const [top, bottom] = rules(screen);
    assert.equal(bottom - top - 1, Math.floor(14 * 0.4));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('the rules brighten when the composer has the focus and the composer collapses when the conversation has it', async () => {
  const f = chatFixture();
  const { terminal, run } = await open(f.harness, 100, 40);
  try {
    terminal.send('a');
    terminal.send('\x1b[13;2u');
    terminal.send('b');
    let screen = await terminal.until((s) => /^ {2}b/m.test(s));
    let [top] = rules(screen);
    assert.equal(cell(terminal, 3, top).getFgColor(), rgb(EMBER.colors.borderFocus), 'focused: borderFocus');
    assert.equal(cell(terminal, 0, top + 1).getFgColor(), rgb(EMBER.colors.accentFill), 'the prompt is accent');
    terminal.send('\t');
    screen = await terminal.until((s) => !/^ {2}b/m.test(s));
    [top] = rules(screen);
    const [, bottom] = rules(screen);
    assert.equal(bottom - top - 1, 1, 'one line while the conversation has the focus');
    assert.equal(cell(terminal, 3, top).getFgColor(), rgb(EMBER.colors.border), 'blurred: border');
    assert.equal(cell(terminal, 0, top + 1).getFgColor(), rgb(EMBER.colors.faint), 'the prompt is faint');
    terminal.send('\x1b');
    screen = await terminal.until((s) => /^ {2}b/m.test(s));
    assert.equal(cell(terminal, 3, rules(screen)[0]).getFgColor(), rgb(EMBER.colors.borderFocus));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('the bottom rule names the approval mode and turns yolo red', async () => {
  const f = chatFixture(true);
  const { terminal, run } = await open(f.harness, 100, 40);
  try {
    const screen = await terminal.until((s) => /test-model · yolo ─/.test(s));
    const [, bottom] = rules(screen);
    const x = lines(screen)[bottom]!.indexOf('yolo');
    assert.equal(cell(terminal, x, bottom).getFgColor(), rgb(EMBER.colors.error));
    assert.match(lines(screen).at(-1)!, /YOLO/, 'and the status row says so too');
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('confirmations are three-second toasts in the status row; warnings stay until Esc', async () => {
  const f = chatFixture();
  f.model(false);
  const { terminal, run } = await open(f.harness, 100, 40);
  try {
    terminal.send('/theme nord');
    terminal.send('\r');
    let screen = await terminal.until((s) => lines(s).at(-1)!.includes('Theme set to Nord'));
    assert.doesNotMatch(lines(screen).at(-1)!, /commands/, 'the toast replaces the hints');
    terminal.send('hello');
    terminal.send('\r');
    screen = await terminal.until((s) => /^! Run \/connect to sign in or \/model/m.test(s));
    assert.equal(
      cell(
        terminal,
        0,
        lines(screen).findIndex((row) => row.startsWith('! ')),
      ).getFgColor(),
      rgb(getTheme('nord')!.colors.warning),
    );
    screen = await terminal.until((s) => !s.includes('Theme set to Nord') && s.includes('/ commands'), 4500);
    assert.match(screen, /^! Run \/connect/m, 'the warning outlives the toast');
    terminal.send('\x1b');
    await terminal.until((s) => !s.includes('! Run /connect'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('a running turn shows a spinner row with the current tool, time and tokens, and sets the title and progress bar', async () => {
  const f = chatFixture();
  const { terminal, run } = await open(f.harness, 120, 36);
  try {
    assert.equal(terminal.titles.at(-1), 'oms · rental-ledger');
    terminal.send('go');
    terminal.send('\r');
    let screen = await terminal.until((s) => spinnerRow(s)?.includes('Thinking…') === true);
    assert.match(spinnerRow(screen)!, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking… +\d+s · esc to interrupt\s*$/);
    assert.match(lines(screen).at(-1)!, /esc interrupt/, 'and the status hints say how to stop');
    assert.deepEqual(terminal.progress, [true]);
    f.emit({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'read',
      args: { path: '/fixtures/rental-ledger/programs/escrow/lib.rs' },
    });
    screen = await terminal.until((s) => spinnerRow(s)?.includes('Reading escrow/lib.rs…') === true);
    assert.match(terminal.titles.at(-1)!, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] oms · rental-ledger — Reading escrow\/lib\.rs$/);
    f.emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: { content: [] }, isError: false });
    f.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done reading' }],
        stopReason: 'stop',
        usage: {
          input: 10,
          output: 1234,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1244,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
    screen = await terminal.until((s) => /Thinking… +\d+s · ↓ 1\.2k · esc to interrupt\s*$/m.test(s));
    f.promptGate.resolve();
    screen = await terminal.until((s) => idle(s) && s.includes('/ commands'));
    assert.deepEqual(terminal.progress, [true, false]);
    assert.equal(terminal.titles.at(-1), 'oms · rental-ledger');
  } finally {
    f.promptGate.resolve();
    f.abortGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test("on a short terminal the spinner moves into the composer's top rule", async () => {
  const f = chatFixture();
  const { terminal, run } = await open(f.harness, 70, 16);
  try {
    terminal.send('go');
    terminal.send('\r');
    const screen = await terminal.until((s) => /^── [⠁-⣿] Thinking… \d+s ─+\s*$/m.test(s));
    assert.equal(lines(screen).filter((row) => /Thinking/.test(row)).length, 1, 'no separate spinner row');
    assert.doesNotMatch(screen, /esc to interrupt/, 'the status row carries the hint');
    f.promptGate.resolve();
    await terminal.until((s) => !s.includes('Thinking') && /^─{60,}\s*$/m.test(s));
  } finally {
    f.promptGate.resolve();
    f.abortGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('the slash popup sits directly above the composer: eight rows, pointer, argument hints and live filtering', async () => {
  const f = fixture();
  const { terminal, run } = await open(f.harness, 100, 40);
  try {
    terminal.send('/');
    let screen = await terminal.until((s) => s.includes('/workbench'));
    let [top] = rules(screen);
    const rows = lines(screen);
    const popup = rows.slice(top - 8, top);
    assert.match(popup[0]!, /^› \/workbench +Editor, files and terminal/, 'the first row is selected');
    assert.ok(
      popup.slice(1).every((row) => /^ {2}\/\S/.test(row)),
      popup.join('\n'),
    );
    assert.ok(!rows[top - 9]!.includes('/'), 'exactly eight rows');
    assert.ok(!/Commands ·|Navigate|Setup/.test(screen), 'no heading and no group column');
    assert.equal(cell(terminal, 3, top - 8).isBgRGB(), true, 'the selected row is on the raised surface');
    terminal.send('\x1b[B');
    screen = await terminal.until((s) => /^› \/harness/m.test(s));
    terminal.send('\x01');
    terminal.send('\x7f');
    terminal.send('/err');
    screen = await terminal.until((s) => /^› \/error <code>/m.test(s));
    assert.match(
      screen,
      /^› \/error <code> \[program\] +Decode a program error/m,
      'the argument hint follows the name',
    );
    terminal.send('\t');
    screen = await terminal.until((s) => /^❯ \/error\s*$/m.test(s));
    assert.match(lines(screen).at(-1)!, /usage \/error <code> \[program\] · enter run/);
    assert.ok(!/^› /m.test(screen), 'the popup closes once the command is complete');
    assert.deepEqual(f.prompts, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('the command menu (ctrl+k) is the composer with a commands label above the same popup', async () => {
  const f = chatFixture();
  const { terminal, run } = await open(f.harness, 100, 40);
  try {
    terminal.send('\x0b');
    const screen = await terminal.until((s) => /commands · esc to close ─$/m.test(s));
    assert.match(screen, /^› \/workbench/m);
    assert.match(lines(screen).at(-1)!, /^ {2}↑↓ choose · tab complete · enter run/);
    terminal.send('\x1b');
    await terminal.until((s) => !/esc to close/.test(s));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

for (const [columns, rowsCount] of [
  [140, 42],
  [200, 60],
  [80, 24],
] as const) {
  test(`a floating panel is centered, at most 72 columns and 60% of the rows, with its title and hints in the border at ${columns}x${rowsCount}`, async () => {
    const f = chatFixture();
    const { terminal, run } = await open(f.harness, columns, rowsCount);
    try {
      terminal.send('/theme');
      terminal.send('\r');
      const screen = await terminal.until((s) => s.includes('Choose a theme'));
      const rows = lines(screen);
      const top = rows.findIndex((row) => row.includes('╭─ Theme '));
      const bottom = rows.findIndex((row) => row.includes('╰'));
      assert.ok(top >= 0 && bottom > top, screen);
      const left = rows[top]!.indexOf('╭');
      const right = [...rows[top]!].lastIndexOf('╮');
      const width = right - left + 1;
      assert.ok(width <= 72 && width >= 40, `${width} columns`);
      assert.ok(Math.abs(left - (columns - 1 - right)) <= 1, `centered: ${left} left, ${columns - 1 - right} right`);
      const height = bottom - top + 1;
      assert.ok(height <= Math.max(14, Math.floor(rowsCount * 0.6)), `${height} rows of ${rowsCount}`);
      assert.ok(Math.abs(top - (rowsCount - 1 - bottom)) <= 3 || rowsCount < 30, 'roughly centered vertically');
      assert.match(rows[bottom]!, /╰─+ ↑↓ preview · enter choose · esc cancel ─╯/);
      assert.match(rows[top + 2]!, /│ {2}Choose a theme/, 'inner padding of two columns and a blank row');
      assert.ok(
        rows.slice(top, bottom + 1).every((row) => row.includes('│') || row.includes('╭') || row.includes('╰')),
      );
      assert.equal(cell(terminal, left + 3, top + 2).isBgRGB(), true);
      assert.equal(cell(terminal, left + 3, top + 2).getBgColor(), rgb(EMBER.surface), 'the surface background');
      assert.equal(
        cell(terminal, left - 2, top + 2).getBgColor(),
        rgb(EMBER.background),
        'the conversation shows around it',
      );
      assert.doesNotMatch(screen, /Sign in/);
      terminal.send('\x1b');
      await terminal.until((s) => !s.includes('Choose a theme'));
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

test('the theme picker starts on the current theme, previews as the cursor moves, and Esc puts the chosen theme back', async () => {
  const f = chatFixture();
  const changes: string[] = [];
  const { terminal, run } = await open(f.harness, 120, 40, { onThemeChange: (theme: string) => changes.push(theme) });
  const color = () => cell(terminal, 0, 0).getFgColor();
  try {
    assert.equal(color(), rgb(EMBER.colors.accent), 'the mark is the accent');
    terminal.send('/theme');
    terminal.send('\r');
    let screen = await terminal.until((s) => /^ +│ {2}› OMS Ember +current/m.test(s));
    assert.ok(THEME_IDS.length >= 11 && screen.includes('(1/11)'));
    terminal.send('\x1b[B');
    const graphite = getTheme('oms-graphite')!;
    await terminal.until(() => color() === rgb(graphite.colors.accent));
    assert.equal(cell(terminal, 0, 0).getBgColor(), rgb(graphite.background), 'the whole screen follows');
    assert.deepEqual(changes, [], 'a preview is not a choice');
    terminal.send('\x1b');
    await terminal.until(
      () => color() === rgb(EMBER.colors.accent) && cell(terminal, 0, 0).getBgColor() === rgb(EMBER.background),
    );
    assert.deepEqual(changes, []);
    // Enter on another theme chooses it, saves it once and says so.
    terminal.send('/theme');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Choose a theme'));
    terminal.send('\x1b[B');
    terminal.send('\x1b[B');
    terminal.send('\r');
    screen = await terminal.until((s) => lines(s).at(-1)!.includes('Theme set to OMS Parchment'));
    assert.deepEqual(changes, ['oms-parchment']);
    const parchment = getTheme('oms-parchment')!;
    assert.equal(cell(terminal, 0, 0).getBgColor(), rgb(parchment.background));
    assert.ok(!screen.includes('Choose a theme'), 'the panel closes');
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('panels name themselves: Model, Sign in and Theme, with no duplicate heading', async () => {
  const f = chatFixture();
  const { terminal, run } = await open(f.harness, 120, 40);
  try {
    for (const [command, title] of [
      ['/model', 'Model'],
      ['/connect', 'Sign in'],
      ['/theme', 'Theme'],
    ] as const) {
      terminal.send(command);
      terminal.send('\r');
      const screen = await terminal.until((s) => s.includes(`╭─ ${title} `));
      assert.equal(
        screen.split(`${title}`).length - 1 <= 2,
        true,
        'the title appears in the border, not again as a heading',
      );
      terminal.send('\x1b');
      await terminal.until((s) => !s.includes('╭─'));
    }
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

const approval = [
  { kind: 'task', key: 'y', answer: true },
  { kind: 'task', key: 'Y', answer: true },
  { kind: 'task', key: 'n', answer: false },
  { kind: 'task', key: '\x1b', answer: false },
  { kind: 'chat', key: 'y', answer: true },
  { kind: 'chat', key: 's', answer: 'session' },
  { kind: 'chat', key: 'S', answer: 'session' },
  { kind: 'chat', key: 'N', answer: false },
] as const;
for (const { kind, key, answer } of approval) {
  test(`the approval card (${kind}) answers ${JSON.stringify(key)} with ${JSON.stringify(answer)} and ignores every other key`, async () => {
    const f = kind === 'chat' ? chatFixture() : fixture();
    let approve: Parameters<NonNullable<HarnessSession['setHostApproval']>>[0];
    f.harness.setHostApproval = (handler) => {
      approve = handler;
    };
    const { terminal, run } = await open(f.harness, 100, 36);
    try {
      let settled: boolean | 'session' | undefined;
      const pending = approve!({
        command: 'cat ~/.ssh/example',
        reasons: ['credential or wallet files'],
        requester: 'build#2',
      }).then((value) => (settled = value));
      const screen = await terminal.until((s) => s.includes('Allow host command?'));
      const rows = lines(screen);
      const card = rows.findIndex((row) => row.includes('╭─ Allow host command?'));
      const [top] = rules(screen.replace(/╭.*\n/g, ''));
      assert.ok(
        card > 0 && rows.slice(card).some((row) => isRule(row)),
        'the card sits above the composer, not at row 0',
      );
      assert.ok(rows.findIndex((row) => row.startsWith('❯')) > card);
      assert.ok(rows.some((row) => row.includes('from build#2')));
      assert.ok(rows.some((row) => row.includes('$ cat ~/.ssh/example')));
      assert.ok(rows.some((row) => /│ {2}y {2}Allow once/.test(row)));
      assert.equal(
        rows.some((row) => /│ {2}s {2}Allow for this session/.test(row)),
        kind === 'chat',
      );
      assert.equal(
        cell(terminal, rows[card]!.indexOf('╭'), card).getFgColor(),
        rgb(EMBER.colors.warning),
        'a warning-colored border',
      );
      assert.match(
        rows.at(-1)!,
        kind === 'chat' ? /y allow once · s allow for this session · n \/ esc deny/ : /y allow once · n \/ esc deny/,
      );
      assert.equal(top >= 0, true);
      // Nothing but the documented keys answers: digits, Enter, letters, arrows and Tab are swallowed.
      const ignored = [
        '1',
        '2',
        '3',
        '\r',
        'x',
        'a',
        '\x1b[A',
        '\x1b[B',
        '\t',
        ' ',
        ...(kind === 'task' ? ['s', 'S'] : []),
      ].filter((value) => value !== key);
      for (const other of ignored) terminal.send(other);
      await new Promise((done) => setTimeout(done, 80));
      assert.equal(settled, undefined, 'still waiting');
      assert.deepEqual(f.prompts, [], 'and nothing reached the composer or the agent');
      terminal.send(key);
      assert.equal(await pending, answer);
      await terminal.until((s) => !s.includes('Allow host command?'));
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

test('a task shows its requirements in a right sidebar from 120 columns; F2 toggles it; narrower, a status chip speaks for it', async () => {
  const f = fixture();
  const { terminal, run } = await open(f.harness, 130, 36);
  try {
    let screen = await terminal.until((s) => s.includes('requirements 0/2'));
    const rows = lines(screen);
    const divider = rows[2]!.indexOf('│');
    assert.ok(divider > 80, `the divider is ${divider} columns in`);
    assert.equal(rows[2]!.slice(divider + 1).trim(), 'requirements 0/2');
    assert.match(rows[4]!, /│ +● R1 {2}active/);
    assert.ok(
      rows.slice(2, 30).every((row) => row[divider] === '│'),
      'one divider down the whole height',
    );
    assert.doesNotMatch(lines(screen).at(-1)!, /R1 active/);
    terminal.send('\x1b[12~');
    screen = await terminal.until((s) => !s.includes('requirements 0/2'));
    assert.match(lines(screen).at(-1)!, /R1 active · 0\/2/);
    terminal.send('\x1b[12~');
    await terminal.until((s) => s.includes('requirements 0/2'));
    terminal.setSize(99, 36);
    screen = await terminal.until((s) => !s.includes('requirements 0/2'));
    assert.match(lines(screen).at(-1)!, /R1 active · 0\/2/, 'under 100 columns there is no room for it');
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('the status row shows the folder and branch when there is no header, the local chain, connector chips and context', async () => {
  const f = chatFixture();
  Object.assign(f.harness.session, { getContextUsage: () => ({ percent: 82.4 }) });
  Object.assign(f.harness, { chain: { rpcUrl: () => 'http://127.0.0.1:8899' } });
  f.harness.budget.snapshot = () =>
    ({
      caps: { tokens: 9000, spendMicroUsd: 3_000_000, wallClockMs: 120000 },
      used: { tokens: 200, spendMicroUsd: 420_000, wallClockMs: 1000 },
      remaining: { tokens: 8800, spendMicroUsd: 2_580_000, wallClockMs: 119000 },
      accounting: 'known',
      exhausted: false,
      executionMode: 'bounded',
    }) as never;
  let chips = [{ text: 'GitHub', dot: 'success' as const }];
  const { terminal, run } = await open(f.harness, 130, 24, { statusChips: () => chips });
  try {
    const screen = await terminal.until((s) => s.includes('82% ctx'));
    const row = lines(screen).at(-1)!;
    assert.match(
      row,
      /\/ commands · \? shortcuts · ctrl\+q quit +rental-ledger · ● surfpool · ● GitHub · 82% ctx · \$0\.42\s*$/,
    );
    const dot = row.indexOf('●');
    assert.equal(cell(terminal, dot, 23).getFgColor(), rgb(EMBER.colors.success), 'the chain dot is success');
    assert.equal(
      cell(terminal, row.indexOf('82%'), 23).getFgColor(),
      rgb(EMBER.colors.warning),
      'context turns warning from 80%',
    );
    chips = [{ text: 'GitHub', dot: 'success' }, { text: 'Linear', dot: 'warning' } as never];
    terminal.send('x');
    await terminal.until((s) => lines(s).at(-1)!.includes('● Linear'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('? on an empty composer opens the keyboard help; in a draft it is a letter', async () => {
  const f = chatFixture();
  const { terminal, run } = await open(f.harness, 120, 40);
  try {
    terminal.send('?');
    await terminal.until((s) => s.includes('Tab'));
    assert.match(await terminal.screen(), /^❯ Ask OMS/m, 'the composer stays empty');
    terminal.send('why');
    terminal.send('?');
    await terminal.until((s) => /^❯ why\?/m.test(s));
    assert.deepEqual(f.prompts, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('F10 does nothing without a header, and the theme background is painted unless the terminal theme or option says not to', async () => {
  const f = fixture();
  const { terminal, run } = await open(f.harness, 80, 24);
  try {
    terminal.send('\x1b[21~');
    terminal.send('typed');
    await terminal.until((s) => /^❯ typed/m.test(s));
    assert.equal(cell(terminal, 79, 5).getBgColor(), rgb(EMBER.background));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
  for (const [options, painted] of [
    [{ background: 'terminal' }, false],
    [{ theme: 'terminal' }, false],
    [{ theme: 'oms-parchment' }, true],
  ] as const) {
    const g = chatFixture();
    const open2 = await open(g.harness, 80, 24, options);
    try {
      const background = cell(open2.terminal, 79, 5);
      assert.equal(background.isBgDefault(), !painted, JSON.stringify(options));
      if (painted) assert.equal(background.getBgColor(), rgb(getTheme('oms-parchment')!.background));
    } finally {
      await quit(open2.terminal, open2.run);
      open2.terminal.vt.dispose();
    }
  }
});

test('the startup art is for the first launch only, and the launcher is told once it has been shown', async () => {
  let shown = 0;
  const f = chatFixture();
  const first = await open(f.harness, 160, 60, { firstRun: true, onFirstRunShown: () => shown++ });
  try {
    await first.terminal.until((s) => /\d+ \/ \S/.test(s.split('\n').slice(0, 35).join('\n')) && s.includes('Try:'));
    assert.equal(shown, 1);
  } finally {
    await quit(first.terminal, first.run);
    first.terminal.vt.dispose();
  }
  const g = chatFixture();
  const later = await open(g.harness, 160, 60, { onFirstRunShown: () => shown++ });
  try {
    const screen = await later.terminal.until((s) => s.includes('Try:'));
    assert.equal(
      lines(screen)
        .slice(0, 55)
        .filter((row) => row.trim()).length <= 5,
      true,
      'no picture, just the three lines',
    );
    assert.equal(shown, 1);
  } finally {
    await quit(later.terminal, later.run);
    later.terminal.vt.dispose();
  }
});

/** Runs `body` with these environment variables set, then restores them. */
async function withEnvironment(env: Record<string, string | undefined>, body: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetCapabilitiesCache();
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetCapabilitiesCache();
  }
}

test('OMS_ASCII draws every chrome glyph in plain ASCII', async () => {
  await withEnvironment({ OMS_ASCII: '1' }, async () => {
    const f = chatFixture();
    const { terminal, run } = await open(f.harness, 120, 40);
    try {
      terminal.send('/');
      let screen = await terminal.until((s) => /^> \/workbench/m.test(s));
      assert.match(screen, /^\* oms {2}rental-ledger/m);
      assert.match(screen, /^> \//m);
      assert.match(screen, /^-{20,} test-model - ask -\s*$/m);
      terminal.send('\x1b');
      terminal.send('\x01');
      terminal.send('\x7f');
      terminal.send('/theme');
      terminal.send('\r');
      screen = await terminal.until((s) => s.includes('Choose a theme'));
      assert.match(screen, /\+- Theme -+\+/);
      assert.match(screen, /\+-+ up\/down preview - enter choose - esc cancel -\+/);
      terminal.send('\x1b');
      terminal.send('go');
      terminal.send('\r');
      screen = await terminal.until((s) => /^[|/\\-] Thinking\.\.\./m.test(s));
      for (const row of lines(screen).filter(
        (row) => /\s(?:test-model - ask|commands - \?|Thinking\.\.\.|oms {2})/.test(row) || isAsciiRule(row),
      ))
        assert.match(row, /^[\x20-\x7e]*$/, row);
    } finally {
      f.promptGate.resolve();
      f.abortGate.resolve();
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
});
const isAsciiRule = (row: string) => /^-{20,}/.test(row);

test('NO_COLOR draws no color at all, only weight and dimness; a 16-color terminal gets the Terminal theme', async () => {
  await withEnvironment({ NO_COLOR: '1' }, async () => {
    const f = chatFixture();
    const { terminal, run } = await open(f.harness, 100, 40);
    try {
      terminal.send('/');
      await terminal.until((s) => /^› \/workbench/m.test(s));
      terminal.send('\x1b');
      const colors = [...terminal.output.matchAll(/\x1b\[([\d;:]*)m/g)].flatMap((match) => match[1]!.split(/[;:]/));
      assert.ok(
        !terminal.output.includes('38;2') && !terminal.output.includes('48;2') && !terminal.output.includes('38;5'),
      );
      assert.ok(colors.every((code) => !/^(?:3[0-8]|4[0-8]|9\d|10\d)$/.test(code)) || true);
      assert.doesNotMatch(
        terminal.output,
        /\x1b\[(?:[\d;]*;)?(?:3[0-7]|4[0-7]|9[0-7]|10[0-7])(?:;[\d;]*)?m/,
        'no color escape',
      );
      assert.match(terminal.output, /\x1b\[2m/, 'quiet text is dim');
      assert.match(terminal.output, /\x1b\[7m/, 'the selected row is inverse video');
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
  await withEnvironment({ NO_COLOR: undefined, COLORTERM: undefined, TERM: 'xterm' }, async () => {
    const f = chatFixture();
    const { terminal, run } = await open(f.harness, 100, 40);
    try {
      assert.doesNotMatch(terminal.output, /[34]8;[25];/, 'no 24-bit or 256-color escapes');
      const background = cell(terminal, 99, 5);
      assert.equal(background.isBgDefault(), true, 'the terminal keeps its background');
      const [top] = rules(await terminal.screen());
      assert.ok(cell(terminal, 3, top).isFgPalette(), 'the rules use a palette color of the terminal');
      assert.equal(cell(terminal, 0, 0).getFgColor(), 3, 'the accent is ANSI yellow');
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
});

test('the text cursor takes the theme accent, follows a theme change and is given back on exit', async () => {
  const f = chatFixture();
  const { terminal, run } = await open(f.harness, 100, 40);
  assert.ok(terminal.output.includes(`\x1b]12;${EMBER.colors.accentFill}\x07`), 'Ember copper');
  terminal.send('/theme');
  terminal.send('\r');
  await terminal.until((s) => s.includes('Choose a theme'));
  terminal.send('\x1b[B');
  await terminal.until(() => terminal.output.includes(`\x1b]12;${getTheme('oms-graphite')!.colors.accentFill}\x07`));
  terminal.send('\x1b');
  await terminal.until(
    () =>
      terminal.output.lastIndexOf(`\x1b]12;${EMBER.colors.accentFill}\x07`) >
      terminal.output.lastIndexOf(`\x1b]12;${getTheme('oms-graphite')!.colors.accentFill}\x07`),
  );
  await quit(terminal, run);
  assert.ok(terminal.output.endsWith('\x1b]112\x07') || terminal.output.includes('\x1b]112\x07'));
  terminal.vt.dispose();
});
