import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conversation } from '../src/tui/transcript.ts';
import { piTheme } from '../src/tui/pi-theme.ts';
import { getTheme, THEME_IDS, type OmsTheme, type ThemeDisplay } from '../src/tui/theme.ts';

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const history = [
  { role: 'user', content: 'Add a counter', timestamp: 1 },
  {
    role: 'assistant',
    content: [{ type: 'text', text: '# Plan\n\nUse `count` here:\n\n```ts\nconst count: number = 1; // start\n```' }],
    stopReason: 'stop',
    usage,
    api: 'x',
    provider: 'p',
    model: 'm',
    timestamp: 2,
  },
];

function theme(id: string, display?: ThemeDisplay): OmsTheme {
  const value = getTheme(id, display);
  assert.ok(value);
  return value;
}
const sgr = (lines: string[]) => new Set(lines.join('\n').match(/\x1b\[[\d;]*m/g));
const rgb = (hex: string, target: 38 | 48) =>
  `\x1b[${target};2;${[1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(';')}m`;

test('the transcript draws user, markdown and code colors from the active OMS theme and follows a live switch', () => {
  const conversation = new Conversation(history);
  const gruvbox = theme('gruvbox');
  const nord = theme('nord');
  conversation.applyTheme(gruvbox);
  const before = conversation.render(60);
  conversation.applyTheme(nord);
  const after = conversation.render(60);
  const text = (lines: string[]) => lines.join('\n').replace(/\x1b\[[\d;]*m|\x1b\]133;[A-C]\x07/g, '');
  assert.equal(text(after), text(before), 'switching themes changes color only');
  for (const [lines, palette, other] of [
    [before, gruvbox, nord],
    [after, nord, gruvbox],
  ] as const) {
    const codes = sgr(lines);
    for (const expected of [
      rgb(palette.surface, 48),
      rgb(palette.colors.accent, 38),
      rgb(palette.colors.syntaxKeyword, 38),
      rgb(palette.colors.syntaxNumber, 38),
    ])
      assert.ok(codes.has(expected), `${palette.id} transcript lacks ${JSON.stringify(expected)}`);
    assert.ok(!codes.has(rgb(other.surface, 48)), `${palette.id} transcript still uses ${other.id}`);
  }
});

test('every theme and color depth builds a complete pi theme', () => {
  for (const id of THEME_IDS) {
    for (const depth of ['truecolor', '256', '16', 'none'] as const) {
      const palette = theme(id, { depth, backdrop: 'theme' });
      const pi = piTheme(palette);
      const out = pi.fg('syntaxKeyword', 'k') + pi.bg('userMessageBg', 'u') + pi.fg('toolDiffRemoved', '-');
      if (depth === 'truecolor') assert.match(out, /38;2;/);
      if (depth === '256') {
        assert.ok(/38;5;/.test(out) && !/;2;/.test(out), out);
        assert.ok(out.includes(`\x1b[${palette.sgr.bg.surface}m`), 'the transcript uses the chrome 256-color mapping');
      }
      if (depth === '16') assert.ok(/38;5;([0-9]|1[0-5])m/.test(out) && !/48;/.test(out), out);
      if (depth === 'none') assert.ok(!/[34]8;/.test(out), out);
    }
  }
});
