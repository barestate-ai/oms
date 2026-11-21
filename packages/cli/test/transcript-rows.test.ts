import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  resetCapabilitiesCache,
  setCapabilityOverrides,
  stripTerminalSequences,
  visibleWidth,
} from '@earendil-works/pi-tui';
import { getTheme, type OmsTheme } from '../src/tui/theme.ts';
import { Conversation, copyableText, type ConversationOptions } from '../src/tui/transcript.ts';

const usage = {
  input: 1,
  output: 1000,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const message = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  role: 'assistant',
  content,
  stopReason: 'stop',
  usage,
  api: 'x',
  provider: 'p',
  model: 'm',
  timestamp: 2,
  ...extra,
});
const rgb = (hex: string, target: 38 | 48) =>
  `\x1b[${target};2;${[1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(';')}m`;
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const theme: OmsTheme = getTheme('gruvbox')!;
const fg = (role: keyof OmsTheme['colors']) => rgb(theme.colors[role], 38);
const bg = (role: 'surface' | 'diffAdded' | 'diffRemoved') => rgb(theme.backgrounds[role], 48);

/** A conversation on a clock the test moves, drawn in gruvbox. */
function session(options: ConversationOptions = {}) {
  const clock = { now: 1_000_000 };
  const conversation = new Conversation([], undefined, { cwd: '/work/project', now: () => clock.now, ...options });
  conversation.applyTheme(theme);
  const accept = (event: unknown) => conversation.accept(event as never);
  return {
    clock,
    conversation,
    accept,
    user(text: string) {
      accept({ type: 'message_start', message: { role: 'user', content: text, timestamp: 1 } });
    },
    reply(content: unknown[], extra: Record<string, unknown> = {}) {
      const value = message(content, extra);
      accept({ type: 'message_start', message: value });
      accept({ type: 'message_end', message: value });
      return value;
    },
    call(id: string, name: string, args: Record<string, unknown>) {
      const value = message([{ type: 'toolCall', id, name, arguments: args }], { stopReason: 'toolUse' });
      accept({ type: 'message_start', message: value });
      accept({ type: 'message_end', message: value });
    },
    start(id: string, name: string, args: Record<string, unknown>) {
      accept({ type: 'tool_execution_start', toolCallId: id, toolName: name, args });
    },
    end(id: string, name: string, text: string, extra: { isError?: boolean; details?: unknown } = {}) {
      accept({
        type: 'tool_execution_end',
        toolCallId: id,
        toolName: name,
        isError: extra.isError ?? false,
        result: { content: [{ type: 'text', text }], details: extra.details },
      });
    },
    /** A whole call: announced, run and finished. */
    run(id: string, name: string, args: Record<string, unknown>, text: string, extra = {}) {
      this.call(id, name, args);
      this.start(id, name, args);
      this.end(id, name, text, extra);
    },
  };
}

// ---------------------------------------------------------------- the user's turn

