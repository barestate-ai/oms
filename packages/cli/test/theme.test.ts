import assert from 'node:assert/strict';
import { test } from 'node:test';
import xterm from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import unicodeGraphemes from '@xterm/addon-unicode-graphemes';
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import {
  THEME_IDS,
  colorBg,
  colorText,
  detectColorDepth,
  getTheme,
  paintThemeRow,
  type BackgroundRole,
  type OmsTheme,
  type ThemeDisplay,
  type ThemeRole,
} from '../src/tui/theme.ts';

const TERMINAL: ThemeDisplay = { depth: 'truecolor', backdrop: 'terminal' };
/** Every theme that draws RGB colors; the Terminal theme draws the terminal's own and has its own tests below. */
const RGB_IDS = THEME_IDS.filter((id) => id !== 'terminal');
const ROLES: ThemeRole[] = [
  'foreground',
  'muted',
  'accent',
  'success',
  'warning',
  'error',
  'border',
  'info',
  'diffAdded',
  'diffRemoved',
  'syntaxKeyword',
  'syntaxString',
  'syntaxNumber',
  'syntaxComment',
  'syntaxFunction',
  'syntaxType',
  'syntaxConstant',
  'syntaxPunctuation',
];
const BACKGROUNDS: BackgroundRole[] = ['background', 'surface', 'selection', 'diffAdded', 'diffRemoved'];

function theme(name: string, display?: ThemeDisplay): OmsTheme {
  const value = getTheme(name, display);
  assert.ok(value, `Missing curated theme ${name}`);
  return value;
}

async function parsedRow(output: string, width: number): Promise<Terminal> {
  const vt = new xterm.Terminal({ cols: width, rows: 2, allowProposedApi: true, logLevel: 'off' });
  vt.loadAddon(new unicodeGraphemes.UnicodeGraphemesAddon());
  vt.unicode.activeVersion = '15-graphemes';
  // TUI consumes hardware-cursor markers before handing rendered bytes to a VT.
  await new Promise<void>((resolve) => vt.write(output.replaceAll(CURSOR_MARKER, ''), resolve));
  return vt;
}

function rgb(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}
function luminance(hex: string): number {
  const linear = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}
