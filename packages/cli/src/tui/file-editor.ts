import {
  CURSOR_MARKER,
  ScrollView,
  decodeKittyPrintable,
  getNativeClipboard,
  isKeyRelease,
  matchesKey,
  renderFakeCursor,
  sliceByColumn,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import { copyToClipboard } from '@earendil-works/pi-coding-agent';
import { FileDocument, MAX_DOCUMENT_BYTES } from './document.ts';
import {
  closerOutdent,
  detectIndent,
  lineEnd,
  lineStart,
  newlineEdit,
  shiftLines,
  softBackspace,
  toggleComment,
  type Edit,
  type Indent,
} from './editing.ts';
import { firstSpanFrom, highlight, commentMarker, paintSyntax, spanAt, type Language, type Span } from './syntax.ts';
import { colorBg, colorText, type OmsTheme } from './theme.ts';

/** How a changed line is marked in the gutter: added, modified, or text removed just above. */
export type ChangeMark = 'add' | 'mod' | 'del';
export interface EditorClipboard {
  write(text: string): void | Promise<void>;
  read(): Promise<string | undefined>;
}
/** Turns the editor into a code editor: syntax colors, themed gutter and current line, and the code-editing keys. */
export interface CodeEditing {
  theme: () => OmsTheme;
  language: () => Language | undefined;
  /** Gutter marks for changed lines, by 0-based row. */
  marks?: () => ReadonlyMap<number, ChangeMark> | undefined;
  clipboard?: EditorClipboard;
  /** Short feedback such as "Copied 3 lines". */
  notice?: (message: string) => void;
}
export interface FileEditorOptions {
  readOnly?: boolean;
  lineNumbers?: boolean;
  requestFocus?: () => boolean | void;
  code?: CodeEditing;
  /** Soft-wrap long lines at the width (the chat composer); code editors scroll sideways instead. */
  wrap?: boolean;
}

export interface FileEditorPane {
  document: FileDocument;
  view: ScrollView;
  focus: Component & Focusable;
  readonly position: { line: number; column: number };
  /** Put the caret on a 1-based line and column and scroll it into view, centered. */
  goTo(line: number, column?: number): void;
  /** The 1-based lines the selection touches (just the caret's line when nothing is selected). */
  selectedLines(): { from: number; to: number };
  /** The indentation this file uses. */
  indent(): Indent;
  /** Comment or uncomment the selected lines; false when this language has no line comment. */
  toggleComment(): boolean;
  /** Rows the text takes at this width: its lines, and with soft wrap the extra rows long lines wrap onto. */
  rows(width: number): number;
}

/** Copy goes to the system clipboard; paste reads it, or what this editor last copied when the system has none. */
let copied = '';
const systemClipboard: EditorClipboard = {
  async write(text) {
    copied = text;
    await copyToClipboard(text);
  },
  async read() {
    try {
      return (await getNativeClipboard()?.getText()) ?? (copied || undefined);
    } catch {
      return copied || undefined;
    }
  },
};

/** One grapheme's display cells; start/end are offsets within its line. */
interface CellRun {
  start: number;
  end: number;
  column: number;
  width: number;
  text: string;
}
/** The display cells of one line's text, shared by every line with that text. */
interface LineLayout {
  width: number;
  runs: CellRun[];
  /** The last plain (no cursor or selection) drawing and the viewport it was drawn for. */
  drawn?: { left: number; width: number; text: string };
}
interface SourceLine {
  start: number;
  end: number;
  breakEnd: number;
  /** A row cut from a longer line by soft wrap: the line goes on in the next row, so no line break ends this one. */
  soft?: boolean;
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** The keys a read-only document still answers: moving, selecting and (in code editors) copying. */
const READ_ONLY_KEYS = [
  'left',
  'right',
  'up',
  'down',
  'home',
  'end',
  'pageUp',
  'pageDown',
  'shift+left',
  'shift+right',
  'shift+up',
  'shift+down',
  'shift+home',
  'shift+end',
  'shift+pageUp',
  'shift+pageDown',
  'ctrl+home',
  'ctrl+end',
  'ctrl+shift+home',
  'ctrl+shift+end',
  'ctrl+a',
  'ctrl+c',
  'ctrl+left',
  'ctrl+right',
  'alt+left',
  'alt+right',
  'ctrl+shift+left',
  'ctrl+shift+right',
  'alt+shift+left',
  'alt+shift+right',
] as const;
/**
 * Rows drawn beyond the viewport, so a resize or scroll the layout applies after drawing still lands on drawn
 * rows: no viewport can outgrow the host terminal.
 */
/** The viewport assumed before the first layout. */
const FIRST_VIEWPORT = 64;
const overdraw = (height: number) => Math.max(height, process.stdout.rows || FIRST_VIEWPORT);

function displayText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 ? String.fromCharCode(0x2400 + code) : code === 127 ? '␡' : `‹${code.toString(16)}›`;
  });
}

