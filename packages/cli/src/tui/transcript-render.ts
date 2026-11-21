import { truncateToWidth, visibleWidth, wrapTextWithAnsi, Markdown, type MarkdownTheme } from '@earendil-works/pi-tui';
import { highlightCode } from '@earendil-works/pi-coding-agent';
import { colorBg, colorText, type OmsTheme, type ThemeRole } from './theme.ts';

/** Presentation of the conversation body: pure functions from text and an OMS theme to terminal rows. */

/** The glyphs of the transcript, with ASCII stand-ins for terminals that cannot draw them. */
interface Glyphs {
  prompt: string;
  dot: string;
  ring: string;
  arm: string;
  thought: string;
  down: string;
  more: string;
  bullet: string;
  minus: string;
  arrow: string;
  check: string;
  cross: string;
}
const UNICODE: Glyphs = {
  prompt: '❯',
  dot: '●',
  ring: '○',
  arm: '⎿',
  thought: '∴',
  down: '▼',
  more: '⋯',
  bullet: '•',
  minus: '−',
  arrow: '→',
  check: '✓',
  cross: '✗',
};
const ASCII: Glyphs = {
  prompt: '>',
  dot: '*',
  ring: 'o',
  arm: '`-',
  thought: '::',
  down: 'v',
  more: '...',
  bullet: '-',
  minus: '-',
  arrow: '->',
  check: 'ok',
  cross: 'x',
};
/** ASCII glyphs for TERM=linux or dumb, or OMS_ASCII=1. */
export function glyphsFor(env: Readonly<Record<string, string | undefined>> = process.env): Glyphs {
  return env.OMS_ASCII === '1' || /^(linux|dumb)$/.test(env.TERM ?? '') ? ASCII : UNICODE;
}
/** Whether the running-dot blink and other motion are off (NO_COLOR, TERM=dumb or OMS_REDUCED_MOTION=1). */
export function reducedMotion(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.OMS_REDUCED_MOTION === '1' || !!env.NO_COLOR || env.TERM === 'dumb';
}

/** Where text starts under a glyph: the glyph, then one space. */
const INDENT = 2;
/** The width of '  ⎿  ': tool results and notes start here. */
export const ARM_WIDTH = 5;
export const HINT = '(ctrl+o to expand)';

/** Colors and attributes of the transcript. Hints, arms, rules and timestamps are the faint role; text a reader reads is muted. */
export class Style {
  readonly theme: OmsTheme;
  readonly g: Glyphs;
  constructor(theme: OmsTheme, g: Glyphs = UNICODE) {
    this.theme = theme;
    this.g = g;
  }
  fg = (role: ThemeRole, text: string): string => colorText(this.theme, role, text);
  muted = (text: string): string => this.fg('muted', text);
  faint = (text: string): string => this.fg('faint', text);
  accent = (text: string): string => this.fg('accent', text);
  success = (text: string): string => this.fg('success', text);
  warning = (text: string): string => this.fg('warning', text);
  error = (text: string): string => this.fg('error', text);
  bold = (text: string): string => `\x1b[1m${text}\x1b[22m`;
  italic = (text: string): string => `\x1b[3m${text}\x1b[23m`;
  /** Whether the terminal can show a painted background at all. */
  get paints(): boolean {
    return this.theme.sgr.bg.surface !== '49';
  }
  /** `text` on the surface color, cut or padded to `width`. */
  surface = (text: string, width: number): string => colorBg(this.theme, 'surface', text, width);
  /** '  ⎿  ': the result arm, as wide as ARM_WIDTH at either glyph set. */
  get arm(): string {
    return '  ' + this.faint(this.g.arm) + ' '.repeat(ARM_WIDTH - 2 - this.g.arm.length);
  }
}

/** 12s, 1m 04s, 2h 05m. */
export function elapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
/** 999, 3.4k, 12k, 1.2M. */
export function compact(count: number): string {
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, '');
  if (count < 1000) return String(count);
  if (count < 10_000) return `${trim(count / 1000)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${trim(count / 1_000_000)}M`;
}
export const plural = (count: number, word: string, many = `${word}s`): string =>
  `${count} ${count === 1 ? word : many}`;

