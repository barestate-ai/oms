import {
  Input,
  fuzzyFilter,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import type { ChangeMarker } from './explorer.ts';
import type { ProjectIndex, TextMatch } from './search.ts';
import { colorBg, colorText, type OmsTheme, type ThemeRole } from './theme.ts';
import { displayText } from './transcript.ts';
import { parsePathLine } from './workbench-text.ts';

interface FinderOptions {
  theme: () => OmsTheme;
  render: () => void;
  index: ProjectIndex;
  marks: () => ReadonlyMap<string, ChangeMarker>;
  /** Files opened this session, most recent first. */
  recent: () => readonly string[];
  openFile: (path: string, line?: number, column?: number) => void;
  /** Move the caret in the active file; false when no file is open. */
  goToLine: (line: number, column?: number) => boolean;
  /** Lines in the active file, for the ':' prompt. */
  lineCount: () => number | undefined;
  /** The user typed '/' or '>': hand over to the command palette. */
  commands: () => void;
  /** The card went away. */
  closed: () => void;
  rows: () => number;
}
type Mode = 'files' | 'line' | 'text';
interface Row {
  key: string;
  text: string;
  right: string;
  open: () => void;
}

const MAX_ROWS = 10;
const SEARCH_DELAY_MS = 150;
const MARK_ROLE: Readonly<Record<ChangeMarker, ThemeRole>> = {
  M: 'warning',
  A: 'success',
  U: 'success',
  D: 'error',
  R: 'info',
};
const clean = (text: string): string => displayText(text, 300).replace(/[\r\n\t]/g, ' ');

/**
 * One entry point for finding things, docked above the workbench: type a file name to open it, `:` and a number for a
 * line, `#` and some text to search the project, `/` for commands.
 */
export class FileFinder {
  readonly view: Component;
  readonly input = new Input({ prompt: '❯ ', placeholder: 'file name · :line · #text · /command' });
  private shown = false;
  private files: string[] | undefined;
  private matches: TextMatch[] = [];
  private searchNote: string | undefined;
  private searching = false;
  private selected = 0;
  private timer: NodeJS.Timeout | undefined;
  private controller: AbortController | undefined;
  private lastQuery = '';
  private ranked: string[] = [];
  private rowsAt = 0;
  /** Enter was pressed before the file list arrived: open the first match as soon as it does. */
  private openWhenReady = false;
  private readonly options: FinderOptions;

  constructor(options: FinderOptions) {
    this.options = options;
    this.view = {
      invalidate() {},
      render: (width) => this.draw(width),
      handleMouse: (event) => this.mouse(event),
    };
  }

  get open(): boolean {
    return this.shown;
  }
  /** The component keyboard focus rests on while the card is open. */
  get focusTarget(): Input {
    return this.input;
  }

  /** Open the card; `initial` is what the field starts with (`#`, `:`, or a name). */
  show(initial = ''): void {
    this.shown = true;
    this.openWhenReady = false;
    this.selected = 0;
    this.matches = [];
    this.searchNote = undefined;
    this.lastQuery = '\0';
    this.input.setValue(initial);
    this.input.focused = true;
    // The cursor goes to the end of the prefilled text.
    this.input.handleInput('\x05');
    void this.options.index
      .list()
      .then((files) => {
        this.files = files;
        if (this.openWhenReady && this.shown) this.rows()[0]?.open();
        this.openWhenReady = false;
        this.options.render();
      })
      .catch(() => {
        this.files = [];
        this.options.render();
      });
    this.schedule();
    this.options.render();
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.input.focused = false;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.options.closed();
    this.options.render();
  }

  private get mode(): Mode {
    const value = this.input.getValue();
    return value.startsWith(':') ? 'line' : value.startsWith('#') ? 'text' : 'files';
  }

  private get query(): string {
    const value = this.input.getValue();
    return this.mode === 'files' ? value : value.slice(1);
  }

  // ------------------------------------------------------------------------------------------------ results

  private schedule(): void {
    clearTimeout(this.timer);
    this.controller?.abort();
    if (this.mode !== 'text' || !this.query.trim()) {
      this.searching = false;
      this.matches = [];
      this.searchNote = undefined;
      return;
    }
    this.searching = true;
    const controller = (this.controller = new AbortController());
    this.timer = setTimeout(() => {
      void this.options.index.search(this.query, controller.signal).then((result) => {
        if (controller.signal.aborted || !this.shown) return;
        this.matches = result.matches;
        this.searchNote = result.note;
        this.searching = false;
        this.selected = 0;
        this.options.render();
      });
    }, SEARCH_DELAY_MS);
    this.timer.unref();
  }

  private rankedFiles(): string[] {
    const { path } = parsePathLine(this.query);
    const key = `${path}\0${this.files?.length ?? -1}`;
    if (key === this.lastQuery) return this.ranked;
    this.lastQuery = key;
    if (!this.files) return (this.ranked = []);
    if (!path.trim()) {
      const recent = this.options.recent().filter((candidate) => this.files!.includes(candidate));
      const rest = this.files.filter((candidate) => !recent.includes(candidate));
      return (this.ranked = [...recent, ...rest].slice(0, 200));
    }
    return (this.ranked = fuzzyFilter(this.files, path, (candidate) => candidate).slice(0, 200));
  }

  private rows(): Row[] {
    const theme = this.options.theme();
    if (this.mode === 'line') {
      const [line, column] = this.query.split(':').map((part) => Number.parseInt(part, 10));
      const total = this.options.lineCount();
      if (!line || line < 1) return [];
      const text = `Go to line ${line}${column ? `, column ${column}` : ''}${total ? ` of ${total}` : ''}`;
      return [
        { key: 'line', text: colorText(theme, 'foreground', text), right: '', open: () => this.goTo(line, column) },
      ];
    }
    if (this.mode === 'text') {
      return this.matches.map((match, index) => ({
        key: `${match.path}:${match.line}:${index}`,
        text:
          colorText(theme, 'foreground', `${clean(match.path)}:${match.line}`) +
          '  ' +
          colorText(theme, 'muted', clean(match.text)),
        right: '',
        open: () => this.go(match.path, match.line, match.column),
      }));
    }
    const { line, column } = parsePathLine(this.query);
    const marks = this.options.marks();
    const recent = new Set(this.options.recent());
    const empty = !this.query.trim();
    return this.rankedFiles().map((path) => {
      const cut = path.lastIndexOf('/');
      const mark = marks.get(path);
      return {
        key: path,
        text:
          colorText(theme, 'muted', clean(path.slice(0, cut + 1))) +
          colorText(theme, 'foreground', clean(path.slice(cut + 1))),
        right: [
          mark ? colorText(theme, MARK_ROLE[mark], mark) : '',
          empty && recent.has(path) ? colorText(theme, 'muted', 'recent') : '',
        ]
          .filter(Boolean)
          .join(' '),
        open: () => this.go(path, line, column),
      };
    });
  }

  private go(path: string, line?: number, column?: number): void {
    this.hide();
    this.options.openFile(path, line, column);
  }
  private goTo(line: number, column?: number): void {
    this.hide();
    this.options.goToLine(line, column);
  }

  // ------------------------------------------------------------------------------------------------ drawing

  private footer(count: number): string {
    if (this.mode === 'line') return this.options.lineCount() ? 'Enter to jump' : 'open a file first';
    if (this.mode === 'text')
      return this.searching
        ? 'searching…'
        : (this.searchNote ?? (this.query.trim() ? `${count} match${count === 1 ? '' : 'es'}` : 'type to search'));
    if (!this.files) return 'looking for files…';
    return `${count}${count >= 200 ? '+' : ''} of ${this.files.length} files`;
  }

  private draw(width: number): string[] {
    if (!this.shown || width < 10) return [];
    const theme = this.options.theme();
    const inner = Math.max(1, width - 4);
    const rows = this.rows();
    this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
    const capacity = Math.max(1, Math.min(MAX_ROWS, this.options.rows() - 10));
    const start = Math.max(0, Math.min(this.selected - Math.floor(capacity / 2), rows.length - capacity));
    this.rowsAt = start;
    const border = (text: string) => colorText(theme, 'accent', text);
    const title = this.mode === 'line' ? 'Go to line' : this.mode === 'text' ? 'Search the project' : 'Open';
    const hint = 'files · / commands · # text · : line';
    const top = ` ${title} `;
    const topFill = Math.max(0, width - 2 - visibleWidth(top) - (width > 60 ? visibleWidth(hint) + 2 : 0));
    const lines = [
      border('╭') +
        colorText(theme, 'foreground', top) +
        border('─'.repeat(topFill)) +
        (width > 60 ? colorText(theme, 'muted', ` ${hint} `) : '') +
        border('╮'),
    ];
    const frame = (content: string) =>
      border('│') + ' ' + truncateToWidth(content, inner, '…', true) + ' ' + border('│');
    lines.push(frame(this.input.render(inner)[0] ?? ''));
    const visible = rows.slice(start, start + capacity);
    for (const [offset, row] of visible.entries()) {
      const index = start + offset;
      const right = row.right ? ` ${row.right}` : '';
      const text = truncateToWidth(
        `${index === this.selected ? '›' : ' '} ${row.text}`,
        Math.max(1, inner - visibleWidth(right)),
        '…',
        true,
      );
      const line = truncateToWidth(text + right, inner, '', true);
      lines.push(
        border('│') +
          ' ' +
          (index === this.selected ? colorBg(theme, 'selection', line, inner) : line) +
          ' ' +
          border('│'),
      );
    }
    if (
      !visible.length &&
      this.query.trim() &&
      this.mode !== 'line' &&
      !(this.mode === 'text' && this.searching) &&
      (this.mode === 'text' || this.files)
    )
      lines.push(frame(colorText(theme, 'muted', this.mode === 'text' ? 'No matches' : 'No file matches')));
    const foot = ` ${this.footer(rows.length)} `;
    lines.push(
      border('╰') +
        border('─'.repeat(Math.max(0, width - 2 - visibleWidth(foot)))) +
        colorText(theme, 'muted', foot) +
        border('╯'),
    );
    return lines;
  }

  // ------------------------------------------------------------------------------------------------ input

  handleInput(data: string): void {
    if (!this.shown || isKeyRelease(data)) return;
    const rows = this.rows();
    const page = Math.max(1, Math.min(MAX_ROWS, this.options.rows() - 10) - 1);
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+p')) this.hide();
    else if (matchesKey(data, 'ctrl+k')) {
      this.hide();
      this.options.commands();
    } else if (matchesKey(data, 'up')) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, 'down')) this.selected = Math.min(rows.length - 1, this.selected + 1);
    else if (matchesKey(data, 'pageUp')) this.selected = Math.max(0, this.selected - page);
    else if (matchesKey(data, 'pageDown')) this.selected = Math.min(rows.length - 1, this.selected + page);
    else if (matchesKey(data, 'enter')) {
      if (this.mode === 'files' && !this.files && this.query.trim()) this.openWhenReady = true;
      else rows[this.selected]?.open();
    } else if (matchesKey(data, 'tab')) {
      // Tab fills the field with the highlighted file name, to refine it.
      const row = rows[this.selected];
      if (this.mode === 'files' && row) this.input.setValue(row.key);
      this.input.handleInput('\x05');
    } else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      const value = this.input
        .getValue()
        .replace(/[\r\n]/g, ' ')
        .slice(0, 300);
      if (value !== this.input.getValue()) this.input.setValue(value);
      if (value !== before) {
        this.selected = 0;
        // A leading '/' or '>' means a command: that is the palette's job.
        if (/^[/>]/.test(value)) {
          this.hide();
          this.options.commands();
          return;
        }
        this.schedule();
      }
    }
    this.options.render();
  }

  private mouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== 'left') return undefined;
    if (event.type === 'press') return { handled: true, focus: false };
    if (event.type !== 'click') return undefined;
    const row = this.rows()[this.rowsAt + event.y - 2];
    if (row) row.open();
    return { handled: true, focus: false };
  }
}
