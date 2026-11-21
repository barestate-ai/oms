import {
  colorToHex,
  getTerminalColorMode,
  mixColors,
  parseColor,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';

/**
 * Foreground roles. Each one maps to a token of the palette: foreground=text, muted=textMuted, faint=textFaint,
 * accent=accentText (accent as text), accentFill=accent (glyphs and borders only), diffAdded=diffAddFg,
 * diffRemoved=diffDelFg. Every role except border, borderFocus, faint and accentFill keeps 4.5:1 contrast on the
 * canvas; faint (hints, timestamps, glyphs; never content) and accentFill keep 3:1.
 */
export type ThemeRole =
  | 'foreground'
  | 'muted'
  | 'faint'
  | 'accent'
  | 'accentFill'
  | 'brand'
  | 'link'
  | 'success'
  | 'warning'
  | 'error'
  | 'border'
  | 'borderFocus'
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
/**
 * Background roles: canvas, surface and selection (the palette's surfaceRaised: the selected row and selection).
 * The diff tints are palette data.
 */
export type BackgroundRole = 'background' | 'surface' | 'selection' | 'diffAdded' | 'diffRemoved';
/** What the terminal can draw: 24-bit, the 256-color cube, the 16 named colors, or no color at all (NO_COLOR). */
export type ColorDepth = 'truecolor' | '256' | '16' | 'none';
/** 'theme' paints the palette background on every full-screen row; 'terminal' keeps the terminal's own background. */
export type Backdrop = 'theme' | 'terminal';
export interface ThemeDisplay {
  depth: ColorDepth;
  backdrop: Backdrop;
}
type SyntaxRole = Extract<ThemeRole, `syntax${string}`>;
/**
 * One palette: the OMS token set. Adding a theme is adding one of these to PALETTES.
 * canvas/surface/surfaceRaised/border/borderFocus are surfaces and lines, text/textMuted/textFaint the three text
 * tones, accent (glyphs, borders) and accentText (text) the one accent, brand the OMS brown (tints and badges).
 */
interface Palette {
  name: string;
  appearance: 'dark' | 'light';
  /** Draws with the terminal's own 16 colors, attributes and background; the hex values only stand in for them. */
  ansi?: true;
  canvas: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderFocus: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentText: string;
  brand: string;
  link: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  diffAddFg: string;
  diffAddBg: string;
  diffDelFg: string;
  diffDelBg: string;
  syntax: Readonly<Record<SyntaxRole, string>>;
  /** 256-color indexes where the nearest cube color is wrong: tinted darks collapse to grays, brown to gray. */
  ansi256?: Partial<Record<TokenName, number>>;
}
type TokenName = Exclude<keyof Palette, 'name' | 'appearance' | 'ansi' | 'syntax' | 'ansi256'>;
export interface OmsTheme extends ThemeDisplay {
  id: OmsThemeId;
  name: string;
  appearance: 'dark' | 'light';
  /** True for the Terminal theme: its hex values are stand-ins, the screen uses the terminal's own colors. */
  ansi: boolean;
  background: string;
  surface: string;
  colors: Readonly<Record<ThemeRole, string>>;
  backgrounds: Readonly<Record<BackgroundRole, string>>;
  /** SGR parameters for each role at this depth, e.g. '38;2;235;219;178', '38;5;187', '33' or '39'. */
  sgr: { fg: Readonly<Record<ThemeRole, string>>; bg: Readonly<Record<BackgroundRole, string>> };
}

/** Upstream palette data only; no upstream editor implementation is copied. */
interface Upstream {
  name: string;
  background: string;
  surface: string;
  selection: string;
  colors: Readonly<Record<UpstreamRole, string>>;
}
type UpstreamRole =
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
  | SyntaxRole;

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
 * Low-contrast comment tokens are not used for text: comments fall back to the muted text token. Gruvbox orange
 * replaces its low-contrast red (also for keywords and removed lines); Nord gold replaces nord15 for numbers; Rosé
 * Pine iris replaces pine for keywords. Labels and +/- markers must convey status, never color alone.
 * Derived colors, never upstream values: the diff background tints (each diff color blended 20% into the background,
 * the way the Catppuccin, Tokyo Night and Rosé Pine Neovim ports derive theirs), the faint text tone (muted blended
 * into the background), Dracula's neutral muted (its foreground blended 35% into the background, because its
 * purple muted tinted all secondary text) and Nord's error (nord11, lifted 30% toward the foreground to reach 4.5:1).
 * Distribution must retain the upstream MIT notices and Apache-2.0 license.
 */
