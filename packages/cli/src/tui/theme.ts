import {
  colorToHex,
  getTerminalColorMode,
  mixColors,
  parseColor,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';

/** Text roles. Every one except border keeps at least 4.5:1 contrast on the theme background. */
export type ThemeRole =
  | 'foreground'
  | 'muted'
  | 'accent'
  | 'success'
  | 'warning'
  | 'error'
  | 'border'
  | 'info'
  | 'diffAdded'
  | 'diffRemoved'
  | 'syntaxKeyword'
  | 'syntaxString'
  | 'syntaxNumber'
  | 'syntaxComment'
  | 'syntaxFunction'
  | 'syntaxType'
  | 'syntaxConstant'
  | 'syntaxPunctuation';
/** Background roles. The diff tints are blended from the palette's own diff colors; the rest are palette data. */
export type BackgroundRole = 'background' | 'surface' | 'selection' | 'diffAdded' | 'diffRemoved';
/** What the terminal can draw: 24-bit, the 256-color cube, the 16 named colors, or no color at all (NO_COLOR). */
export type ColorDepth = 'truecolor' | '256' | '16' | 'none';
/** 'theme' paints the palette background on every full-screen row; 'terminal' keeps the terminal's own background. */
export type Backdrop = 'theme' | 'terminal';
export interface ThemeDisplay {
  depth: ColorDepth;
  backdrop: Backdrop;
}
/** One palette entry: adding a theme is adding one of these to PALETTES. */
interface Palette {
  name: string;
  background: string;
  surface: string;
  selection: string;
  colors: Readonly<Record<ThemeRole, string>>;
}
export interface OmsTheme extends ThemeDisplay {
  id: OmsThemeId;
  name: string;
  background: string;
  surface: string;
  colors: Readonly<Record<ThemeRole, string>>;
  backgrounds: Readonly<Record<BackgroundRole, string>>;
  /** SGR parameters for each role at this depth, e.g. '38;2;235;219;178', '38;5;187', '33' or '39'. */
  sgr: { fg: Readonly<Record<ThemeRole, string>>; bg: Readonly<Record<BackgroundRole, string>> };
}

/* Palette data only; no upstream editor implementation is copied.
 * Gruvbox: Pavel Pertsev <morhetz@gmail.com>, MIT/X11.
 * https://github.com/morhetz/gruvbox/blob/ef8864bb42bf244f0295d1c5a403b27e3d139695/colors/gruvbox.vim
 * Catppuccin Mocha: Copyright (c) 2021 Catppuccin, MIT.
 * https://github.com/catppuccin/palette/blob/07d02aa110ef9eb7e7427afca5c73ba9cf7f8ebd/palette.json
 * Tokyo Night (night inherits storm): folke/tokyonight.nvim, Apache-2.0.
 * https://github.com/folke/tokyonight.nvim/tree/cdc07ac78467a233fd62c493de29a17e0cf2b2b6/lua/tokyonight/colors
 * Nord: Copyright (c) 2016-present Sven Greb <development@svengreb.de>, MIT.
 * https://github.com/nordtheme/nord/blob/1cef71605416a222e57225b544540ce0fcec18d4/src/swatches/nord.gpl
 * Dracula: Copyright (c) 2023 Dracula Theme, MIT. https://draculatheme.com/spec
 * Rosé Pine main: Copyright (c) mvllow, MIT.
 * https://github.com/rose-pine/rose-pine-palette/blob/92af52b465ab6e47437aca223c9b8d3009a2023b/dist/css/rose-pine.css
 * OMS maps original tokens to semantic roles; no invented colors. Selection is each scheme's own visual-selection
 * token (Tokyo Night's bg_visual is the upstream's published blend). Syntax roles follow each scheme's style guide.
 * Low-contrast comment tokens are not used for text: comments fall back to the muted text token. Gruvbox orange and
 * Nord gold replace their low-contrast reds (also for keywords and removed lines); Nord gold replaces nord15 for
 * numbers; Rosé Pine iris replaces pine for keywords. Labels and +/- markers must convey status, never color alone.
 * The only derived colors are the diff background tints: each diff color blended 20% into the background, the way
 * the Catppuccin, Tokyo Night and Rosé Pine Neovim ports derive theirs.
 * Distribution must retain the upstream MIT notices and Apache-2.0 license.
 */
const PALETTES = {
  gruvbox: {
    name: 'Gruvbox',
    background: '#282828',
    surface: '#3c3836',
    selection: '#665c54',
    colors: {
      foreground: '#ebdbb2',
      muted: '#a89984',
      accent: '#8ec07c',
      success: '#b8bb26',
      warning: '#fabd2f',
      error: '#fe8019',
      border: '#665c54',
      info: '#83a598',
      diffAdded: '#b8bb26',
      diffRemoved: '#fe8019',
      syntaxKeyword: '#fe8019',
      syntaxString: '#b8bb26',
      syntaxNumber: '#d3869b',
      syntaxComment: '#a89984',
      syntaxFunction: '#b8bb26',
      syntaxType: '#fabd2f',
      syntaxConstant: '#d3869b',
      syntaxPunctuation: '#ebdbb2',
    },
  },
  catppuccin: {
    name: 'Catppuccin Mocha',
    background: '#1e1e2e',
    surface: '#313244',
    selection: '#45475a',
    colors: {
      foreground: '#cdd6f4',
      muted: '#a6adc8',
      accent: '#89b4fa',
      success: '#a6e3a1',
      warning: '#f9e2af',
      error: '#f38ba8',
      border: '#585b70',
      info: '#89dceb',
      diffAdded: '#a6e3a1',
      diffRemoved: '#f38ba8',
      syntaxKeyword: '#cba6f7',
      syntaxString: '#a6e3a1',
      syntaxNumber: '#fab387',
      syntaxComment: '#9399b2',
      syntaxFunction: '#89b4fa',
      syntaxType: '#f9e2af',
      syntaxConstant: '#fab387',
      syntaxPunctuation: '#9399b2',
    },
  },
  'tokyo-night': {
    name: 'Tokyo Night',
    background: '#1a1b26',
    surface: '#292e42',
    selection: '#283457',
    colors: {
      foreground: '#c0caf5',
      muted: '#a9b1d6',
      accent: '#7aa2f7',
      success: '#9ece6a',
      warning: '#e0af68',
      error: '#f7768e',
      border: '#414868',
      info: '#0db9d7',
      diffAdded: '#9ece6a',
      diffRemoved: '#f7768e',
      syntaxKeyword: '#9d7cd8',
      syntaxString: '#9ece6a',
      syntaxNumber: '#ff9e64',
      syntaxComment: '#a9b1d6',
      syntaxFunction: '#7aa2f7',
      syntaxType: '#2ac3de',
      syntaxConstant: '#ff9e64',
      syntaxPunctuation: '#89ddff',
    },
  },
  nord: {
    name: 'Nord',
    background: '#2e3440',
    surface: '#3b4252',
    selection: '#434c5e',
    colors: {
      foreground: '#eceff4',
      muted: '#d8dee9',
      accent: '#88c0d0',
      success: '#a3be8c',
      warning: '#ebcb8b',
      error: '#ebcb8b',
      border: '#4c566a',
      info: '#88c0d0',
      diffAdded: '#a3be8c',
      diffRemoved: '#ebcb8b',
      syntaxKeyword: '#81a1c1',
      syntaxString: '#a3be8c',
      syntaxNumber: '#ebcb8b',
      syntaxComment: '#d8dee9',
      syntaxFunction: '#88c0d0',
      syntaxType: '#8fbcbb',
      syntaxConstant: '#ebcb8b',
      syntaxPunctuation: '#eceff4',
    },
  },
  dracula: {
    name: 'Dracula',
    background: '#282a36',
    surface: '#44475a',
    selection: '#44475a',
    colors: {
      foreground: '#f8f8f2',
      muted: '#bd93f9',
      accent: '#8be9fd',
      success: '#50fa7b',
      warning: '#f1fa8c',
      error: '#ff5555',
      border: '#6272a4',
      info: '#8be9fd',
      diffAdded: '#50fa7b',
      diffRemoved: '#ff5555',
      syntaxKeyword: '#ff79c6',
      syntaxString: '#f1fa8c',
      syntaxNumber: '#bd93f9',
      syntaxComment: '#bd93f9',
      syntaxFunction: '#50fa7b',
      syntaxType: '#8be9fd',
      syntaxConstant: '#bd93f9',
      syntaxPunctuation: '#f8f8f2',
    },
  },
  'rose-pine': {
    name: 'Rosé Pine',
    background: '#191724',
    surface: '#1f1d2e',
    selection: '#403d52',
    colors: {
      foreground: '#e0def4',
      muted: '#908caa',
      accent: '#c4a7e7',
      success: '#9ccfd8',
      warning: '#f6c177',
      error: '#eb6f92',
      border: '#524f67',
      info: '#9ccfd8',
      diffAdded: '#9ccfd8',
      diffRemoved: '#eb6f92',
      syntaxKeyword: '#c4a7e7',
      syntaxString: '#f6c177',
      syntaxNumber: '#f6c177',
      syntaxComment: '#908caa',
      syntaxFunction: '#ebbcba',
      syntaxType: '#9ccfd8',
      syntaxConstant: '#f6c177',
      syntaxPunctuation: '#908caa',
    },
  },
} satisfies Record<string, Palette>;

export type OmsThemeId = keyof typeof PALETTES;
export const THEME_IDS = Object.freeze(Object.keys(PALETTES)) as readonly OmsThemeId[];
export const DEFAULT_THEME_ID: OmsThemeId = 'gruvbox';
const DEFAULT_DISPLAY: ThemeDisplay = { depth: 'truecolor', backdrop: 'theme' };

/** The 16 named colors by role. Their real shades belong to the user's terminal palette, so only hues are chosen. */
const ANSI16: Readonly<Record<ThemeRole, number>> = {
  foreground: 39,
  muted: 90,
  accent: 36,
  success: 32,
  warning: 33,
  error: 31,
  border: 90,
  info: 34,
  diffAdded: 32,
  diffRemoved: 31,
  syntaxKeyword: 35,
  syntaxString: 32,
  syntaxNumber: 33,
  syntaxComment: 90,
  syntaxFunction: 34,
  syntaxType: 36,
  syntaxConstant: 33,
  syntaxPunctuation: 39,
};

function mapValues<K extends string, V, R>(record: Readonly<Record<K, V>>, map: (value: V, key: K) => R): Record<K, R> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value as V, key as K)])) as Record<
    K,
    R
  >;
}