/** Rows of one source line wrapped at `wrap` cells: after the last space that fits, or in the word when none does. */
function wrapLine(base: number, text: string, wrap: number, layout: (text: string) => LineLayout): SourceLine[] {
  const runs = layout(text).runs;
  const rows: SourceLine[] = [];
  let first = 0;
  let index = 0;
  while (index < runs.length) {
    const run = runs[index]!;
    if (index === first || run.column + run.width - runs[first]!.column <= wrap) {
      index++;
      continue;
    }
    let cut = index;
    for (let back = index - 1; back > first; back--) {
      if (/^\s/.test(text.slice(runs[back]!.start, runs[back]!.end))) {
        cut = back + 1;
        break;
      }
    }
    const edge = base + runs[cut]!.start;
    rows.push({ start: base + runs[first]!.start, end: edge, breakEnd: edge, soft: true });
    first = cut;
    index = cut;
  }
  rows.push({ start: base + (runs[first]?.start ?? 0), end: base + text.length, breakEnd: base + text.length });
  return rows;
}

function project(text: string, wrap = 0, layout: (text: string) => LineLayout = layoutLine): SourceLine[] {
  const lines: SourceLine[] = [];
  const breaks = /\r\n|\r|\n/g;
  let start = 0;
  for (;;) {
    const delimiter = breaks.exec(text);
    const end = delimiter?.index ?? text.length;
    const breakEnd = delimiter ? end + delimiter[0].length : end;
    // A line of n code units is at most 2n cells wide, so only the long ones need measuring.
    if (wrap > 0 && (end - start) * 2 > wrap) {
      const rows = wrapLine(start, text.slice(start, end), wrap, layout);
      rows[rows.length - 1]!.breakEnd = breakEnd;
      lines.push(...rows);
    } else lines.push({ start, end, breakEnd });
    if (!delimiter) return lines;
    start = breakEnd;
  }
}

function layoutLine(text: string): LineLayout {
  const runs: CellRun[] = [];
  let column = 0;
  for (const part of segmenter.segment(text)) {
    let shown = part.segment === '\t' ? ' '.repeat(4 - (column % 4)) : displayText(part.segment);
    if (visibleWidth(shown) === 0) shown = '◌' + shown;
    const width = visibleWidth(shown);
    // Stored as a whole-cell slice draws it (marks after the ◌ placeholder fall away), so drawing needs no slicing.
    const cells = sliceByColumn(shown, 0, width, true);
    const text = cells + ' '.repeat(Math.max(0, width - visibleWidth(cells)));
    runs.push({ start: part.index, end: part.index + part.segment.length, column, width, text });
    column += width;
  }
  return { width: column, runs };
}

class FileEditor implements Component, Focusable {
  focused = false;
  private projectedText: string | undefined;
  private projectedWrap = 0;
  /** Cells a row may use when soft wrap is on (one less than the width, for the cursor's cell); 0 means no wrap. */
  private wrapWidth = 0;
  private readonly wrap: boolean;
  private lines: SourceLine[] = [];
  private readonly layouts = new Map<string, LineLayout>();
  /** The last drawing, returned unchanged while nothing it depends on changed. */
  private drawn: { text: string; key: string; lines: string[] } | undefined;
  /** Row ranges [from, to) of the last drawing that hold text; the rest are blank. */
  drawnRanges: Array<[number, number]> = [];
  private width = 0;
  private left = 0;
  private goalColumn: number | undefined;
  private gutter = 0;
  private pendingSurrogate = '';
  private dragging = false;
  private error = '';
  private lastCursor = -1;
  revealPending = true;
  view!: ScrollView;

  readonly document: FileDocument;
  private readonly readOnly: boolean;
  private readonly requestRender: () => void;
  private readonly lineNumbers: boolean;
  private readonly requestFocus: (() => boolean | void) | undefined;
  private readonly code: CodeEditing | undefined;
  private spans: { text: string; language: Language; spans: Span[] } | undefined;
  private indentFor: { text: string; indent: Indent } | undefined;
  /** The next reveal centers the caret (after a jump) instead of scrolling the minimum. */
  private centerPending = false;