const UPSTREAM = {
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
      error: '#cc8c93',
      border: '#4c566a',
      info: '#88c0d0',
      diffAdded: '#a3be8c',
      diffRemoved: '#cc8c93',
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
      muted: '#afb0b0',
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
      syntaxComment: '#afb0b0',
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
} satisfies Record<string, Upstream>;

const BRAND = '#744123';
const mix = (from: string, to: string, weight: number) =>
  colorToHex(mixColors(parseColor(from), parseColor(to), weight, 'srgb'));

/** An upstream scheme in the OMS token set: its own colors, plus the tokens it does not define, derived. */
function fromUpstream(scheme: Upstream): Palette {
  const { colors, background } = scheme;
  const { diffAdded, diffRemoved, ...syntax } = colors;
  return {
    name: scheme.name,
    appearance: 'dark',
    canvas: background,
    surface: scheme.surface,
    surfaceRaised: scheme.selection,
    border: colors.border,
    borderFocus: colors.accent,
    text: colors.foreground,
    textMuted: colors.muted,
    textFaint: mix(background, colors.muted, 0.72),
    accent: colors.accent,
    accentText: colors.accent,
    brand: BRAND,
    link: colors.info,
    success: colors.success,
    warning: colors.warning,
    error: colors.error,
    info: colors.info,
    diffAddFg: diffAdded,
    diffAddBg: mix(background, diffAdded, 0.2),
    diffDelFg: diffRemoved,
    diffDelBg: mix(background, diffRemoved, 0.2),
    syntax: {
      syntaxKeyword: syntax.syntaxKeyword,
      syntaxString: syntax.syntaxString,
      syntaxNumber: syntax.syntaxNumber,
      syntaxComment: syntax.syntaxComment,
      syntaxFunction: syntax.syntaxFunction,
      syntaxType: syntax.syntaxType,
      syntaxConstant: syntax.syntaxConstant,
      syntaxPunctuation: syntax.syntaxPunctuation,
    },
    ansi256: { brand: 94, diffAddBg: 22, diffDelBg: 52 },
  };
}

/**
 * The OMS palettes are original (MIT, oms contributors). Ember is built around the brand brown #744123: as a
 * foreground that is only 2.2:1 on dark, so it tints badges and the usable accent is a lifted copper in the same hue.
 * Comments and punctuation use the muted tone (the faint tone is for hints, never for code a reader must read).
 */
