import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import { inGlyphs, type Glyphs } from './glyphs.ts';
import { colorText, paintSurfaceRow, type OmsTheme, type ThemeRole } from './theme.ts';
import { APPROVAL_TEXT_LIMIT } from '../connectors/approvals.ts';
import { displayText, singleLine } from './transcript.ts';

export interface BoxOptions {
  theme: OmsTheme;
  glyphs: Glyphs;
  width: number;
  /** Inside the top border, after one space. */
  title: string;
  /** Inside the bottom border, right-aligned. */
  hint?: string;
  /** Color of the border and of the title. */
  border: ThemeRole;
  /** Styled rows; each is cut to the content width. */
  rows: readonly string[];
  /** Columns of padding inside the side borders (default 2) and rows of padding inside top and bottom (default 1). */
  padX?: number;
  padY?: number;
}

/**
 * A rounded box on the surface background: the title sits in the top border, key hints in the bottom border, and the
 * content has inner padding. Every returned row is exactly `width` columns, painted, with no side effects.
 */
export function boxLines(options: BoxOptions): string[] {
  const { theme, glyphs, width } = options;
  const { topLeft, topRight, bottomLeft, bottomRight } = glyphs.corners;
  const padX = options.padX ?? 2;
  const padY = options.padY ?? 1;
  const edge = (text: string) => colorText(theme, options.border, text);
  const inner = Math.max(0, width - 2);
  const content = Math.max(1, inner - 2 * padX);
  const title = options.title
    ? truncateToWidth(` ${inGlyphs(glyphs, singleLine(options.title, 200))} `, Math.max(0, inner - 2), '')
    : '';
  const top =
    edge(topLeft + glyphs.rule) +
    colorText(theme, options.border, `\x1b[1m${title}\x1b[22m`) +
    edge(glyphs.rule.repeat(Math.max(0, inner - 1 - visibleWidth(title))) + topRight);
  const hint = options.hint
    ? truncateToWidth(` ${inGlyphs(glyphs, singleLine(options.hint, 200))} `, Math.max(0, inner - 2), '')
    : '';
  const bottom =
    edge(bottomLeft + glyphs.rule.repeat(Math.max(0, inner - 1 - visibleWidth(hint)))) +
    colorText(theme, 'faint', hint) +
    edge(glyphs.rule + bottomRight);
  const side = edge(glyphs.vertical);
  const blank = side + ' '.repeat(inner) + side;
  const row = (text: string) => {
    const fitted = truncateToWidth(text, content, '');
    return side + ' '.repeat(padX) + fitted + ' '.repeat(Math.max(0, content - visibleWidth(fitted)) + padX) + side;
  };
  const lines = [
    top,
    ...Array<string>(padY).fill(blank),
    ...options.rows.map(row),
    ...Array<string>(padY).fill(blank),
    bottom,
  ];
  return lines.map((line) => paintSurfaceRow(theme, line, width));
}

export interface PanelOptions {
  theme: () => OmsTheme;
  glyphs: Glyphs;
  title: () => string;
  hint: () => string;
  body: Component;
  /** One row under the body: a filter or the entry field. */
  input?: Component;
  /** The tallest the whole panel may be, borders and padding included. */
  maxRows: () => number;
  /** A short terminal: no padding rows and no gap above the input. */
  compact?: () => boolean;
}

/** A centered floating panel for the setup, model, connect, theme, settings and account screens. */
export class Panel implements Component {
  private readonly options: PanelOptions;
  constructor(options: PanelOptions) {
    this.options = options;
  }
  /** Rows the panel's own chrome takes (borders, padding, and the input row). */
  chromeRows(): number {
    const compact = this.options.compact?.() ?? false;
    return 2 + (compact ? 0 : 2) + (this.options.input ? 1 : 0);
  }
  /** Rows left for the body at the current terminal size. */
  bodyRows(): number {
    return Math.max(1, this.options.maxRows() - this.chromeRows());
  }
  invalidate(): void {
    this.options.body.invalidate();
    this.options.input?.invalidate();
  }
  /** Mouse events inside the border go to the body in its own coordinates; the border and padding swallow them. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const body = this.options.body;
    if (!body.handleMouse) return undefined;
    const x = event.x - 3;
    const y = event.y - 1 - ((this.options.compact?.() ?? false) ? 0 : 1);
    const width = event.width - 6;
    if (x < 0 || y < 0 || x >= width || y >= this.bodyRows()) return { handled: true, focus: false };
    return body.handleMouse({ ...event, x, y, width, height: this.bodyRows() });
  }
  render(width: number): string[] {
    const o = this.options;
    const content = Math.max(1, width - 6);
    const body = o.body.render(content).slice(0, this.bodyRows());
    const compact = o.compact?.() ?? false;
    const input = o.input ? o.input.render(content).slice(0, 1) : [];
    return boxLines({
      padY: compact ? 0 : 1,
      theme: o.theme(),
      glyphs: o.glyphs,
      width,
      title: o.title(),
      hint: o.hint(),
      border: 'borderFocus',
      rows: [...body, ...input],
    });
  }
}

export interface ApprovalRequest {
  /** The card's title; 'Allow host command?' when absent. */
  title?: string;
  /** `command` is a sentence about a connector action, not a shell command: no `$` prefix. */
  plain?: boolean;
  requester?: string;
  reasons: readonly string[];
  command: string;
  /** Chat sessions offer approval for the rest of the session. */
  session: boolean;
}