test('a prompt is a surface band with an accent marker and bold text, clipped to six lines', () => {
  const s = session();
  s.user('Add a vault');
  const [row] = s.conversation.render(60);
  assert.equal(plain([row!])[0], ' ❯ Add a vault');
  assert.ok(row!.includes(bg('surface')), 'on the surface color');
  assert.ok(row!.includes(fg('accent') + '❯'), 'the marker is accent');
  assert.ok(row!.includes('\x1b[1mAdd a vault'), 'the text is bold');
  assert.equal(visibleWidth(row!), 60, 'the band spans the width');

  const long = session();
  long.user(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
  const clipped = plain(long.conversation.render(60));
  assert.deepEqual(
    clipped.slice(0, 6),
    [1, 2, 3, 4, 5, 6].map((n) => (n === 1 ? ` ❯ line 1` : `   line ${n}`)),
  );
  assert.equal(clipped[6], '   … +4 lines (ctrl+o to expand)');
  long.conversation.toggleToolOutput();
  const all = plain(long.conversation.render(60));
  assert.equal(all.length, 10);
  assert.equal(all[9], '   line 10');
});

test('a tall terminal pads the band by a row above and below, a short one does not', () => {
  for (const [rows, expected] of [
    [24, 1],
    [40, 3],
  ] as const) {
    const s = session({ rows: () => rows });
    s.user('hello');
    const lines = s.conversation.render(40);
    assert.equal(lines.length, expected);
    assert.ok(lines.every((line) => line.includes(bg('surface'))));
  }
});

// ---------------------------------------------------------------- assistant prose

test('prose is indented under the glyph column, with bold headings, muted bullets and one blank line before a heading', () => {
  const s = session();
  s.reply([{ type: 'text', text: 'Intro line.\n- first\n- second\n## Next steps\nDo `it` now.\n\n\n\nEnd.' }]);
  const lines = s.conversation.render(60);
  assert.deepEqual(plain(lines), [
    '  Intro line.',
    '  • first',
    '  • second',
    '',
    '  Next steps',
    '  Do it now.',
    '',
    '  End.',
  ]);
  assert.ok(lines[4]!.includes('\x1b[1m'), 'a heading is bold');
  assert.ok(!lines[4]!.includes(fg('accent')), 'and only H1 is accent');
  assert.ok(lines[5]!.includes(fg('accent') + 'it'), 'inline code is accent');
  assert.ok(lines[1]!.includes(fg('muted') + '• '), 'bullets are muted');
  const h1 = session();
  h1.reply([{ type: 'text', text: '# Title\ntext' }]);
  assert.ok(h1.conversation.render(60)[0]!.includes(fg('accent')), 'H1 is accent');
  assert.ok(!h1.conversation.render(60)[0]!.includes('\x1b[4m'), 'and not underlined');
});

test('a code block sits on the surface with its language at the right and no fences', () => {
  const s = session();
  s.reply([{ type: 'text', text: 'Here:\n\n```rust\nlet x = 1;\n  let y = 2;\n```\nDone.' }]);
  const lines = s.conversation.render(40);
  const text = plain(lines);
  assert.deepEqual(text.slice(0, 2), ['  Here:', '']);
  assert.match(text[2]!, /^ {2} let x = 1;\s+rust$/);
  assert.equal(text[3], '     let y = 2;');
  assert.equal(text[4], '');
  assert.equal(text[5], '  Done.');
  assert.ok(!text.join('\n').includes('```'));
  for (const row of lines.slice(2, 4)) {
    assert.ok(row.includes(bg('surface')), 'code rows are on the surface');
    assert.equal(visibleWidth(row), 40);
  }
  assert.ok(lines[2]!.includes(fg('syntaxKeyword') + 'let'), 'and highlighted');
});

test('an unfinished code block while the answer streams draws as an open block', () => {
  const s = session();
  const partial = message([{ type: 'text', text: 'Code:\n```ts\nconst a = 1;' }]);
  s.accept({ type: 'message_start', message: partial });
  const lines = plain(s.conversation.render(40));
  assert.equal(lines[0], '  Code:');
  assert.match(lines[2]!, /^ {2} const a = 1;\s+ts$/);
});

test('a link carries its address as an OSC 8 hyperlink when the terminal can follow it, in text when it cannot', () => {
  const link = { type: 'text', text: 'See [the docs](https://solana.com/docs).' };
  try {
    setCapabilityOverrides({ hyperlinks: true });
    const linked = session();
    linked.reply([link]);
    const row = linked.conversation.render(60)[0]!;
    assert.equal(plain([row])[0], '  See the docs.');
    assert.ok(row.includes('\x1b]8;;https://solana.com/docs'), 'the address is the link target');
    assert.ok(row.includes(fg('info')), 'a link has its own color');
    assert.ok(row.includes('\x1b[4m'), 'and is underlined');
    setCapabilityOverrides({ hyperlinks: false });
    const text = session();
    text.reply([link]);
    assert.equal(plain(text.conversation.render(60))[0], '  See the docs (https://solana.com/docs).');
  } finally {
    resetCapabilitiesCache();
  }
});

// ---------------------------------------------------------------- thinking

test('thinking folds to one line with its duration, shows live as Thinking…, and Ctrl+T opens it', () => {
  const s = session();
  s.accept({ type: 'agent_start' });
  const first = message([{ type: 'thinking', thinking: 'Weigh the seeds.' }]);
  s.accept({ type: 'message_start', message: first });
  assert.deepEqual(plain(s.conversation.render(60)), ['∴ Thinking…']);
  s.clock.now += 3400;
  const done = message([
    { type: 'thinking', thinking: 'Weigh the seeds.' },
    { type: 'text', text: 'Use two seeds.' },
  ]);
  s.accept({ type: 'message_update', message: done });
  s.accept({ type: 'message_end', message: done });
  assert.deepEqual(plain(s.conversation.render(60)), ['∴ Thought for 3s', '', '  Use two seeds.']);
  assert.equal(s.conversation.toggleThinking(), false);
  assert.deepEqual(plain(s.conversation.render(60)), [
    '∴ Thought for 3s',
    '  Weigh the seeds.',
    '',
    '  Use two seeds.',
  ]);
});

// ---------------------------------------------------------------- tool rows

test('a call is a dot in its state color: running accent, done success, failed error with the exit code', () => {
  const s = session({ env: { OMS_REDUCED_MOTION: '1' } });
  s.call('b1', 'bash', { command: 'anchor test' });
  let lines = s.conversation.render(80);
  assert.equal(plain(lines)[0], '● Running  anchor test');
  assert.ok(lines[0]!.startsWith(fg('accent') + '●'));
  s.start('b1', 'bash', { command: 'anchor test' });
  s.clock.now += 1500;
  s.end('b1', 'bash', 'ok\n');
  lines = s.conversation.render(80);
  assert.deepEqual(plain(lines), ['● Ran  anchor test', '  ⎿  ok']);
  assert.ok(lines[0]!.startsWith(fg('success') + '●'));

  const failed = session();
  failed.call('b2', 'bash', { command: 'anchor test' });
  failed.start('b2', 'bash', { command: 'anchor test' });
  failed.end('b2', 'bash', 'boom\n\nCommand exited with code 101', { isError: true });
  const row = failed.conversation.render(80);
  assert.deepEqual(plain(row), ['● Ran  anchor test  exit 101', '  ⎿  boom']);
  assert.ok(row[0]!.startsWith(fg('error') + '●'), 'the dot is error');
  assert.ok(row[0]!.includes(fg('error') + 'exit 101'), 'so is the exit chip');
  assert.ok(row[1]!.includes(fg('error') + '⎿'), 'and the arm');
  assert.notEqual(row[0]!.slice(0, 20), lines[0]!.slice(0, 20), 'a failure does not look like a success');
});

test('a running dot blinks with the clock, and not at all with reduced motion', () => {
  const s = session();
  s.call('b1', 'bash', { command: 'sleep 9' });
  s.start('b1', 'bash', { command: 'sleep 9' });
  s.clock.now = 2_000_000;
  const lit = plain(s.conversation.render(60))[0]!;
  s.clock.now += 500;
  const dim = plain(s.conversation.render(60))[0]!;
  assert.deepEqual([lit.slice(0, 1), dim.slice(0, 1)].sort(), ['○', '●']);
  const still = session({ env: { OMS_REDUCED_MOTION: '1' } });
  still.call('b1', 'bash', { command: 'sleep 9' });
  still.start('b1', 'bash', { command: 'sleep 9' });
  still.clock.now += 500;
  assert.equal(plain(still.conversation.render(60))[0]![0], '●');
});

test('a command that runs shows its elapsed time at the right and the tail of its output', () => {
  const s = session({ env: { OMS_REDUCED_MOTION: '1' } });
  s.call('b1', 'bash', { command: 'anchor build' });
  s.start('b1', 'bash', { command: 'anchor build' });
  s.clock.now += 12_000;
  s.accept({
    type: 'tool_execution_update',
    toolCallId: 'b1',
    toolName: 'bash',
    args: { command: 'anchor build' },
    partialResult: { content: [{ type: 'text', text: 'a\nb\nc\nd\ne' }] },
  });
  const lines = plain(s.conversation.render(60));
  assert.match(lines[0]!, /^● Running {2}anchor build +12s$/);
  assert.deepEqual(lines.slice(1), ['  ⎿  c', '     d', '     e']);
});

test('shell output shows its first rows and last rows, and says how many are left out', () => {
  const s = session();
  s.run('b1', 'bash', { command: 'ls' }, Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join('\n'));
  assert.deepEqual(plain(s.conversation.render(60)), [
    '● Ran  ls',
    '  ⎿  row 1',
    '     row 2',
    '     … +15 lines',
    '     row 18',
    '     row 19',
    '     row 20 (ctrl+o to expand)',
  ]);
  const quiet = session();
  quiet.run('b2', 'bash', { command: 'true' }, '');
  assert.deepEqual(plain(quiet.conversation.render(60)), ['● Ran  true', '  ⎿  (no output)']);
});

test('only the latest cut-short entry names the key that expands it', () => {
  const s = session();
  s.run('b1', 'bash', { command: 'one' }, Array.from({ length: 12 }, (_, i) => `a${i}`).join('\n'));
  s.run('b2', 'bash', { command: 'two' }, Array.from({ length: 12 }, (_, i) => `b${i}`).join('\n'));
  const text = plain(s.conversation.render(60)).join('\n');
  assert.equal(text.match(/ctrl\+o to expand/g)?.length, 1);
  assert.match(text, /b11 \(ctrl\+o to expand\)/);
  s.conversation.toggleToolOutput();
  assert.ok(!plain(s.conversation.render(60)).join('\n').includes('ctrl+o'), 'expanded entries need no hint');
});

// ---------------------------------------------------------------- grouping

test('consecutive read-only calls fold into one Explored entry with what was read and searched', () => {
  const s = session({ env: { OMS_REDUCED_MOTION: '1' } });
  s.run('r1', 'read', { path: '/work/project/programs/escrow/src/lib.rs' }, 'a\nb');
  s.run('r2', 'read', { path: 'Anchor.toml' }, 'c');
  s.run('g1', 'solana_docs_search', { query: 'pda seeds' }, '{"results":[]}');
  assert.deepEqual(plain(s.conversation.render(80)), [
    '● Explored  2 files · 1 search',
    '  ⎿  Read lib.rs, Anchor.toml',
    '     Searched "pda seeds" (ctrl+o to expand)',
  ]);
  s.conversation.toggleToolOutput();
  assert.deepEqual(plain(s.conversation.render(80)), [
    '● Explored  2 files · 1 search',
    '  ⎿  Read programs/escrow/src/lib.rs · 2 lines',
    '     Read Anchor.toml · 1 line',
    '     Searched Solana docs "pda seeds" · 0 results',
  ]);
});

test('a running read group says Exploring, a lone read is not grouped, and a failed read leaves the group', () => {
  const s = session({ env: { OMS_REDUCED_MOTION: '1' } });
  s.call('r1', 'read', { path: 'a.rs' });
  s.start('r1', 'read', { path: 'a.rs' });
  assert.deepEqual(plain(s.conversation.render(80)), ['● Reading  a.rs']);
  s.call('r2', 'read', { path: 'b.rs' });
  s.start('r2', 'read', { path: 'b.rs' });
  assert.equal(plain(s.conversation.render(80))[0], '● Exploring  2 files…');
  s.end('r1', 'read', 'x');
  s.end('r2', 'read', 'ENOENT: no such file', { isError: true });
  const lines = s.conversation.render(80);
  assert.deepEqual(plain(lines), ['● Read  a.rs', '  ⎿  1 line', '', '● Read  b.rs', '  ⎿  ENOENT: no such file']);
  assert.ok(lines[3]!.startsWith(fg('error') + '●'));
  assert.ok(lines[4]!.includes(fg('error') + 'ENOENT'));
});

test('a call that is not read-only ends the group', () => {
  const s = session();
  s.run('r1', 'read', { path: 'a.rs' }, 'x');
  s.run('r2', 'read', { path: 'b.rs' }, 'x');
  s.run('b1', 'bash', { command: 'ls' }, 'f');
  s.run('r3', 'read', { path: 'c.rs' }, 'x');
  const heads = plain(s.conversation.render(80)).filter((line) => line.startsWith('●'));
  assert.deepEqual(heads, ['● Explored  2 files', '● Ran  ls', '● Read  c.rs']);
});

// ---------------------------------------------------------------- edits

const DIFF = [
  ' 40 pub fn init() {',
  '-41     let a = 1;',
  '+41     let a = 2;',
  '+42     let b = 3;',
  ' 43 }',
  '     ...',
  ' 90 fn tail() {',
  '-91     old();',
  '+91     new();',
  ' 92 }',
].join('\n');

test('an edit shows +added −removed and a unified diff with a line-number gutter and tinted rows', () => {
  const s = session();
  s.run('e1', 'edit', { path: '/work/project/src/lib.rs' }, 'ok', { details: { diff: DIFF } });
  const lines = s.conversation.render(60);
  assert.deepEqual(plain(lines), [
    '● Edited  src/lib.rs  +3 −2',
    '  ⎿  40   pub fn init() {',
    '     41 −     let a = 1;',
    '     41 +     let a = 2;',
    '     42 +     let b = 3;',
    '     43   }',
    '        ⋯',
    '     90   fn tail() {',
    '     91 −     old();',
    '     91 +     new();',
    '     92   }',
  ]);
  assert.ok(lines[0]!.includes(fg('diffAdded') + '+3'), '+3 in the added color');
  assert.ok(lines[0]!.includes(fg('diffRemoved') + '−2'), '−2 in the removed color');
  assert.ok(lines[2]!.includes(bg('diffRemoved')) && lines[2]!.includes(fg('diffRemoved') + '−'), 'a removed row');
  assert.ok(lines[3]!.includes(bg('diffAdded')) && lines[3]!.includes(fg('diffAdded') + '+'), 'an added row');
  assert.ok(!lines[1]!.includes(bg('diffAdded')) && !lines[1]!.includes(bg('diffRemoved')), 'context is untinted');
  assert.equal(visibleWidth(lines[3]!), 60, 'a tinted row runs to the edge');
  assert.ok(lines[8]!.includes('\x1b[1mold'), 'what changed inside a single replaced line is bold');
  assert.ok(lines[9]!.includes('\x1b[1mnew'));
});

test('a long line in a diff wraps under the code, not under the gutter', () => {
  const s = session();
  const text = 'x'.repeat(50);
  s.run('e1', 'edit', { path: 'a.rs' }, 'ok', { details: { diff: `+ 7 ${text}` } });
  const lines = plain(s.conversation.render(30));
  assert.equal(lines[1], '  ⎿   7 + ' + 'x'.repeat(20));
  assert.equal(lines[2], ' '.repeat(10) + 'x'.repeat(20));
  assert.equal(lines[3], ' '.repeat(10) + 'x'.repeat(10));
});

test('a very long diff shows its first hunk and counts the others until Ctrl+O', () => {
  const hunk = (start: number) => [...Array.from({ length: 22 }, (_, i) => `+${start + i} added ${i}`)];
  const diff = [...hunk(1), '     ...', ...hunk(100)].join('\n');
  const s = session();
  s.run('e1', 'edit', { path: 'a.rs' }, 'ok', { details: { diff } });
  const lines = plain(s.conversation.render(60));
  assert.equal(lines.length, 1 + 22 + 1);
  assert.equal(lines.at(-1), '     … +1 more hunk (ctrl+o to expand)');
  s.conversation.toggleToolOutput();
  assert.ok(plain(s.conversation.render(60)).join('\n').includes('100 + added 0'));
});

test('a new file is a line count, its content comes with Ctrl+O, and a rewrite shows the diff', () => {
  const s = session();
  s.run('w1', 'write', { path: 'hello.mjs', content: 'a\nb\n' }, 'ok', { details: { created: true, lines: 2 } });
  assert.deepEqual(plain(s.conversation.render(60)), ['● Wrote  hello.mjs', '  ⎿  2 lines (ctrl+o to expand)']);
  s.conversation.toggleToolOutput();
  assert.deepEqual(plain(s.conversation.render(60)), ['● Wrote  hello.mjs', '  ⎿  2 lines', '     a', '     b']);
});

// ---------------------------------------------------------------- Solana

test('Solana commands read as what they did, with short addresses', () => {
  const wallet = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const s = session();
  s.run('b1', 'bash', { command: `solana airdrop 2 ${wallet}` }, 'Requesting airdrop\n\nSignature: 4sGj\n2 SOL');
  s.run(
    'b2',
    'bash',
    { command: 'anchor deploy --program-name escrow' },
    `Deploying\nProgram Id: ${wallet}\nDeploy success`,
  );
  const signature = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn';
  s.run(
    'b3',
    'bash',
    { command: `solana confirm -v ${signature}` },
    `Signature: ${signature}\nSlot: 1204\nCompute Units Consumed: 12345\nFinalized`,
  );
  const text = plain(s.conversation.render(100));
  assert.ok(text.includes('● Airdropped  2 SOL → 7xKX…gAsU'));
  assert.ok(text.includes('● Deployed  escrow  7xKX…gAsU'));
  const sent = `● Sent tx  ${signature.slice(0, 4)}…${signature.slice(-4)}  ✓ confirmed · slot 1,204 · CU 12,345`;
  assert.ok(text.some((line) => line.startsWith(sent)));
  assert.ok(!text.join('\n').includes('Requesting airdrop'), 'the command output waits for Ctrl+O');
});

test('a program error in a result is named with the offline error tables', () => {
  const s = session();
  s.run('b1', 'bash', { command: 'anchor test' }, 'Error: custom program error: 0xbc4\n\nCommand exited with code 1', {
    isError: true,
  });
  const text = plain(s.conversation.render(80));
  assert.ok(text.includes('     custom program error 0xbc4 → AccountNotInitialized'));
  const unnamed = session();
  unnamed.run('b2', 'bash', { command: 'x' }, 'custom program error: 0x1', { isError: true });
  assert.ok(
    !plain(unnamed.conversation.render(80)).join('\n').includes('→'),
    'a code several programs share is not guessed',
  );
});

// ---------------------------------------------------------------- errors, notes and the turn

test('a provider error is one summarized line, the raw payload comes with Ctrl+O', () => {
  const raw =
    'Provider error: 429 rate_limit_error: {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}';
  const s = session();
  s.reply([], { stopReason: 'error', errorMessage: raw });
  const lines = s.conversation.render(140);
  assert.deepEqual(plain(lines), [
    '● Error  Provider error: 429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit (ctrl+o to expand)',
  ]);
  assert.ok(lines[0]!.startsWith(fg('error') + '●'));
  assert.deepEqual(plain(s.conversation.render(100)), [
    '● Error  Provider error: 429 rate_limit_error: Number of request tokens has exceeded your per-minute',
    '         rate limit (ctrl+o to expand)',
  ]);
  const narrow = plain(s.conversation.render(112));
  assert.equal(narrow.length, 2, 'with no room beside the last words the key takes a row of its own');
  assert.equal(narrow[1], '         (ctrl+o to expand)');
  s.conversation.toggleToolOutput();
  const expanded = plain(s.conversation.render(140));
  assert.ok(
    expanded.length > 1 && expanded.join('\n').includes('"type":"rate_limit_error"'),
    'the payload is behind Ctrl+O',
  );
});

test('an interrupted answer says so, and a cut-off one is flagged as a warning', () => {
  const s = session();
  s.reply([{ type: 'text', text: 'Partial' }], { stopReason: 'aborted' });
  s.reply([{ type: 'text', text: 'Long' }], { stopReason: 'length' });
  const lines = s.conversation.render(80);
  assert.deepEqual(plain(lines), [
    '  Partial',
    '',
    '● Interrupted',
    '',
    '  Long',
    '',
    '● Cut off  The response was truncated before it finished.',
  ]);
  assert.ok(lines[2]!.startsWith(fg('warning') + '●'));
});

test('notes: a bare note is a faint line, command output hangs under its title, a failure reads as an error', () => {
  const s = session();
  s.conversation.note('', 'Resumed the last chat.');
  s.conversation.note('status', 'Task: rent\nModel: local');
  s.conversation.note('error', 'Custom error 3012: AccountNotInitialized');
  s.conversation.note('agent failed', 'Something broke');
  s.conversation.note('Host approval required', 'Allow `npm test`?');
  assert.deepEqual(plain(s.conversation.render(60)), [
    '· Resumed the last chat.',
    '',
    '  ⎿  status',
    '     Task: rent',
    '     Model: local',
    '',
    '  ⎿  error',
    '     Custom error 3012: AccountNotInitialized',
    '',
    '● Error  Something broke',
    '',
    '● Host approval required  Allow `npm test`?',
  ]);
});

test('a turn that worked a while ends with how long and how many tokens', () => {
  const s = session();
  s.accept({ type: 'agent_start' });
  s.user('go');
  s.clock.now += 72_000;
  s.reply([{ type: 'text', text: 'Done.' }], { usage: { ...usage, output: 3400 } });
  s.accept({ type: 'agent_settled', aborted: false });
  assert.equal(plain(s.conversation.render(60)).at(-1), '  Worked 1m 12s · ↓ 3.4k');
  const quick = session();
  quick.accept({ type: 'agent_start' });
  quick.reply([{ type: 'text', text: 'Hi.' }]);
  quick.clock.now += 2000;
  quick.accept({ type: 'agent_settled', aborted: false });
  assert.ok(!plain(quick.conversation.render(60)).join('\n').includes('Worked'));
  const aborted = session();
  aborted.accept({ type: 'agent_start' });
  aborted.clock.now += 60_000;
  aborted.accept({ type: 'agent_settled', aborted: true });
  assert.deepEqual(aborted.conversation.render(60), []);
});

test('history beyond what is kept is one faint line', () => {
  const history = Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `turn ${i}`, timestamp: i }));
  const lines = plain(new Conversation(history).render(60));
  assert.equal(lines[0], '⋯ earlier entries hidden');
  assert.equal(lines[1], '');
  assert.equal(lines.at(-1), ' ❯ turn 199');
});

