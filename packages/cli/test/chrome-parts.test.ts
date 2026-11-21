import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { OMS_COMMANDS } from '../src/tui/commands.ts';
import {
  emptyStateRows,
  headerLeft,
  placeholderRow,
  promptRow,
  requirementsRows,
  ruleRow,
  warningRows,
} from '../src/tui/chrome-rows.ts';
import { glyphsFor } from '../src/tui/glyphs.ts';
import { approvalCard, boxLines, Panel } from '../src/tui/panel.ts';
import { argumentUsage, POPUP_ROWS, slashChoices, slashPopup } from '../src/tui/slash-popup.ts';
import { formatCount, formatElapsed, SpinnerRow, toolVerb } from '../src/tui/spinner.ts';
import { getTheme } from '../src/tui/theme.ts';

const theme = getTheme('oms-ember')!;
const glyphs = glyphsFor({});
const ascii = glyphsFor({ OMS_ASCII: '1' });
const plain = (text: string) => stripTerminalSequences(text.replaceAll(CURSOR_MARKER, ''));

test('glyphs are Unicode, plain ASCII for OMS_ASCII or a Linux console, and hold still when motion is reduced', () => {
  assert.equal(glyphs.ascii, false);
  assert.equal(glyphs.prompt, '❯');
  for (const env of [{ OMS_ASCII: '1' }, { OMS_ASCII: 'true' }, { TERM: 'linux' }, { TERM: 'dumb' }]) {
    const g = glyphsFor(env);
    assert.equal(g.ascii, true, JSON.stringify(env));
    for (const glyph of [
      g.mark,
      g.prompt,
      g.dot,
      g.pointer,
      g.rule,
      g.vertical,
      g.separator,
      g.ellipsis,
      g.down,
      g.queued,
      ...g.spinner,
      ...Object.values(g.corners),
    ])
      assert.match(glyph, /^[\x20-\x7e]+$/, `${JSON.stringify(env)} ${glyph}`);
  }
  assert.equal(glyphsFor({ OMS_ASCII: '0', TERM: 'xterm-256color' }).ascii, false);
  assert.deepEqual(glyphsFor({ OMS_REDUCED_MOTION: '1' }).spinner, ['●']);
  assert.deepEqual(glyphsFor({ OMS_REDUCED_MOTION: '1', OMS_ASCII: '1' }).spinner, ['*']);
  assert.equal(glyphs.spinner.length, 10);
  assert.equal(glyphs.spinnerMs, 80);
});

test('slash choices rank names that start with the text, then contain it, then fuzzy matches, then descriptions', () => {
  const names = (draft: string) => slashChoices(draft, 'task')?.map((command) => command.name);
  assert.equal(names('hello'), undefined, 'ordinary text is not a command');
  assert.equal(names('/model x'), undefined, 'arguments stay normal input');
  assert.equal(names('/')?.length, OMS_COMMANDS.filter((command) => command.availability !== 'chat').length);
  assert.equal(names('/')![0], 'workbench', 'an empty name lists the commands in menu order');
  const th = names('/th')!;
  assert.equal(th[0], 'theme', 'the name that starts with it comes first');
  const contains = names('/ile')!;
  assert.ok(
    contains.indexOf('files') >= 0 && contains.indexOf('files') < (contains.indexOf('goal') + 1 || 99),
    'contains beats a description match',
  );
  const fuzzy = names('/wbn')!;
  assert.ok(fuzzy.includes('workbench'), 'in-order letters match');
  const description = names('/sandbox')!;
  assert.ok(description.includes('terminal'), 'the description is searched too');
  assert.deepEqual(names('/zzzz'), []);
  // A chat hides task commands, a task hides chat commands.
  assert.ok(slashChoices('/', 'chat')!.every((command) => command.availability !== 'task'));
  assert.ok(!slashChoices('/', 'task')!.some((command) => command.availability === 'chat'));
});

test('an argument hint appears once a command that needs one is complete', () => {
  assert.equal(argumentUsage('/error ', 'task'), '/error <code> [program]');
  assert.equal(argumentUsage('/error', 'task'), undefined);
  assert.equal(argumentUsage('/error 6000', 'task'), undefined);
  assert.equal(argumentUsage('/help ', 'task'), '/help [keys]');
  assert.equal(argumentUsage('/quit ', 'task'), undefined, 'no argument, no hint');
  assert.equal(argumentUsage('/requirements ', 'chat'), undefined, 'not offered in this session');
});

