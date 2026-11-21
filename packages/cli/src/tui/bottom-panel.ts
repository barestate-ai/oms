import {
  ScrollView,
  VStack,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import type { ChangesStore, FileChange } from './changes.ts';
import { ListView, type ListItem } from './list-view.ts';
import type { Problem } from './problems.ts';
import type { TerminalPane } from './terminal-pane.ts';
import { colorText, type OmsTheme, type ThemeRole } from './theme.ts';
import { displayText } from './transcript.ts';

export type PanelTab = 'terminal' | 'problems' | 'output' | 'changes';
export const PANEL_TABS: readonly PanelTab[] = ['terminal', 'problems', 'output', 'changes'];

/** One command's result: what ran, how it ended and its text. */
export interface OutputEntry {
  id: number;
  command: string;
  title: string;
  text: string;
  time: Date;
  failed?: boolean;
}
interface PanelOptions {
  theme: () => OmsTheme;
  render: () => void;
  terminal: TerminalPane;
  changes: ChangesStore;
  /** Files the agent edited this turn. */
  touched: () => ReadonlySet<string>;
  openFile: (path: string, line?: number, column?: number) => void;
  openDiff: (change: FileChange) => void;
  /** Show an output entry's whole text in the editor. */
  openOutput: (entry: OutputEntry) => void;
  /** Run a slash command (`/error 6000`). */
  runCommand: (command: string) => void;
  revert: (change: FileChange) => void;
  /** The panel (or one of its tabs) was clicked: give it keyboard focus. */
  requestFocus: (tab: PanelTab) => void;
  /** The ▾ hide control. */
  hide: () => void;
  /** Whether the panel is open (default true); closed, only its header strip shows and the control reads ▴ show. */
  open?: () => boolean;
  /** The ▴ show control of a closed panel. */
  show?: () => void;
  leave: () => void;
}
interface HeaderHit {
  tab?: PanelTab;
  action?: 'start' | 'stop' | 'hide' | 'show';
  start: number;
  end: number;
}

const LABELS: Readonly<Record<PanelTab, string>> = {
  terminal: 'terminal',
  problems: 'problems',
  output: 'output',
  changes: 'changes',
};
const OUTPUT_LIMIT = 50;
const clean = (text: string, limit = 400): string => displayText(text, limit).replace(/[\r\n\t]/g, ' ');

function clock(time: Date): string {
  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
}

/**
 * The bottom panel: a row of tabs (terminal, problems, output, changes) over the active one's content. Each tab is
 * one stable view; the shell is the terminal pane's own body.
 */
export class BottomPanel {
  readonly body = new VStack();
  readonly focus: Component & Focusable;
  /** Just the row of tabs: what shows while the panel is closed. */
  readonly header: Component;
  tab: PanelTab = 'terminal';
  private focused = false;
  private problemList: Problem[] = [];
  private outputs: OutputEntry[] = [];
  private outputIndex = 0;
  private nextOutputId = 1;
  private hits: HeaderHit[] = [];
  private headerWidth = 0;
  private readonly problemsView: ListView;
  private readonly changesView: ListView;
  private readonly outputScroll: ScrollView;
  private readonly options: PanelOptions;

  constructor(options: PanelOptions) {
    this.options = options;
    const owner = this;
    this.focus = {
      get focused() {
        return owner.focused;
      },
      set focused(value: boolean) {
        if (owner.focused === value) return;
        owner.focused = value;
        owner.options.render();
      },
      invalidate() {},
      render: () => [],
      handleInput: (data) => this.handleInput(data),
    };
    this.problemsView = new ListView({
      theme: options.theme,
      render: options.render,
      focused: () => this.focused && this.tab === 'problems',
      items: () => this.problemItems(),
      activate: (item) => this.openProblem(this.problemList[Number(item.key)]),
      requestFocus: () => options.requestFocus('problems'),
      empty: () => [
        '',
        `  ${colorText(options.theme(), 'muted', 'No problems found.')}`,
        `  ${colorText(options.theme(), 'muted', 'Build and test errors show up here, with the file and line to open.')}`,
      ],
    });
    this.changesView = new ListView({
      theme: options.theme,
      render: options.render,
      focused: () => this.focused && this.tab === 'changes',
      items: () => this.changeItems(),
      activate: (item) => {
        const change = this.options.changes.files.find((file) => file.path === item.key);
        if (change) this.options.openDiff(change);
      },
      requestFocus: () => options.requestFocus('changes'),
      empty: () => {
        const theme = options.theme();
        const note = options.changes.note;
        return options.changes.ready
          ? [
              '',
              `  ${colorText(theme, 'muted', note ?? 'No changes yet.')}`,
              ...(note ? [] : [`  ${colorText(theme, 'muted', 'Edits made by you or the agent show up here.')}`]),
            ]
          : ['', `  ${colorText(theme, 'muted', 'Looking for changes…')}`];
      },
    });
    this.outputScroll = new ScrollView(
      {
        invalidate() {},
        render: (width) => this.outputLines(width),
        handleMouse: (event) => this.outputMouse(event),
      },
      { follow: 'none', scrollbar: 'auto', overscroll: 'contain' },
    );
    const header: Component = {
      invalidate() {},
      render: (width) => this.renderHeader(width),
      handleMouse: (event) => this.headerMouse(event),
    };
    this.header = header;
    this.body.addChild(header, { basis: 1, shrink: 0 });
    this.body.addChild(options.terminal.body, {
      basis: 0,
      grow: 1,
      minSize: 1,
      visible: () => this.tab === 'terminal',
    });
    this.body.addChild(this.problemsView.view, {
      basis: 0,
      grow: 1,
      minSize: 1,
      visible: () => this.tab === 'problems',
    });
    this.body.addChild(this.outputBody(), { basis: 0, grow: 1, minSize: 1, visible: () => this.tab === 'output' });
    this.body.addChild(this.changesView.view, { basis: 0, grow: 1, minSize: 1, visible: () => this.tab === 'changes' });
  }

  // ------------------------------------------------------------------------------------------------ data

  get problems(): readonly Problem[] {
    return this.problemList;
  }
  get outputEntries(): readonly OutputEntry[] {
    return this.outputs;
  }
  setProblems(problems: readonly Problem[]): void {
    this.problemList = [...problems];
    this.problemsView.reset();
    this.options.render();
  }
  /** Record a command's result (newest first, 50 kept) and show it. Returns the entry. */
  pushOutput(entry: Omit<OutputEntry, 'id' | 'time'>): OutputEntry {
    const full: OutputEntry = { ...entry, id: this.nextOutputId++, time: new Date() };
    this.outputs = [full, ...this.outputs].slice(0, OUTPUT_LIMIT);
    this.outputIndex = 0;
    this.outputScroll.scrollToStart();
    this.options.render();
    return full;
  }
  show(tab: PanelTab): void {
    this.tab = tab;
    this.options.render();
  }

  /** What the footer says for the active tab. */
  get hint(): string {
    if (this.tab === 'terminal') return this.options.terminal.hint;
    if (this.tab === 'problems') return '↑↓ choose · Enter go to it · 1-4 switch tab · Esc editor';
    if (this.tab === 'output')
      return '↑↓ scroll · ←→ other results · Enter open in the editor · 1-4 switch tab · Esc editor';
    return '↑↓ choose · Enter see the diff · o open file · a mark reviewed · R revert · Esc editor';
  }

  // ------------------------------------------------------------------------------------------------ rows

  private problemItems(): ListItem[] {
    const theme = this.options.theme();
    return this.problemList.map((problem, index) => {
      const glyph = colorText(
        theme,
        problem.severity === 'error' ? 'error' : 'warning',
        problem.severity === 'error' ? '×' : '!',
      );
      const where = problem.path
        ? `${problem.path}${problem.line ? `:${problem.line}${problem.column ? `:${problem.column}` : ''}` : ''}`
        : '';
      const text =
        ` ${glyph} ${where ? colorText(theme, 'foreground', clean(where)) + '  ' : ''}` +
        `${problem.code ? colorText(theme, 'muted', problem.code + ' ') : ''}${colorText(theme, 'muted', clean(problem.message))}`;
      return { key: String(index), text };
    });
  }

  private changeItems(): ListItem[] {
    const theme = this.options.theme();
    const touched = this.options.touched();
    return this.options.changes.files.map((change) => {
      const reviewed = this.options.changes.isReviewed(change);
      const role: ThemeRole =
        change.status === 'D' ? 'error' : change.status === 'M' || change.status === 'R' ? 'warning' : 'success';
      const status = change.status === 'B' ? 'M' : change.status;
      const counts =
        change.status === 'U'
          ? 'new'
          : change.status === 'B'
            ? 'binary'
            : `${colorText(theme, 'success', `+${change.added}`)} ${colorText(theme, 'error', `−${change.removed}`)}`;
      const note = reviewed
        ? colorText(theme, 'success', '✓')
        : touched.has(change.path)
          ? colorText(theme, 'accent', '● agent')
          : '';
      return {
        key: change.path,
        text: ` ${colorText(theme, reviewed ? 'muted' : role, status)}  ${colorText(theme, reviewed ? 'muted' : 'foreground', clean(change.path))}`,
        right: [counts, note].filter(Boolean).join('  '),
      };
    });
  }

  private openProblem(problem: Problem | undefined): void {
    if (!problem) return;
    if (problem.path) this.options.openFile(problem.path, problem.line, problem.column);
    else if (problem.command) this.options.runCommand(problem.command);
  }

  private outputBody(): Component {
    const column = new VStack();
    column.addChild(
      {
        invalidate() {},
        render: (width) => [this.outputTitle(width)],
        handleMouse: (event) => this.outputMouse(event),
      },
      { basis: 1, shrink: 0, visible: () => this.outputs.length > 0 },
    );
    column.addChild(this.outputScroll, { basis: 0, grow: 1, minSize: 1 });
    return column;
  }

  private outputTitle(width: number): string {
    const theme = this.options.theme();
    const entry = this.outputs[this.outputIndex];
    if (!entry) return '';
    const state = entry.failed ? colorText(theme, 'error', 'failed') : colorText(theme, 'success', 'ok');
    const position = `${this.outputIndex + 1} of ${this.outputs.length}`;
    return truncateToWidth(
      ` ${colorText(theme, 'foreground', clean(entry.title, 80))}  ${state}  ${colorText(theme, 'muted', `${clock(entry.time)} · ${position}`)}`,
      width,
      '',
    );
  }

  private outputLines(width: number): string[] {
    const theme = this.options.theme();
    const entry = this.outputs[this.outputIndex];
    if (!entry)
      return [
        '',
        `  ${colorText(theme, 'muted', 'No output yet.')}`,
        `  ${colorText(theme, 'muted', 'Run /test or /run <command>; the result shows up here.')}`,
      ];
    return displayText(entry.text, 64 * 1024)
      .split(/\r?\n/)
      .map((line) => truncateToWidth(' ' + line.replace(/\t/g, '    '), width, ''));
  }

  private outputMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== 'left') return undefined;
    if (event.type === 'press') return { handled: true, focus: true };
    if (event.type === 'click') {
      this.options.requestFocus('output');
      return { handled: true, focus: true };
    }
    return undefined;
  }

  // ------------------------------------------------------------------------------------------------ header

  private renderHeader(width: number): string[] {
    const theme = this.options.theme();
    this.headerWidth = width;
    this.hits = [];
    let line = '';
    let column = 0;
    const put = (text: string, colored: string, hit?: Omit<HeaderHit, 'start' | 'end'>) => {
      if (hit) this.hits.push({ ...hit, start: column, end: column + visibleWidth(text) });
      line += colored;
      column += visibleWidth(text);
    };
    const right = this.tab === 'terminal' ? (this.options.terminal.running ? '■ stop' : '▸ start') : '';
    const isOpen = this.options.open?.() ?? true;
    const hide = isOpen ? '▾ hide' : '▴ show';
    const tail = (right ? right + '  ' : '') + hide + (width >= 36 ? ' ─' : '');
    // On a narrow terminal the tabs that are not showing give way first.
    const tabs = PANEL_TABS.map((tab) => {
      const count = tab === 'problems' ? this.problemList.length : tab === 'changes' ? this.options.changes.count : 0;
      return { tab, count, size: LABELS[tab].length + (count ? String(count).length + 1 : 0) + 3 };
    });
    let room = width - 2 - visibleWidth(tail) - 1;
    const shown = tabs.filter((candidate) => candidate.tab === this.tab);
    room -= shown[0]!.size;
    for (const candidate of tabs) {
      if (candidate.tab === this.tab) continue;
      if (candidate.size <= room) {
        shown.push(candidate);
        room -= candidate.size;
      }
    }
    put('─ ', colorText(theme, 'border', '─ '));
    for (const candidate of tabs.filter((item) => shown.includes(item))) {
      const active = this.tab === candidate.tab;
      const label = LABELS[candidate.tab];
      const role: ThemeRole = active ? (this.focused ? 'accent' : 'foreground') : 'muted';
      put(label, colorText(theme, role, active ? `\x1b[1m${label}\x1b[22m` : label), { tab: candidate.tab });
      if (candidate.count) {
        const text = ` ${candidate.count}`;
        put(text, colorText(theme, candidate.tab === 'problems' ? 'warning' : 'muted', text));
      }
      put('   ', '   ');
    }
    const fill = Math.max(1, width - column - visibleWidth(tail));
    put('─'.repeat(fill), colorText(theme, this.focused ? 'accent' : 'border', '─'.repeat(fill)));
    if (right)
      put(right, colorText(theme, 'foreground', right), { action: this.options.terminal.running ? 'stop' : 'start' });
    if (right) put('  ', '  ');
    put(hide, colorText(theme, 'muted', hide), { action: isOpen ? 'hide' : 'show' });
    if (width >= 36) put(' ─', colorText(theme, 'border', ' ─'));
    return [truncateToWidth(line, width, '')];
  }

  private headerMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.width !== this.headerWidth) return undefined;
    if (event.button !== 'left') return undefined;
    if (event.type === 'press') return { handled: true, focus: false };
    if (event.type !== 'click') return undefined;
    const hit = this.hits.find((candidate) => event.x >= candidate.start && event.x < candidate.end);
    if (!hit) return { handled: true, focus: false };
    if (hit.tab) {
      this.tab = hit.tab;
      this.options.requestFocus(hit.tab);
    } else if (hit.action === 'hide') this.options.hide();
    else if (hit.action === 'show') this.options.show?.();
    else if (hit.action === 'start') {
      this.options.requestFocus('terminal');
      void this.options.terminal.start();
    } else if (hit.action === 'stop') void this.options.terminal.stop();
    this.options.render();
    return { handled: true, focus: false };
  }

  // ------------------------------------------------------------------------------------------------ keys

  private handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, 'escape')) {
      this.options.leave();
      return;
    }
    for (const [index, tab] of PANEL_TABS.entries()) {
      if (data === String(index + 1)) {
        this.tab = tab;
        this.options.requestFocus(tab);
        this.options.render();
        return;
      }
    }
    if (this.tab === 'problems') this.problemsView.handleInput(data);
    else if (this.tab === 'changes') this.changeKeys(data);
    else if (this.tab === 'output') this.outputKeys(data);
  }

  private changeKeys(data: string): void {
    if (this.changesView.handleInput(data)) return;
    const change = this.options.changes.files.find((file) => file.path === this.changesView.item?.key);
    if (data === 'r') void this.options.changes.refresh();
    else if (!change) return;
    else if (data === 'o') this.options.openFile(change.path);
    else if (data === 'a') this.options.changes.toggleReviewed(change);
    else if (data === 'R') this.options.revert(change);
  }

  private outputKeys(data: string): void {
    const page = Math.max(1, this.outputScroll.viewportHeight - 1);
    if (matchesKey(data, 'up')) this.outputScroll.scrollBy(-1);
    else if (matchesKey(data, 'down')) this.outputScroll.scrollBy(1);
    else if (matchesKey(data, 'pageUp')) this.outputScroll.scrollBy(-page);
    else if (matchesKey(data, 'pageDown')) this.outputScroll.scrollBy(page);
    else if (matchesKey(data, 'home')) this.outputScroll.scrollToStart();
    else if (matchesKey(data, 'end')) this.outputScroll.scrollToEnd();
    else if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
      const next = this.outputIndex + (matchesKey(data, 'right') ? 1 : -1);
      this.outputIndex = Math.max(0, Math.min(this.outputs.length - 1, next));
      this.outputScroll.scrollToStart();
    } else if (matchesKey(data, 'enter')) {
      const entry = this.outputs[this.outputIndex];
      if (entry) this.options.openOutput(entry);
    }
    this.options.render();
  }

  /** The components the viewport may treat as this panel for mouse focus. */
  resolveMouseFocus(component: Component): PanelTab | undefined {
    if (component === this.problemsView.view) return 'problems';
    if (component === this.changesView.view) return 'changes';
    if (component === this.outputScroll) return 'output';
    return undefined;
  }
}