const CUBE = [0, 95, 135, 175, 215, 255];
/**
 * The nearest xterm 256-color index, from the 6x6x6 cube or the gray ramp (as tmux picks). Indexes 0-15 are left to
 * the user's terminal palette. pi-tui's own mapping keeps the cube for tinted darks, which turns Nord's gray teal.
 */
function ansi256(red: number, green: number, blue: number): number {
  const near = (value: number) =>
    CUBE.reduce((best, step, i) => (Math.abs(step - value) < Math.abs(CUBE[best]! - value) ? i : best), 0);
  const [r, g, b] = [near(red), near(green), near(blue)];
  const level = Math.min(23, Math.max(0, Math.round(((red + green + blue) / 3 - 8) / 10)));
  const gray = 8 + level * 10;
  const distance = (x: number, y: number, z: number) => (red - x) ** 2 + (green - y) ** 2 + (blue - z) ** 2;
  return distance(CUBE[r]!, CUBE[g]!, CUBE[b]!) <= distance(gray, gray, gray) ? 16 + 36 * r + 6 * g + b : 232 + level;
}

/** SGR color parameters for a palette color at 24-bit or 256-color depth. */
function rgbSgr(hex: string, depth: 'truecolor' | '256', target: 38 | 48): string {
  const [red, green, blue] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
  return depth === 'truecolor' ? `${target};2;${red};${green};${blue}` : `${target};5;${ansi256(red, green, blue)}`;
}