test('the slash popup is two columns, at most eight rows, with the selection on the raised surface', () => {
  const choices = slashChoices('/', 'task')!;
  const rows = slashPopup(theme, glyphs, choices, 0, 90);
  assert.equal(rows.length, POPUP_ROWS);
  assert.ok(rows.every((row) => visibleWidth(row) <= 90));
  assert.match(plain(rows[0]!), /^› \/workbench +Editor, files and terminal/);
  assert.match(plain(rows[1]!), /^ {2}\/harness +Back to the conversation/);
  assert.ok(rows[0]!.includes('48;2;'), 'the selected row has a background');
  assert.ok(!rows[1]!.includes('48;2;'));
  assert.match(
    plain(rows[3]!),
    /\/terminal \[start\|stop\|hide\] +Sandbox shell/,
    'the argument hint follows the name',
  );
  // Moving past the last visible row scrolls the window.
  const scrolled = slashPopup(theme, glyphs, choices, 11, 90).map(plain);
  assert.equal(scrolled.length, POPUP_ROWS);
  assert.ok(scrolled.at(-1)!.startsWith('›'), scrolled.join('\n'));
  assert.equal(slashPopup(theme, glyphs, choices, 0, 90, 3).length, 3);
  assert.equal(slashPopup(theme, glyphs, [], 0, 90).length, 1);
  assert.match(plain(slashPopup(theme, glyphs, [], 0, 90)[0]!), /No command matches/);
  // Narrow widths drop the description with an ellipsis, never wrap.
  const narrow = slashPopup(theme, glyphs, choices, 0, 30).map(plain);
  assert.ok(narrow.every((row) => visibleWidth(row) <= 30));
  assert.match(narrow[0]!, /^› \/workbench/);
  assert.match(slashPopup(theme, ascii, choices, 0, 60).map(plain)[0]!, /^> \/workbench/);
});

test('elapsed time and counts are compact', () => {
  assert.deepEqual([0, 4_999, 12_000, 59_999, 64_000, 3_599_000, 3_722_000].map(formatElapsed), [
    '0s',
    '4s',
    '12s',
    '59s',
    '1m 04s',
    '59m 59s',
    '1h 02m',
  ]);
  assert.deepEqual([0, 412, 999, 1_000, 1_234, 9_960, 12_345, 999_999, 1_300_000].map(formatCount), [
    '0',
    '412',
    '999',
    '1k',
    '1.2k',
    '10k',
    '12k',
    '1M',
    '1.3M',
  ]);
});

test('the spinner names what the agent is doing from its current tool', () => {
  assert.equal(toolVerb(undefined, undefined), 'Thinking');
  assert.equal(toolVerb('read', { path: '/work/proj/programs/escrow/lib.rs' }), 'Reading escrow/lib.rs');
  assert.equal(toolVerb('edit', { file_path: 'lib.rs' }), 'Editing lib.rs');
  assert.equal(toolVerb('write', {}), 'Writing');
  assert.equal(toolVerb('bash', { command: 'anchor test --skip-build' }), 'Running anchor test --skip-build');
  assert.equal(toolVerb('bash', { command: 'x'.repeat(200) }).length, 'Running '.length + 48);
  assert.equal(toolVerb('web_search', { query: 'secret' }), 'Searching the web');
  assert.equal(toolVerb('solana_docs_search', { query: 'pda' }), 'Searching Solana docs');
  assert.equal(toolVerb('agent', {}), 'Running a helper agent');
  assert.equal(toolVerb('propose_done', {}), 'Checking the requirements');
  assert.equal(toolVerb('custom_tool', {}), 'Running custom tool');
  assert.ok(
    !toolVerb('bash', { command: 'a\x1b]52;c;x\x07b\nc' }).includes('\x1b'),
    'tool arguments cannot inject escapes',
  );
});