// ---------------------------------------------------------------- the whole conversation

test('entries are one blank line apart, never two, with no blank at either end and nothing past the width', () => {
  const s = session({ rows: () => 24, env: { OMS_REDUCED_MOTION: '1' } });
  s.accept({ type: 'agent_start' });
  s.user('Add a vault\nwith spacing');
  s.reply([
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: '# Plan\n\n\n- a\n\n- b\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\n\nok' },
  ]);
  s.run('r1', 'read', { path: 'a.rs' }, 'x');
  s.run('r2', 'read', { path: 'b.rs' }, 'x');
  s.run('e1', 'edit', { path: 'a.rs' }, 'ok', { details: { diff: DIFF } });
  s.run('b1', 'bash', { command: 'x'.repeat(300) }, 'y'.repeat(300));
  s.conversation.note('status', 'a\n\n\nb');
  s.reply([], { stopReason: 'error', errorMessage: 'bad\n\n\nthing' });
  s.clock.now += 20_000;
  s.accept({ type: 'agent_settled', aborted: false });
  for (const width of [20, 40, 80, 140]) {
    const lines = s.conversation.render(width);
    // A painted row (the prompt band, a code block) is content even when it is empty.
    const text = lines.map((line) => (line.includes('\x1b[48;') ? '·' : plain([line])[0]!));
    assert.notEqual(text[0], '', `no leading blank at ${width}`);
    assert.ok(
      lines.every((line) => !line.includes('\n')),
      'one physical row per line',
    );
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `every row fits ${width}`,
    );
    for (let i = 1; i < text.length; i++)
      if (text[i] === '' && text[i - 1] === '')
        assert.fail(`two blank rows at ${i} for width ${width}\n${text.join('\n')}`);
    assert.notEqual(text.at(-1), '', `no trailing blank at ${width}`);
  }
});