  constructor(document: FileDocument, requestRender: () => void, options: FileEditorOptions = {}) {
    this.readOnly = options.readOnly ?? false;
    this.requestFocus = options.requestFocus;
    this.lineNumbers = options.lineNumbers ?? false;
    this.code = options.code;
    this.wrap = options.wrap ?? false;
    this.document = document;
    this.requestRender = requestRender;
  }

  invalidate(): void {
    this.projectedText = undefined;
    this.drawn = undefined;
    this.layouts.clear();
  }

  private sourceLines(): SourceLine[] {
    if (this.projectedText !== this.document.text || this.projectedWrap !== this.wrapWidth) {
      this.lines = project(this.document.text, this.wrapWidth, (text) => this.layoutText(text));
      this.projectedText = this.document.text;
      this.projectedWrap = this.wrapWidth;
      // ponytail: drop every cached line layout once edits leave too many stale ones; visible rows rebuild in microseconds.
      if (this.layouts.size > 2 * this.lines.length + 256) this.layouts.clear();
    }
    return this.lines;
  }

  private layoutText(text: string): LineLayout {
    let layout = this.layouts.get(text);
    if (!layout) {
      layout = layoutLine(text);
      this.layouts.set(text, layout);
    }
    return layout;
  }

  private layoutOf(line: SourceLine): LineLayout {
    return this.layoutText(this.document.text.slice(line.start, line.end));
  }

  /** Rows the text takes when drawn `width` cells wide. */
  rows(width: number): number {
    this.wrapWidth = this.wrap ? Math.max(1, Math.floor(width) - 1) : 0;
    return this.sourceLines().length;
  }