/** `path` cut to `width` columns in the middle, keeping its first and last segments: programs/…/lib.rs. */
export function middleEllipsis(path: string, width: number): string {
  if (visibleWidth(path) <= width) return path;
  const parts = path.split('/');
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    const shown = [parts[0]!, '…', ...parts.slice(parts.length - keep)].join('/');
    if (parts.length > keep + 1 && visibleWidth(shown) <= width) return shown;
  }
  return truncateToWidth(path, width, '…');
}

// ---------------------------------------------------------------- user turn

/** A prompt as a full-width surface band: ' ❯ ' in accent, then the text in bold. `pad` adds a row above and below. */
export function userBand(
  s: Style,
  text: string,
  width: number,
  options: { expanded: boolean; hint: boolean; pad: boolean; limit?: number },
): { lines: string[]; clipped: boolean } {
  const inner = Math.max(1, width - 3);
  const rows = text.split('\n').flatMap((line) => (line ? wrapTextWithAnsi(line, inner) : ['']));
  const limit = options.limit ?? 6;
  const clipped = !options.expanded && rows.length > limit + 1;
  const shown = clipped ? rows.slice(0, limit) : rows;
  const body = shown.map((row, index) => ` ${index === 0 ? s.accent(s.g.prompt) : ' '} ${s.bold(row)}`);
  if (clipped)
    body.push(`   ${s.muted(`… +${rows.length - limit} lines${options.hint ? ' (ctrl+o to expand)' : ''}`)}`);
  const painted = body.map((row) => (s.paints ? s.surface(row, width) : row));
  if (options.pad && s.paints) {
    painted.unshift(s.surface('', width));
    painted.push(s.surface('', width));
  }
  return { lines: painted, clipped };
}

// ---------------------------------------------------------------- assistant prose

const UNDERLINE = '\x1b[4m';
const UNDERLINE_OFF = '\x1b[24m';
/** A private-use mark in front of heading text, so the blank lines around headings can be set after wrapping. */
const HEADING = '\uE000';

/** Markdown elements in the OMS palette: bold headings (H1 in accent), muted bullets, accent code, OSC 8 links. */
function markdownTheme(s: Style): MarkdownTheme {
  return {
    // pi draws H1 as heading(bold(underline(text))) and the other levels as heading(bold(text)).
    heading: (text) =>
      HEADING +
      (text.startsWith(`\x1b[1m${UNDERLINE}`)
        ? s.accent(text.replace(UNDERLINE, '').replace(UNDERLINE_OFF, ''))
        : text),
    link: (text) => s.fg('info', text),
    linkUrl: s.faint,
    code: s.accent,
    codeBlock: (text) => text,
    codeBlockBorder: s.faint,
    quote: s.muted,
    quoteBorder: s.faint,
    hr: () => s.faint('───'),
    listBullet: (text) => s.muted(text.startsWith('- ') ? `${s.g.bullet} ` : text),
    bold: s.bold,
    italic: s.italic,
    strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
    underline: (text) => UNDERLINE + text + UNDERLINE_OFF,
  };
}

/** Markdown rows for `text`: no trailing padding, one blank line before a heading and none after it, never two blanks. */
function markdownRows(s: Style, text: string, width: number, thought: boolean): string[] {
  const markdown = new Markdown(
    text.trim(),
    0,
    0,
    markdownTheme(s),
    thought ? { color: s.muted, italic: true } : undefined,
  );
  const rows: string[] = [];
  let afterHeading = false;
  for (const raw of markdown.render(width)) {
    const heading = raw.includes(HEADING);
    const row = raw.replaceAll(HEADING, '').replace(/ +$/, '');
    if (!visibleWidth(row)) {
      if (rows.length && rows.at(-1) !== '' && !afterHeading) rows.push('');
      continue;
    }
    if (heading && rows.length && rows.at(-1) !== '') rows.push('');
    rows.push(row);
    afterHeading = heading;
  }
  while (rows.at(-1) === '') rows.pop();
  return rows;
}

