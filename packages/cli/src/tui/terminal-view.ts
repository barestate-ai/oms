import xterm from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import unicodeGraphemes from '@xterm/addon-unicode-graphemes';
import {
  CURSOR_MARKER,
  ScrollView,
  decodeKittyPrintable,
  isKeyRelease,
  parseKey,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';

export const MAX_PENDING_VT_BYTES = 256 * 1024;
export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
const MAX_SCROLLBACK = 1000;
const CONTROL_PUNCTUATION: Readonly<Record<string, string>> = {
  '@': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  _: '\x1f',
  '-': '\x1f',
  '?': '\x7f',
};

/**
 * Rows drawn beyond the viewport, so a resize or scroll the layout applies after drawing still lands on drawn
 * rows: no viewport can outgrow the host terminal.
 */
const overdraw = (height: number) => Math.max(height, process.stdout.rows || 64);

/** Layout allocates the scroll viewport after rendering its child. */
class TerminalScrollView extends ScrollView {
  private readonly terminalView: TerminalView;
  constructor(view: TerminalView) {
    super(view, { follow: 'end', scrollbar: 'hidden', overscroll: 'contain' });
    this.terminalView = view;
  }
  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    const previousHeight = this.viewportHeight;
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    const bottom = Math.min(this.scrollTop + this.viewportHeight, contentHeight);
    const undrawn = this.scrollTop < this.terminalView.drawnFrom || bottom > this.terminalView.drawnTo;
    if (this.viewportHeight !== previousHeight || undrawn) requestRender();
  }
}

export interface TerminalViewOptions {
  columns: number;
  rows: number;
  requestRender: () => void;
  requestFocus?: () => void;
  input: (data: string) => void;
  resize: (columns: number, rows: number) => void;
}

/** Child bytes end here: only parsed cells and locally generated SGR leave this component. */
export class TerminalView implements Component, Focusable {
  readonly view: ScrollView;
  focused = false;
  private readonly terminal: HeadlessTerminal;
  private readonly writes = new Set<Promise<void>>();
  private pendingBytes = 0;
  private disposed = false;
  private inputClosed = false;
  private pendingHighSurrogate = '';
  private frame: NodeJS.Timeout | undefined;
  private cursorVisible = true;
  /** The last drawing, reused until output, a resize, focus or scrolling changes it. */
  private drawn: { key: string; lines: string[] } | undefined;
  private dirty = true;
  /** Rows [drawnFrom, drawnTo) of the last drawing hold cells; the rest are blank. */
  drawnFrom = 0;
  drawnTo = 0;

  private readonly options: TerminalViewOptions;

