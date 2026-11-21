import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import {
  DEFAULT_THEME_ID,
  THEME_IDS,
  colorBg,
  colorText,
  getTheme,
  paintSurfaceRow,
  paintThemeRow,
  type OmsTheme,
  type ThemeRole,
} from '../src/tui/theme.ts';

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
const theme = (id: string, display?: Parameters<typeof getTheme>[1]): OmsTheme => {
  const value = getTheme(id, display);
  assert.ok(value, id);
  return value;
};
const OMS = ['oms-ember', 'oms-graphite', 'oms-parchment', 'oms-sol'];
const DRAWN = THEME_IDS.filter((id) => id !== 'terminal');

test('the OMS themes, the Terminal theme and the six upstream themes are all there, with Ember as the default', () => {
  assert.deepEqual(
    [...THEME_IDS],
    [...OMS, 'terminal', 'gruvbox', 'catppuccin', 'tokyo-night', 'nord', 'dracula', 'rose-pine'],
  );
  assert.equal(DEFAULT_THEME_ID, 'oms-ember');
  assert.deepEqual(
    THEME_IDS.map((id) => theme(id).name),
    [
      'OMS Ember',
      'OMS Graphite',
      'OMS Parchment',
      'OMS Sol',
      'Terminal',
      'Gruvbox',
      'Catppuccin Mocha',
      'Tokyo Night',
      'Nord',
      'Dracula',
      'Rosé Pine',
    ],
  );
  assert.equal(theme('oms-parchment').appearance, 'light');
  for (const id of THEME_IDS.filter((id) => id !== 'oms-parchment')) assert.equal(theme(id).appearance, 'dark');
  assert.ok(luminance(theme('oms-parchment').background) > 0.8, 'the light theme has a light canvas');
});

for (const id of DRAWN) {
  test(`${id}: contrast floors hold for text, muted, faint, accent, status colors and borders`, () => {
    const t = theme(id);
    const canvas = t.background;
    const c = (role: ThemeRole, on = canvas) => contrast(t.colors[role], on);
    const label = (role: ThemeRole, on: string, ratio: number) => `${id}.${role} on ${on} is ${ratio.toFixed(2)}:1`;
    for (const on of [canvas, t.surface])
      assert.ok(c('foreground', on) >= 7, label('foreground', on, c('foreground', on)));
    assert.ok(c('muted') >= 4.5, label('muted', canvas, c('muted')));
    assert.ok(c('faint') >= 3, label('faint', canvas, c('faint')));
    assert.ok(c('faint') < c('muted'), `${id}: faint is quieter than muted`);
    assert.ok(c('accent') >= 4.5, label('accent', canvas, c('accent')));
    assert.ok(c('accentFill') >= 3, label('accentFill', canvas, c('accentFill')));
    assert.ok(c('borderFocus') >= 2.8, label('borderFocus', canvas, c('borderFocus')));
    for (const role of ['link', 'success', 'warning', 'error', 'info', 'diffAdded', 'diffRemoved'] as const)
      assert.ok(c(role) >= 4.5, label(role, canvas, c(role)));
    const border = c('border');
    // OMS borders are decoration: visible, never loud. Upstream borders are their own scheme's lines.
    assert.ok(border >= 1.3 && border <= (OMS.includes(id) ? 1.7 : 3.1), label('border', canvas, border));
    assert.ok(border < c('borderFocus'), `${id}: focus brightens the border`);
    for (const [fg, bg] of [
      ['diffAdded', 'diffAdded'],
      ['diffRemoved', 'diffRemoved'],
    ] as const) {
      const ratio = contrast(t.colors[fg], t.backgrounds[bg]);
      assert.ok(ratio >= 3, `${id}: ${fg} on its tint is ${ratio.toFixed(2)}:1`);
    }
    // Muted text never sits on the selected row (some upstream selection colors are too close to it): selected rows use text.
    assert.ok(contrast(t.colors.foreground, t.backgrounds.selection) >= 4.5, `${id}: text on the selected row`);
  });
}

test('the brand brown is only a tint on dark themes and the accent itself on the light one', () => {
  for (const id of OMS) {
    const t = theme(id);
    assert.equal(t.colors.brand.toLowerCase(), '#744123');
  }
  assert.ok(contrast(theme('oms-ember').colors.brand, theme('oms-ember').background) < 3);
  assert.equal(theme('oms-parchment').colors.accent, theme('oms-parchment').colors.brand);
  assert.notEqual(theme('oms-ember').colors.accent.toLowerCase(), '#744123');
});

test('Dracula secondary text is neutral, not purple, and Nord errors are red, not the warning gold', () => {
  const dracula = theme('dracula').colors.muted;
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(dracula.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 12, `Dracula muted ${dracula} is neutral`);
  const nord = theme('nord');
  assert.notEqual(nord.colors.error, nord.colors.warning);
  const [red, green, blue] = [1, 3, 5].map((start) => Number.parseInt(nord.colors.error.slice(start, start + 2), 16));
  assert.ok(red! > green! && red! > blue!, `Nord error ${nord.colors.error} is red`);
  assert.equal(nord.colors.diffRemoved, nord.colors.error);
});