/** Every wrapped row of the command, as the card draws it: up to the limit callers are held to, so nothing is cut. */
export function approvalCommandRows(command: string, width: number, plain = false): string[] {
  const content = Math.max(1, width - 6);
  return displayText(command, APPROVAL_TEXT_LIMIT)
    .split('\n')
    .flatMap((line, index) => wrapTextWithAnsi(plain ? line : index === 0 ? `$ ${line}` : `  ${line}`, content));
}

/** The window of the command the card shows; the rest is read by scrolling. */
export interface ApprovalView {
  rows: number;
  offset: number;
}

/** Whether the window has reached the last row of the command, so the whole command has been on screen. */
export const approvalFullyShown = (total: number, view: ApprovalView): boolean => view.offset + view.rows >= total;

/**
 * The host-command approval card, drawn between the conversation and the composer. Presentation only. A command taller
 * than `view.rows` scrolls inside the card, and the Allow options are marked locked until its last row has been shown.
 */
export function approvalCard(
  theme: OmsTheme,
  glyphs: Glyphs,
  request: ApprovalRequest,
  width: number,
  view?: ApprovalView,
): string[] {
  const content = Math.max(1, width - 6);
  const reason = request.reasons
    .map((item) => singleLine(item, 200))
    .filter(Boolean)
    .join(', ');
  const rows: string[] = [];
  if (request.requester) rows.push(colorText(theme, 'muted', `from ${singleLine(request.requester, 40)}`));
  if (reason) rows.push(...wrapTextWithAnsi(colorText(theme, 'warning', reason), content));
  const command = approvalCommandRows(request.command, width, request.plain);
  const shown = view ? Math.max(1, view.rows) : command.length;
  const offset = view ? Math.max(0, Math.min(view.offset, command.length - shown)) : 0;
  const locked = view ? !approvalFullyShown(command.length, { rows: shown, offset }) : false;
  rows.push('', ...command.slice(offset, offset + shown));
  if (command.length > shown) {
    const above = offset;
    const below = command.length - offset - shown;
    rows.push(
      colorText(
        theme,
        locked ? 'warning' : 'faint',
        inGlyphs(
          glyphs,
          `${above ? `↑ ${above} above` : ''}${above && below ? ' · ' : ''}${below ? `↓ ${below} more` : ''} · ↑↓ scroll`,
        ),
      ),
    );
  }
  const option = (key: string, label: string) =>
    locked ? `${colorText(theme, 'faint', key)}  ${colorText(theme, 'faint', label)}` : keyOption(theme, key, label);
  rows.push(
    '',
    option('y', locked ? 'Allow once · read the whole command first' : 'Allow once'),
    ...(request.session
      ? [option('s', locked ? 'Allow for this session · read it first' : 'Allow for this session')]
      : []),
    keyOption(theme, 'n', `Deny${' '.repeat(2)}${colorText(theme, 'faint', 'esc')}`),
  );
  return boxLines({
    theme,
    glyphs,
    width,
    title: request.title ?? 'Allow host command?',
    border: 'warning',
    rows,
    padY: 0,
  });
}

const keyOption = (theme: OmsTheme, key: string, label: string): string =>
  `${colorText(theme, 'accent', `\x1b[1m${key}\x1b[22m`)}  ${label}`;

/** A yes/no question a command asked (/yolo), drawn like the approval card and answered on one key. */
export function confirmationCard(theme: OmsTheme, glyphs: Glyphs, question: string, width: number): string[] {
  const rows = [
    ...wrapTextWithAnsi(displayText(question, 400), Math.max(1, width - 6)),
    '',
    keyOption(theme, 'y', 'Yes'),
    keyOption(theme, 'n', `No${' '.repeat(2)}${colorText(theme, 'faint', 'esc')}`),
  ];
  return boxLines({ theme, glyphs, width, title: 'Confirm', border: 'warning', rows, padY: 0 });
}
