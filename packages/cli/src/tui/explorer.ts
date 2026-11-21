import { posix } from 'node:path';
import {
  ScrollView,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import type { TaskFileAccess, TaskFileEntry } from '@oms/engine';
import { colorBg, colorText, type OmsTheme, type ThemeRole } from './theme.ts';
import { displayText } from './transcript.ts';
import { isPrivatePath } from './search.ts';
import { friendlyError } from './workbench-text.ts';

/** git status of a file: modified, added, deleted, renamed or untracked. */
export type ChangeMarker = 'M' | 'A' | 'D' | 'R' | 'U';
/** One line in a sidebar section a provider fills (connectors, Solana). */
export interface SidebarItem {
  id: string;
  label: string;
  /** Right-aligned text, in `detailRole`'s color. */
  detail?: string;
  detailRole?: ThemeRole;
  /** The label's own color (default: foreground). */
  role?: ThemeRole;
  /** Pressing Enter or clicking runs this; without it the row is information. */
  onActivate?: () => void;
}
export interface SidebarSection {
  /** Lowercase, like the built-in sections: 'connectors', 'solana'. */
  id: string;
  title: string;
  /** A short word at the right of the heading, such as 'preview'. */
  badge?: string;
  items: readonly SidebarItem[];
}

interface ExplorerOptions {
  theme: () => OmsTheme;
  render: () => void;
  files: Pick<TaskFileAccess, 'list'>;
  /** Open a file; `focusEditor` is true for a deliberate open (Enter, click) and false for a preview. */
  open: (path: string, focusEditor: boolean) => void;
  openFiles: () => ReadonlyArray<{ path: string; label: string; dirty: boolean; active: boolean }>;
  marks: () => ReadonlyMap<string, ChangeMarker>;
  /** Files the agent edited this turn. */
  touched: () => ReadonlySet<string>;
  /** Extra sections below 'files' and 'open': connectors, Solana. A section that is absent or has no items is hidden. */
  sections: () => ReadonlyArray<SidebarSection | undefined>;
  newFile: (directory: string) => void;
  ask: (path: string) => void;
  requestFocus: () => void;
  /** Escape: leave the explorer for the editor. */
  leave: () => void;
  signal?: AbortSignal;
}

type Listing = { state: 'loading' } | { state: 'ready'; entries: TaskFileEntry[] } | { state: 'error'; text: string };
type Row =
  | { kind: 'section'; key: string; id: string; title: string; badge?: string; collapsed: boolean }
  | { kind: 'dir'; key: string; path: string; depth: number; expanded: boolean }
  | { kind: 'file'; key: string; path: string; depth: number }
  | { kind: 'note'; key: string; text: string; depth: number; role: ThemeRole }
  | { kind: 'open'; key: string; path: string; label: string; dirty: boolean; active: boolean }
  | { kind: 'item'; key: string; item: SidebarItem };

/** Folders nobody browses for their own sake; they are shown dim and never opened by themselves. */
const DIM_FOLDERS = new Set(['node_modules', 'target', 'dist', 'build', '.next', '.cache', 'coverage']);
const MARK_ROLE: Readonly<Record<ChangeMarker, ThemeRole>> = {
  M: 'warning',
  A: 'success',
  U: 'success',
  D: 'error',
  R: 'info',
};

const baseName = (path: string): string => posix.basename(path);
const clean = (text: string): string => displayText(text, 400).replace(/[\r\n\t]/g, ' ');

/** Folders first, then files, each in natural order (file2 before file10). */
export function sortEntries(entries: readonly TaskFileEntry[]): TaskFileEntry[] {
  return [...entries].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) ||
      baseName(a.path).localeCompare(baseName(b.path), undefined, { numeric: true, sensitivity: 'base' }),
  );
}

/**
 * The left column of the workbench: a lazy file tree with change and agent markers, the open files, and any sections a
 * provider adds. Rows are selected with a filled bar; a click or Enter opens a file or toggles a folder.
 */
export class Explorer {
  readonly body: ScrollView;
  readonly focus: Component & Focusable;
  private readonly options: ExplorerOptions;
  private readonly listings = new Map<string, Listing>();
  private readonly generations = new Map<string, number>();
  private readonly expanded = new Set<string>(['.']);
  private readonly collapsedSections = new Set<string>();
  private selected = 'd:.';
  private focused = false;
  private revealSelection = true;
  private lastRows: Row[] = [];
  /** The root is listed the first time the explorer is drawn, so a session that never shows it does no file IO. */
  private started = false;