const OMS_PALETTES = {
  'oms-ember': {
    name: 'OMS Ember',
    appearance: 'dark',
    canvas: '#15120F',
    surface: '#221D19',
    surfaceRaised: '#2E2722',
    border: '#3B332D',
    borderFocus: '#9A6440',
    text: '#ECE4DB',
    textMuted: '#A89A8C',
    textFaint: '#7A6D62',
    accent: '#D98C5F',
    accentText: '#D98C5F',
    brand: BRAND,
    link: '#8DB9CC',
    success: '#A5C67C',
    warning: '#E4B65E',
    error: '#E46F6F',
    info: '#8DB9CC',
    diffAddFg: '#A5C67C',
    diffAddBg: '#1F2B1B',
    diffDelFg: '#E46F6F',
    diffDelBg: '#361C1A',
    syntax: {
      syntaxKeyword: '#D98C5F',
      syntaxString: '#A5C67C',
      syntaxNumber: '#E4B65E',
      syntaxComment: '#A89A8C',
      syntaxFunction: '#8DB9CC',
      syntaxType: '#8DB9CC',
      syntaxConstant: '#E4B65E',
      syntaxPunctuation: '#A89A8C',
    },
    ansi256: { brand: 94, diffAddBg: 22, diffDelBg: 52 },
  },
  'oms-graphite': {
    name: 'OMS Graphite',
    appearance: 'dark',
    canvas: '#131313',
    surface: '#1E1E1E',
    surfaceRaised: '#2A2A2A',
    border: '#353535',
    borderFocus: '#5E5E5E',
    text: '#E6E6E6',
    textMuted: '#A3A3A3',
    textFaint: '#757575',
    accent: '#D58D60',
    accentText: '#D58D60',
    brand: BRAND,
    link: '#88B0DE',
    success: '#8DC286',
    warning: '#DDB463',
    error: '#E46F6F',
    info: '#88B0DE',
    diffAddFg: '#8DC286',
    diffAddBg: '#173019',
    diffDelFg: '#E46F6F',
    diffDelBg: '#3B1719',
    syntax: {
      syntaxKeyword: '#D58D60',
      syntaxString: '#8DC286',
      syntaxNumber: '#DDB463',
      syntaxComment: '#A3A3A3',
      syntaxFunction: '#88B0DE',
      syntaxType: '#88B0DE',
      syntaxConstant: '#DDB463',
      syntaxPunctuation: '#A3A3A3',
    },
    ansi256: { brand: 94, diffAddBg: 22, diffDelBg: 52 },
  },
  'oms-parchment': {
    name: 'OMS Parchment',
    appearance: 'light',
    canvas: '#FBF8F3',
    surface: '#F3EDE4',
    surfaceRaised: '#E9E0D4',
    border: '#DCD0C1',
    borderFocus: '#A06B48',
    text: '#2A211B',
    textMuted: '#665A50',
    textFaint: '#8A7D71',
    accent: BRAND,
    accentText: BRAND,
    brand: BRAND,
    link: '#2B6789',
    success: '#3B7430',
    warning: '#8F5F00',
    error: '#B3261E',
    info: '#2B6789',
    diffAddFg: '#2D6A23',
    diffAddBg: '#E2F0DA',
    diffDelFg: '#A1281F',
    diffDelBg: '#F7DFDA',
    syntax: {
      syntaxKeyword: BRAND,
      syntaxString: '#3B7430',
      syntaxNumber: '#8F5F00',
      syntaxComment: '#665A50',
      syntaxFunction: '#2B6789',
      syntaxType: '#2B6789',
      syntaxConstant: '#8F5F00',
      syntaxPunctuation: '#665A50',
    },
    ansi256: { accent: 94, accentText: 94, brand: 94, warning: 130, diffAddBg: 194, diffDelBg: 224 },
  },
  // Solana purple only where 3:1 is enough (glyphs, borders); purple text uses the lifted accentText. Generic name:
  // no Solana logo or gradient, and no claim to be an official Solana theme.
  'oms-sol': {
    name: 'OMS Sol',
    appearance: 'dark',
    canvas: '#0F0E14',
    surface: '#1A1824',
    surfaceRaised: '#252233',
    border: '#2F2B40',
    borderFocus: '#9945FF',
    text: '#ECEAF4',
    textMuted: '#A6A2BB',
    textFaint: '#75708E',
    accent: '#9945FF',
    accentText: '#B996FF',
    brand: BRAND,
    link: '#7CCBF2',
    success: '#14F195',
    warning: '#F2C45A',
    error: '#FF6E86',
    info: '#7CCBF2',
    diffAddFg: '#14F195',
    diffAddBg: '#0D2A20',
    diffDelFg: '#FF6E86',
    diffDelBg: '#2F1422',
    syntax: {
      syntaxKeyword: '#B996FF',
      syntaxString: '#14F195',
      syntaxNumber: '#F2C45A',
      syntaxComment: '#A6A2BB',
      syntaxFunction: '#7CCBF2',
      syntaxType: '#7CCBF2',
      syntaxConstant: '#F2C45A',
      syntaxPunctuation: '#A6A2BB',
    },
    ansi256: { accent: 99, accentText: 141, success: 49, error: 204, brand: 94, diffAddBg: 22, diffDelBg: 52 },
  },
  /**
   * Draws only with the terminal's own 16 colors and attributes and keeps its background, so it reads on any profile,
   * through tmux and SSH, and on TERM=linux. The hex values are stand-ins (xterm's default palette), never drawn.
   */
  terminal: {
    name: 'Terminal',
    appearance: 'dark',
    ansi: true,
    canvas: '#000000',
    surface: '#000000',
    surfaceRaised: '#4d4d4d',
    border: '#7f7f7f',
    borderFocus: '#e5e5e5',
    text: '#e5e5e5',
    textMuted: '#b3b3b3',
    textFaint: '#7f7f7f',
    accent: '#cdcd00',
    accentText: '#cdcd00',
    brand: '#cdcd00',
    link: '#00cdcd',
    success: '#00cd00',
    warning: '#cdcd00',
    error: '#cd0000',
    info: '#00cdcd',
    diffAddFg: '#00cd00',
    diffAddBg: '#000000',
    diffDelFg: '#cd0000',
    diffDelBg: '#000000',
    syntax: {
      syntaxKeyword: '#cd00cd',
      syntaxString: '#00cd00',
      syntaxNumber: '#cdcd00',
      syntaxComment: '#7f7f7f',
      syntaxFunction: '#0000ee',
      syntaxType: '#00cdcd',
      syntaxConstant: '#cdcd00',
      syntaxPunctuation: '#e5e5e5',
    },
  },
} satisfies Record<string, Palette>;