/** A fenced code block on the surface color with its language at the right of the first row. */
function codeRows(s: Style, code: string, lang: string, width: number): string[] {
  const inner = Math.max(1, width - 1);
  const rows = highlightCode(code.replace(/\n$/, ''), lang || undefined).flatMap((line) =>
    wrapTextWithAnsi(line.replace(/\t/g, '    ') || ' ', Math.max(1, inner - 1)),
  );
  const label = lang && s.paints ? s.faint(lang) : '';
  return rows.map((row, index) => {
    const tag = index === 0 && label && visibleWidth(row) + visibleWidth(lang) + 3 <= inner ? label : '';
    const gap = tag ? ' '.repeat(inner - 1 - visibleWidth(row) - visibleWidth(lang)) : '';
    const body = ` ${row}${gap}${tag}`;
    return s.paints ? s.surface(body, width) : body;
  });
}

interface Piece {
  text: string;
  lang?: string;
  fenced: boolean;
}
/** Splits prose at its ``` fences. A fence that is still open (streaming) takes the rest of the text. */
function pieces(text: string): Piece[] {
  const parts: Piece[] = [];
  let prose: string[] = [];
  let code: string[] | undefined;
  let lang = '';
  let fence = '';
  const flush = () => {
    if (prose.join('\n').trim()) parts.push({ text: prose.join('\n'), fenced: false });
    prose = [];
  };
  for (const line of text.split('\n')) {
    if (code) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) {
        parts.push({ text: code.join('\n'), lang, fenced: true });
        code = undefined;
      } else code.push(line);
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(line);
    if (open) {
      flush();
      fence = open[1]!;
      lang = open[2] ?? '';
      code = [];
    } else prose.push(line);
  }
  if (code) parts.push({ text: code.join('\n'), lang, fenced: true });
  flush();
  return parts;
}

/** The assistant's words: Markdown indented under the glyph column, code on the surface, one blank line between parts. */
export function proseRows(s: Style, text: string, width: number, thought = false): string[] {
  const inner = Math.max(1, width - INDENT);
  const out: string[] = [];
  for (const piece of pieces(text)) {
    const rows = piece.fenced
      ? codeRows(s, piece.text, piece.lang ?? '', inner)
      : markdownRows(s, piece.text, inner, thought);
    if (!rows.length) continue;
    if (out.length) out.push('');
    out.push(...rows.map((row) => (row ? ' '.repeat(INDENT) + row : row)));
  }
  return out;
}

/** '∴ Thought for 3s', or the full thinking under it when expanded. */
export function thoughtRows(
  s: Style,
  text: string,
  width: number,
  state: { ms?: number; live: boolean; expanded: boolean },
): string[] {
  const label = state.live
    ? 'Thinking…'
    : state.ms === undefined || state.ms < 1000
      ? 'Thought'
      : `Thought for ${elapsed(state.ms)}`;
  const head = s.faint(s.italic(`${s.g.thought} ${label}`));
  return state.expanded && text.trim() ? [head, ...proseRows(s, text, width, true)] : [head];
}

// ---------------------------------------------------------------- errors, notes and the turn footer

/** The message of a provider error without its JSON payload: 'Provider error: 429 rate_limit_error: {"error":{"message":"Slow down"}}' → '… Slow down'. */
function errorSummary(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const start = flat.indexOf('{');
  if (start < 0) return flat;
  try {
    const parsed = JSON.parse(flat.slice(start)) as { message?: unknown; error?: { message?: unknown } | string };
    const inner = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    const message = typeof inner === 'string' ? inner : parsed.message;
    if (typeof message === 'string' && message.trim()) return `${flat.slice(0, start).trim()} ${message.trim()}`.trim();
  } catch {
    // Not JSON after all: the message stays as the provider wrote it.
  }
  return flat;
}

