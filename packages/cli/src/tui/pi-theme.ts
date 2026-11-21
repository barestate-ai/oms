import { Theme, type ThemeBg, type ThemeColor } from '@earendil-works/pi-coding-agent';
import type { BackgroundRole, OmsTheme, ThemeRole } from './theme.ts';

/** Which OMS role draws each pi-coding-agent token, so the transcript, markdown, tools, diffs and code follow /theme. */
const FOREGROUND: Readonly<Record<ThemeColor, ThemeRole>> = {
  accent: 'accent',
  border: 'border',
  borderAccent: 'accent',
  borderMuted: 'border',
  success: 'success',
  error: 'error',
  warning: 'warning',
  muted: 'muted',
  dim: 'muted',
  text: 'foreground',
  thinkingText: 'muted',
  scrollbarTrack: 'border',
  scrollbarThumb: 'muted',
  searchMatchText: 'foreground',
  userMessageText: 'foreground',
  customMessageText: 'foreground',
  customMessageLabel: 'accent',
  toolTitle: 'foreground',
  toolOutput: 'muted',
  mdHeading: 'accent',
  mdLink: 'info',
  mdLinkUrl: 'muted',
  mdCode: 'syntaxConstant',
  mdCodeBlock: 'foreground',
  mdCodeBlockBorder: 'border',
  mdQuote: 'muted',
  mdQuoteBorder: 'border',
  mdHr: 'border',
  mdListBullet: 'accent',
  toolDiffAdded: 'diffAdded',
  toolDiffRemoved: 'diffRemoved',
  toolDiffContext: 'muted',
  syntaxComment: 'syntaxComment',
  syntaxKeyword: 'syntaxKeyword',
  syntaxFunction: 'syntaxFunction',
  syntaxVariable: 'foreground',
  syntaxString: 'syntaxString',
  syntaxNumber: 'syntaxNumber',
  syntaxType: 'syntaxType',
  syntaxOperator: 'syntaxPunctuation',
  syntaxPunctuation: 'syntaxPunctuation',
  thinkingOff: 'border',
  thinkingMinimal: 'muted',
  thinkingLow: 'info',
  thinkingMedium: 'accent',
  thinkingHigh: 'warning',
  thinkingXhigh: 'error',
  thinkingMax: 'error',
  bashMode: 'warning',
};
const BACKGROUND: Readonly<Record<ThemeBg, BackgroundRole>> = {
  selectedBg: 'selection',
  searchMatchBg: 'selection',
  userMessageBg: 'surface',
  customMessageBg: 'surface',
  toolPendingBg: 'surface',
  toolSuccessBg: 'diffAdded',
  toolErrorBg: 'diffRemoved',
};

/**
 * A token value at the theme's depth: the hex color, the same 256-color index OMS chrome uses, a 16-color palette
 * index, or '' for the terminal default.
 */
function value(theme: OmsTheme, hex: string, sgr: string): string | number {
  if (theme.depth === 'truecolor') return hex;
  const code = Number(sgr.split(';').at(-1));
  if (theme.depth === '256') return code;
  return theme.depth === '16' && code >= 30 && code <= 37
    ? code - 30
    : theme.depth === '16' && code >= 90
      ? code - 82
      : '';
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
    map(BACKGROUND, (role) => value(theme, theme.backgrounds[role], theme.sgr.bg[role])),
    theme.depth === 'truecolor' ? 'truecolor' : '256color',
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