test('the spinner row shows an animated frame, the verb, time, tokens and how to stop, and cuts to its width', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let renders = 0;
  const ui = { requestRender: () => void renders++ } as unknown as TUI;
  let elapsedMs = 12_000;
  let tokens = 1_234;
  const row = new SpinnerRow(
    ui,
    () => theme,
    glyphs,
    () => ({ verb: 'Reading lib.rs', elapsedMs, tokens }),
  );
  try {
    // It does not animate until work starts.
    t.mock.timers.tick(1000);
    assert.equal(renders, 1, 'only the construction redraw');
    row.start();
    const first = plain(row.render(80)[0]!);
    assert.match(first, /^⠋ Reading lib\.rs… +12s · ↓ 1\.2k · esc to interrupt$/);
    const before = renders;
    t.mock.timers.tick(80 * 3);
    assert.ok(renders >= before + 3, 'the Loader redraws every frame');
    assert.match(plain(row.render(80)[0]!), /^⠸ Reading/, 'the frame advanced');
    elapsedMs = 64_000;
    tokens = 0;
    assert.match(plain(row.render(80)[0]!), / 1m 04s · esc to interrupt$/);
    assert.ok(!plain(row.render(80)[0]!).includes('↓'), 'no token count until there is one');
    // A narrow row keeps the time and drops the stop hint, then cuts the verb.
    const narrow = plain(row.render(36)[0]!);
    assert.ok(visibleWidth(narrow) <= 36 && narrow.includes('1m 04s') && !narrow.includes('interrupt'), narrow);
    assert.ok(row.render(20).every((line) => visibleWidth(line) <= 20));
    assert.equal(row.render(80).length, 1, "one row, not the Loader's two");
    row.stop();
    const stopped = renders;
    t.mock.timers.tick(1000);
    assert.equal(renders, stopped, 'stopped for good when work ends');
  } finally {
    row.stop();
  }
});

test('the spinner holds still with reduced motion and draws plain ASCII frames without Unicode', () => {
  const ui = { requestRender() {} } as unknown as TUI;
  const still = new SpinnerRow(
    ui,
    () => theme,
    glyphsFor({ OMS_REDUCED_MOTION: '1' }),
    () => ({ verb: 'Thinking', elapsedMs: 0, tokens: 0 }),
  );
  const flat = new SpinnerRow(
    ui,
    () => theme,
    ascii,
    () => ({ verb: 'Thinking', elapsedMs: 0, tokens: 0 }),
  );
  try {
    assert.match(plain(still.render(60)[0]!), /^● Thinking…/);
    assert.match(plain(flat.render(60)[0]!), /^\| Thinking\.\.\./);
    assert.match(plain(flat.render(60)[0]!), /^[\x20-\x7e]+$/);
  } finally {
    still.stop();
    flat.stop();
  }
});

test('rules are full width, brighten when focused and carry the model and mode at the right end', () => {
  const blurred = ruleRow(theme, glyphs, 40, false);
  const focused = ruleRow(theme, glyphs, 40, true);
  assert.equal(plain(blurred), '─'.repeat(40));
  assert.notEqual(blurred, focused);
  assert.ok(blurred.includes('38;2;59;51;45') && focused.includes('38;2;154;100;64'), 'border, then borderFocus');
  const labelled = ruleRow(theme, glyphs, 40, true, [
    { text: 'sonnet-4.5', role: 'muted' },
    { text: 'ask', role: 'muted' },
  ]);
  assert.equal(plain(labelled), '─'.repeat(21) + ' sonnet-4.5 · ask ─');
  assert.equal(visibleWidth(labelled), 40);
  const yolo = ruleRow(theme, glyphs, 40, false, [
    { text: 'm', role: 'muted' },
    { text: 'yolo', role: 'error' },
  ]);
  assert.ok(yolo.includes('38;2;228;111;111'), 'yolo is drawn in the error color');
  assert.equal(
    visibleWidth(ruleRow(theme, glyphs, 24, false, [{ text: 'a-very-long-model-name', role: 'muted' }])),
    24,
  );
  assert.match(plain(ruleRow(theme, ascii, 30, true, [{ text: 'm', role: 'muted' }])), /^-+ m -$/);
  assert.equal(
    plain(ruleRow(theme, glyphs, 8, false, [{ text: 'm', role: 'muted' }])),
    '─'.repeat(8),
    'too narrow for a label',
  );
  // The merged spinner of a short terminal: `── ⠹ Reading lib.rs… 12s ──`.
  const merged = ruleRow(theme, glyphs, 40, false, [], '⠹ Reading lib.rs… 12s');
  assert.equal(plain(merged), '── ⠹ Reading lib.rs… 12s ' + '─'.repeat(15));
  assert.equal(visibleWidth(ruleRow(theme, glyphs, 20, false, [], 'x'.repeat(60))), 20);
});

