import {
  CURSOR_MARKER,
  ScrollView,
  decodeKittyPrintable,
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
import { FileDocument, MAX_DOCUMENT_BYTES } from './document.ts';

export interface FileEditorPane {
  document: FileDocument;
  view: ScrollView;
  focus: Component & Focusable;
  readonly position: { line: number; column: number };
}

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
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
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

function project(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const breaks = /\r\n|\r|\n/g;
  let start = 0;
  for (;;) {
    const delimiter = breaks.exec(text);
    const end = delimiter?.index ?? text.length;
    const breakEnd = delimiter ? end + delimiter[0].length : end;
    lines.push({ start, end, breakEnd });
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

  constructor(
    document: FileDocument,
    requestRender: () => void,
    lineNumbers = false,
    requestFocus?: () => boolean | void,
    readOnly = false,
  ) {
    this.readOnly = readOnly;
    this.requestFocus = requestFocus;
    this.lineNumbers = lineNumbers;
    this.document = document;
    this.requestRender = requestRender;
  }

  invalidate(): void {
    this.projectedText = undefined;
    this.drawn = undefined;
    this.layouts.clear();
  }

  private sourceLines(): SourceLine[] {
    if (this.projectedText !== this.document.text) {
      this.lines = project(this.document.text);
      this.projectedText = this.document.text;
      // ponytail: drop every cached line layout once edits leave too many stale ones; visible rows rebuild in microseconds.
      if (this.layouts.size > 2 * this.lines.length + 256) this.layouts.clear();
    }
    return this.lines;
  }

  private layoutOf(line: SourceLine): LineLayout {
    const text = this.document.text.slice(line.start, line.end);
    let layout = this.layouts.get(text);
    if (!layout) {
      layout = layoutLine(text);
      this.layouts.set(text, layout);
    }
    return layout;
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
    if (row < this.view.scrollTop) this.view.scrollTo(row);
    else if (row >= this.view.scrollTop + this.view.viewportHeight) {
      this.view.scrollTo(row - this.view.viewportHeight + 1);
    }
    this.revealPending = false;
  }

  /** Content height stays the line count, but only rows near the viewport are drawn; the rest are blank. */
  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
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
    if (column < this.left) this.left = column;
    if (column + cursorWidth > this.left + width) this.left = Math.max(0, column + cursorWidth - width);
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
    const key = `${width}|${this.gutter}|${this.left}|${this.drawnRanges.join(';')}|${cursor}|${this.document.anchor}|${this.focused}|${this.error}`;
    if (this.drawn?.text === this.document.text && this.drawn.key === key) return this.drawn.lines;
    const selectionStart = Math.min(this.document.anchor, cursor);
    const selectionEnd = Math.max(this.document.anchor, cursor);
    const rendered = new Array<string>(lines.length).fill('');
    const drawn = new Set<number>();
    for (const [from, to] of this.drawnRanges) for (let index = from; index < to; index++) drawn.add(index);
    for (const index of drawn) {
      if (width > 0) rendered[index] = this.drawLine(lines[index]!, index === row, selectionStart, selectionEnd, width);
    }
    if (this.error && width > 0) {
      rendered[row] =
        (this.focused ? CURSOR_MARKER + renderFakeCursor(' ') : '') +
        sliceByColumn(`Edit refused: ${this.error}`, 0, width - (this.focused ? 1 : 0), true);
    }
    if (this.gutter > 0) {
      for (const index of drawn) {
        const label = String(index + 1).padStart(this.gutter - 2) + ' │';
        rendered[index] = '\x1b[2m' + sliceByColumn(label, 0, this.gutter, true) + '\x1b[22m' + rendered[index];
      }
    }
    this.drawn = { text: this.document.text, key, lines: rendered };
    return rendered;
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

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (
      this.readOnly &&
      !(
        [
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
        ] as const
      ).some((key) => matchesKey(data, key))
    )
      return;
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
          target = direction === 'home' ? lines[row]!.start : lines[row]!.end;
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
    if (matchesKey(data, 'ctrl+home') || matchesKey(data, 'ctrl+shift+home')) {
      doc.select(matchesKey(data, 'ctrl+shift+home') ? doc.anchor : 0, 0);
    } else if (matchesKey(data, 'ctrl+end') || matchesKey(data, 'ctrl+shift+end')) {
      doc.select(matchesKey(data, 'ctrl+shift+end') ? doc.anchor : doc.text.length, doc.text.length);
    } else if (matchesKey(data, 'ctrl+a')) doc.select(0, doc.text.length);
    else if (matchesKey(data, 'ctrl+z')) doc.undo();
    else if (matchesKey(data, 'ctrl+y') || matchesKey(data, 'ctrl+shift+z')) doc.redo();
    else if (matchesKey(data, 'backspace')) doc.backspace();
    else if (matchesKey(data, 'delete')) doc.deleteForward();
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
      if (!/[\x00-\x1f\x7f-\x9f]/.test(text)) doc.insert(text);
    }
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
  options: { readOnly?: boolean; lineNumbers?: boolean; requestFocus?: () => boolean | void } = {},
): FileEditorPane {
  const document = typeof text === 'string' ? new FileDocument(text) : text;
  const focus = new FileEditor(document, requestRender, options.lineNumbers, options.requestFocus, options.readOnly);
  const view = new EditorScrollView(focus);
  focus.view = view;
  return {
    document,
    view,
    focus,
    get position() {
      return focus.position;
    },
  };
}