  constructor(options: TerminalViewOptions) {
    this.options = options;
    if (![options.columns, options.rows].every((value) => Number.isInteger(value) && value > 0 && value <= 500)) {
      throw new Error('terminal dimensions must be integers between 1 and 500');
    }
    this.terminal = new xterm.Terminal({
      cols: options.columns,
      rows: options.rows,
      scrollback: MAX_SCROLLBACK,
      allowProposedApi: true,
      logLevel: 'off',
    });
    this.terminal.loadAddon(new unicodeGraphemes.UnicodeGraphemesAddon());
    this.terminal.unicode.activeVersion = '15-graphemes';
    this.view = new TerminalScrollView(this);
    this.terminal.onData((data) => {
      if (this.inputClosed || this.disposed || !data) return;
      data = this.pendingHighSurrogate + data;
      this.pendingHighSurrogate = '';
      if (Buffer.byteLength(data) > MAX_TERMINAL_INPUT_BYTES) return;
      // The outer terminal can emit one UTF-16 code unit per input event.
      const last = data.charCodeAt(data.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        this.pendingHighSurrogate = data.slice(-1);
        data = data.slice(0, -1);
      }
      if (data) options.input(data);
    });
    // Cursor visibility is not exposed by the public buffer API.
    for (const final of ['h', 'l']) {
      this.terminal.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (params.includes(25)) this.cursorVisible = final === 'h';
        return false;
      });
    }
    this.terminal.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
      this.cursorVisible = true;
      return false;
    });
    this.terminal.parser.registerEscHandler({ final: 'c' }, () => {
      this.cursorVisible = true;
      return false;
    });
  }

  write(data: Uint8Array): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('terminal is disposed'));
    if (this.pendingBytes + data.byteLength > MAX_PENDING_VT_BYTES)
      return Promise.reject(new Error('terminal pending output limit exceeded'));
    this.pendingBytes += data.byteLength;
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    this.writes.add(pending);
    this.terminal.write(data, () => {
      this.pendingBytes -= data.byteLength;
      this.writes.delete(pending);
      this.invalidate();
      resolve();
    });
    return pending;
  }

  async flush(): Promise<void> {
    await Promise.all(this.writes);
    if (this.frame) {
      clearTimeout(this.frame);
      this.frame = undefined;
      this.options.requestRender();
    }
  }

  stopInput(): void {
    this.inputClosed = true;
    this.pendingHighSurrogate = '';
  }

  invalidate(): void {
    this.dirty = true;
    if (!this.disposed && !this.frame) {
      this.frame = setTimeout(() => {
        this.frame = undefined;
        if (!this.disposed) this.options.requestRender();
      }, 16);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.options.requestFocus || this.disposed || event.button !== 'left' || event.type !== 'press')
      return undefined;
    this.options.requestFocus();
    return { handled: true, focus: true };
  }

  handleInput(data: string): void {
    if (this.inputClosed || this.disposed || Buffer.byteLength(data) > MAX_TERMINAL_INPUT_BYTES || isKeyRelease(data))
      return;
    this.view.scrollToEnd();
    if (data.length === 1 && /[\x00-\x1f\x7f]/.test(data)) {
      this.terminal.input(data, true);
      return;
    }
    if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
      const text = data.slice(6, -6);
      this.terminal.input(
        this.terminal.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text.replace(/\r?\n/g, '\r'),
        true,
      );
      return;
    }
    const enhancedKeys = [...data.matchAll(/\x1b\[[\d:;]*u/g)];
    const firstEnhanced = enhancedKeys[0];
    if (firstEnhanced && (enhancedKeys.length > 1 || firstEnhanced[0].length !== data.length)) {
      let offset = 0;
      for (const match of enhancedKeys) {
        const index = match.index!;
        if (index > offset) this.handleInput(data.slice(offset, index));
        this.handleInput(match[0]);
        offset = index + match[0].length;
      }
      if (offset < data.length) this.handleInput(data.slice(offset));
      return;
    }
    const key = parseKey(data);
    const kittyCode = /^\x1b\[(\d+)/.exec(data);
    const functional = kittyCode && Number(kittyCode[1]) >= 57344 && Number(kittyCode[1]) <= 63743;
    const printable = functional ? undefined : decodeKittyPrintable(data);
    let translated = printable;
    if (translated === undefined && key) {
      const parts = key.split('+');
      const base = parts.pop()!;
      const shift = parts.includes('shift');
      const alt = parts.includes('alt');
      const ctrl = parts.includes('ctrl');
      if (parts.includes('super')) return;
      const arrows: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
      const tilde: Record<string, number> = {
        insert: 2,
        delete: 3,
        pageUp: 5,
        pageDown: 6,
        f5: 15,
        f6: 17,
        f7: 18,
        f8: 19,
        f9: 20,
        f10: 21,
        f11: 23,
        f12: 24,
      };
      const modifier = 1 + Number(shift) + 2 * Number(alt) + 4 * Number(ctrl);
      if (arrows[base])
        translated =
          modifier === 1
            ? `\x1b${this.terminal.modes.applicationCursorKeysMode ? 'O' : '['}${arrows[base]}`
            : `\x1b[1;${modifier}${arrows[base]}`;
      else if (tilde[base]) translated = `\x1b[${tilde[base]}${modifier === 1 ? '' : `;${modifier}`}~`;
      else if (/^f[1-4]$/.test(base))
        translated =
          modifier === 1
            ? `\x1bO${'PQRS'[Number(base.slice(1)) - 1]}`
            : `\x1b[1;${modifier}${'PQRS'[Number(base.slice(1)) - 1]}`;
      else if (base === 'tab') translated = shift ? '\x1b[Z' : '\t';
      else if (base === 'enter' || base === 'return') translated = '\r';
      else if (base === 'backspace') translated = '\x7f';
      else if (base === 'escape' || base === 'esc') translated = '\x1b';
      else if (base === 'space') translated = ctrl ? '\x00' : ' ';
      else if (!functional && base.length === 1) {
        if (ctrl)
          translated = /^[a-z]$/i.test(base)
            ? String.fromCharCode(base.toUpperCase().charCodeAt(0) - 64)
            : CONTROL_PUNCTUATION[base];
        else translated = shift ? base.toUpperCase() : base;
      }
      if (alt && translated && !arrows[base] && !tilde[base]) translated = `\x1b${translated}`;
    }
    // Unknown enhanced protocol sequences cannot be interpreted by a legacy child.
    if (translated === undefined && /^\x1b\[[\d:;]*u$/.test(data)) return;
    if (translated === undefined && /^\x1b\[27;\d+;\d+~$/.test(data)) return;
    this.terminal.input(translated ?? data, true);
  }

  render(width: number): string[] {
    if (this.disposed) {
      this.drawnFrom = this.drawnTo = 0;
      return [];
    }
    const columns = Math.min(500, Math.max(1, Math.floor(width)));
    const rows = Math.min(500, Math.max(1, this.view.viewportHeight || this.terminal.rows));
    if (!this.inputClosed && (columns !== this.terminal.cols || rows !== this.terminal.rows)) {
      this.terminal.resize(columns, rows);
      this.options.resize(columns, rows);
      this.dirty = true;
    }
    const buffer = this.terminal.buffer.active;
    // Only the rows where the scroll view will show this frame are drawn; scrollback above stays blank.
    const height = this.view.viewportHeight || rows;
    const end = Math.max(0, buffer.length - height);
    const top = this.view.isFollowingEnd ? end : Math.min(this.view.scrollTop, end);
    const reach = overdraw(height);
    this.drawnFrom = Math.max(0, top - reach);
    this.drawnTo = Math.min(buffer.length, top + height + reach);
    const key = `${columns}|${buffer.length}|${this.drawnFrom}|${this.drawnTo}|${this.focused}`;
    if (!this.dirty && this.drawn?.key === key) return this.drawn.lines;
    this.dirty = false;
    const cell = buffer.getNullCell();
    const lines = new Array<string>(buffer.length).fill('');
    const cursorRow = buffer.baseY + buffer.cursorY;
    const cursorColumn = Math.min(buffer.cursorX, columns - 1);
    for (let y = this.drawnFrom; y < this.drawnTo; y++) {
      const line = buffer.getLine(y);
      let rendered = '';
      let lastStyle = '';
      for (let x = 0; x < columns; x++) {
        const current = line?.getCell(x, cell);
        if (!current || current.getWidth() === 0) continue;
        if (this.focused && this.cursorVisible && y === cursorRow && x === cursorColumn) rendered += CURSOR_MARKER;
        const codes: number[] = [];
        if (current.isBold()) codes.push(1);
        if (current.isDim()) codes.push(2);
        if (current.isItalic()) codes.push(3);
        if (current.isUnderline()) codes.push(4);
        if (current.isInverse()) codes.push(7);
        if (current.isStrikethrough()) codes.push(9);
        for (const foreground of [true, false]) {
          const color = foreground ? current.getFgColor() : current.getBgColor();
          if (foreground ? current.isFgRGB() : current.isBgRGB())
            codes.push(foreground ? 38 : 48, 2, (color >>> 16) & 255, (color >>> 8) & 255, color & 255);
          else if (foreground ? current.isFgPalette() : current.isBgPalette())
            codes.push(foreground ? 38 : 48, 5, color & 255);
        }
        const style = codes.join(';');
        if (style !== lastStyle) {
          rendered += `\x1b[0m${style ? `\x1b[${style}m` : ''}`;
          lastStyle = style;
        }
        const chars = current.getChars().replace(/[\x00-\x1f\x7f-\x9f]/g, '');
        rendered += current.isInvisible() ? ' '.repeat(current.getWidth()) : chars || ' ';
      }
      lines[y] = rendered + (lastStyle ? '\x1b[0m' : '');
    }
    this.drawn = { key, lines };
    return lines;
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.writes.size) throw new Error('flush pending terminal writes before disposal');
    this.disposed = true;
    this.stopInput();
    clearTimeout(this.frame);
    this.terminal.dispose();
  }
}