test('the prompt is accent when focused and faint when blurred, the placeholder is one faint line with the cursor on it', () => {
  assert.ok(promptRow(theme, glyphs, true).includes('38;2;217;140;95'));
  assert.ok(promptRow(theme, glyphs, false).includes('38;2;122;109;98'));
  assert.equal(plain(promptRow(theme, glyphs, true)), '❯ ');
  assert.equal(plain(promptRow(theme, ascii, true)), '> ');
  assert.equal(plain(promptRow(theme, glyphs, true, '!')), '! ');
  const focused = placeholderRow(theme, glyphs, 'Ask OMS to build…', true, 40);
  assert.ok(focused.includes(CURSOR_MARKER), 'the hardware cursor is placed on the first letter');
  assert.equal(plain(focused), 'Ask OMS to build…');
  assert.ok(!placeholderRow(theme, glyphs, 'Ask OMS', false, 40).includes(CURSOR_MARKER));
  assert.equal(plain(placeholderRow(theme, glyphs, 'Ask OMS to build, test or explain', false, 12)), 'Ask OMS to …');
});

test('the header names the folder and branch; the empty state is three lines; a warning is marked and wrapped', () => {
  assert.equal(plain(headerLeft(theme, glyphs, 'escrow', 'oms/escrow', 60)), '◆ oms  escrow  oms/escrow');
  assert.equal(plain(headerLeft(theme, glyphs, 'escrow', undefined, 60)), '◆ oms  escrow');
  assert.equal(plain(headerLeft(theme, ascii, 'escrow', undefined, 60)), '* oms  escrow');
  assert.equal(visibleWidth(headerLeft(theme, glyphs, 'x'.repeat(100), 'y'.repeat(100), 30)), 30);
  assert.deepEqual(
    emptyStateRows(
      theme,
      glyphs,
      { version: '0.1.2', model: 'sonnet-4.5', folder: 'escrow', rows: 40 },
      'Try: add a withdraw instruction',
    ).map(plain),
    ['◆ oms 0.1.2', '  sonnet-4.5 · escrow', '  Try: add a withdraw instruction'],
  );
  assert.deepEqual(
    emptyStateRows(theme, glyphs, { version: '', model: undefined, folder: 'escrow', rows: 40 }, 'Run /connect').map(
      plain,
    ),
    ['◆ oms', '  No model connected · escrow', '  Run /connect'],
  );
  assert.equal(
    emptyStateRows(theme, glyphs, { version: '0.1.2', model: 'm', folder: 'f', rows: 6 }, 'x').length,
    1,
    'a tiny screen gets one line',
  );
  const warning = warningRows(
    theme,
    'Run /connect to sign in or /model to choose a model. Your draft is kept.',
    40,
  ).map(plain);
  assert.ok(warning.length > 1 && warning[0]!.startsWith('! ') && warning[1]!.startsWith('  '));
  assert.ok(warning.every((line) => visibleWidth(line) <= 40));
  assert.deepEqual(warningRows(theme, '', 40), []);
});