  constructor(options: ExplorerOptions) {
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
    const content: Component = {
      invalidate() {},
      render: (width) => this.render(width),
      handleMouse: (event) => this.handleMouse(event),
    };
    this.body = new (class extends ScrollView {
      override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
        super.updateLayout(contentHeight, viewportHeight, requestRender);
        if (!owner.revealSelection || viewportHeight < 1) return;
        owner.revealSelection = false;
        const index = owner.lastRows.findIndex((row) => row.key === owner.selected);
        if (index < 0) return;
        if (index < this.scrollTop) this.scrollTo(index);
        else if (index >= this.scrollTop + viewportHeight) this.scrollTo(index - viewportHeight + 1);
      }
    })(content, { follow: 'none', scrollbar: 'auto', overscroll: 'contain' });
  }

  /** The viewport owns this stable component for mouse focus. */
  owns(component: Component): boolean {
    return component === this.body || component === this.focus;
  }

  // ------------------------------------------------------------------------------------------------ listing

  private generation(directory: string): number {
    const next = (this.generations.get(directory) ?? 0) + 1;
    this.generations.set(directory, next);
    return next;
  }

  /** List a folder (once; `force` lists it again). A listing that finishes after a newer one is dropped. */
  async load(directory: string, force = false): Promise<void> {
    if (this.options.signal?.aborted) return;
    const known = this.listings.get(directory);
    if (known && known.state !== 'error' && !force) return;
    // Keep the old entries on screen while a forced listing runs, so a refresh never blinks.
    if (!known || known.state === 'error') this.listings.set(directory, { state: 'loading' });
    const generation = this.generation(directory);
    this.options.render();
    try {
      const entries = await this.options.files.list(directory, this.options.signal);
      if (generation !== this.generations.get(directory)) return;
      // The file helper already hides private folders; the screen never shows them either way.
      this.listings.set(directory, {
        state: 'ready',
        entries: sortEntries(entries.filter((entry) => !isPrivatePath(entry.path))),
      });
    } catch (error) {
      if (generation !== this.generations.get(directory) || this.options.signal?.aborted) return;
      this.listings.set(directory, {
        state: 'error',
        text: /512-entry/.test(error instanceof Error ? error.message : '')
          ? 'too many entries · Ctrl+P opens by name'
          : friendlyError(error, { path: directory }),
      });
    }
    this.options.render();
  }

  /** List the folders that are open again: after the agent or a command may have added or removed files. */
  async refresh(directories?: readonly string[]): Promise<void> {
    const targets = directories ?? [...this.expanded].filter((directory) => this.listings.has(directory));
    for (const directory of targets.slice(0, 20)) await this.load(directory, true);
  }

  /** Expand the folders above `path`, select it and scroll to it. */
  async reveal(path: string): Promise<void> {
    const parts = posix
      .dirname(path)
      .split('/')
      .filter((part) => part && part !== '.');
    let directory = '.';
    this.expanded.add('.');
    for (const part of parts) {
      directory = directory === '.' ? part : `${directory}/${part}`;
      this.expanded.add(directory);
      await this.load(directory);
    }
    this.selected = `f:${path}`;
    this.revealSelection = true;
    this.options.render();
  }

  // ------------------------------------------------------------------------------------------------ rows

  private rows(): Row[] {
    const rows: Row[] = [];
    rows.push({
      key: 's:files',
      kind: 'section',
      id: 'files',
      title: 'files',
      badge: 'Ctrl+P find',
      collapsed: this.collapsedSections.has('files'),
    });
    if (!this.collapsedSections.has('files')) this.treeRows('.', 0, rows);
    const open = this.options.openFiles();
    if (open.length) {
      rows.push({
        key: 's:open',
        kind: 'section',
        id: 'open',
        title: 'open',
        collapsed: this.collapsedSections.has('open'),
      });
      if (!this.collapsedSections.has('open'))
        for (const file of open) rows.push({ key: `o:${file.path}`, kind: 'open', ...file });
    }
    for (const section of this.options.sections()) {
      if (!section?.items.length) continue;
      rows.push({
        key: `s:${section.id}`,
        kind: 'section',
        id: section.id,
        title: section.title,
        badge: section.badge,
        collapsed: this.collapsedSections.has(section.id),
      });
      if (!this.collapsedSections.has(section.id))
        for (const item of section.items) rows.push({ key: `i:${section.id}:${item.id}`, kind: 'item', item });
    }
    return rows;
  }

  private treeRows(directory: string, depth: number, rows: Row[]): void {
    const listing = this.listings.get(directory);
    if (!listing || listing.state === 'loading') {
      rows.push({ key: `n:${directory}:loading`, kind: 'note', text: '…', depth, role: 'muted' });
      return;
    }
    if (listing.state === 'error') {
      rows.push({ key: `n:${directory}:error`, kind: 'note', text: listing.text, depth, role: 'warning' });
      return;
    }
    if (!listing.entries.length) {
      rows.push({ key: `n:${directory}:empty`, kind: 'note', text: 'empty', depth, role: 'muted' });
      return;
    }
    for (const entry of listing.entries) {
      if (entry.kind === 'file') {
        rows.push({ key: `f:${entry.path}`, kind: 'file', path: entry.path, depth });
        continue;
      }
      const expanded = this.expanded.has(entry.path);
      rows.push({ key: `d:${entry.path}`, kind: 'dir', path: entry.path, depth, expanded });
      if (expanded) this.treeRows(entry.path, depth + 1, rows);
    }
  }

  /** Folders that contain a changed file, for the dot beside their name. */
  private changedFolders(): Set<string> {
    const folders = new Set<string>();
    for (const path of this.options.marks().keys()) {
      for (let at = posix.dirname(path); at !== '.' && at !== '/'; at = posix.dirname(at)) folders.add(at);
    }
    return folders;
  }

  private render(width: number): string[] {
    if (!this.started) {
      this.started = true;
      void this.load('.');
    }
    const theme = this.options.theme();
    const rows = this.rows();
    this.lastRows = rows;
    if (!rows.some((row) => row.key === this.selected)) this.selected = rows[0]?.key ?? 's:files';
    const marks = this.options.marks();
    const touched = this.options.touched();
    const folders = this.changedFolders();
    const open = new Set(
      this.options
        .openFiles()
        .filter((file) => file.active)
        .map((file) => file.path),
    );
    return rows.map((row) => {
      const selected = row.key === this.selected;
      let left = '';
      let right = '';
      let rightRole: ThemeRole = 'muted';
      let leftRole: ThemeRole = 'foreground';
      const indent = (depth: number) => '  '.repeat(depth);
      if (row.kind === 'section') {
        left = `${row.collapsed ? '▸' : '▾'} ${row.title}`;
        leftRole = 'muted';
        right = row.badge ?? '';
      } else if (row.kind === 'dir') {
        left = `${indent(row.depth)}${row.expanded ? '▾' : '▸'} ${clean(baseName(row.path))}`;
        if (DIM_FOLDERS.has(baseName(row.path))) leftRole = 'muted';
        if (folders.has(row.path)) {
          right = '●';
          rightRole = 'muted';
        }
      } else if (row.kind === 'file') {
        left = `${indent(row.depth)}  ${clean(baseName(row.path))}`;
        if (open.has(row.path)) leftRole = 'accent';
        const mark = marks.get(row.path);
        right = `${touched.has(row.path) ? '● ' : ''}${mark ?? ''}`;
        rightRole = touched.has(row.path) && !mark ? 'accent' : mark ? MARK_ROLE[mark] : 'muted';
      } else if (row.kind === 'note') {
        left = `${indent(row.depth)}  ${clean(row.text)}`;
        leftRole = row.role;
      } else if (row.kind === 'open') {
        left = `  ${clean(row.label)}`;
        if (row.active) leftRole = 'accent';
        right = row.dirty ? '●' : '';
        rightRole = 'warning';
      } else {
        left = `  ${clean(row.item.label)}`;
        leftRole = row.item.role ?? (row.item.onActivate ? 'foreground' : 'muted');
        right = row.item.detail ?? '';
        rightRole = row.item.detailRole ?? 'muted';
      }
      const room = Math.max(0, width - (right ? visibleWidth(right) + 2 : 0));
      const clipped = truncateToWidth(left, Math.max(1, room), '…');
      const gap = Math.max(0, width - visibleWidth(clipped) - visibleWidth(right) - (right ? 1 : 0));
      const line =
        colorText(theme, leftRole, clipped) + ' '.repeat(gap) + (right ? colorText(theme, rightRole, right) + ' ' : '');
      // The selected row is a filled bar: bright while the explorer has focus, quiet otherwise.
      return selected ? colorBg(theme, this.focused ? 'selection' : 'surface', line, width) : line;
    });
  }

  // ------------------------------------------------------------------------------------------------ keys and mouse

  private move(delta: number | 'start' | 'end'): void {
    if (!this.lastRows.length) this.lastRows = this.rows();
    const rows = this.lastRows.filter((row) => row.kind !== 'note');
    if (!rows.length) return;
    const at = rows.findIndex((row) => row.key === this.selected);
    const next =
      delta === 'start' ? 0 : delta === 'end' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + delta));
    this.selected = rows[next]!.key;
    this.revealSelection = true;
    this.options.render();
  }

  private current(): Row | undefined {
    if (!this.lastRows.length) this.lastRows = this.rows();
    return this.lastRows.find((row) => row.key === this.selected);
  }

  private toggleDirectory(path: string, expand?: boolean): void {
    const open = expand ?? !this.expanded.has(path);
    if (open) {
      this.expanded.add(path);
      void this.load(path);
    } else this.expanded.delete(path);
    this.options.render();
  }

  /** Enter or a click on the selected row. `deliberate` focuses the editor after opening a file. */
  private activate(row: Row | undefined, deliberate = true): void {
    if (!row) return;
    if (row.kind === 'dir') this.toggleDirectory(row.path);
    else if (row.kind === 'file' || row.kind === 'open') this.options.open(row.path, deliberate);
    else if (row.kind === 'item') row.item.onActivate?.();
    else if (row.kind === 'section') {
      if (this.collapsedSections.has(row.id)) this.collapsedSections.delete(row.id);
      else this.collapsedSections.add(row.id);
      this.options.render();
    }
  }

  /** The folder the selection is in, for new files. */
  private folder(): string {
    const row = this.current();
    if (row?.kind === 'dir') return row.path;
    if (row?.kind === 'file' || row?.kind === 'open') return posix.dirname(row.path);
    return '.';
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    const page = Math.max(1, this.body.viewportHeight - 1);
    const row = this.current();
    if (matchesKey(data, 'up')) this.move(-1);
    else if (matchesKey(data, 'down')) this.move(1);
    else if (matchesKey(data, 'pageUp')) this.move(-page);
    else if (matchesKey(data, 'pageDown')) this.move(page);
    else if (matchesKey(data, 'home')) this.move('start');
    else if (matchesKey(data, 'end')) this.move('end');
    else if (matchesKey(data, 'enter')) this.activate(row);
    else if (matchesKey(data, 'right')) {
      if (row?.kind === 'dir' && !row.expanded) this.toggleDirectory(row.path, true);
      else if (row?.kind === 'dir') this.move(1);
      else if (row?.kind === 'file') this.activate(row);
    } else if (matchesKey(data, 'left')) {
      if (row?.kind === 'dir' && row.expanded) this.toggleDirectory(row.path, false);
      else if (row?.kind === 'file' || row?.kind === 'dir') {
        // To the folder it is in.
        const parent = posix.dirname(row.path);
        if (parent !== '.') {
          this.selected = `d:${parent}`;
          this.revealSelection = true;
          this.options.render();
        }
      }
    } else if (data === ' ') {
      if (row?.kind === 'file' || row?.kind === 'open') this.options.open(row.path, false);
      else this.activate(row);
    } else if (data === 'n') this.options.newFile(this.folder());
    else if (data === 'r') void this.refresh();
    else if (data === 'a' && (row?.kind === 'file' || row?.kind === 'open')) this.options.ask(row.path);
    else if (matchesKey(data, 'escape')) this.options.leave();
  }

  private handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== 'left') return undefined;
    if (event.type === 'press') return { handled: true, focus: true };
    if (event.type !== 'click') return undefined;
    const row = this.lastRows[event.y];
    this.options.requestFocus();
    if (!row || row.kind === 'note') return { handled: true, focus: true };
    this.selected = row.key;
    this.activate(row);
    this.options.render();
    return { handled: true, focus: true };
  }

  /** What the key footer says while the explorer has focus. */
  get hint(): string {
    const row = this.current();
    if (row?.kind === 'dir') return '↑↓ move · → open folder · n new file · r refresh · Ctrl+B hide · Esc editor';
    return '↑↓ move · Enter open · Space preview · n new file · a ask the agent · Ctrl+B hide · Esc editor';
  }
}