const PALETTES = {
  ...OMS_PALETTES,
  ...(Object.fromEntries(Object.entries(UPSTREAM).map(([id, scheme]) => [id, fromUpstream(scheme)])) as Record<
    keyof typeof UPSTREAM,
    Palette
  >),
} satisfies Record<string, Palette>;

export type OmsThemeId = keyof typeof PALETTES;
export const THEME_IDS = Object.freeze(Object.keys(PALETTES)) as readonly OmsThemeId[];
export const DEFAULT_THEME_ID: OmsThemeId = 'oms-ember';
const DEFAULT_DISPLAY: ThemeDisplay = { depth: 'truecolor', backdrop: 'theme' };

/** The Terminal theme's SGR by role: default text, attributes for emphasis, and the 16 named colors for hue. */
const TERMINAL_FG: Readonly<Record<ThemeRole, string>> = {
  foreground: '39',
  muted: '2',
  faint: '90',
  accent: '33',
  accentFill: '33',
  brand: '33',
  link: '36;4',
  success: '32',
  warning: '1;33',
  error: '31',
  border: '90',
  borderFocus: '37',
  info: '36',
  diffAdded: '32',
  diffRemoved: '31',
  syntaxKeyword: '35',
  syntaxString: '32',
  syntaxNumber: '33',
  syntaxComment: '90',
  syntaxFunction: '34',
  syntaxType: '36',
  syntaxConstant: '33',
  syntaxPunctuation: '39',
};
/** The 16 named colors for a palette on a 16-color terminal. Their real shades belong to the user's palette. */
const ANSI16: Readonly<Record<ThemeRole, number>> = {
  foreground: 39,
  muted: 90,
  faint: 90,
  accent: 36,
  accentFill: 36,
  brand: 33,
  link: 34,
  success: 32,
  warning: 33,
  error: 31,
  border: 90,
  borderFocus: 36,
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
/** Without color (NO_COLOR) only attributes remain: the quiet tones dim, the loud ones bold. */
const NO_COLOR_FG: Partial<Record<ThemeRole, string>> = {
  muted: '2',
  faint: '2',
  warning: '1',
  error: '1',
  syntaxComment: '2',
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

/** SGR color parameters for a palette color at 24-bit or 256-color depth; an override pins the 256-color index. */
function rgbSgr(hex: string, depth: 'truecolor' | '256', target: 38 | 48, index?: number): string {
  const [red, green, blue] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
  if (depth === 'truecolor') return `${target};2;${red};${green};${blue}`;
  return `${target};5;${index ?? ansi256(red, green, blue)}`;
}

/** The palette token each foreground and background role draws. */
const FOREGROUND_TOKEN: Readonly<Record<ThemeRole, TokenName | `syntax:${SyntaxRole}`>> = {
  foreground: 'text',
  muted: 'textMuted',
  faint: 'textFaint',
  accent: 'accentText',
  accentFill: 'accent',
  brand: 'brand',
  link: 'link',
  success: 'success',
  warning: 'warning',
  error: 'error',
  border: 'border',
  borderFocus: 'borderFocus',
  info: 'info',
  diffAdded: 'diffAddFg',
  diffRemoved: 'diffDelFg',
  syntaxKeyword: 'syntax:syntaxKeyword',
  syntaxString: 'syntax:syntaxString',
  syntaxNumber: 'syntax:syntaxNumber',
  syntaxComment: 'syntax:syntaxComment',
  syntaxFunction: 'syntax:syntaxFunction',
  syntaxType: 'syntax:syntaxType',
  syntaxConstant: 'syntax:syntaxConstant',
  syntaxPunctuation: 'syntax:syntaxPunctuation',
};
const BACKGROUND_TOKEN: Readonly<Record<BackgroundRole, TokenName>> = {
  background: 'canvas',
  surface: 'surface',
  selection: 'surfaceRaised',
  diffAdded: 'diffAddBg',
  diffRemoved: 'diffDelBg',
};

function buildTheme(id: OmsThemeId, display: ThemeDisplay): OmsTheme {
  const palette: Palette = PALETTES[id];
  const hex = (token: TokenName | `syntax:${SyntaxRole}`) =>
    token.startsWith('syntax:') ? palette.syntax[token.slice(7) as SyntaxRole] : palette[token as TokenName];
  const colors = mapValues(FOREGROUND_TOKEN, hex) as Record<ThemeRole, string>;
  const backgrounds = mapValues(BACKGROUND_TOKEN, hex) as Record<BackgroundRole, string>;
  const { depth } = display;
  const rgb = depth === 'truecolor' || depth === '256' ? depth : undefined;
  const pinned = (token: string) => (token.startsWith('syntax:') ? undefined : palette.ansi256?.[token as TokenName]);
  const sgr = palette.ansi
    ? {
        fg: depth === 'none' ? mapValues(TERMINAL_FG, (_, role) => NO_COLOR_FG[role] ?? '39') : TERMINAL_FG,
        // Surfaces are never painted; selection is inverse video.
        bg: mapValues(backgrounds, (_, role) => (role === 'selection' ? '7' : '49')),
      }
    : {
        fg: mapValues(colors, (value, role) =>
          rgb
            ? rgbSgr(value, rgb, 38, pinned(FOREGROUND_TOKEN[role]))
            : depth === '16'
              ? String(ANSI16[role])
              : (NO_COLOR_FG[role] ?? '39'),
        ),
        // Without RGB there is no theme background; selection stays visible as inverse video.
        bg: mapValues(backgrounds, (value, role) =>
          rgb ? rgbSgr(value, rgb, 48, pinned(BACKGROUND_TOKEN[role])) : role === 'selection' ? '7' : '49',
        ),
      };
  return Object.freeze({
    id,
    name: palette.name,
    appearance: palette.appearance,
    ansi: !!palette.ansi,
    background: palette.canvas,
    surface: palette.surface,
    colors,
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

/** What closes an SGR span: attributes close with their own code, a color with the default foreground. */
const closers = new Map<string, string>();
function closeFor(open: string): string {
  let close = closers.get(open);
  if (close === undefined) {
    const parameters = open.split(';');
    const codes = new Set<string>();
    for (let index = 0; index < parameters.length; index++) {
      const code = parameters[index]!;
      if (code === '38') {
        codes.add('39');
        index += parameters[index + 1] === '2' ? 4 : 2;
      } else if (/^(?:3[0-7]|9[0-7])$/.test(code)) codes.add('39');
      else if (code === '1' || code === '2') codes.add('22');
      else if (code === '4') codes.add('24');
    }
    close = [...codes].join(';') || '39';
    closers.set(open, close);
  }
  return close;
}

/** Controlled, already-sanitized text only. Row painting restores the base color. */
export function colorText(theme: OmsTheme, role: ThemeRole, text: string): string {
  const open = theme.sgr.fg[role];
  return open === '39' ? text : `\x1b[${open}m${text}\x1b[${closeFor(open)}m`;
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

/**
 * One row painted on the surface background (floating panels): like paintThemeRow, but nested resets return to the
 * surface and the padding is surface-colored. Terminal and no-color themes leave the surface to the terminal.
 */
export function paintSurfaceRow(theme: OmsTheme, text: string, width: number): string {
  if (/[\r\n]/.test(text)) throw new Error('A painted row cannot contain a newline or carriage return');
  const foreground = theme.sgr.fg.foreground;
  const background = theme.sgr.bg.surface;
  const base = `\x1b[0;${foreground};${background}m`;
  const row = truncateToWidth(text, width, '');
  const padding = ' '.repeat(Math.max(0, width - visibleWidth(row)));
  return base + restoreRowColors(row, foreground, background) + base + padding + '\x1b[0m';
}