test('requirements list their state, close count and selection, with the raised surface on the selected one', () => {
  const items = [
    { id: 'R1', title: 'Calculate rent exactly', status: 'active' },
    { id: 'R2', title: 'Reject duplicate deposits', status: 'closed' },
    { id: 'R3', title: 'Refund on close', status: 'proposed' },
    { id: 'R4', title: 'Rounding', status: 'open' },
  ];
  const rows = requirementsRows(theme, glyphs, items, 'R1', true, 30);
  const text = rows.map(plain);
  assert.equal(text[0], 'requirements 1/4');
  assert.equal(text[2]!.trimEnd(), '› ● R1  active');
  assert.equal(text[3]!.trimEnd(), '    Calculate rent exactly');
  assert.match(text[5]!, /^ {2}✓ R2 {2}closed/);
  assert.match(text[8]!, /^ {2}◆ R3 {2}proposed/);
  assert.match(text[11]!, /^ {2}○ R4 {2}open/);
  assert.ok(rows[2]!.includes('48;2;') && !rows[5]!.includes('48;2;'), 'only the selected one is raised');
  assert.ok(rows.every((row) => visibleWidth(row) <= 30));
  assert.match(
    requirementsRows(theme, glyphs, items, 'R1', false, 30).map(plain)[2]!,
    /^ {2}● R1/,
    'no pointer without focus',
  );
  assert.deepEqual(requirementsRows(theme, glyphs, [], undefined, false, 30).map(plain), [
    'requirements',
    '',
    'Task state unavailable',
  ]);
});

test('boxes are rounded with the title and hints in the borders, exact width, on the surface', () => {
  const lines = boxLines({
    theme,
    glyphs,
    width: 40,
    title: 'Model',
    hint: '↑↓ select · esc',
    border: 'borderFocus',
    rows: ['one', 'two'],
  });
  const text = lines.map(plain);
  assert.equal(text.length, 2 + 2 + 2, 'borders, one padding row each side, two rows');
  assert.ok(lines.every((line) => visibleWidth(line) === 40));
  assert.equal(text[0], '╭─ Model ' + '─'.repeat(40 - 10) + '╮');
  assert.equal(text[1], '│' + ' '.repeat(38) + '│');
  assert.equal(text[2], '│  one' + ' '.repeat(40 - 7) + '│', 'two columns of inner padding');
  assert.equal(text.at(-1), '╰' + '─'.repeat(20) + ' ↑↓ select · esc ─╯');
  assert.ok(
    lines.every((line) => line.includes('48;2;34;29;25')),
    'every row is painted on the surface',
  );
  const rounded = boxLines({ theme, glyphs: ascii, width: 20, title: 'A', border: 'border', rows: [] }).map(plain);
  assert.deepEqual(
    [rounded[0]![0], rounded[0]!.at(-1), rounded.at(-1)![0], rounded.at(-1)!.at(-1), rounded[1]![0]],
    ['+', '+', '+', '+', '|'],
  );
  assert.equal(boxLines({ theme, glyphs, width: 40, title: '', border: 'border', rows: ['x'], padY: 0 }).length, 3);
  // Untrusted titles and hints cannot add escapes or rows.
  const hostile = boxLines({
    theme,
    glyphs,
    width: 30,
    title: 'a\nb\x1b]52;c;x\x07',
    hint: 'h\x1b[2J',
    border: 'border',
    rows: [],
  });
  assert.equal(hostile.length, 4);
  assert.ok(hostile.every((line) => !line.includes('\x1b]52') && !line.includes('\x1b[2J')));
});

test('the panel caps its height, keeps the input row and gives the body what is left', () => {
  let maxRows = 20;
  let compact = false;
  const panel = new Panel({
    theme: () => theme,
    glyphs,
    title: () => 'Theme',
    hint: () => 'esc cancel',
    body: { invalidate() {}, render: () => Array.from({ length: 50 }, (_, i) => `row ${i}`) },
    input: { invalidate() {}, render: () => ['Filter: x'] },
    maxRows: () => maxRows,
    compact: () => compact,
  });
  assert.equal(panel.bodyRows(), 20 - 5, 'borders, padding and the input row');
  let lines = panel.render(60).map(plain);
  assert.equal(lines.length, 20);
  assert.equal(lines[2], '│  row 0' + ' '.repeat(60 - 9) + '│');
  assert.match(lines.at(-3)!, /^│ {2}Filter: x/);
  assert.match(lines[0]!, /^╭─ Theme /);
  compact = true;
  maxRows = 10;
  assert.equal(panel.bodyRows(), 10 - 3);
  lines = panel.render(60).map(plain);
  assert.equal(lines.length, 10);
  assert.match(lines[1]!, /^│ {2}row 0/, 'no padding row when compact');
});

