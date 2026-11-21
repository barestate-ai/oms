import { Theme, type ThemeBg, type ThemeColor } from '@earendil-works/pi-coding-agent';
import type { BackgroundRole, OmsTheme, ThemeRole } from './theme.ts';

/**
 * Which OMS role draws each pi-coding-agent token, so the transcript, markdown, tools, diffs and code share the
 * chrome's one palette and follow /theme. Prose is `text`; only inline code and keywords use the accent.
 */
const FOREGROUND: Readonly<Record<ThemeColor, ThemeRole>> = {
  accent: 'accent',
  border: 'border',
  borderAccent: 'borderFocus',
  borderMuted: 'border',
  success: 'success',
  error: 'error',
  warning: 'warning',
  muted: 'muted',
  dim: 'faint',
  text: 'foreground',
  thinkingText: 'muted',
  scrollbarTrack: 'border',
  scrollbarThumb: 'faint',
  searchMatchText: 'foreground',
  userMessageText: 'foreground',
  customMessageText: 'muted',
  customMessageLabel: 'accent',
  toolTitle: 'foreground',
  toolOutput: 'muted',
  mdHeading: 'foreground',
  mdLink: 'link',
  mdLinkUrl: 'faint',
  mdCode: 'accent',
  mdCodeBlock: 'foreground',
  mdCodeBlockBorder: 'border',
  mdQuote: 'muted',
  mdQuoteBorder: 'border',
  mdHr: 'faint',
  mdListBullet: 'muted',
  toolDiffAdded: 'diffAdded',
  toolDiffRemoved: 'diffRemoved',
  toolDiffContext: 'faint',
  syntaxComment: 'syntaxComment',
  syntaxKeyword: 'syntaxKeyword',
  syntaxFunction: 'syntaxFunction',
  syntaxVariable: 'foreground',
  syntaxString: 'syntaxString',
  syntaxNumber: 'syntaxNumber',
  syntaxType: 'syntaxType',
  syntaxOperator: 'syntaxPunctuation',
  syntaxPunctuation: 'syntaxPunctuation',
  thinkingOff: 'faint',
  thinkingMinimal: 'faint',
  thinkingLow: 'muted',
  thinkingMedium: 'muted',
  thinkingHigh: 'accent',
  thinkingXhigh: 'accent',
  thinkingMax: 'accent',
  bashMode: 'success',
};
/** Tool rows draw no background of their own, so the three tool tints stay on the canvas (the row painter's). */
const BACKGROUND: Readonly<Record<ThemeBg, BackgroundRole>> = {
  selectedBg: 'selection',
  searchMatchBg: 'selection',
  userMessageBg: 'surface',
  customMessageBg: 'surface',
  toolPendingBg: 'background',
  toolSuccessBg: 'background',
  toolErrorBg: 'background',
};

/**
 * A token value at the theme's depth: the hex color at 24-bit, the same 256-color index OMS chrome uses, a 16-color
 * palette index, or '' for the terminal default. The Terminal theme and 16 colors keep quiet tones on bright black.
 */
function value(theme: OmsTheme, hex: string, sgr: string): string | number {
  if (theme.depth === 'none') return '';
  if (theme.depth === 'truecolor' && !theme.ansi) return hex;
  const codes = sgr.split(';').map(Number);
  if (codes[0] === 38 || codes[0] === 48) return codes[1] === 5 ? codes[2]! : '';
  for (const code of codes) {
    if (code >= 30 && code <= 37) return code - 30;
    if (code >= 90 && code <= 97) return code - 82;
  }
  return codes.includes(2) ? 8 : '';
}

/** pi-coding-agent's Theme drawn from an OMS palette at its color depth. */
export function piTheme(theme: OmsTheme): Theme {
  const map = <K extends string, R extends string>(
    table: Readonly<Record<K, R>>,
    color: (role: R) => string | number,
  ): Record<K, string | number> =>
    Object.fromEntries(Object.entries(table).map(([token, role]) => [token, color(role as R)])) as Record<
      K,
      string | number
    >;
  return new Theme(
    map(FOREGROUND, (role) => value(theme, theme.colors[role], theme.sgr.fg[role])),
    map(BACKGROUND, (role) => (role === 'background' ? '' : value(theme, theme.backgrounds[role], theme.sgr.bg[role]))),
    theme.depth === 'truecolor' && !theme.ansi ? 'truecolor' : '256color',
    { name: `oms-${theme.id}` },
  );
}

/**
 * pi-coding-agent 1.4.0 exports Theme and initTheme but not setThemeInstance. Its components read the active theme
 * through this global (shared across module loaders on purpose), which setThemeInstance itself writes.
 */
const PI_THEME = Symbol.for('@earendil-works/pi-coding-agent:theme');

/** Make pi-coding-agent's components draw with `theme` from their next render. */
export function installPiTheme(theme: OmsTheme): void {
  (globalThis as Record<symbol, unknown>)[PI_THEME] = piTheme(theme);
}
