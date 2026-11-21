import {
  CURSOR_MARKER,
  renderFakeCursor,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { Requirement } from './commands.ts';
import type { Glyphs } from './glyphs.ts';
import { edge } from './status-row.ts';
import { colorBg, colorText, type OmsTheme, type ThemeRole } from './theme.ts';
import { singleLine } from './transcript.ts';

/** One part of the label on the composer's bottom rule: `sonnet-4.5 · ask`. */
export interface RuleLabel {
  text: string;
  role: ThemeRole;
}

/**
 * A full-width rule. It is `border` when the composer is blurred and `borderFocus` when focused; a label sits at the
 * right end: `──────── sonnet-4.5 · ask ─`.
 */
export function ruleRow(
  theme: OmsTheme,
  glyphs: Glyphs,
  width: number,
  focused: boolean,
  label: readonly RuleLabel[] = [],
  /** Styled text at the left end, for a short terminal's merged spinner: `── ⠹ Reading lib.rs… 12s ──`. */
  left?: string,
): string {
  const role: ThemeRole = focused ? 'borderFocus' : 'border';
  if (left) {
    const text = truncateToWidth(left, Math.max(1, width - 6), '');
    const rest = Math.max(2, width - visibleWidth(text) - 4);
    return (
      colorText(theme, role, glyphs.rule.repeat(2) + ' ') +
      text +
      colorText(theme, role, ' ' + glyphs.rule.repeat(rest))
    );
  }
  const plain = label.map((part) => part.text).join(glyphs.separator);
  if (!plain || width < 12) return colorText(theme, role, glyphs.rule.repeat(Math.max(0, width)));
  const room = Math.max(1, width - 5);
  const fitted = visibleWidth(plain) > room;
  const text = fitted
    ? colorText(theme, 'muted', truncateToWidth(plain, room, glyphs.ellipsis))
    : label.map((part) => colorText(theme, part.role, part.text)).join(colorText(theme, 'faint', glyphs.separator));
  const size = fitted ? room : visibleWidth(plain);
  const fill = Math.max(2, width - size - 3);
  return colorText(theme, role, glyphs.rule.repeat(fill) + ' ') + text + colorText(theme, role, ' ' + glyphs.rule);
}

/** The prompt column left of the composer: `❯` accent when focused, faint when blurred. */
export function promptRow(theme: OmsTheme, glyphs: Glyphs, focused: boolean, mark = glyphs.prompt): string {
  return colorText(theme, focused ? 'accentFill' : 'faint', mark) + ' ';
}

/** What the empty composer shows: the cursor on the first letter when focused, the placeholder in faint text. */
export function placeholderRow(theme: OmsTheme, glyphs: Glyphs, text: string, focused: boolean, width: number): string {
  const shown = truncateToWidth(text, Math.max(1, width), glyphs.ellipsis);
  const [first = ' '] = Array.from(shown);
  const rest = shown.slice(first.length);
  return focused
    ? CURSOR_MARKER + renderFakeCursor(first) + colorText(theme, 'faint', rest)
    : colorText(theme, 'faint', shown);
}

/** The header: `◆ oms  folder  branch`. The view tabs are separate (an ActionBar) at the right. */
export function headerLeft(
  theme: OmsTheme,
  glyphs: Glyphs,
  name: string,
  branch: string | undefined,
  width: number,
): string {
  const mark = colorText(theme, 'accent', `\x1b[1m${glyphs.mark} oms\x1b[22m`);
  const label = ' '.repeat(2) + colorText(theme, 'foreground', singleLine(name, 160));
  const where = branch ? '  ' + colorText(theme, 'muted', singleLine(branch, 80)) : '';
  return truncateToWidth(mark + label + where, Math.max(0, width), glyphs.ellipsis);
}

/** The persistent warning, directly above the status row: `! text`, wrapped. Confirmations are toasts instead. */
export function warningRows(theme: OmsTheme, text: string, width: number): string[] {
  if (!text) return [];
  const room = Math.max(1, width - edge(width) - 2);
  return wrapTextWithAnsi(text, room).map(
    (line, index) => (index === 0 ? colorText(theme, 'warning', '!') + ' ' : '  ') + colorText(theme, 'warning', line),
  );
}

/** Requirement state as one glyph: closed ✓, active ●, proposed or stale needs a look, open ○. */
function stateGlyph(theme: OmsTheme, glyphs: Glyphs, status: string): string {
  if (/^(?:closed|done|verified|passed)$/.test(status)) return colorText(theme, 'success', glyphs.ascii ? 'x' : '✓');
  if (status === 'active') return colorText(theme, 'accentFill', glyphs.dot);
  if (status === 'proposed' || status === 'stale') return colorText(theme, 'warning', glyphs.mark);
  return colorText(theme, 'faint', glyphs.ascii ? 'o' : '○');
}

/** The task sidebar's requirements: a lowercase heading with how many are closed, then one two-line entry each. */
export function requirementsRows(
  theme: OmsTheme,
  glyphs: Glyphs,
  items: readonly Requirement[],
  selectedId: string | undefined,
  focused: boolean,
  width: number,
): string[] {
  const closed = items.filter((item) => /^(?:closed|done|verified|passed)$/.test(item.status)).length;
  const rows = [colorText(theme, 'muted', `requirements${items.length ? ` ${closed}/${items.length}` : ''}`), ''];
  for (const item of items) {
    const selected = item.id === selectedId;
    const head = `${selected && focused ? glyphs.pointer : ' '} ${stateGlyph(theme, glyphs, item.status)} ${colorText(theme, 'foreground', `\x1b[1m${singleLine(item.id, 40)}\x1b[22m`)}  ${colorText(theme, 'muted', singleLine(item.status, 40))}`;
    const title = `    ${colorText(theme, selected ? 'foreground' : 'muted', singleLine(item.title, 400))}`;
    rows.push(selected ? colorBg(theme, 'selection', head, width) : truncateToWidth(head, width, ''));
    rows.push(selected ? colorBg(theme, 'selection', title, width) : truncateToWidth(title, width, glyphs.ellipsis));
    rows.push('');
  }
  if (!items.length) rows.push(colorText(theme, 'faint', 'Task state unavailable'));
  return rows;
}

export interface EmptyStateInput {
  version: string;
  /** The short model name, or undefined when nothing is connected. */
  model: string | undefined;
  folder: string;
  /** Rows the transcript has: a short terminal gets one line. */
  rows: number;
}

/** The three-line empty state at the top of a new conversation. */
export function emptyStateRows(theme: OmsTheme, glyphs: Glyphs, input: EmptyStateInput, suggestion: string): string[] {
  const title =
    colorText(theme, 'accent', `\x1b[1m${glyphs.mark} oms\x1b[22m`) +
    (input.version ? ' ' + colorText(theme, 'faint', input.version) : '');
  const where = colorText(
    theme,
    'muted',
    input.model
      ? `${input.model}${glyphs.separator}${singleLine(input.folder, 80)}`
      : `No model connected${glyphs.separator}${singleLine(input.folder, 80)}`,
  );
  if (input.rows < 8) return [title];
  return [title, '  ' + where, '  ' + colorText(theme, 'faint', suggestion)];
}