  private cursorLine(): number {
    const lines = this.sourceLines();
    const cursor = this.document.cursor;
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lines[middle]!.start > cursor) high = middle - 1;
      else low = middle;
    }
    return low;
  }

  get position(): { line: number; column: number } {
    const row = this.cursorLine();
    return { line: row + 1, column: this.columnAt(this.sourceLines()[row]!, this.document.cursor) + 1 };
  }

  private columnAt(line: SourceLine, offset: number): number {
    const layout = this.layoutOf(line);
    return layout.runs.find((run) => run.start >= offset - line.start)?.column ?? layout.width;
  }

  private offsetAt(line: SourceLine, column: number): number {
    for (const run of this.layoutOf(line).runs) {
      if (column < run.column + run.width / 2) return line.start + run.start;
      if (column < run.column + run.width) return line.start + run.end;
    }
    return line.end;
  }

  reveal(): void {
    if (!this.revealPending || this.view.viewportHeight <= 0) return;
    const row = this.cursorLine();
    if (this.centerPending) {
      this.view.scrollTo(Math.max(0, row - Math.floor(this.view.viewportHeight / 2)));
      this.centerPending = false;
    } else if (row < this.view.scrollTop) this.view.scrollTo(row);
    else if (row >= this.view.scrollTop + this.view.viewportHeight) {
      this.view.scrollTo(row - this.view.viewportHeight + 1);
    }
    this.revealPending = false;
  }

  /** Content height stays the line count, but only rows near the viewport are drawn; the rest are blank. */
  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    this.wrapWidth = this.wrap && width > 0 ? Math.max(1, width - 1) : 0;
    const lines = this.sourceLines();
    const row = this.cursorLine();
    const line = lines[row]!;
    const cursor = this.document.cursor;
    const column = this.columnAt(line, cursor);
    this.gutter = this.lineNumbers ? Math.min(Math.max(0, width - 1), String(lines.length).length + 2) : 0;
    width -= this.gutter;
    if (width !== this.width || this.lastCursor !== cursor) this.revealPending = true;
    this.width = width;
    this.lastCursor = cursor;
    const cursorWidth = Math.min(
      width,
      this.layoutOf(line).runs.find((run) => run.start === cursor - line.start)?.width ?? 1,
    );
    // The caret stays visible with a few columns of context; a line that fits on screen is never left scrolled away.
    const margin = this.code ? Math.min(8, Math.floor(width / 4)) : 0;
    if (column + cursorWidth <= width - margin) this.left = 0;
    else {
      if (column < this.left + margin) this.left = Math.max(0, column - margin);
      if (column + cursorWidth > this.left + width - margin)
        this.left = Math.max(0, column + cursorWidth - width + margin);
    }
    // Draw where the scroll view will show this frame: it reveals the cursor only after drawing.
    const height = this.view.viewportHeight || FIRST_VIEWPORT;
    let top = this.view.scrollTop;
    if (this.revealPending && row < top) top = row;
    else if (this.revealPending && row >= top + height) top = row - height + 1;
    top = Math.max(0, Math.min(top, lines.length - height));
    // Around the cursor too: a resize the layout applies after drawing reveals it, wherever the view was.
    const reach = overdraw(height);
    const clamp = (index: number) => Math.max(0, Math.min(lines.length, index));
    this.drawnRanges =
      width > 0
        ? [
            [clamp(top - reach), clamp(top + height + reach)],
            [clamp(row - reach), clamp(row + reach + 1)],
          ]
        : [[0, lines.length]];
    const code = this.code;
    const language = code?.language();
    const marks = code?.marks?.();
    const theme = code?.theme();
    const key = `${width}|${this.gutter}|${this.left}|${this.drawnRanges.join(';')}|${cursor}|${this.document.anchor}|${this.focused}|${this.error}|${theme?.id}|${theme?.depth}|${theme?.backdrop}|${language}|${marks ? [...marks].join(',') : ''}`;
    if (this.drawn?.text === this.document.text && this.drawn.key === key) return this.drawn.lines;
    const selectionStart = Math.min(this.document.anchor, cursor);
    const selectionEnd = Math.max(this.document.anchor, cursor);
    const rendered = new Array<string>(lines.length).fill('');
    const drawn = new Set<number>();
    for (const [from, to] of this.drawnRanges) for (let index = from; index < to; index++) drawn.add(index);
    const spans = code && language ? this.spansOf(language) : [];
    for (const index of drawn) {
      if (width <= 0) continue;
      rendered[index] = code
        ? this.drawCodeLine(lines[index]!, index === row, selectionStart, selectionEnd, width, code.theme(), spans)
        : this.drawLine(lines[index]!, index === row, selectionStart, selectionEnd, width);
    }
    if (this.error && width > 0) {
      rendered[row] =
        (this.focused ? CURSOR_MARKER + renderFakeCursor(' ') : '') +
        sliceByColumn(`Edit refused: ${this.error}`, 0, width - (this.focused ? 1 : 0), true);
    }
    if (this.gutter > 0) {
      for (const index of drawn) {
        rendered[index] =
          (theme
            ? this.themedGutter(theme, index, index === row, marks?.get(index))
            : '\x1b[2m' +
              sliceByColumn(String(index + 1).padStart(this.gutter - 2) + ' │', 0, this.gutter, true) +
              '\x1b[22m') + rendered[index];
      }
    }
    this.drawn = { text: this.document.text, key, lines: rendered };
    return rendered;
  }

  private spansOf(language: Language): Span[] {
    const text = this.document.text;
    if (this.spans?.text !== text || this.spans.language !== language)
      this.spans = { text, language, spans: highlight(text, language) };
    return this.spans.spans;
  }

  /** Change mark, right-aligned line number and a space; the caret's line sits on the surface color. */
  private themedGutter(theme: OmsTheme, index: number, current: boolean, mark: ChangeMark | undefined): string {
    const digits = this.gutter - 2;
    const lit = current && this.focused;
    const bar = mark ? colorText(theme, mark === 'add' ? 'success' : mark === 'mod' ? 'warning' : 'error', '▎') : ' ';
    const text = bar + colorText(theme, lit ? 'foreground' : 'muted', String(index + 1).padStart(digits)) + ' ';
    return lit ? colorBg(theme, 'surface', text) : text;
  }

  private drawLine(
    source: SourceLine,
    cursorRow: boolean,
    selectionStart: number,
    selectionEnd: number,
    width: number,
  ) {
    const layout = this.layoutOf(source);
    const cursor = this.focused && cursorRow ? this.document.cursor - source.start : -1;
    const selected = selectionStart < selectionEnd && selectionStart < source.breakEnd && selectionEnd > source.start;
    const plain = cursor < 0 && !selected;
    if (plain && layout.drawn?.left === this.left && layout.drawn.width === width) return layout.drawn.text;
    const from = selectionStart - source.start;
    const to = selectionEnd - source.start;
    let result = '';
    for (const run of layout.runs) {
      if (run.column >= this.left + width) break;
      if (run.column + run.width <= this.left) continue;
      const skip = Math.max(0, this.left - run.column);
      const count = Math.min(run.width - skip, this.left + width - run.column);
      let shown = run.text;
      if (skip > 0 || count < run.width) {
        shown = sliceByColumn(run.text, skip, count, true);
        shown += ' '.repeat(Math.max(0, count - visibleWidth(shown)));
      }
      if (run.start < to && run.end > from) shown = `\x1b[7m${shown}\x1b[0m`;
      if (run.start === cursor) shown = CURSOR_MARKER + renderFakeCursor(shown || ' ');
      result += shown;
    }
    const hasEndCell = source.end - source.start === cursor;
    const selectedBreak = source.end < selectionEnd && source.breakEnd > selectionStart;
    if ((hasEndCell || selectedBreak) && layout.width >= this.left && layout.width < this.left + width) {
      let shown = selectedBreak ? '\x1b[7m \x1b[0m' : ' ';
      if (hasEndCell) shown = CURSOR_MARKER + renderFakeCursor(shown);
      result += shown;
    }
    if (plain) layout.drawn = { left: this.left, width, text: result };
    return result;
  }

  /** One line in code mode: syntax colors per run, selection and the caret's line as backgrounds, nothing cached. */
  private drawCodeLine(
    source: SourceLine,
    cursorRow: boolean,
    selectionStart: number,
    selectionEnd: number,
    width: number,
    theme: OmsTheme,
    spans: readonly Span[],
  ): string {
    const layout = this.layoutOf(source);
    const cursor = this.focused && cursorRow ? this.document.cursor - source.start : -1;
    const lit = this.focused && cursorRow;
    const from = selectionStart - source.start;
    const to = selectionEnd - source.start;
    let spanIndex = firstSpanFrom(spans, source.start);
    let result = '';
    let pending = '';
    let pendingKey = '';
    let pendingRole: Span['role'] | undefined;
    let pendingBackground: 'selection' | 'surface' | 'diffAdded' | 'diffRemoved' | undefined;
    let lineBackground: typeof pendingBackground;
    let used = 0;
    const flush = () => {
      if (!pending) return;
      let text = pending;
      if (pendingRole) text = paintSyntax(theme, pendingRole, text);
      if (pendingBackground) text = colorBg(theme, pendingBackground, text);
      result += text;
      pending = '';
      pendingKey = '';
    };
    for (const run of layout.runs) {
      if (run.column >= this.left + width) break;
      if (run.column + run.width <= this.left) continue;
      const skip = Math.max(0, this.left - run.column);
      const count = Math.min(run.width - skip, this.left + width - run.column);
      let shown = run.text;
      if (skip > 0 || count < run.width) {
        shown = sliceByColumn(run.text, skip, count, true);
        shown += ' '.repeat(Math.max(0, count - visibleWidth(shown)));
      }
      used += count;
      const found = spanAt(spans, source.start + run.start, spanIndex);
      spanIndex = found.next;
      const role = found.role;
      const selected = run.start < to && run.end > from;
      const tint = role === 'diffAdd' ? 'diffAdded' : role === 'diffDel' ? 'diffRemoved' : undefined;
      lineBackground ??= tint;
      const background = selected ? 'selection' : (tint ?? (lit ? 'surface' : undefined));
      if (run.start === cursor) {
        flush();
        result += CURSOR_MARKER + renderFakeCursor(shown || ' ');
        continue;
      }
      const key = `${role ?? ''}|${background ?? ''}`;
      if (key !== pendingKey) {
        flush();
        pendingKey = key;
        pendingRole = role;
        pendingBackground = background;
      }
      pending += shown;
    }
    flush();
    const hasEndCell = source.end - source.start === cursor;
    const selectedBreak = source.end < selectionEnd && source.breakEnd > selectionStart;
    if ((hasEndCell || selectedBreak) && layout.width >= this.left && layout.width < this.left + width) {
      let shown = selectedBreak ? colorBg(theme, 'selection', ' ') : lit ? colorBg(theme, 'surface', ' ') : ' ';
      if (hasEndCell) shown = CURSOR_MARKER + renderFakeCursor(selectedBreak || lit ? ' ' : shown);
      result += shown;
      used++;
    }
    // The caret's line and a whole added or removed line are tinted to the full width.
    const rest = width - used;
    const fill = lineBackground ?? (lit ? 'surface' : undefined);
    if (fill && rest > 0) result += colorBg(theme, fill, ' '.repeat(rest));
    return result;
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (this.readOnly && !READ_ONLY_KEYS.some((key) => matchesKey(data, key))) return;
    try {
      if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
        this.pendingSurrogate = '';
        const text = data.slice(6, -6);
        if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES)
          throw new RangeError('Paste exceeds the 64 KiB UTF-8 limit');
        this.document.insert(text);
        this.goalColumn = undefined;
      } else {
        this.key(data);
      }
      this.error = '';
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Unsupported edit';
    }
    this.revealPending = true;
    this.requestRender();
  }

  private key(data: string): void {
    const doc = this.document;
    if (this.pendingSurrogate && /[\x00-\x1f\x7f-\x9f]/.test(data)) this.pendingSurrogate = '';
    for (const direction of ['left', 'right', 'up', 'down', 'home', 'end', 'pageUp', 'pageDown'] as const) {
      const extend = matchesKey(data, `shift+${direction}`);
      if (!extend && !matchesKey(data, direction)) continue;
      this.pendingSurrogate = '';
      if (direction === 'left' || direction === 'right') {
        doc.move(direction, extend);
        this.goalColumn = undefined;
      } else {
        const lines = this.sourceLines();
        const row = this.cursorLine();
        let target: number;
        if (direction === 'home' || direction === 'end') {
          const line = lines[row]!;
          // A wrapped row ends before the one it goes on in: End stops on its last character, not in the next row.
          const lastRun = line.soft ? this.layoutOf(line).runs.at(-1) : undefined;
          target = direction === 'home' ? line.start : lastRun ? line.start + lastRun.start : line.end;
          this.goalColumn = undefined;
        } else {
          this.goalColumn ??= this.columnAt(lines[row]!, doc.cursor);
          const distance =
            direction === 'pageUp' || direction === 'pageDown' ? Math.max(1, this.view.viewportHeight) : 1;
          const delta = direction === 'up' || direction === 'pageUp' ? -distance : distance;
          target = this.offsetAt(lines[Math.max(0, Math.min(lines.length - 1, row + delta))]!, this.goalColumn);
        }
        doc.select(extend ? doc.anchor : target, target);
      }
      return;
    }
    this.goalColumn = undefined;
    if (this.code && this.codeKey(data)) return;
    if (matchesKey(data, 'ctrl+home') || matchesKey(data, 'ctrl+shift+home')) {
      doc.select(matchesKey(data, 'ctrl+shift+home') ? doc.anchor : 0, 0);
    } else if (matchesKey(data, 'ctrl+end') || matchesKey(data, 'ctrl+shift+end')) {
      doc.select(matchesKey(data, 'ctrl+shift+end') ? doc.anchor : doc.text.length, doc.text.length);
    } else if (matchesKey(data, 'ctrl+a')) doc.select(0, doc.text.length);
    else if (matchesKey(data, 'ctrl+z')) doc.undo();
    else if (matchesKey(data, 'ctrl+y') || matchesKey(data, 'ctrl+shift+z')) doc.redo();
    else if (matchesKey(data, 'backspace')) doc.backspace(!!this.code);
    else if (matchesKey(data, 'delete')) doc.deleteForward(!!this.code);
    else if (matchesKey(data, 'enter') || matchesKey(data, 'shift+enter')) doc.insert(doc.newline);
    else if (matchesKey(data, 'tab')) doc.insert('\t');
    else {
      let text = decodeKittyPrintable(data) ?? data;
      // StdinBuffer emits legacy supplementary characters as two UTF-16 events.
      if (this.pendingSurrogate) {
        const pending = this.pendingSurrogate;
        this.pendingSurrogate = '';
        if (/^[\udc00-\udfff]/.test(text)) text = pending + text;
        else throw new Error('Incomplete Unicode surrogate input');
      }
      if (/^[\ud800-\udbff]$/.test(text)) {
        this.pendingSurrogate = text;
        return;
      }
      if (/[\x00-\x1f\x7f-\x9f]/.test(text)) return;
      const outdent = this.code && /^[}\])]$/.test(text) && doc.anchor === doc.cursor && this.code.language();
      const edit = outdent ? closerOutdent(doc.text, doc.cursor, this.indent()) : undefined;
      if (edit) doc.replaceRange(edit.from, edit.to, text);
      else doc.insert(text, !!this.code);
    }
  }

  indent(): Indent {
    const text = this.document.text;
    if (this.indentFor?.text !== text) {
      const language = this.code?.language();
      const fallback: Indent = { kind: 'spaces', size: language === 'ts' || language === 'json' ? 2 : 4 };
      this.indentFor = { text, indent: detectIndent(text, fallback) };
    }
    return this.indentFor.indent;
  }

  private apply(edit: Edit | undefined): void {
    if (edit) this.document.replaceRange(edit.from, edit.to, edit.text, { anchor: edit.anchor, cursor: edit.cursor });
  }

  private say(message: string): void {
    this.code?.notice?.(message);
  }

  /** The code-editing keys: word movement, clipboard, indentation, comments and Enter. True when `data` was one of them. */
  private codeKey(data: string): boolean {
    const doc = this.document;
    const text = doc.text;
    const left = matchesKey(data, 'ctrl+left') || matchesKey(data, 'alt+left');
    const right = matchesKey(data, 'ctrl+right') || matchesKey(data, 'alt+right');
    const selectLeft = matchesKey(data, 'ctrl+shift+left') || matchesKey(data, 'alt+shift+left');
    const selectRight = matchesKey(data, 'ctrl+shift+right') || matchesKey(data, 'alt+shift+right');
    if (left || right || selectLeft || selectRight) {
      doc.moveWord(left || selectLeft ? 'left' : 'right', selectLeft || selectRight);
      return true;
    }
    if (matchesKey(data, 'ctrl+c')) {
      this.copy(false);
      return true;
    }
    if (this.readOnly) return false;
    if (matchesKey(data, 'ctrl+x')) {
      this.copy(true);
      return true;
    }
    if (matchesKey(data, 'ctrl+v')) {
      this.paste();
      return true;
    }
    if (matchesKey(data, 'alt+backspace') || matchesKey(data, 'ctrl+backspace')) {
      doc.deleteWord('left');
      return true;
    }
    if (matchesKey(data, 'ctrl+delete') || matchesKey(data, 'alt+delete') || matchesKey(data, 'alt+d')) {
      doc.deleteWord('right');
      return true;
    }
    if (matchesKey(data, 'ctrl+/') || matchesKey(data, 'ctrl+_')) {
      if (!this.toggleComment()) this.say('This kind of file has no line comment.');
      return true;
    }
    const indent = this.indent();
    if (matchesKey(data, 'tab')) {
      if (doc.anchor !== doc.cursor) this.apply(shiftLines(text, doc.anchor, doc.cursor, indent, false));
      else if (indent.kind === 'tab') doc.insert('\t');
      else {
        const before = text.slice(lineStart(text, doc.cursor), doc.cursor);
        doc.insert(' '.repeat(indent.size - (before.length % indent.size)));
      }
      return true;
    }
    if (matchesKey(data, 'shift+tab')) {
      const edit = shiftLines(text, doc.anchor, doc.cursor, indent, true);
      if (edit && doc.anchor === doc.cursor) {
        const start = lineStart(text, doc.cursor);
        const cursor = Math.max(start, doc.cursor - (lineEnd(text, doc.cursor) - start - edit.text.length));
        this.apply({ ...edit, anchor: cursor, cursor });
      } else this.apply(edit);
      return true;
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'shift+enter')) {
      const start = Math.min(doc.anchor, doc.cursor);
      const end = Math.max(doc.anchor, doc.cursor);
      const edit = newlineEdit(
        start === end ? text : text.slice(0, start) + text.slice(end),
        start,
        doc.newline,
        indent,
      );
      this.apply({ ...edit, to: Math.max(edit.to, end) });
      return true;
    }
    if (matchesKey(data, 'backspace') && doc.anchor === doc.cursor) {
      const soft = softBackspace(text, doc.cursor, indent);
      if (soft) {
        doc.replaceRange(soft.from, soft.to, '');
        return true;
      }
    }
    return false;
  }

  toggleComment(): boolean {
    const marker = commentMarker(this.code?.language());
    const doc = this.document;
    if (!marker || this.readOnly) return false;
    const edit = toggleComment(doc.text, doc.anchor, doc.cursor, marker);
    if (!edit) return true;
    if (doc.anchor === doc.cursor) {
      const old = edit.to - edit.from;
      const cursor = Math.max(edit.from, Math.min(edit.from + edit.text.length, doc.cursor + edit.text.length - old));
      this.apply({ ...edit, anchor: cursor, cursor });
    } else this.apply(edit);
    return true;
  }

  private copy(cut: boolean): void {
    const doc = this.document;
    const clipboard = this.code?.clipboard ?? systemClipboard;
    let text = doc.selectedText;
    let range: [number, number];
    if (text) range = [Math.min(doc.anchor, doc.cursor), Math.max(doc.anchor, doc.cursor)];
    else {
      // Nothing selected copies (or cuts) the whole line, like most editors.
      const line = this.sourceLines()[this.cursorLine()]!;
      text = doc.text.slice(line.start, line.end) + doc.newline;
      range = [line.start, line.breakEnd];
    }
    const lines = text.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(text) ? 1 : 0);
    const what = lines > 1 ? `${lines} lines` : doc.selectedText ? 'selection' : 'line';
    Promise.resolve(clipboard.write(text)).then(
      () => this.say(`${cut ? 'Cut' : 'Copied'} ${what}`),
      (error: unknown) => this.say(`Copy failed: ${error instanceof Error ? error.message : 'clipboard unavailable'}`),
    );
    if (cut) doc.replaceRange(range[0], range[1], '');
  }

  private paste(): void {
    const clipboard = this.code?.clipboard ?? systemClipboard;
    void clipboard.read().then(
      (text) => {
        if (!text) {
          this.say('The clipboard is empty.');
          return;
        }
        try {
          this.document.insert(text);
          this.error = '';
        } catch (error) {
          this.error = error instanceof Error ? error.message : 'Unsupported paste';
        }
        this.revealPending = true;
        this.requestRender();
      },
      () => this.say('Paste failed: the clipboard is unavailable.'),
    );
  }

  /** Put the caret on a 1-based line and column and show it centered. */
  goTo(line: number, column = 1): void {
    const lines = this.sourceLines();
    const row = Math.max(0, Math.min(lines.length - 1, Math.floor(line) - 1));
    const target = this.offsetAt(lines[row]!, Math.max(0, Math.floor(column) - 1));
    this.document.select(target, target);
    this.goalColumn = undefined;
    this.revealPending = true;
    this.centerPending = true;
    this.requestRender();
  }

  selectedLines(): { from: number; to: number } {
    const lines = this.sourceLines();
    const rowOf = (offset: number) => {
      let low = 0;
      let high = lines.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (lines[middle]!.start > offset) high = middle - 1;
        else low = middle;
      }
      return low;
    };
    const doc = this.document;
    const start = Math.min(doc.anchor, doc.cursor);
    const end = Math.max(doc.anchor, doc.cursor);
    const last = end > start && lines[rowOf(end)]!.start === end ? rowOf(end) - 1 : rowOf(end);
    return { from: rowOf(start) + 1, to: Math.max(rowOf(start), last) + 1 };
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'wheel') return undefined;
    if (event.button !== 'left' && event.type !== 'drag' && event.type !== 'release') return undefined;
    if (event.type === 'release') {
      this.dragging = false;
      return { handled: true };
    }
    if (event.type !== 'press' && event.type !== 'click' && !(event.type === 'drag' && this.dragging)) return undefined;
    if (this.requestFocus?.() === false) {
      this.dragging = false;
      return { handled: true };
    }
    const lines = this.sourceLines();
    // ScrollView already translates y into content coordinates.
    const line = lines[Math.max(0, Math.min(lines.length - 1, event.y))]!;
    const cursor = this.offsetAt(line, Math.max(0, event.x - this.gutter) + this.left);
    const extend = event.shift || event.type === 'drag';
    if (this.code && event.type === 'press' && (event.clickCount ?? 1) >= 2) {
      // Double click selects the word, triple click the line.
      if (event.clickCount === 2) {
        const end = this.document.wordBoundary(cursor, 'right');
        this.document.select(this.document.wordBoundary(end, 'left'), end);
      } else this.document.select(line.start, line.breakEnd);
      this.goalColumn = undefined;
      this.requestRender();
      return { handled: true, capture: true, focus: true };
    }
    this.document.select(extend ? this.document.anchor : cursor, cursor);
    if (event.type === 'press') this.dragging = true;
    this.goalColumn = undefined;
    this.revealPending = true;
    this.requestRender();
    return { handled: true, capture: event.type === 'press', focus: true };
  }
}

