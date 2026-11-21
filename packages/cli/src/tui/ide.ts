import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import {
  HStack,
  VStack,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import { LAYOUT_NODE } from '@earendil-works/pi-tui/dist/layout-node.js';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { OmsSession } from '@oms/engine';
import { ChangesStore, diffTarget, readChanges, revert, type FileChange } from './changes.ts';
import type { FocusTarget } from './commands.ts';
import { Explorer, type SidebarSection } from './explorer.ts';
import type { EditorClipboard } from './file-editor.ts';
import { FileFinder } from './file-finder.ts';
import { BottomPanel, type OutputEntry, type PanelTab } from './bottom-panel.ts';
import { parseProblems } from './problems.ts';
import { verticalRule } from './rules.ts';
import { ProjectIndex } from './search.ts';
import { maskSecrets } from './secret-mask.ts';
import { SolanaPanel } from './solana-panel.ts';
import { TasksDashboard, type DashboardSources } from './tasks-dashboard.ts';
import type { Hint } from './status-row.ts';
import { TerminalPane } from './terminal-pane.ts';
import { colorBg, colorText, type OmsTheme, type ThemeRole } from './theme.ts';
import { displayText } from './transcript.ts';
import { WorkbenchPane, type WelcomeAction } from './workbench.ts';
import { friendlyError, type MessageKind } from './workbench-text.ts';

export type { SidebarSection } from './explorer.ts';
/** The areas of the workbench that can hold keyboard focus. */
export type IdeFocus = Extract<FocusTarget, 'explorer' | 'editor' | 'terminal' | 'panel'>;

/** Columns at which the explorer shows beside the editor, and the agent drawer beside both. */
export const EXPLORER_COLUMNS = 100;
export const DRAWER_COLUMNS = 140;
const PANEL_ROWS = 30;

export interface IdeOptions {
  theme: () => OmsTheme;
  render: () => void;
  viewport: () => { columns: number; rows: number };
  /** Move keyboard focus (the interface owns the focus model). */
  focus: (target: FocusTarget) => void;
  focused: () => FocusTarget;
  /** The workbench is the visible view. */
  visible: () => boolean;
  /** The agent composer is on screen, so the ask bar is not needed. */
  composerVisible: () => boolean;
  notice: (message: string, kind?: MessageKind) => void;
  /** Send text to the agent as the user's next message. */
  ask: (text: string) => void;
  /** Put text in the agent composer and focus it. */
  draft: (text: string) => void;
  /** Open the command palette, typed with `prefill` when given. */
  commands: (prefill?: string) => void;
  /** Run a slash command as if chosen from the palette. */
  run: (command: string) => void;
  busy: () => boolean;
  /** What stops the running work from the editor, if anything does: Esc, or nothing (a review runs to its end). */
  interrupt: () => 'esc' | 'ctrl+l' | undefined;
  awaiting: () => boolean;
  startedAt: number;
  copy: (text: string) => void;
  /** The editor changed which file is active, or a buffer was rebuilt. */
  focusChanged: () => void;
  clipboard?: EditorClipboard;
  /** The sidebar's connectors section; absent until a connectors provider is registered. */
  connectors?: () => SidebarSection | undefined;
  sources?: DashboardSources;
}

const clean = (text: string, limit = 400): string => displayText(text, limit).replace(/[\r\n\t]/g, ' ');
const base = (path: string): string => posix.basename(path);

/** The checked-out branch of a folder, read from `.git/HEAD` without running git. */
function branchOf(folder: string): string | undefined {
  try {
    const head = readFileSync(`${folder}/.git/HEAD`, 'utf8').trim();
    return /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? 'detached';
  } catch {
    return undefined;
  }
}

interface Segment {
  text: string;
  role: ThemeRole;
  click?: () => void;
}
interface Card {
  title: string;
  hint: string;
  items: Array<{ label: string; run: () => void; disabled?: boolean }>;
  selected: number;
  note?: string;
}

/**
 * The workbench as one IDE-like screen: a file explorer, tabbed editors, a bottom panel (terminal, problems, output,
 * changes), a status row and a hint row, with quick open, project search and ask-the-agent cards above. The interface
 * only places it and routes keys; everything the user sees in the workbench is composed here.
 */
export class WorkbenchIde {
  readonly workbench: WorkbenchPane;
  readonly shell: TerminalPane;
  readonly explorer: Explorer;
  readonly panel: BottomPanel;
  readonly finder: FileFinder;
  readonly changes: ChangesStore;
  readonly index: ProjectIndex;
  readonly solana: SolanaPanel;
  readonly dashboard: TasksDashboard;
  readonly body = new VStack();
  private readonly options: IdeOptions;
  private readonly harness: OmsSession;
  private readonly touched = new Set<string>();
  private readonly pending = new Map<string, string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private recent: string[] = [];
  /** What the user chose with Ctrl+B; until they choose, the explorer shows when the terminal is wide enough. */
  private explorerPref: boolean | undefined;
  private panelOpen = false;
  private dashboardOn = false;
  private drawerOn = false;
  private card: Card | undefined;
  private confirm: { text: string; run: () => void } | undefined;
  private started = false;
  private statusHits: Array<{ start: number; end: number; click: () => void }> = [];
  private statusWidth = 0;
  private entries: { sidebar?: { basis: number | 'auto'; grow?: number }; panel?: { basis: number | 'auto' } } = {};
  private disposed = false;
  private main: HStack | undefined;

  constructor(harness: OmsSession, options: IdeOptions) {
    this.harness = harness;
    this.options = options;
    const { theme, render } = options;
    this.index = new ProjectIndex({
      root: harness.root,
      files: { list: (path, signal) => harness.files.list(path, signal) },
    });
    this.changes = new ChangesStore(
      () => readChanges(harness),
      () => {
        render();
      },
    );
    this.workbench = new WorkbenchPane(harness, {
      theme,
      render,
      rows: () => options.viewport().rows,
      root: harness.root,
      clipboard: options.clipboard,
      notice: (message, kind) => options.notice(message, kind),
      focusChanged: options.focusChanged,
      requestFocus: () => {
        if (options.focused() !== 'editor') options.focus('editor');
      },
      marks: (path) => this.changes.marksFor(path),
      opened: (path) => {
        this.recent = [path, ...this.recent.filter((candidate) => candidate !== path)].slice(0, 20);
      },
      saved: () => {
        this.index.invalidate();
        this.afterWrite();
      },
      suggest: (name) => this.index.named(name),
      pick: (query, matches) => this.openFinder(matches.length === 1 ? matches[0]! : query),
      welcome: () => this.welcome(),
    });
    this.shell = new TerminalPane(harness, {
      theme,
      render,
      notice: (message) => this.workbench.say(message, 'info'),
      requestFocus: () => {
        this.showPanel('terminal');
      },
      columns: () => Math.max(20, options.viewport().columns - (this.sidebarShown() ? this.sidebarWidth() + 1 : 0)),
      rows: () => Math.max(3, this.panelRows() - 1),
    });
    this.panel = new BottomPanel({
      theme,
      render,
      terminal: this.shell,
      changes: this.changes,
      touched: () => this.touched,
      openFile: (path, line, column) => this.openFile(path, line, column),
      openDiff: (change) => this.openDiff(change),
      openOutput: (entry) => this.workbench.openReport(`out-${entry.id}`, entry.text, 'output', { title: entry.title }),
      runCommand: options.run,
      revert: (change) => this.askRevert(change),
      requestFocus: (tab) => this.showPanel(tab),
      hide: () => this.hidePanel(),
      open: () => this.panelOpen,
      show: () => this.showPanel(),
      leave: () => options.focus('editor'),
    });
    this.explorer = new Explorer({
      theme,
      render,
      files: { list: (path, signal) => harness.files.list(path, signal) },
      open: (path, focusEditor) => this.openFile(path, undefined, undefined, focusEditor),
      openFiles: () => this.workbench.openFiles,
      marks: () => this.changes.markers(),
      touched: () => this.touched,
      sections: () => [options.connectors?.(), this.solana.section()],
      newFile: (directory) => {
        options.focus('editor');
        this.workbench.newFile(undefined, directory === '.' ? '' : `${directory}/`);
      },
      ask: (path) => this.openAsk({ path }),
      requestFocus: () => options.focus('explorer'),
      leave: () => {
        // On a narrow terminal the explorer took the whole editor area: Escape gives it back.
        if (this.explorerFull()) this.explorerPref = undefined;
        options.focus('editor');
      },
    });
    this.finder = new FileFinder({
      theme,
      render,
      index: this.index,
      marks: () => this.changes.markers(),
      recent: () => this.recent,
      openFile: (path, line, column) => this.openFile(path, line, column),
      goToLine: (line, column) => this.workbench.goToLine(line, column),
      lineCount: () => this.workbench.lineCount,
      commands: () => options.commands(),
      closed: () => options.focusChanged(),
      rows: () => options.viewport().rows,
    });
    this.solana = new SolanaPanel({
      harness,
      render,
      run: options.run,
      prefill: (command) => options.commands(command),
      openReport: (id, text, title) => this.workbench.openReport(id, text, 'idl', { title }),
      notice: (message) => this.workbench.say(message, 'info'),
      visible: () => options.visible(),
    });
    this.dashboard = new TasksDashboard({
      theme,
      render,
      harness,
      busy: options.busy,
      awaiting: options.awaiting,
      startedAt: options.startedAt,
      sources: options.sources,
      back: () => this.closeDashboard(),
      openReport: (id, text, title) => {
        this.closeDashboard();
        this.workbench.openReport(id, text, 'tasks', { title });
      },
      copy: options.copy,
      say: (message) => this.workbench.say(message, 'info'),
      requestFocus: () => options.focus('editor'),
    });
    this.buildLayout();
  }

  // ------------------------------------------------------------------------------------------------ layout

  private sidebarWidth(): number {
    const { columns } = this.options.viewport();
    return columns >= 160 ? 32 : columns >= 120 ? 30 : 28;
  }
  /** Beside the editor at 100 columns or more; under that the explorer takes the whole editor area instead. */
  private explorerShown(): boolean {
    return this.explorerPref ?? this.options.viewport().columns >= EXPLORER_COLUMNS;
  }
  private sidebarShown(): boolean {
    return this.explorerShown() && this.options.viewport().columns >= EXPLORER_COLUMNS;
  }
  private explorerFull(): boolean {
    return this.explorerShown() && this.options.viewport().columns < EXPLORER_COLUMNS;
  }
  /** On a very short terminal an open panel takes the whole body: there is no room for both. */
  private panelFills(): boolean {
    return this.panelOpen && this.options.viewport().rows < 16;
  }
  private panelRows(): number {
    const { rows } = this.options.viewport();
    return Math.max(6, Math.min(16, Math.floor(rows * 0.3)));
  }

  private buildLayout(): void {
    const { options } = this;
    const rows = () => options.viewport().rows;
    const editorColumn = new VStack([
      { component: this.workbench.body, basis: 0, grow: 1, minSize: 1, visible: () => !this.dashboardOn },
      { component: this.dashboard.body, basis: 0, grow: 1, minSize: 1, visible: () => this.dashboardOn },
    ]);
    const divider = verticalRule(options.theme, () => (options.focused() === 'explorer' ? 'accent' : 'border'), rows);
    const main = new HStack(
      [
        { component: this.explorer.body, basis: this.sidebarWidth(), shrink: 0, visible: () => this.explorerShown() },
        { component: divider, basis: 1, shrink: 0, visible: () => this.sidebarShown() },
        {
          component: editorColumn,
          basis: 0,
          grow: 1,
          minSize: 1,
          visible: () => !this.explorerFull() && !this.panelFills(),
        },
      ],
      { gap: 0 },
    );
    this.main = main;
    this.body.addChild(this.cardView(), { basis: 'auto', shrink: 0, visible: () => !!this.card });
    this.body.addChild(this.finder.view, { basis: 'auto', shrink: 0, visible: () => this.finder.open });
    this.body.addChild(main, { basis: 0, grow: 1, shrink: 1, minSize: 3, visible: () => !this.panelFills() });
    this.body.addChild(this.panel.header, {
      basis: 1,
      shrink: 0,
      visible: () => !this.panelOpen && rows() >= PANEL_ROWS && !this.explorerFull(),
    });
    this.body.addChild(this.panel.body, {
      basis: this.panelRows(),
      shrink: 1,
      minSize: 3,
      visible: () => this.panelOpen && !this.explorerFull(),
    });
    this.body.addChild(this.askBar(), {
      basis: 1,
      shrink: 0,
      visible: () => rows() >= PANEL_ROWS && !options.composerVisible(),
    });
    this.body.addChild(this.statusRow(), { basis: 1, shrink: 0, visible: () => rows() >= 14 });
    const entries = main[LAYOUT_NODE]().entries;
    this.entries.sidebar = entries.find((entry) => entry.component === this.explorer.body) as never;
    this.entries.panel = this.body[LAYOUT_NODE]().entries.find((entry) => entry.component === this.panel.body) as never;
  }

  /** Place the agent's conversation at the right of the editor, shown at 140 columns or more when turned on. */
  attachDrawer(component: Component): void {
    const rows = () => this.options.viewport().rows;
    this.main?.addChild(
      verticalRule(this.options.theme, () => 'border', rows),
      { basis: 1, shrink: 0, visible: () => this.agentDrawer },
    );
    this.main?.addChild(component, { basis: 44, shrink: 0, visible: () => this.agentDrawer });
  }

  /** Called before each frame: widths and heights that depend on the terminal's size. */
  prepare(): void {
    const sidebar = this.entries.sidebar as { basis: number | 'auto'; grow?: number; shrink?: number } | undefined;
    if (sidebar) {
      if (this.explorerFull()) {
        sidebar.basis = 0;
        sidebar.grow = 1;
        sidebar.shrink = 1;
      } else {
        sidebar.basis = this.sidebarWidth();
        sidebar.grow = 0;
        sidebar.shrink = 0;
      }
    }
    const panel = this.entries.panel as { basis: number | 'auto'; grow?: number } | undefined;
    if (panel) {
      panel.basis = this.panelFills() ? 0 : this.panelRows();
      panel.grow = this.panelFills() ? 1 : 0;
    }
    if (!this.started && this.options.visible()) {
      this.started = true;
      void this.changes.refresh();
      this.solana.start();
    }
  }

  // ------------------------------------------------------------------------------------------------ state

  get panelVisible(): boolean {
    return this.panelOpen;
  }
  get explorerVisible(): boolean {
    return this.explorerShown();
  }
  get dashboardVisible(): boolean {
    return this.dashboardOn;
  }
  get agentDrawer(): boolean {
    return this.drawerOn && this.options.viewport().columns >= DRAWER_COLUMNS;
  }
  setAgentDrawer(visible: boolean | undefined): void {
    this.drawerOn = visible ?? !this.drawerOn;
    this.options.render();
  }
  /** Something modal is open (quick open, ask menu, a confirmation): it takes every key. */
  get capturing(): boolean {
    return this.finder.open || !!this.card || !!this.confirm;
  }
  /** The editor shows its file with nothing of its own to close: Esc is free to stop running work. */
  get atRest(): boolean {
    return !this.capturing && this.workbench.atRest;
  }
  /** Terminal focus is only meaningful while the panel shows the terminal. */
  get terminalFocusable(): boolean {
    return this.panelOpen && this.panel.tab === 'terminal';
  }

  toggleExplorer(visible?: boolean): void {
    this.explorerPref = visible ?? !this.explorerShown();
    if (this.explorerShown()) this.options.focus('explorer');
    else if (this.options.focused() === 'explorer') this.options.focus('editor');
    this.options.render();
  }

  showPanel(tab: PanelTab = this.panel.tab): void {
    this.panelOpen = true;
    this.panel.show(tab);
    this.options.focus(tab === 'terminal' ? 'terminal' : 'panel');
    this.options.render();
  }
  hidePanel(): void {
    this.panelOpen = false;
    const focused = this.options.focused();
    if (focused === 'terminal' || focused === 'panel') this.options.focus('editor');
    this.options.render();
  }
  togglePanel(): void {
    if (this.panelOpen) this.hidePanel();
    else this.showPanel();
  }

  /**
   * Which areas are on screen: a full-width explorer (under 100 columns) takes the editor's place, and on a very short
   * terminal an open panel takes both. Keys must never reach an area that is not drawn.
   */
  private areaVisible(area: 'explorer' | 'editor' | 'panel'): boolean {
    if (area === 'explorer') return this.explorerShown() && !this.panelFills();
    if (area === 'editor') return !this.explorerFull() && !this.panelFills();
    return this.panelOpen && !this.explorerFull();
  }
  /** What the focus should be after the layout changed: a hidden area cannot keep it. */
  repairFocus(focus: FocusTarget): FocusTarget {
    const panelArea = this.panel.tab === 'terminal' ? 'terminal' : 'panel';
    const shown = this.areas();
    if (focus === 'terminal' || focus === 'panel') {
      if (!this.areaVisible('panel')) return shown[0] ?? 'input';
      return panelArea;
    }
    if ((focus === 'explorer' || focus === 'editor') && !this.areaVisible(focus))
      return shown.find((area) => area !== focus) ?? shown[0] ?? 'input';
    return focus;
  }
  /** The areas Tab and F6 cycle through, in order: only the ones on screen. */
  areas(): IdeFocus[] {
    return [
      ...(this.areaVisible('explorer') ? (['explorer'] as const) : []),
      ...(this.areaVisible('editor') ? (['editor'] as const) : []),
      ...(this.areaVisible('panel')
        ? [this.panel.tab === 'terminal' ? ('terminal' as const) : ('panel' as const)]
        : []),
    ];
  }
  /** The component keyboard focus rests on for an area. */
  focusTarget(area: IdeFocus) {
    // Quick open's field is the text cursor's owner while the card is up.
    if (this.finder.open) return this.finder.focusTarget;
    return area === 'explorer'
      ? this.explorer.focus
      : area === 'editor'
        ? this.workbench.focus
        : area === 'panel'
          ? this.panel.focus
          : this.shell.focus;
  }
  /** Map a clicked component to the area it belongs to. */
  areaOf(component: Component): IdeFocus | undefined {
    if (this.explorer.owns(component)) return 'explorer';
    if (this.workbench.resolveMouseFocus(component)) return 'editor';
    if (this.shell.resolveMouseFocus(component)) return 'terminal';
    if (this.panel.resolveMouseFocus(component)) return 'panel';
    return undefined;
  }

  // ------------------------------------------------------------------------------------------------ opening things

  /** Open a file (optionally at a line); a deliberate open also takes the editor's keyboard focus. */
  openFile(path: string, line?: number, column?: number, focusEditor = true): void {
    this.dashboardOn = false;
    if (focusEditor && this.explorerFull()) this.explorerPref = undefined;
    void this.workbench.open(path, line === undefined ? undefined : { line, column }).then(() => {
      const active = this.workbench.active;
      if (active && !active.path.startsWith('\0')) void this.explorer.reveal(active.path);
      if (focusEditor) this.options.focus('editor');
      this.options.render();
    });
  }

  openFinder(initial = ''): void {
    this.card = undefined;
    this.dashboardOn = false;
    this.finder.show(initial);
    this.options.focus('editor');
  }
  /** Project search for `text`. */
  search(text: string): void {
    this.openFinder('#' + text);
  }
  goToLine(argument: string): void {
    const match = /^:?\s*(\d+)(?::(\d+))?$/.exec(argument.trim());
    if (!match) {
      this.workbench.say('Use /goto <line>, for example /goto 42 or /goto 42:7.', 'warning');
      return;
    }
    if (!this.workbench.goToLine(Number(match[1]), match[2] ? Number(match[2]) : undefined))
      this.workbench.say('Open a file first, then go to a line.', 'info');
  }

  openDashboard(): void {
    this.finder.hide();
    this.card = undefined;
    this.dashboardOn = true;
    void this.dashboard.refresh();
    this.options.focus('editor');
    this.options.render();
  }
  closeDashboard(): void {
    if (!this.dashboardOn) return;
    this.dashboardOn = false;
    this.options.render();
  }

  openDiff(change: FileChange): void {
    const text =
      change.patch ||
      (change.status === 'U'
        ? 'This file is new and not tracked by git yet, so there is no diff to show.'
        : 'No textual changes.');
    this.workbench.updateReport(change.path.replace(/\//g, '~'), text, 'diff', {
      title: base(change.path),
      language: 'diff',
    });
    this.options.focus('editor');
  }

  private welcome(): WelcomeAction[] {
    return [
      { label: 'Open a file', keys: 'Ctrl+P', run: () => this.openFinder() },
      { label: 'New file', keys: 'Ctrl+N', run: () => this.workbench.newFile() },
      { label: 'Search the project', keys: '/search', run: () => this.openFinder('#') },
      { label: 'Ask the agent', keys: 'Ctrl+L', run: () => this.options.focus('input') },
      { label: 'Commands', keys: 'Ctrl+K', run: () => this.options.commands() },
    ];
  }

  // ------------------------------------------------------------------------------------------------ the agent at work

  /** Session events: files the agent edits refresh the open buffers, the explorer, the change list and the file index. */
  onSessionEvent(event: AgentSessionEvent): void {
    if (this.disposed) return;
    // A turn starting, a tool starting or ending, or the turn settling changes what the dashboard shows.
    if (event.type === 'agent_start' || event.type === 'agent_settled' || event.type.startsWith('tool_execution_'))
      this.touchDashboard();
    if (event.type === 'agent_start') {
      this.touched.clear();
      return;
    }
    if (event.type === 'tool_execution_start' && (event.toolName === 'write' || event.toolName === 'edit')) {
      const path = this.projectRelative((event.args as { path?: unknown } | undefined)?.path);
      if (path) this.pending.set(event.toolCallId, path);
      return;
    }
    if (event.type === 'tool_execution_end' && (event.toolName === 'write' || event.toolName === 'edit')) {
      const path = this.pending.get(event.toolCallId);
      this.pending.delete(event.toolCallId);
      if (!path || event.isError) return;
      this.touched.add(path);
      this.later(() => {
        void this.workbench.refreshFromDisk([path]);
        void this.explorer.refresh([posix.dirname(path)]);
      }, 200);
      this.afterWrite();
      return;
    }
    if (event.type === 'agent_settled') {
      // A shell command may have changed anything: look at everything once.
      this.index.invalidate();
      this.solana.refresh();
      void this.workbench.refreshFromDisk();
      void this.explorer.refresh();
      void this.changes.refresh();
    }
  }

  private dashboardTimer: NodeJS.Timeout | undefined;
  /** The dashboard bakes busy, awaiting and helper states into its rows: read them again soon (once, however often asked). */
  touchDashboard(): void {
    if (!this.dashboardOn || this.disposed || this.dashboardTimer) return;
    this.dashboardTimer = setTimeout(() => {
      this.dashboardTimer = undefined;
      if (this.dashboardOn && !this.disposed) void this.dashboard.refresh();
    }, 100);
    this.dashboardTimer.unref();
  }

  private afterWrite(): void {
    this.later(() => void this.changes.refresh(), 400);
    this.options.render();
  }

  private later(action: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) action();
    }, ms);
    timer.unref();
    this.timers.add(timer);
  }

  /** The agent's path argument as a project-relative path, or undefined for anything outside the project. */
  private projectRelative(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value) return undefined;
    const root = this.harness.root.replace(/\/$/, '');
    const path = posix.normalize(
      value.startsWith(root + '/') ? value.slice(root.length + 1) : value.replace(/^\/work\//, ''),
    );
    return path.startsWith('..') || path.startsWith('/') ? undefined : path;
  }

  /**
   * A command's result, kept in the panel. Returns true when the workbench is where the user is, so the interface does not
   * pull them to the conversation: build and test errors become a list of problems with a file and line to open.
   */
  recordOutput(command: string, output: { title: string; text: string; failure?: string }): boolean {
    // Only a build, test or command result replaces the problems list; /status and the like leave it alone.
    const builds = ['test', 'run', 'verify'].includes(output.title);
    const problems = builds ? parseProblems(output.text, this.harness.root) : [];
    const exit = /^Exit: (\d+)/m.exec(output.text)?.[1];
    this.panel.pushOutput({
      command,
      title: output.title,
      text: output.text,
      failed:
        !!output.failure ||
        (exit !== undefined && exit !== '0') ||
        problems.some((problem) => problem.severity === 'error'),
    });
    if (builds) this.panel.setProblems(problems);
    this.panelOpen = true;
    this.panel.show(problems.length ? 'problems' : 'output');
    this.index.invalidate();
    this.afterWrite();
    return this.options.visible();
  }

  /** A command that failed: say why in the panel and the footer, in words a person can act on. */
  recordFailure(kind: string, message: string): void {
    const text = friendlyError(message, { root: this.harness.root });
    this.panel.pushOutput({ command: kind, title: `${kind} failed`, text, failed: true });
    this.panelOpen = true;
    this.panel.show('output');
    this.workbench.say(text, 'error');
  }

  // ------------------------------------------------------------------------------------------------ cards

  private context(
    subject: { path: string } | undefined,
  ): { reference: string; body: string; notice?: string } | undefined {
    const active = this.workbench.askContext();
    const path = subject?.path ?? active?.path;
    if (!path) return undefined;
    const report = path.startsWith('\0');
    const useSelection = !subject && active && active.path === path;
    const where =
      useSelection && active.selected
        ? `lines ${active.from}${active.to > active.from ? `-${active.to}` : ''} of \`${path}\``
        : report
          ? 'this report'
          : `the file \`${path}\``;
    let body = '';
    let notice: string | undefined;
    // The agent reads the saved file. Text goes along only when it cannot (unsaved edits, a report), and never a secret.
    const text = useSelection && active ? active.text : '';
    if (text && (active?.dirty || active?.readOnly || report)) {
      if (maskSecrets(text) !== text || /(^|\/)\.env(\.|$)/.test(path))
        notice = 'The selection looks like a secret, so only its location was sent.';
      else body = '\n\n```\n' + text.slice(0, 8 * 1024) + '\n```';
    }
    return { reference: `In ${where}`, body, notice };
  }

  /** The ask menu: what to do with the selection, the open file or a file picked in the explorer. */
  openAsk(subject?: { path: string }): void {
    const context = this.context(subject);
    if (!context) {
      this.workbench.say('Open a file to ask about it.', 'info');
      return;
    }
    const busy = this.options.busy();
    const path = subject?.path ?? this.workbench.askContext()?.path ?? '';
    const send = (instruction: string) => () => {
      this.card = undefined;
      if (context.notice) this.workbench.say(context.notice, 'info');
      this.options.ask(`${context.reference}${context.body}\n\n${instruction}`);
    };
    const problems = this.panel.problems.filter((problem) => problem.path === path);
    const items: Card['items'] = [
      { label: 'Explain this', run: send('Explain what this does, briefly.'), disabled: busy },
      {
        label: 'Find bugs',
        run: send('Look for bugs and unsafe assumptions. Do not change anything yet; list what you find.'),
        disabled: busy,
      },
      {
        label: 'Write a test for this',
        run: send('Write a test for this, run it, and keep it only if it passes.'),
        disabled: busy,
      },
      ...(problems.length
        ? [
            {
              label: `Fix the ${problems.length} problem${problems.length === 1 ? '' : 's'} in this file`,
              run: send(
                'Fix these problems:\n' +
                  problems
                    .slice(0, 12)
                    .map(
                      (problem) =>
                        `- ${problem.line ?? '?'}:${problem.column ?? '?'} ${problem.code ?? ''} ${clean(problem.message, 200)}`,
                    )
                    .join('\n'),
              ),
              disabled: busy,
            },
          ]
        : []),
      {
        label: 'Security review (/review)',
        run: () => {
          this.card = undefined;
          this.options.run('/review');
        },
        disabled: busy,
      },
      {
        label: 'Ask something else…',
        run: () => {
          this.card = undefined;
          this.options.draft(`${context.reference}${context.body}\n\n`);
        },
      },
    ];
    this.card = {
      title: `Ask OMS · ${clean(subject ? base(path) : (this.workbench.askContext()?.label ?? base(path)), 60)}`,
      hint: busy ? 'The agent is working; wait for it to finish' : '↑↓ choose · Enter ask · Esc close',
      items,
      selected: Math.max(
        0,
        items.findIndex((item) => !item.disabled),
      ),
    };
    this.options.render();
  }

  /** Ask before reverting a file: the diff base may include the user's own work, so this is never one keystroke. */
  askRevert(change: FileChange): void {
    this.confirm = {
      text: `Revert ${clean(change.path, 80)} to the last commit? This discards its changes.  y yes · any other key no`,
      run: () => {
        void revert(change, this.harness.files).then(
          (result) => {
            if (result.ok) {
              this.workbench.say(`Reverted ${change.path}.`, 'success');
              void this.workbench.refreshFromDisk([change.path]);
            } else this.workbench.say(result.reason, 'warning');
            void this.changes.refresh();
          },
          (error) => this.workbench.say(friendlyError(error, { path: change.path, root: this.harness.root }), 'error'),
        );
      },
    };
    this.options.render();
  }

  private cardView(): Component {
    return {
      invalidate() {},
      render: (width) => {
        const card = this.card;
        if (!card || width < 12) return [];
        const theme = this.options.theme();
        const border = (text: string) => colorText(theme, 'accent', text);
        const inner = width - 4;
        const title = ` ${card.title} `;
        const lines = [
          border('╭') +
            colorText(theme, 'foreground', title) +
            border('─'.repeat(Math.max(0, width - 2 - visibleWidth(title)))) +
            border('╮'),
        ];
        card.items.forEach((item, index) => {
          const text = truncateToWidth(`${index === card.selected ? '›' : ' '} ${item.label}`, inner, '…', true);
          const role: ThemeRole = item.disabled ? 'muted' : 'foreground';
          const line = colorText(theme, role, text);
          lines.push(
            border('│') +
              ' ' +
              (index === card.selected ? colorBg(theme, 'selection', line, inner) : line) +
              ' ' +
              border('│'),
          );
        });
        const foot = ` ${card.hint} `;
        lines.push(
          border('╰') +
            border('─'.repeat(Math.max(0, width - 2 - visibleWidth(foot)))) +
            colorText(theme, 'muted', foot) +
            border('╯'),
        );
        return lines;
      },
      handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
        if (event.button !== 'left') return undefined;
        if (event.type === 'press') return { handled: true, focus: false };
        if (event.type !== 'click') return undefined;
        const item = this.card?.items[event.y - 1];
        if (item && !item.disabled) {
          item.run();
          this.options.render();
        }
        return { handled: true, focus: false };
      },
    };
  }

  // ------------------------------------------------------------------------------------------------ rows

  private askBar(): Component {
    return {
      invalidate() {},
      render: (width) => {
        const theme = this.options.theme();
        const busy = this.options.busy();
        const context = this.workbench.askContext();
        const about = context
          ? ` about ${clean(context.label, 40)}${context.selected ? `:${context.from}${context.to > context.from ? `-${context.to}` : ''}` : ''}`
          : '';
        const stop = this.options.interrupt();
        const left = busy
          ? colorText(theme, 'accent', ' ◐ ') +
            colorText(
              theme,
              'muted',
              `The agent is working${stop === 'esc' ? ' · Esc cancels' : stop === 'ctrl+l' ? ' · Ctrl+L then Esc cancels' : ''}`,
            )
          : colorText(theme, 'accent', ' ❯ ') + colorText(theme, 'muted', `Ask OMS${about}…`);
        const right = colorText(theme, 'muted', busy ? '' : 'Ctrl+L type · Alt+A actions ');
        const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
        return [colorBg(theme, 'surface', truncateToWidth(left + ' '.repeat(gap) + right, width, '', true))];
      },
      handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
        if (event.button !== 'left' || event.type !== 'click')
          return event.type === 'press' ? { handled: true, focus: false } : undefined;
        this.options.focus('input');
        return { handled: true, focus: false };
      },
    };
  }

  private segments(): { left: Segment[]; middle: Segment[]; right: Segment[] } {
    const active = this.workbench.active;
    const left: Segment[] = [];
    const branch =
      this.harness.kind === 'chat'
        ? this.harness.folder.git
          ? branchOf(this.harness.root)
          : undefined
        : clean(this.harness.task.id, 40);
    if (branch) left.push({ text: branch, role: 'muted' });
    if (this.changes.ready && this.changes.count)
      left.push({ text: `${this.changes.count} changed`, role: 'warning', click: () => this.showPanel('changes') });
    const middle: Segment[] = [];
    if (active) {
      if (active.language) middle.push({ text: active.language, role: 'muted' });
      middle.push({
        text: `Ln ${active.line}, Col ${active.column}`,
        role: 'muted',
        click: () => this.openFinder(':'),
      });
      middle.push({ text: active.newline, role: 'muted' });
      middle.push({ text: active.bom ? 'UTF-8 BOM' : 'UTF-8', role: 'muted' });
      if (active.dirty) middle.push({ text: 'unsaved', role: 'warning' });
      if (active.readOnly) middle.push({ text: 'read-only', role: 'muted' });
    }
    const right: Segment[] = [];
    const chip = this.solana.statusChip();
    if (chip) right.push({ text: chip.text, role: chip.role, click: () => this.options.run('/chain') });
    if (this.shell.running)
      right.push({ text: 'terminal running', role: 'muted', click: () => this.showPanel('terminal') });
    return { left, middle, right };
  }

  private statusRow(): Component {
    return {
      invalidate() {},
      render: (width) => {
        const theme = this.options.theme();
        this.statusWidth = width;
        this.statusHits = [];
        const { left, middle, right } = this.segments();
        const separator = colorText(theme, 'border', ' · ');
        // Drop what does not fit, rightmost group first: the chain chip, then the branch, then the file's facts.
        const groups = [left, middle, right].map((group) => [...group]);
        const build = (
          list: Segment[][],
        ): { text: string; hits: Array<{ start: number; end: number; click: () => void }> } => {
          let text = ' ';
          let column = 1;
          const hits: Array<{ start: number; end: number; click: () => void }> = [];
          let first = true;
          for (const segment of list.flat()) {
            if (!first) {
              text += separator;
              column += 3;
            }
            first = false;
            const shown = clean(segment.text);
            if (segment.click) hits.push({ start: column, end: column + visibleWidth(shown), click: segment.click });
            text += colorText(theme, segment.role, shown);
            column += visibleWidth(shown);
          }
          return { text, hits };
        };
        let built = build(groups);
        for (const drop of [2, 0, 1]) {
          if (visibleWidth(built.text) <= width) break;
          groups[drop] = [];
          built = build(groups);
        }
        this.statusHits = built.hits;
        return [colorBg(theme, 'surface', truncateToWidth(built.text, width, '', true))];
      },
      handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
        if (event.button !== 'left' || event.width !== this.statusWidth) return undefined;
        if (event.type === 'press') return { handled: true, focus: false };
        if (event.type !== 'click') return undefined;
        this.statusHits.find((hit) => event.x >= hit.start && event.x < hit.end)?.click();
        return { handled: true, focus: false };
      },
    };
  }

  /** The key hints for what has focus now; a message, when there is one, takes their place. */
  private currentHint(): string {
    if (this.confirm) return this.confirm.text;
    if (this.finder.open) return '↑↓ choose · Enter open · Esc close · /commands  #search  :line';
    if (this.card) return this.card.hint;
    if (this.dashboardOn) return this.dashboard.hint;
    const focused = this.options.focused();
    if (focused === 'input') return 'Enter sends to the agent · Esc back to the editor · Ctrl+K commands';
    if (focused === 'explorer') return this.explorer.hint;
    if (focused === 'panel' || focused === 'terminal') return this.panel.hint;
    return `${this.workbench.hint}${this.explorerShown() ? '' : ' · Ctrl+B files'}`;
  }

  /**
   * What the interface's one status row says while the workbench is on screen: the latest message or a question waiting
   * for y/n (drawn in the color of its kind), else the key hints for what has focus.
   */
  statusLine(): { toast?: { text: string; role: ThemeRole }; hints: readonly Hint[] } {
    const hints = hintList(this.currentHint());
    if (this.confirm) return { toast: { text: this.confirm.text, role: 'warning' }, hints };
    const message = this.workbench.message;
    if (!message) return { hints };
    const role: ThemeRole =
      message.kind === 'error'
        ? 'error'
        : message.kind === 'warning'
          ? 'warning'
          : message.kind === 'success'
            ? 'success'
            : 'foreground';
    return { toast: { text: message.text, role }, hints };
  }

  // ------------------------------------------------------------------------------------------------ keys

  /** Keys while something modal is open. */
  handleCaptured(data: string): void {
    if (this.confirm) {
      const { run } = this.confirm;
      this.confirm = undefined;
      if (data.toLowerCase() === 'y') run();
      this.options.render();
      return;
    }
    if (this.finder.open) {
      this.finder.handleInput(data);
      return;
    }
    const card = this.card;
    if (!card) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'alt+a')) this.card = undefined;
    else if (matchesKey(data, 'up')) card.selected = Math.max(0, card.selected - 1);
    else if (matchesKey(data, 'down')) card.selected = Math.min(card.items.length - 1, card.selected + 1);
    else if (matchesKey(data, 'enter')) {
      const item = card.items[card.selected];
      if (item && !item.disabled) item.run();
    }
    this.options.render();
  }

  /** Keys that mean the same wherever focus is in the workbench. True when consumed. */
  handleGlobalKey(data: string): boolean {
    if (matchesKey(data, 'ctrl+b')) {
      this.toggleExplorer();
      return true;
    }
    if (matchesKey(data, 'alt+j')) {
      this.togglePanel();
      return true;
    }
    if (matchesKey(data, 'ctrl+g')) {
      this.openFinder(':');
      return true;
    }
    if (matchesKey(data, 'ctrl+shift+f')) {
      this.openFinder('#');
      return true;
    }
    if (matchesKey(data, 'alt+a')) {
      this.openAsk();
      return true;
    }
    if (matchesKey(data, 'f7')) {
      if (this.dashboardOn) this.closeDashboard();
      else this.openDashboard();
      return true;
    }
    return false;
  }

  /** Keys for the focused area. False for the few that should fall through to the interface (Tab cycles focus). */
  routeKey(focus: FocusTarget, data: string): boolean {
    if (matchesKey(data, 'tab') && focus !== 'editor' && focus !== 'terminal') return false;
    if (matchesKey(data, 'shift+tab') && focus !== 'editor') return false;
    if (focus === 'explorer') {
      this.explorer.focus.handleInput?.(data);
      return true;
    }
    if (focus === 'panel') {
      this.panel.focus.handleInput?.(data);
      return true;
    }
    if (focus === 'editor') {
      if (this.dashboardOn) {
        if (matchesKey(data, 'escape')) this.closeDashboard();
        else this.dashboard.handleInput(data);
        this.options.render();
        return true;
      }
      this.workbench.handleInput(data);
      return true;
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.finder.hide();
    clearTimeout(this.dashboardTimer);
    this.solana.dispose();
    this.dashboard.dispose();
    this.workbench.dispose();
  }

  /** Where the project's diff base is, for callers that want a branch name. */
  get branch(): string | undefined {
    return diffTarget(this.harness)?.branch;
  }
}

/** 'Ctrl+K commands · Esc back' as hints: the first word of each part is its key, lower-cased unless it is a lone letter. */
export function hintList(text: string): Hint[] {
  return text
    .split(' · ')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): Hint => {
      const space = part.indexOf(' ');
      const key = space < 0 ? part : part.slice(0, space);
      return [key.length > 1 ? key.toLowerCase() : key, space < 0 ? '' : part.slice(space + 1).trim()];
    });
}