test('the approval card shows the request in a warning box with the keys it answers to, and only presentation', () => {
  const rows = (request: Parameters<typeof approvalCard>[2], width = 80) =>
    approvalCard(theme, glyphs, request, width).map(plain);
  const once = rows({ reasons: ['credential or wallet files'], command: 'cat ~/.ssh/example', session: false });
  assert.match(once[0]!, /^╭─ Allow host command\? ─+╮$/);
  assert.ok(once.some((line) => line.includes('credential or wallet files')));
  assert.ok(once.some((line) => line.includes('$ cat ~/.ssh/example')));
  assert.ok(once.some((line) => /│ {2}y {2}Allow once/.test(line)));
  assert.ok(once.some((line) => /│ {2}n {2}Deny {2}esc/.test(line)));
  assert.ok(!once.some((line) => /Allow for this session/.test(line)), 'a task has no session approval');
  const chat = rows({ requester: 'build#2', reasons: ['sudo'], command: 'python x.py', session: true });
  assert.ok(chat.some((line) => /│ {2}s {2}Allow for this session/.test(line)));
  assert.ok(chat.some((line) => line.includes('from build#2')));
  assert.match(chat.at(-1)!, /^╰─+╯$/);
  const longRequest = {
    reasons: [],
    command: Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'),
    session: true,
  };
  // Without a window the card draws every row of the command: nothing is hidden from the person who allows it.
  const whole = rows(longRequest);
  assert.ok(whole.some((line) => line.includes('line 11')));
  assert.ok(!whole.some((line) => /more/.test(line)));
  // In a window the rest scrolls, and Allow is marked locked until the last row has been shown.
  const window = (offset: number) => approvalCard(theme, glyphs, longRequest, 80, { rows: 6, offset }).map(plain);
  const top = window(0);
  assert.ok(top.some((line) => line.includes('line 5')) && !top.some((line) => line.includes('line 6')));
  assert.ok(top.some((line) => line.includes('↓ 6 more · ↑↓ scroll')));
  assert.ok(top.some((line) => /read the whole command first/.test(line)));
  const end = window(6);
  assert.ok(end.some((line) => line.includes('line 11')) && !end.some((line) => line.includes('line 5')));
  assert.ok(end.some((line) => line.includes('↑ 6 above')));
  assert.ok(!end.some((line) => /read the whole command first/.test(line)), 'Allow opens at the end');
  const hostile = approvalCard(
    theme,
    glyphs,
    { reasons: ['x\x1b[2J'], command: 'echo \x1b]52;c;x\x07 hi', requester: 'r\x1b[2J', session: false },
    60,
  );
  assert.ok(
    hostile.every((line) => !line.includes('\x1b]52') && !line.includes('\x1b[2J') && visibleWidth(line) === 60),
  );
  assert.ok(
    approvalCard(theme, glyphs, { reasons: [], command: 'ls', session: false }, 60)[0]!.includes('38;2;228;182;94'),
    'a warning-colored border',
  );
});

test('every drawn chrome part is plain ASCII with OMS_ASCII', () => {
  const asciiOnly = (lines: string[]) => lines.map(plain).every((line) => /^[\x20-\x7e]*$/.test(line));
  const choices = slashChoices('/', 'task')!;
  assert.ok(
    asciiOnly(slashPopup(theme, ascii, choices, 0, 80).map((line) => line.replace('Back to the conversation', 'x'))),
  );
  assert.ok(
    asciiOnly(
      boxLines({ theme, glyphs: ascii, width: 30, title: 'Model', hint: 'esc', border: 'border', rows: ['x'] }),
    ),
  );
  assert.ok(asciiOnly(approvalCard(theme, ascii, { reasons: ['r'], command: 'ls', session: true }, 50)));
  assert.ok(
    asciiOnly([
      ruleRow(theme, ascii, 40, true, [{ text: 'm', role: 'muted' }]),
      headerLeft(theme, ascii, 'p', 'b', 40),
      promptRow(theme, ascii, true),
    ]),
  );
  assert.ok(asciiOnly(emptyStateRows(theme, ascii, { version: '1', model: 'm', folder: 'f', rows: 30 }, 'Try: x')));
});