class EditorScrollView extends ScrollView {
  private readonly editor: FileEditor;

  constructor(editor: FileEditor) {
    super(editor, { follow: 'none', overscroll: 'contain', scrollbar: 'hidden' });
    this.editor = editor;
  }

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    const resized = viewportHeight !== this.viewportHeight;
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (resized) this.editor.revealPending = true;
    this.editor.reveal();
    // A viewport that moved past the drawn rows (a resize, or the first layout) needs one more frame.
    const bottom = Math.min(this.scrollTop + this.viewportHeight, contentHeight);
    if (!this.editor.drawnRanges.some(([from, to]) => this.scrollTop >= from && bottom <= to)) requestRender();
  }
}

export function createFileEditorPane(
  text: string | FileDocument,
  requestRender: () => void,
  options: FileEditorOptions = {},
): FileEditorPane {
  const document = typeof text === 'string' ? new FileDocument(text) : text;
  const focus = new FileEditor(document, requestRender, options);
  const view = new EditorScrollView(focus);
  focus.view = view;
  return {
    document,
    view,
    focus,
    get position() {
      return focus.position;
    },
    goTo: (line, column) => focus.goTo(line, column),
    selectedLines: () => focus.selectedLines(),
    indent: () => focus.indent(),
    toggleComment: () => focus.toggleComment(),
    rows: (width) => focus.rows(width),
  };
}