function buildTheme(id: OmsThemeId, display: ThemeDisplay): OmsTheme {
  const palette: Palette = PALETTES[id];
  const tint = (hex: string) => colorToHex(mixColors(parseColor(palette.background), parseColor(hex), 0.2, 'srgb'));
  const backgrounds = {
    background: palette.background,
    surface: palette.surface,
    selection: palette.selection,
    diffAdded: tint(palette.colors.diffAdded),
    diffRemoved: tint(palette.colors.diffRemoved),
  };
  const { depth } = display;
  const rgb = depth === 'truecolor' || depth === '256' ? depth : undefined;
  // Without RGB there is no theme background; selection stays visible as inverse video.
  const sgr = {
    fg: mapValues(palette.colors, (hex, role) =>
      rgb ? rgbSgr(hex, rgb, 38) : depth === '16' ? String(ANSI16[role]) : '39',
    ),
    bg: mapValues(backgrounds, (hex, role) => (rgb ? rgbSgr(hex, rgb, 48) : role === 'selection' ? '7' : '49')),
  };
  return Object.freeze({
    id,
    name: palette.name,
    background: palette.background,
    surface: palette.surface,
    colors: palette.colors,
    backgrounds,
    sgr,
    ...display,
  });
}

const built = new Map<string, OmsTheme>();
/** A curated theme drawn for `display` (default: 24-bit color on the theme background). */
export function getTheme(name: string, display: ThemeDisplay = DEFAULT_DISPLAY): OmsTheme | undefined {
  if (!Object.hasOwn(PALETTES, name)) return undefined;
  const key = `${name}\0${display.depth}\0${display.backdrop}`;
  let theme = built.get(key);
  if (!theme) built.set(key, (theme = buildTheme(name as OmsThemeId, display)));
  return theme;
}