/** '● Error  <message>': the summary wraps to three rows; the whole text shows when expanded. */
export function errorRows(
  s: Style,
  text: string,
  width: number,
  options: { expanded: boolean; hint: boolean; label?: string; tone?: 'error' | 'warning' },
): { lines: string[]; collapsed: boolean } {
  const color = (options.tone ?? 'error') === 'error' ? s.error : s.warning;
  const label = options.label ?? 'Error';
  const lead = visibleWidth(label) + INDENT + 2;
  const prefix = `${color(s.g.dot)} ${s.bold(label)}  `;
  const summary = errorSummary(text);
  const rows = wrapTextWithAnsi(summary, Math.max(1, width - lead));
  const full = text
    .split('\n')
    .flatMap((line) => (line.trim() ? wrapTextWithAnsi(line, Math.max(1, width - ARM_WIDTH)) : []));
  const longer = rows.length > 3 || summary !== text.replace(/\s+/g, ' ').trim();
  const shown = rows.slice(0, 3);
  const room = Math.max(1, width - lead);
  if (rows.length > 3) shown[2] = truncateToWidth(`${shown[2]} …`, room, '…');
  const lines = shown.map((row, index) => (index === 0 ? prefix : ' '.repeat(lead)) + row);
  if (options.expanded) {
    if (longer)
      lines.push(
        ...full.slice(0, 200).map((row, index) => (index === 0 ? s.arm : ' '.repeat(ARM_WIDTH)) + s.muted(row)),
      );
    return { lines, collapsed: false };
  }
  if (longer && options.hint) {
    // The key that expands it goes at the end of the last row, or on a row of its own when there is no room.
    if (visibleWidth(shown.at(-1)!) + 1 + HINT.length <= room) lines[lines.length - 1] += ' ' + s.muted(HINT);
    else lines.push(' '.repeat(lead) + s.muted(HINT));
  }
  return { lines, collapsed: longer };
}

/** A line of the conversation that is not a message: '· text' for a bare note, an arm under a title for command output. */
export function noteRows(s: Style, label: string, text: string, width: number): string[] {
  const body = text
    .split('\n')
    .flatMap((line) => (line.trim() ? wrapTextWithAnsi(line, Math.max(1, width - ARM_WIDTH)) : ['']));
  while (body.at(-1) === '') body.pop();
  for (let i = body.length - 1; i > 0; i--) if (body[i] === '' && body[i - 1] === '') body.splice(i, 1);
  if (!label) return body.map((row, index) => (index === 0 ? `${s.faint('·')} ${s.muted(row)}` : `  ${s.muted(row)}`));
  const warn = /unavailable|required|refused|blocked/i.test(label);
  if (warn) {
    const [first = '', ...rest] = body;
    return [`${s.warning(s.g.dot)} ${s.bold(label)}  ${first}`, ...rest.map((row) => ' '.repeat(INDENT) + row)];
  }
  return [s.arm + s.bold(label), ...body.map((row) => ' '.repeat(ARM_WIDTH) + s.muted(row))];
}

/** 'Worked 1m 12s · ↓ 3.4k' after a turn. */
export function footerRow(s: Style, ms: number, tokens: number): string {
  return ' '.repeat(INDENT) + s.faint(`Worked ${elapsed(ms)}${tokens > 0 ? ` · ↓ ${compact(tokens)}` : ''}`);
}

/** '▼ new output' centered on a row, in accent. */
export function newOutputChip(s: Style, width: number): string {
  const chip = s.accent(`${s.g.down} new output`);
  const pad = Math.max(0, Math.floor((width - visibleWidth(chip)) / 2));
  return ' '.repeat(pad) + chip;
}

// ---------------------------------------------------------------- copying

const GUTTER = /^ *(?:[●○❯⎿∴▼] {1,2}|`- )/;
/**
 * Selected transcript text without its glyph gutters: '● Read  lib.rs' copies as 'Read  lib.rs' and the rows under a
 * glyph lose the hanging indent. Text with no gutter glyph (the editor, the terminal) is returned as it is.
 */
export function copyableText(text: string): string {
  const lines = text.split('\n');
  if (!lines.some((line) => GUTTER.test(line))) return text;
  let hang = INDENT;
  return lines
    .map((line) => {
      if (!line.trim()) {
        hang = INDENT;
        return line;
      }
      const match = GUTTER.exec(line);
      if (match) {
        hang = match[0].length;
        return line.slice(match[0].length);
      }
      return line.slice(Math.min(hang, line.length - line.trimStart().length));
    })
    .join('\n');
}