test('256-color overrides pin the tints that would collapse to gray and keep the brand brown', () => {
  const d256 = { depth: '256', backdrop: 'theme' } as const;
  for (const id of ['oms-ember', 'oms-graphite', 'oms-sol', 'gruvbox', 'nord']) {
    const t = theme(id, d256);
    assert.equal(t.sgr.bg.diffAdded, '48;5;22', id);
    assert.equal(t.sgr.bg.diffRemoved, '48;5;52', id);
    assert.equal(t.sgr.fg.brand, '38;5;94', id);
  }
  const parchment = theme('oms-parchment', d256);
  assert.equal(parchment.sgr.bg.diffAdded, '48;5;194');
  assert.equal(parchment.sgr.bg.diffRemoved, '48;5;224');
  assert.equal(parchment.sgr.fg.accent, '38;5;94');
  assert.equal(parchment.sgr.fg.warning, '38;5;130');
  const sol = theme('oms-sol', d256);
  assert.equal(sol.sgr.fg.accentFill, '38;5;99');
  assert.equal(sol.sgr.fg.accent, '38;5;141');
  assert.equal(sol.sgr.fg.success, '38;5;49');
  assert.equal(sol.sgr.fg.error, '38;5;204');
  // Truecolor ignores the overrides.
  assert.match(theme('oms-ember').sgr.fg.brand, /^38;2;/);
});

test('every OMS role has a distinct 256-color index where the spec needs one', () => {
  const t = theme('oms-ember', { depth: '256', backdrop: 'theme' });
  const index = (role: ThemeRole) => t.sgr.fg[role];
  assert.notEqual(index('error'), index('accent'), 'error no longer collides with the accent');
  assert.notEqual(index('foreground'), index('muted'));
  assert.notEqual(index('muted'), index('faint'));
});

test('the Terminal theme uses the terminal palette, attributes and background only', () => {
  const t = theme('terminal', { depth: 'truecolor', backdrop: 'theme' });
  assert.equal(t.ansi, true);
  assert.equal(t.sgr.bg.background, '49');
  assert.equal(t.sgr.bg.surface, '49');
  assert.equal(t.sgr.bg.selection, '7');
  assert.equal(colorText(t, 'foreground', 'x'), 'x');
  assert.equal(colorText(t, 'muted', 'x'), '\x1b[2mx\x1b[22m', 'muted is dim default text');
  assert.equal(colorText(t, 'accent', 'x'), '\x1b[33mx\x1b[39m');
  assert.equal(colorText(t, 'warning', 'x'), '\x1b[1;33mx\x1b[22;39m', 'warning is bold yellow');
  assert.equal(colorText(t, 'error', 'x'), '\x1b[31mx\x1b[39m');
  assert.equal(colorText(t, 'link', 'x'), '\x1b[36;4mx\x1b[39;24m');
  assert.equal(colorBg(t, 'surface', 'x'), 'x');
  assert.equal(colorBg(t, 'selection', 'x'), '\x1b[7mx\x1b[27m');
  const row = paintThemeRow(t, colorText(t, 'success', 'ok'), 10);
  assert.ok(!/[34]8;[25];/.test(row), 'no 24-bit or 256-color escapes');
  assert.ok(!/\x1b\[[\d;]*4[0-7]m/.test(row), 'never paints a background');
  assert.equal(stripTerminalSequences(row), 'ok        ');
  for (const depth of ['256', '16'] as const) {
    const same = theme('terminal', { depth, backdrop: 'theme' });
    assert.deepEqual(same.sgr.fg, t.sgr.fg, `${depth} draws the same 16 colors`);
  }
});

test('NO_COLOR keeps weight and dimness for quiet and loud roles but never a color', () => {
  const t = theme('oms-ember', { depth: 'none', backdrop: 'theme' });
  assert.equal(colorText(t, 'accent', 'x'), 'x');
  assert.equal(colorText(t, 'muted', 'x'), '\x1b[2mx\x1b[22m');
  assert.equal(colorText(t, 'faint', 'x'), '\x1b[2mx\x1b[22m');
  assert.equal(colorText(t, 'error', 'x'), '\x1b[1mx\x1b[22m');
  const row = paintThemeRow(t, colorText(t, 'warning', 'A') + colorText(t, 'muted', 'B'), 4);
  const codes = [...row.matchAll(/\x1b\[([\d;]*)m/g)].flatMap((match) => match[1]!.split(';').map(Number));
  assert.ok(!codes.some((code) => (code >= 30 && code <= 38) || (code >= 40 && code <= 48) || code >= 90), row);
});

test('the default display paints the palette canvas and a floating panel row paints the surface', () => {
  const t = theme('oms-ember');
  assert.equal(t.backdrop, 'theme');
  const canvas = [1, 3, 5].map((start) => Number.parseInt(t.background.slice(start, start + 2), 16)).join(';');
  assert.ok(paintThemeRow(t, 'x', 4).includes(`48;2;${canvas}`));
  const surface = [1, 3, 5].map((start) => Number.parseInt(t.surface.slice(start, start + 2), 16)).join(';');
  const panel = paintSurfaceRow(t, 'a\x1b[0mb\x1b[49mc', 6);
  assert.equal(visibleWidth(panel), 6);
  assert.ok(panel.includes(`48;2;${surface}`));
  assert.ok(!panel.includes(`48;2;${canvas}`), 'nested resets return to the surface, never the canvas');
  assert.equal(stripTerminalSequences(panel), 'abc   ');
});