test('text from the model cannot put terminal sequences on screen', () => {
  const s = session();
  s.user('hi \x1b]52;c;INJECT\x07 there');
  s.reply([{ type: 'text', text: 'ok \x1b[2J \x1b]0;title\x07 done' }]);
  s.run('b1', 'bash', { command: 'echo \x1b[31mred' }, 'out \x1b]52;c;X\x07 \x1b[2Jtext');
  s.run('t1', 'weird_tool', { thing: 'v \x1b[2J' }, 'result \x1b[31m red');
  const raw = s.conversation.render(80).join('\n');
  assert.ok(!raw.includes('INJECT') && !raw.includes(']52') && !raw.includes('[2J') && !raw.includes(']0;'));
  assert.ok(!/\x1b\[31mred/.test(raw), 'the model cannot color its own output');
});

test('display never changes what the model sent or received', () => {
  const args = { path: '.env', content: 'API_KEY=sk-secret-1234567890abcdef\n' };
  const result = { content: [{ type: 'text', text: 'API_KEY=sk-secret-1234567890abcdef\n' }], details: { lines: 1 } };
  const before = JSON.stringify({ args, result });
  const s = session();
  s.call('w1', 'write', args);
  s.accept({ type: 'tool_execution_start', toolCallId: 'w1', toolName: 'write', args });
  s.accept({ type: 'tool_execution_end', toolCallId: 'w1', toolName: 'write', isError: false, result });
  s.conversation.toggleToolOutput();
  const screen = plain(s.conversation.render(80)).join('\n');
  assert.ok(!screen.includes('sk-secret'), 'masked on screen');
  assert.equal(JSON.stringify({ args, result }), before, 'and untouched for the model');
});

test('ASCII glyphs stand in on a terminal that cannot draw the Unicode ones', () => {
  const s = session({ env: { TERM: 'linux', OMS_REDUCED_MOTION: '1' } });
  s.user('hi');
  s.run('b1', 'bash', { command: 'ls' }, 'a');
  assert.deepEqual(plain(s.conversation.render(30)), [' > hi', '', '* Ran  ls', '  `- a']);
});

// ---------------------------------------------------------------- timers

test('the clock runs only while a call is running', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let renders = 0;
    const s = session({ requestRender: () => renders++ });
    s.call('b1', 'bash', { command: 'sleep 9' });
    s.start('b1', 'bash', { command: 'sleep 9' });
    renders = 0;
    mock.timers.tick(1500);
    assert.equal(renders, 3, 'a frame every half second while a call runs');
    s.end('b1', 'bash', 'done');
    renders = 0;
    mock.timers.tick(5000);
    assert.equal(renders, 0, 'and none once it is done');
    // A call that never reported back stops when the agent settles, instead of blinking for ever.
    s.start('b2', 'bash', { command: 'hang' });
    s.accept({ type: 'agent_settled', aborted: true });
    assert.deepEqual(plain(s.conversation.render(60)).slice(-2), ['○ Running  hang', '  ⎿  interrupted']);
    renders = 0;
    mock.timers.tick(5000);
    assert.equal(renders, 0);
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------- scrolling and copying

test('scrolled up, new output shows a ▼ chip over the bottom row until the view is back at the end', () => {
  const s = session();
  for (let i = 0; i < 30; i++) s.user(`turn ${i}`);
  const lines = s.conversation.render(40);
  const view = { isFollowingEnd: false, scrollTop: 5, viewportHeight: 10 };
  assert.equal(s.conversation.withNewOutput(lines, { ...view, isFollowingEnd: true }, 40), lines, 'following: none');
  assert.equal(s.conversation.withNewOutput(lines, view, 40), lines, 'scrolled up with nothing new: none');
  s.user('another');
  const next = s.conversation.render(40);
  const shown = s.conversation.withNewOutput(next, view, 40);
  assert.equal(plain(shown)[14]?.trim(), '▼ new output', 'on the last visible row');
  assert.ok(shown[14]!.includes(fg('accent')));
  assert.equal(shown.length, next.length);
  assert.equal(plain(shown).filter((line) => line.includes('new output')).length, 1);
  assert.equal(s.conversation.newOutputStale(view, next.length), false);
  assert.equal(s.conversation.newOutputStale({ ...view, scrollTop: 8 }, next.length), true, 'the view moved');
  s.conversation.withNewOutput(next, { ...view, isFollowingEnd: true }, 40);
  assert.equal(s.conversation.withNewOutput(next, view, 40), next, 'back at the end: seen');
});

test('copying drops the glyph gutters and the hanging indent, and leaves other text alone', () => {
  assert.equal(copyableText(' ❯ Add a vault'), 'Add a vault');
  assert.equal(
    copyableText('● Ran  anchor test  exit 1\n  ⎿  Compiling\n     Error: x\n\n  Plain prose\n  continues'),
    'Ran  anchor test  exit 1\nCompiling\nError: x\n\nPlain prose\ncontinues',
  );
  const code = '    fn main() {\n        1\n    }';
  assert.equal(copyableText(code), code, 'selected code keeps its indentation');
});

test('every color depth draws the whole conversation inside its width, and NO_COLOR draws no color', () => {
  for (const depth of ['truecolor', '256', '16', 'none'] as const) {
    const palette = getTheme('nord', { depth, backdrop: 'theme' })!;
    const s = session({ rows: () => 40 });
    s.conversation.applyTheme(palette);
    s.user('Add a vault');
    s.reply([{ type: 'text', text: '# T\n`x` and\n```ts\nconst a = 1;\n```' }]);
    s.run('e1', 'edit', { path: 'a.rs' }, 'ok', { details: { diff: DIFF } });
    s.run('b1', 'bash', { command: 'x' }, 'boom\n\nCommand exited with code 1', { isError: true });
    for (const width of [1, 3, 8, 30, 100]) {
      const lines = s.conversation.render(width);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `${depth} at ${width}`,
      );
    }
    const raw = s.conversation.render(60).join('\n');
    if (depth === 'none') assert.ok(!/\x1b\[[34]8;|\x1b\[(?:3[0-7]|4[0-7]|9[0-7])m/.test(raw), 'no color codes');
    if (depth === '16' || depth === 'none') assert.ok(!/\x1b\[48;/.test(raw), `${depth} paints no backgrounds`);
    assert.ok(raw.includes('\x1b[1m'), 'bold stays');
    const failure = plain(s.conversation.render(60)).join('\n');
    assert.ok(
      failure.includes(`${depth === 'none' ? '✗' : '●'} Ran  x  exit 1`),
      `${depth}: the failure is a word, not only a color`,
    );
  }
});

test('listings, searches and lookups say what they found, and an unknown tool shows its name and first argument', () => {
  const s = session();
  s.run('l1', 'ls', { path: 'src' }, 'a\nb\nc');
  s.run('b1', 'bash', { command: 'true' }, 'x');
  s.run('g1', 'grep', { pattern: 'init', path: 'src' }, 'a.rs:1:init\nb.rs:2:init');
  s.run('b2', 'bash', { command: 'true' }, 'x');
  s.run('g2', 'grep', { pattern: 'zzz' }, 'No matches found');
  s.run('b3', 'bash', { command: 'true' }, 'x');
  s.run('f1', 'find', { pattern: '*.rs', path: 'src' }, 'a.rs');
  s.run('d1', 'decode_error', { code: '0xbc4' }, 'AccountNotInitialized (Anchor framework): not initialized');
  s.run('x1', 'custom_tool', { thing: 'v' }, 'fine');
  const text = plain(s.conversation.render(100)).filter((line) => line.startsWith('●') || line.startsWith('  ⎿'));
  assert.deepEqual(
    text.filter((line) => !line.includes('Ran  true') && !line.includes('  ⎿  x')),
    [
      '● Listed  src',
      '  ⎿  3 entries',
      '● Searched  "init" in src',
      '  ⎿  2 matches (ctrl+o to expand)',
      '● Searched  "zzz"',
      '  ⎿  no matches',
      '● Found  *.rs in src',
      '  ⎿  1 file',
      '● Decoded  error 0xbc4',
      '  ⎿  AccountNotInitialized (Anchor framework): not initialized',
      '● custom_tool  "v"',
      '  ⎿  fine',
    ],
  );
});

test('a command the user ran saved in history reads like a tool row, with its exit code', () => {
  const history = [
    { role: 'bashExecution', command: 'git status', output: 'clean\n', exitCode: 0, cancelled: false },
    { role: 'bashExecution', command: 'false', output: '', exitCode: 1, cancelled: false },
    { role: 'bashExecution', command: 'sleep 99', output: '', cancelled: true },
  ];
  const lines = plain(new Conversation(history).render(60));
  assert.deepEqual(lines, [
    '● Ran  git status',
    '  ⎿  clean',
    '',
    '● Ran  false  exit 1',
    '',
    '● Ran  sleep 99  aborted',
  ]);
});

test('with no color at all a failed call still reads as one', () => {
  const s = session();
  s.conversation.applyTheme(getTheme('nord', { depth: 'none', backdrop: 'theme' })!);
  s.run('r1', 'read', { path: 'a.rs' }, 'ENOENT', { isError: true });
  assert.deepEqual(plain(s.conversation.render(60)), ['✗ Read  a.rs', '  ⎿  ENOENT']);
});

test('a script of several lines shows its first line and an ellipsis', () => {
  const s = session();
  s.run('b1', 'bash', { command: 'cd app\nnpm test\nnpm run build' }, 'ok');
  assert.equal(plain(s.conversation.render(60))[0], '● Ran  cd app …');
});

test('clicking an entry opens or folds just that entry; short ones and the gaps between do nothing', () => {
  const s = session();
  s.run('b1', 'bash', { command: 'one' }, Array.from({ length: 12 }, (_, i) => `a${i}`).join('\n'));
  s.run('b2', 'bash', { command: 'two' }, 'short');
  s.reply([
    { type: 'thinking', thinking: 'Weigh it.' },
    { type: 'text', text: 'Done.' },
  ]);
  const rows = () => plain(s.conversation.render(60));
  const at = (text: string) => rows().findIndex((row) => row.includes(text));
  assert.equal(s.conversation.click(at('… +7 lines')), 'toggled');
  assert.ok(rows().includes('     a6'), 'the clicked command is open');
  assert.ok(rows().includes('  ⎿  short'), 'the others are as they were');
  assert.equal(s.conversation.click(at('a6')), 'toggled');
  assert.ok(!rows().includes('     a6'), 'a second click folds it');
  assert.equal(s.conversation.click(at('short')), undefined, 'a short entry has nothing to open');
  assert.equal(s.conversation.click(-1), undefined, 'above the first entry');
  assert.equal(s.conversation.click(at('Thought')), 'toggled');
  assert.ok(rows().includes('  Weigh it.'), 'a click opens that thinking');
  assert.equal(s.conversation.click(at('Weigh it.')), 'toggled');
  assert.ok(!rows().includes('  Weigh it.'));
  assert.equal(s.conversation.click(500), undefined, 'below the end');
});

test('thinking restored from history has no duration to give, and a sub-second thought gives none either', () => {
  const history = [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Earlier.' },
        { type: 'text', text: 'Hi.' },
      ],
      stopReason: 'stop',
      usage,
      api: 'x',
      provider: 'p',
      model: 'm',
      timestamp: 1,
    },
  ];
  assert.equal(plain(new Conversation(history).render(60))[0], '∴ Thought');
  const s = session();
  s.reply([
    { type: 'thinking', thinking: 'Quick.' },
    { type: 'text', text: 'Yes.' },
  ]);
  assert.equal(plain(s.conversation.render(60))[0], '∴ Thought');
});