/**
 * NO_COLOR (set and non-empty) turns color off. Otherwise pi-tui's terminal detection decides 24-bit color
 * (COLORTERM, PI_TRUE_COLOR and known terminals); without it, a 256-color TERM, tmux or screen get the 256-color
 * cube (macOS Terminal.app sets xterm-256color without COLORTERM) and anything else the 16 named colors.
 */
export function detectColorDepth(
  env: Readonly<Record<string, string | undefined>> = process.env,
  trueColor = getTerminalColorMode() === 'truecolor',
): ColorDepth {
  if (env.NO_COLOR) return 'none';
  if (trueColor) return 'truecolor';
  return /256/.test(env.TERM ?? '') || env.TMUX || env.STY ? '256' : '16';
}

/** Controlled, already-sanitized text only. Row painting restores the base color. */
export function colorText(theme: OmsTheme, role: ThemeRole, text: string): string {
  return theme.depth === 'none' ? text : `\x1b[${theme.sgr.fg[role]}m${text}\x1b[39m`;
}

/**
 * Controlled text on a background role; with `width`, the text is cut or padded so the whole span is painted.
 * Without RGB color, backgrounds are left to the terminal and selection is drawn as inverse video.
 */
export function colorBg(theme: OmsTheme, role: BackgroundRole, text: string, width?: number): string {
  const body = width === undefined ? text : truncateToWidth(text, width, '', true);
  const code = theme.sgr.bg[role];
  if (code === '49') return body;
  return code === '7' ? `\x1b[7m${body}\x1b[27m` : `\x1b[${code}m${body}\x1b[49m`;
}

/** Restore the row's base foreground and background after nested resets. */
function restoreRowColors(text: string, foreground: string, background: string): string {
  return text.replace(/\x1b\[([\d;:]*)m/g, (sequence: string, parameters: string) => {
    const values = parameters.split(';');
    let changed = false;
    for (let index = 0; index < values.length; index++) {
      const value = values[index]!;
      // Semicolon RGB/indexed payloads contain numbers (including zero), not SGR
      // instructions. Colon-form color payloads stay intact as a single value.
      if (value === '38' || value === '48' || value === '58') {
        const mode = values[index + 1];
        index += mode === '2' ? 4 : mode === '5' ? 2 : 0;
        continue;
      }
      if (value.includes(':')) continue;
      const code = Number(value);
      if (code === 0) values[index] = `0;${foreground};${background}`;
      else if (code === 39) values[index] = foreground;
      else if (code === 49 && background !== '49') values[index] = background;
      else continue;
      changed = true;
    }
    return changed ? `\x1b[${values.join(';')}m` : sequence;
  });
}

/**
 * Paint one trusted rendered row, never raw subprocess output. Public TUI width
 * helpers preserve grapheme boundaries, SGR spans and zero-width cursor markers.
 * These local SGR colors never alter the terminal's global palette/profile.
 * The 'theme' backdrop paints the palette background (padding included); 'terminal' keeps the terminal's own.
 */
export function paintThemeRow(theme: OmsTheme, text: string, width: number): string {
  if (/[\r\n]/.test(text)) throw new Error('A painted row cannot contain a newline or carriage return');
  if (!Number.isSafeInteger(width) || width < 0) throw new RangeError('Row width must be a nonnegative integer');
  const foreground = theme.sgr.fg.foreground;
  const background = theme.backdrop === 'theme' ? theme.sgr.bg.background : '49';
  const base = `\x1b[0;${foreground};${background}m`;
  const row = truncateToWidth(text, width, '');
  const padding = ' '.repeat(Math.max(0, width - visibleWidth(row)));
  return base + restoreRowColors(row, foreground, background) + base + padding + '\x1b[0m';
}