function contrast(first: string, second: string): number {
  const [a, b] = [luminance(first), luminance(second)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('terminal backdrop rows preserve terminal-default backgrounds through nested resets and padding', async () => {
  const vt = await parsedRow(
    '\x1b[48;2;1;2;3m' + paintThemeRow(theme('gruvbox', TERMINAL), 'A\x1b[0mB\x1b[49mC', 9),
    9,
  );
  try {
    const line = vt.buffer.active.getLine(0)!;
    assert.equal(line.translateToString(false).trimEnd(), 'ABC');
    for (let column = 0; column < 9; column++) {
      assert.ok(line.getCell(column)!.isBgDefault(), `column ${column} overrides the terminal background`);
    }
  } finally {
    vt.dispose();
  }
});

for (const id of RGB_IDS) {
  test(`${id}: terminal backdrop rows use terminal-default backgrounds including trailing blanks`, async () => {
    const palette = theme(id, TERMINAL);
    for (const text of ['', 'OMS']) {
      const output = paintThemeRow(palette, text, 11);
      assert.equal(visibleWidth(output), 11);
      const vt = await parsedRow('\x1b[48;2;1;2;3m' + output, 11);
      try {
        const line = vt.buffer.active.getLine(0)!;
        assert.equal(line.translateToString(false).trimEnd(), text);
        for (let column = 0; column < 11; column++) {
          const cell = line.getCell(column)!;
          assert.ok(cell.isBgDefault(), `column ${column} overrides the terminal background`);
          assert.ok(cell.isFgRGB());
          assert.equal(cell.getFgColor(), rgb(palette.colors.foreground));
        }
      } finally {
        vt.dispose();
      }
    }
  });

  test(`${id}: theme backdrop paints the palette background on every cell including trailing blanks`, async () => {
    const palette = theme(id);
    for (const text of ['', 'OMS']) {
      const output = paintThemeRow(palette, text, 11);
      assert.equal(visibleWidth(output), 11);
      const vt = await parsedRow('\x1b[48;2;1;2;3m' + output, 11);
      try {
        const line = vt.buffer.active.getLine(0)!;
        assert.equal(line.translateToString(false).trimEnd(), text);
        for (let column = 0; column < 11; column++) {
          const cell = line.getCell(column)!;
          assert.ok(cell.isBgRGB(), `column ${column} keeps the terminal background`);
          assert.equal(cell.getBgColor(), rgb(palette.background));
          assert.equal(cell.getFgColor(), rgb(palette.colors.foreground));
        }
      } finally {
        vt.dispose();
      }
    }
  });

  test(`${id}: theme backdrop restores the palette background and foreground after nested resets`, async () => {
    const palette = theme(id);
    const text =
      colorBg(palette, 'surface', 'A') + 'B\x1b[0mC\x1b[49mD\x1b[m' + colorBg(palette, 'selection', 'E') + 'F';
    const vt = await parsedRow(paintThemeRow(palette, text, 8), 8);
    try {
      const line = vt.buffer.active.getLine(0)!;
      assert.equal(line.translateToString(false).trimEnd(), 'ABCDEF');
      const expected = [palette.surface, palette.background, palette.background, palette.background];
      expected.push(palette.backgrounds.selection, palette.background, palette.background, palette.background);
      for (const [column, hex] of expected.entries()) {
        assert.equal(line.getCell(column)!.getBgColor(), rgb(hex), `column ${column}`);
        assert.equal(line.getCell(column)!.getFgColor(), rgb(palette.colors.foreground), `column ${column}`);
      }
    } finally {
      vt.dispose();
    }
  });

  test(`${id}: nested resets restore row foreground without overriding terminal backgrounds`, async () => {
    const palette = theme(id, TERMINAL);
    const text = colorText(palette, 'warning', 'A') + 'B\x1b[0mC\x1b[39mD\x1b[49mE\x1b[mF\x1b[0;1mG\x1b[22mH';
    const vt = await parsedRow(paintThemeRow(palette, text, 12), 12);
    try {
      const line = vt.buffer.active.getLine(0)!;
      assert.equal(line.translateToString(false).trimEnd(), 'ABCDEFGH');
      for (let column = 0; column < 12; column++) {
        const cell = line.getCell(column)!;
        assert.ok(cell.isBgDefault());
        assert.ok(cell.isFgRGB());
        assert.equal(cell.getFgColor(), rgb(column === 0 ? palette.colors.warning : palette.colors.foreground));
      }
    } finally {
      vt.dispose();
    }
  });

  test(`${id}: body and status roles have readable contrast using valid RGB palette data`, () => {
    const palette = theme(id);
    assert.match(palette.background, /^#[0-9a-f]{6}$/i);
    assert.match(palette.surface, /^#[0-9a-f]{6}$/i);

    for (const role of ROLES) {
      assert.match(palette.colors[role], /^#[0-9a-f]{6}$/i);
      if (role === 'border') continue;
      assert.ok(contrast(palette.colors[role], palette.background) >= 4.5, `${id}.${role} fails normal-text contrast`);
    }
    for (const role of BACKGROUNDS) {
      assert.match(palette.backgrounds[role], /^#[0-9a-f]{6}$/i);
      const ratio = contrast(palette.colors.foreground, palette.backgrounds[role]);
      assert.ok(ratio >= 4.5, `${id} foreground on ${role} is ${ratio.toFixed(2)}:1`);
    }
    assert.equal(palette.backgrounds.background, palette.background);
    assert.equal(palette.backgrounds.surface, palette.surface);
  });
}
test('truecolor channel zeros are not mistaken for SGR reset parameters', async () => {
  const palette = theme('gruvbox', TERMINAL);
  const vt = await parsedRow(paintThemeRow(palette, '\x1b[38;2;0;128;0mA\x1b[39mB', 3), 3);
  try {
    const line = vt.buffer.active.getLine(0)!;
    assert.equal(line.getCell(0)!.getFgColor(), 0x008000);
    assert.equal(line.getCell(1)!.getFgColor(), rgb(palette.colors.foreground));
    assert.ok(line.getCell(2)!.isBgDefault());
  } finally {
    vt.dispose();
  }
});

test('inline backgrounds survive foreground and attribute resets but not background resets or padding', async () => {
  const palette = theme('gruvbox', TERMINAL);
  const text =
    '\x1b[48;2;0;128;0;1mA\x1b[39mB\x1b[22mC\x1b[49mD' + '\x1b[48;5;0mE\x1b[0;4mF\x1b[24mG\x1b[48;2;0;0;128mH';
  const vt = await parsedRow(paintThemeRow(palette, text, 10), 10);
  try {
    const line = vt.buffer.active.getLine(0)!;
    assert.equal(line.translateToString(false).trimEnd(), 'ABCDEFGH');
    for (const column of [0, 1, 2]) {
      assert.ok(line.getCell(column)!.isBgRGB());
      assert.equal(line.getCell(column)!.getBgColor(), 0x008000);
    }
    assert.ok(line.getCell(0)!.isBold());
    assert.ok(line.getCell(1)!.isBold());
    assert.ok(!line.getCell(2)!.isBold());
    assert.ok(line.getCell(3)!.isBgDefault());
    assert.ok(line.getCell(4)!.isBgPalette());
    assert.equal(line.getCell(4)!.getBgColor(), 0);
    assert.ok(line.getCell(5)!.isBgDefault());
    assert.ok(line.getCell(5)!.isUnderline());
    assert.ok(!line.getCell(6)!.isUnderline());
    assert.ok(line.getCell(6)!.isBgDefault());
    assert.equal(line.getCell(7)!.getBgColor(), 0x000080);
    for (const column of [8, 9]) {
      assert.ok(line.getCell(column)!.isBgDefault());
      assert.ok(!line.getCell(column)!.isBold());
      assert.ok(!line.getCell(column)!.isUnderline());
    }
    for (let column = 0; column < 10; column++) {
      assert.equal(line.getCell(column)!.getFgColor(), rgb(palette.colors.foreground));
    }
  } finally {
    vt.dispose();
  }
});

test('styled Unicode graphemes and zero-width cursor markers survive row painting', async () => {
  const palette = theme('gruvbox');
  const text = `e\u0301${CURSOR_MARKER}${colorText(palette, 'success', '界👩‍💻')}!`;
  const output = paintThemeRow(palette, text, 10);
  assert.ok(output.includes(CURSOR_MARKER));
  assert.equal(visibleWidth(output), 10);
  assert.equal(stripTerminalSequences(output), 'e\u0301界👩‍💻!    ');
  const vt = await parsedRow(output, 10);
  try {
    assert.equal(vt.buffer.active.getLine(0)!.translateToString(false).trimEnd(), 'e\u0301界👩‍💻!');
  } finally {
    vt.dispose();
  }
});

test('truncation respects wide grapheme boundaries, styles and a cursor before the cut', async () => {
  const palette = theme('nord');
  const output = paintThemeRow(palette, `${CURSOR_MARKER}${colorText(palette, 'accent', 'A界🙂B')}`, 4);
  assert.ok(output.includes(CURSOR_MARKER));
  assert.equal(visibleWidth(output), 4);
  assert.equal(stripTerminalSequences(output), 'A界 ');
  const vt = await parsedRow(output, 4);
  try {
    assert.equal(vt.buffer.active.getLine(0)!.translateToString(false).trimEnd(), 'A界');
  } finally {
    vt.dispose();
  }
});

test('controlled spans color only their text and return following content to the base foreground', async () => {
  const palette = theme('dracula');
  const output = paintThemeRow(palette, ROLES.map((role) => colorText(palette, role, 'X') + '.').join(''), 36);
  const vt = await parsedRow(output, 36);
  try {
    const line = vt.buffer.active.getLine(0)!;
    for (const [index, role] of ROLES.entries()) {
      assert.equal(line.getCell(index * 2)!.getFgColor(), rgb(palette.colors[role]));
      assert.equal(line.getCell(index * 2 + 1)!.getFgColor(), rgb(palette.colors.foreground));
    }
  } finally {
    vt.dispose();
  }
});

test('painting is local SGR styling rather than terminal-global palette mutation', () => {
  for (const id of THEME_IDS) {
    const palette = theme(id);
    const output = paintThemeRow(palette, colorText(palette, 'accent', 'OMS'), 8);
    assert.ok(!output.includes('\x1b]'), 'renderer emitted an OSC command');
    assert.ok(!output.includes('\x9d'), 'renderer emitted a C1 OSC command');
    assert.ok(output.endsWith('\x1b[0m'), 'row must reset attributes when complete');
    assert.equal(visibleWidth(paintThemeRow(palette, 'unprinted', 0)), 0);
  }
});

test('unknown names, aliases and inherited object keys are not usable themes', () => {
  for (const name of [
    '',
    'unknown',
    'Gruvbox',
    ' gruvbox',
    'gruvbox ',
    'mocha',
    'tokyonight',
    'rosepine',
    'constructor',
    '__proto__',
    'toString',
  ]) {
    assert.equal(getTheme(name), undefined, name);
  }
  for (const id of THEME_IDS) assert.equal(theme(id).id, id);
});

test('a painted row cannot contain physical newlines or carriage returns', () => {
  const palette = theme('gruvbox');
  for (const text of ['one\ntwo', 'one\rtwo', 'one\r\ntwo']) {
    assert.throws(() => paintThemeRow(palette, text, 20), /row|newline|line|carriage/i);
  }
});

test('256-color terminals get the nearest cube colors for text, rows and backgrounds', async () => {
  const palette = theme('gruvbox', { depth: '256', backdrop: 'theme' });
  const text = colorText(palette, 'accent', 'A') + colorBg(palette, 'selection', 'B') + 'C';
  const output = paintThemeRow(palette, text, 5);
  assert.ok(!output.includes('38;2;') && !output.includes('48;2;'), 'no 24-bit color on a 256-color terminal');
  const vt = await parsedRow(output, 5);
  try {
    const line = vt.buffer.active.getLine(0)!;
    for (let column = 0; column < 5; column++) {
      const cell = line.getCell(column)!;
      assert.ok(cell.isFgPalette() && cell.isBgPalette(), `column ${column}`);
      assert.ok(cell.getFgColor() >= 16 && cell.getBgColor() >= 16, 'never the user-defined 16 colors');
    }
    assert.notEqual(line.getCell(0)!.getFgColor(), line.getCell(2)!.getFgColor());
    assert.notEqual(line.getCell(1)!.getBgColor(), line.getCell(2)!.getBgColor());
  } finally {
    vt.dispose();
  }
});

test('256-color picks the nearest of the color cube and the gray ramp, so dark neutrals never turn teal', () => {
  const index = (sgr: string) => Number(sgr.split(';')[2]);
  const channels = (n: number): number[] => {
    if (n >= 232) return [8 + (n - 232) * 10, 8 + (n - 232) * 10, 8 + (n - 232) * 10];
    const cube = [0, 95, 135, 175, 215, 255];
    return [cube[Math.floor((n - 16) / 36)]!, cube[Math.floor((n - 16) / 6) % 6]!, cube[(n - 16) % 6]!];
  };
  for (const id of RGB_IDS) {
    const palette = theme(id, { depth: '256', backdrop: 'theme' });
    for (const [hex, sgr] of [
      [palette.background, palette.sgr.bg.background],
      [palette.surface, palette.sgr.bg.surface],
      [palette.colors.foreground, palette.sgr.fg.foreground],
    ] as const) {
      const wanted = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
      const distance = (n: number) => channels(n).reduce((sum, value, i) => sum + (value - wanted[i]!) ** 2, 0);
      const best = Math.min(...Array.from({ length: 240 }, (_, n) => distance(n + 16)));
      assert.equal(distance(index(sgr)), best, `${id} ${hex} -> ${sgr}`);
    }
  }
  assert.equal(theme('nord', { depth: '256', backdrop: 'theme' }).sgr.bg.background, '48;5;237');
});

test('16-color terminals get named role colors and keep their own background', async () => {
  const palette = theme('nord', { depth: '16', backdrop: 'theme' });
  assert.equal(colorText(palette, 'error', 'x'), '\x1b[31mx\x1b[39m');
  assert.equal(colorText(palette, 'syntaxComment', 'x'), '\x1b[90mx\x1b[39m');
  assert.equal(colorBg(palette, 'surface', 'x'), 'x');
  assert.equal(colorBg(palette, 'selection', 'x'), '\x1b[7mx\x1b[27m');
  const vt = await parsedRow(paintThemeRow(palette, colorText(palette, 'success', 'A') + 'B', 4), 4);
  try {
    const line = vt.buffer.active.getLine(0)!;
    assert.equal(line.getCell(0)!.getFgColor(), 2);
    for (let column = 0; column < 4; column++) assert.ok(line.getCell(column)!.isBgDefault());
    assert.ok(line.getCell(1)!.isFgDefault());
  } finally {
    vt.dispose();
  }
});

test('NO_COLOR rows carry no color at all, and selection stays visible as inverse video', () => {
  for (const id of THEME_IDS) {
    const palette = theme(id, { depth: 'none', backdrop: 'theme' });
    assert.equal(colorText(palette, 'accent', 'OMS'), 'OMS');
    const output = paintThemeRow(palette, colorText(palette, 'warning', 'A') + colorBg(palette, 'surface', 'B'), 6);
    const codes = [...output.matchAll(/\x1b\[([\d;]*)m/g)].flatMap((match) => match[1]!.split(';').map(Number));
    assert.ok(!codes.some((code) => (code >= 30 && code <= 38) || (code >= 40 && code <= 48) || code >= 90), output);
    assert.equal(stripTerminalSequences(output), 'AB    ');
    assert.equal(colorBg(palette, 'selection', 'x'), '\x1b[7mx\x1b[27m');
  }
});

test('color depth follows NO_COLOR, then pi-tui truecolor detection, then TERM', () => {
  const table: [Record<string, string>, boolean, string][] = [
    [{ NO_COLOR: '1', COLORTERM: 'truecolor' }, true, 'none'],
    [{ NO_COLOR: '', COLORTERM: 'truecolor' }, true, 'truecolor'],
    [{ TERM: 'xterm-256color' }, true, 'truecolor'],
    [{ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }, false, '256'],
    [{ TERM: 'tmux-256color', TMUX: '/tmp/tmux-1/default,1,0' }, false, '256'],
    [{ TERM: 'screen', TMUX: '/tmp/tmux-1/default,1,0' }, false, '256'],
    [{ TERM: 'screen', STY: '1234.pts-0.host' }, false, '256'],
    [{ TERM: 'xterm' }, false, '16'],
    [{ TERM: 'linux' }, false, '16'],
    [{}, false, '16'],
  ];
  for (const [env, trueColor, depth] of table)
    assert.equal(detectColorDepth(env, trueColor), depth, JSON.stringify(env));
});

test('background spans with a width are cut or padded so the whole span is painted', async () => {
  const palette = theme('catppuccin');
  assert.equal(visibleWidth(colorBg(palette, 'surface', 'abc', 6)), 6);
  assert.equal(stripTerminalSequences(colorBg(palette, 'surface', 'abcdefgh', 4)), 'abcd');
  const vt = await parsedRow(paintThemeRow(palette, colorBg(palette, 'diffAdded', '+x', 5), 7), 7);
  try {
    const line = vt.buffer.active.getLine(0)!;
    for (let column = 0; column < 7; column++) {
      const hex = column < 5 ? palette.backgrounds.diffAdded : palette.background;
      assert.equal(line.getCell(column)!.getBgColor(), rgb(hex), `column ${column}`);
    }
  } finally {
    vt.dispose();
  }
});

test('adding a theme is one palette entry: ids, names and every role resolve for every display', () => {
  assert.equal(new Set(THEME_IDS).size, THEME_IDS.length);
  for (const id of THEME_IDS) {
    for (const depth of ['truecolor', '256', '16', 'none'] as const) {
      for (const backdrop of ['theme', 'terminal'] as const) {
        const palette = theme(id, { depth, backdrop });
        assert.equal(palette.id, id);
        assert.equal(palette.depth, depth);
        assert.equal(palette.backdrop, backdrop);
        assert.equal(theme(id, { depth, backdrop }), palette, 'themes are built once per display');
        for (const role of ROLES) assert.match(palette.sgr.fg[role], /^[\d;]+$/);
        for (const role of BACKGROUNDS) assert.match(palette.sgr.bg[role], /^[\d;]+$/);
      }
    }
  }
});
