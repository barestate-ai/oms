import { posix } from 'node:path';
import {
  HStack,
  VStack,
  ScrollView,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui';
import type { TaskFileAccess, TaskFileEntry } from '@oms/engine';
import { createFileEditorPane, type FileEditorPane } from './file-editor.ts';
import { colorText, type OmsTheme } from './theme.ts';
import { displayText } from './transcript.ts';
import { ActionBar, PaneFrame, type ActionItem } from './chrome.ts';

interface OpenBuffer {
  readOnly?: boolean;
  path: string;
  revision: string | undefined;
  editors: [FileEditorPane, FileEditorPane];
  saving?: Promise<void>;
}
interface WorkbenchOptions {
  theme: () => OmsTheme;
  render: () => void;
  notice: (message: string) => void;
  focusChanged: () => void;
  requestFocus?: () => void;
  rows?: () => number;
}
type Mode = 'editor' | 'browser' | 'new' | 'find' | 'replace-find' | 'replace-with' | 'close';

function label(value: string, limit = 1000): string {
  return displayText(value, limit).replace(/[\r\n]/g, ' ');
}

function bufferDirty(buffer: OpenBuffer): boolean {
  return !buffer.readOnly && (buffer.revision === undefined || buffer.editors[0].document.dirty);
}

/** File presentation only: all IO uses the existing session's guarded task files. */
export class WorkbenchPane {
  readonly body = new VStack();
  readonly focus: Component & Focusable;
  private readonly buffers = new Map<string, OpenBuffer>();
  private readonly slots: [OpenBuffer | undefined, OpenBuffer | undefined] = [undefined, undefined];
  private side: 0 | 1 = 0;
  private divided = false;
  private focused = false;
  private disposed = false;
  private mode: Mode = 'editor';
  private closing: OpenBuffer | undefined;
  private pendingReport: OpenBuffer | undefined;
  private readonly lifetime = new AbortController();
  private openGeneration = 0;
  private directory = '.';
  private entries: TaskFileEntry[] = [];
  private selected = 0;
  private revealSelection = false;
  private loading = false;
  private message = '';
  private search = '';
  private replacement = '';
  private prompt = createFileEditorPane('', () => this.options.render(), {
    requestFocus: () => {
      this.options.requestFocus?.();
    },
  });
  private readonly browser: ScrollView;
  private readonly browserContent: Component;
  private readonly actions: ActionBar;
  private readonly tabs: ActionBar;
  private readonly frames = new Set<Component>();
  private readonly harness: { files: TaskFileAccess };
  private readonly options: WorkbenchOptions;

  constructor(harness: { files: TaskFileAccess }, options: WorkbenchOptions) {
    this.harness = harness;
    this.options = options;
    const owner = this;
    this.focus = {
      get focused() {
        return owner.focused;
      },
      set focused(value) {
        owner.focused = value;
        owner.syncFocus();
      },
      handleInput(data) {
        owner.handleInput(data);
      },
      render() {
        return [];
      },
      invalidate() {
        owner.body.invalidate();
      },
    };
    this.browserContent = {
      invalidate() {},
      render: (width) => this.browserRows(width),
      handleMouse: (event) => {
        if (
          this.mode !== 'browser' ||
          this.loading ||
          event.button !== 'left' ||
          !['press', 'click'].includes(event.type)
        )
          return undefined;
        if (event.y < 0 || event.y >= this.entries.length) return undefined;
        this.selected = event.y;
        this.options.requestFocus?.();
        if (event.type === 'click' && event.clickCount === 2) this.browserInput('\r');
        this.options.render();
        return { handled: true, focus: true };
      },
    };
    this.browser = new (class extends ScrollView {
      override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
        super.updateLayout(contentHeight, viewportHeight, requestRender);
        if (!owner.revealSelection || viewportHeight < 1) return;
        owner.revealSelection = false;
        if (owner.selected < this.scrollTop) this.scrollTo(owner.selected);
        else if (owner.selected >= this.scrollTop + viewportHeight) this.scrollTo(owner.selected - viewportHeight + 1);
      }
    })(this.browserContent, { follow: 'none', scrollbar: 'auto', overscroll: 'contain' });
    this.actions = new ActionBar(() => this.actionItems(), { theme: options.theme, render: options.render });
    this.tabs = new ActionBar(
      () =>
        [...this.buffers.values()].map((buffer) => ({
          id: buffer.path,
          label:
            label(posix.basename(buffer.path), 200) +
            (bufferDirty(buffer) ? '*' : '') +
            (buffer.saving ? ' [saving]' : ''),
          icon: this.slots[this.side] === buffer ? '>' : undefined,
          active: this.slots[this.side] === buffer,
          disabled: this.modal,
          onPress: () => {
            if (this.modal) return;
            ++this.openGeneration;
            this.activate(buffer);
            this.options.requestFocus?.();
          },
        })),
      { theme: options.theme, render: options.render },
    );
    this.rebuild(false);
  }

  get dirty(): boolean {
    return [...this.buffers.values()].some(bufferDirty);
  }
  /** Showing the editors with no prompt, file list or confirmation open: Esc has nothing here to close. */
  get atRest(): boolean {
    return this.mode === 'editor';
  }
  get acceptsText(): boolean {
    return this.mode !== 'browser' && (this.mode !== 'editor' || !!this.slots[this.side]);
  }
  get hint(): string {
    if (this.mode === 'browser') return '↑↓ select · Enter open · Backspace parent · Ctrl+N new file · Esc editor';
    if (this.mode === 'new') return 'Enter opens a new unsaved buffer · Ctrl+S saves after editing · Esc cancels';
    if (this.mode === 'close') return 'Type discard then Enter to close without saving · Esc keeps draft';
    if (this.mode === 'find') return 'Enter next match · Ctrl+A edit query · Esc editor';
    if (this.mode === 'replace-find') return 'Enter choose replacement · Esc editor';
    if (this.mode === 'replace-with') return 'Enter replace match and find next · Ctrl+A edit replacement · Esc editor';
    if (this.slots[this.side]?.readOnly) return 'Read-only report · Ctrl+F find · Ctrl+W close';
    return 'Ctrl+P files · Ctrl+S save · Ctrl+F find' + (this.divided ? ' · Ctrl+\\ other split' : '');
  }

  private get modal(): boolean {
    return this.mode !== 'editor' && this.mode !== 'browser';
  }

  /** Keep renderer focus on the stable owner instead of a transient nested editor. */
  resolveMouseFocus(component: Component): Component | undefined {
    if (
      component === this.actions ||
      component === this.tabs ||
      component === this.browser ||
      component === this.browserContent ||
      component === this.prompt.focus ||
      component === this.prompt.view ||
      this.frames.has(component)
    )
      return this.focus;
    for (const side of [0, 1] as const) {
      const editor = this.slots[side]?.editors[side];
      if (editor && (component === editor.focus || component === editor.view)) {
        if (!this.modal) this.selectPointerSide(side);
        return this.focus;
      }
    }
    return undefined;
  }

  private selectPointerSide(side: 0 | 1): boolean {
    if (this.modal || this.disposed) return false;
    if (side !== this.side || this.loading) {
      ++this.openGeneration;
      this.loading = false;
      this.message = '';
    }
    this.side = side;
    this.syncFocus();
    return true;
  }

  private pointerEditor(side: 0 | 1): boolean {
    if (!this.selectPointerSide(side)) return false;
    this.options.requestFocus?.();
    this.options.render();
    return true;
  }

  private actionItems(): ActionItem[] {
    const buffer = this.slots[this.side];
    const disabled = this.modal || this.disposed;
    const items: ActionItem[] = [
      {
        id: 'files',
        label: 'Files',
        active: this.mode === 'browser',
        disabled,
        onPress: () => {
          void this.open();
          this.options.requestFocus?.();
        },
      },
      {
        id: 'new',
        label: 'New',
        icon: '+',
        disabled,
        onPress: () => {
          this.newFile();
          this.options.requestFocus?.();
        },
      },
      {
        id: 'save',
        label: 'Save',
        disabled: disabled || !buffer || !!buffer.saving || !bufferDirty(buffer),
        onPress: () => {
          void this.save();
          this.options.requestFocus?.();
        },
      },
      {
        id: 'find',
        label: 'Find',
        disabled: disabled || !buffer,
        onPress: () => {
          this.find();
          this.options.requestFocus?.();
        },
      },
      {
        id: 'split',
        label: 'Split',
        active: this.divided,
        disabled: disabled || !buffer,
        onPress: () => {
          this.split();
          this.options.requestFocus?.();
        },
      },
      {
        id: 'close',
        label: 'Close',
        disabled: disabled || !buffer || !!buffer.saving,
        onPress: () => {
          this.closeBuffer();
          this.options.requestFocus?.();
        },
      },
    ];
    return (this.options.rows?.() ?? 24) <= 12 ? items.slice(0, 4) : items;
  }

  async open(path?: string): Promise<void> {
    if (this.disposed || this.modal) return;
    if (path === undefined) {
      await this.browse(this.directory);
      return;
    }
    const generation = ++this.openGeneration;
    try {
      const absolute = posix.resolve('/work', path);
      if (!absolute.startsWith('/work/')) throw new Error('Choose a file inside the project');
      const key = absolute.slice('/work/'.length);
      const existing = this.buffers.get(key);
      if (existing) {
        this.activate(existing);
        return;
      }
      this.loading = true;
      this.tell(`Opening ${key}…`);
      const snapshot = await this.harness.files.read(key, this.lifetime.signal);
      if (this.disposed || generation !== this.openGeneration) return;
      const first = createFileEditorPane(snapshot.bytes.toString('utf8'), () => this.options.render(), {
        lineNumbers: true,
        requestFocus: () => this.pointerEditor(0),
      });
      const second = createFileEditorPane(first.document, () => this.options.render(), {
        lineNumbers: true,
        requestFocus: () => this.pointerEditor(1),
      });
      const buffer: OpenBuffer = { path: key, revision: snapshot.revision, editors: [first, second] };
      this.buffers.set(key, buffer);
      this.activate(buffer);
    } catch (error) {
      if (!this.disposed && generation === this.openGeneration) this.tell(`Open failed: ${this.errorText(error)}`);
    } finally {
      if (!this.disposed && generation === this.openGeneration) {
        this.loading = false;
        this.options.render();
      }
    }
  }

  /** In-memory report; never mapped to task file IO. */
  openReport(id: string, text: string, folder = 'review'): void {
    if (this.disposed) return;
    const key = `\0${folder}/${id}/report.md`;
    ++this.openGeneration;
    const existing = this.buffers.get(key);
    if (existing) {
      if (this.modal) this.pendingReport = existing;
      else this.activate(existing);
      return;
    }
    const first = createFileEditorPane(text, () => this.options.render(), {
      readOnly: true,
      requestFocus: () => this.pointerEditor(0),
    });
    const second = createFileEditorPane(first.document, () => this.options.render(), {
      readOnly: true,
      requestFocus: () => this.pointerEditor(1),
    });
    const buffer: OpenBuffer = { path: key, revision: undefined, readOnly: true, editors: [first, second] };
    this.buffers.set(key, buffer);
    if (this.modal) {
      this.pendingReport = buffer;
      this.tell('Review saved; close this prompt to view the read-only report.');
    } else this.activate(buffer);
  }

  newFile(path?: string): void {
    if (this.disposed || (this.modal && this.mode !== 'new')) return;
    ++this.openGeneration;
    this.loading = false;
    if (path === undefined) {
      this.mode = 'new';
      const prefix = this.directory === '.' ? '' : this.directory + '/';
      this.setPrompt(prefix);
      this.prompt.document.select(prefix.length, prefix.length);
      this.message = '';
      this.rebuild();
      return;
    }
    try {
      const absolute = posix.resolve('/work', path);
      if (
        !path ||
        /[\r\n\0]/.test(path) ||
        path.endsWith('/') ||
        !absolute.startsWith('/work/') ||
        absolute.split('/').some((part) => ['.git', '.oms', '.keys', '.env.agent'].includes(part))
      ) {
        throw new Error('Choose a single-line file path inside the project, outside private directories');
      }
      const key = absolute.slice('/work/'.length);
      if (this.buffers.has(key)) throw new Error(`${key} is already open; use its tab instead`);
      const first = createFileEditorPane('', () => this.options.render(), {
        lineNumbers: true,
        requestFocus: () => this.pointerEditor(0),
      });
      const second = createFileEditorPane(first.document, () => this.options.render(), {
        lineNumbers: true,
        requestFocus: () => this.pointerEditor(1),
      });
      const buffer: OpenBuffer = { path: key, revision: undefined, editors: [first, second] };
      this.buffers.set(key, buffer);
      this.activate(buffer);
      this.tell(`New unsaved file: ${key}. Ctrl+S creates it; existing files are never overwritten.`);
    } catch (error) {
      this.tell(`New file refused: ${this.errorText(error)}`);
    }
  }

  async save(): Promise<void> {
    const buffer = this.slots[this.side];
    if (!buffer || this.disposed || this.modal) return;
    if (buffer.readOnly) {
      this.tell('Report is read-only.');
      return;
    }
    if (buffer.saving) {
      await buffer.saving;
      return;
    }
    const document = buffer.editors[0].document;
    const snapshot = document.text;
    this.tell(`Saving ${buffer.path}…`);
    buffer.saving = (async () => {
      try {
        const bytes = Buffer.from(snapshot, 'utf8');
        const revision =
          buffer.revision === undefined
            ? await this.harness.files.create(buffer.path, bytes, this.lifetime.signal)
            : await this.harness.files.write(buffer.path, bytes, buffer.revision, this.lifetime.signal);
        buffer.revision = revision;
        document.markSaved(snapshot);
        if (!this.disposed) this.tell(`Saved ${buffer.path}${document.dirty ? '; newer edits remain unsaved' : ''}`);
      } catch (error) {
        if (!this.disposed) this.tell(`Save failed: ${this.errorText(error)}`);
      } finally {
        buffer.saving = undefined;
        if (!this.disposed) this.options.render();
      }
    })();
    await buffer.saving;
  }

  closeBuffer(): void {
    const buffer = this.slots[this.side];
    if (!buffer || this.disposed || this.modal) return;
    if (buffer.saving) {
      this.tell('Save in progress; wait before closing this buffer.');
      return;
    }
    if (bufferDirty(buffer)) {
      ++this.openGeneration;
      this.loading = false;
      this.mode = 'close';
      this.closing = buffer;
      this.setPrompt('');
      this.tell(`Unsaved changes in ${buffer.path}. Type discard to close, or Esc to keep editing.`);
      this.rebuild();
      return;
    }
    this.removeBuffer(buffer);
  }

  find(): void {
    this.beginSearch('find');
  }
  replace(): void {
    if (this.slots[this.side]?.readOnly) {
      this.tell('Report is read-only.');
      return;
    }
    this.beginSearch('replace-find');
  }

  nextBuffer(): void {
    if (this.disposed || this.modal) return;
    const buffers = [...this.buffers.values()];
    if (!buffers.length) return;
    const index = buffers.indexOf(this.slots[this.side]!);
    ++this.openGeneration;
    this.activate(buffers[(index + 1) % buffers.length]!);
  }

  split(): void {
    if (this.disposed || this.modal) return;
    if (!this.slots[this.side]) {
      this.tell('Open a file before splitting the editor.');
      return;
    }
    ++this.openGeneration;
    this.loading = false;
    if (this.divided) {
      this.slots[0] = this.slots[this.side];
      this.slots[1] = undefined;
      this.side = 0;
    } else {
      this.slots[1] = this.slots[0];
    }
    this.divided = !this.divided;
    this.mode = 'editor';
    this.rebuild();
  }

  handleInput(data: string): void {
    if (this.disposed || isKeyRelease(data)) return;
    if (matchesKey(data, 'escape')) {
      ++this.openGeneration;
      this.loading = false;
      this.mode = 'editor';
      this.closing = undefined;
      this.message = '';
      this.rebuild();
      return;
    }
    // Confirmation is modal: tab/file switching cannot redirect a pending discard.
    if (this.mode === 'close') {
      if (matchesKey(data, 'enter')) {
        const buffer = this.closing;
        if (this.prompt.document.text === 'discard' && buffer && !buffer.saving) this.removeBuffer(buffer);
        else this.tell('Type discard exactly, or press Esc to keep the draft.');
      } else this.prompt.focus.handleInput?.(data);
      return;
    }
    if (this.mode === 'new') {
      if (matchesKey(data, 'enter')) this.newFile(this.prompt.document.text);
      else if (matchesKey(data, 'shift+enter') || /[\r\n]/.test(data))
        this.tell('New file paths must fit on one line.');
      else this.prompt.focus.handleInput?.(data);
      return;
    }
    if (this.modal) {
      this.searchInput(data);
      return;
    }
    if (matchesKey(data, 'ctrl+n')) {
      this.newFile();
      return;
    }
    if (matchesKey(data, 'ctrl+p')) {
      void this.open();
      return;
    }
    if (matchesKey(data, 'ctrl+s')) {
      void this.save();
      return;
    }
    if (matchesKey(data, 'ctrl+w')) {
      this.closeBuffer();
      return;
    }
    if (matchesKey(data, 'ctrl+tab')) {
      this.nextBuffer();
      return;
    }
    if (matchesKey(data, 'ctrl+f')) {
      this.find();
      return;
    }
    if (matchesKey(data, 'ctrl+h')) {
      this.replace();
      return;
    }
    if (this.divided && matchesKey(data, 'ctrl+\\')) {
      ++this.openGeneration;
      this.loading = false;
      this.message = '';
      this.side = this.side === 0 ? 1 : 0;
      this.mode = 'editor';
      this.rebuild();
      return;
    }
    if (this.mode === 'browser') {
      this.browserInput(data);
      return;
    }
    if (this.mode !== 'editor') {
      this.searchInput(data);
      return;
    }
    this.slots[this.side]?.editors[this.side].focus.handleInput?.(data);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.openGeneration;
    this.lifetime.abort();
    this.focused = false;
    this.syncFocus();
  }

  private activate(buffer: OpenBuffer): void {
    this.slots[this.side] = buffer;
    this.mode = 'editor';
    this.loading = false;
    this.message = '';
    this.rebuild();
  }

  private removeBuffer(buffer: OpenBuffer): void {
    ++this.openGeneration;
    this.buffers.delete(buffer.path);
    const remaining = [...this.buffers.values()].at(-1);
    for (const side of [0, 1] as const) if (this.slots[side] === buffer) this.slots[side] = remaining;
    if (!remaining) {
      this.divided = false;
      this.side = 0;
    }
    this.mode = 'editor';
    this.closing = undefined;
    this.message = '';
    this.rebuild();
  }

  private async browse(path: string): Promise<void> {
    const generation = ++this.openGeneration;
    this.mode = 'browser';
    this.loading = true;
    this.entries = [];
    this.selected = 0;
    this.directory = path;
    this.message = '';
    this.browser.scrollToStart();
    this.rebuild();
    try {
      const entries = await this.harness.files.list(path, this.lifetime.signal);
      if (this.disposed || generation !== this.openGeneration) return;
      this.entries = path === '.' ? entries : [{ path: posix.dirname(path), kind: 'directory' }, ...entries];
    } catch (error) {
      if (!this.disposed && generation === this.openGeneration)
        this.tell(`Files unavailable: ${this.errorText(error)}. Use /open <path>.`);
    } finally {
      if (!this.disposed && generation === this.openGeneration) {
        this.loading = false;
        this.options.render();
      }
    }
  }

  private browserInput(data: string): void {
    if (matchesKey(data, 'backspace') || matchesKey(data, 'left')) {
      if (this.directory !== '.') void this.browse(posix.dirname(this.directory));
      return;
    }
    if (this.loading) return;
    if (matchesKey(data, 'enter') || matchesKey(data, 'right')) {
      const entry = this.entries[this.selected];
      if (entry?.kind === 'directory') void this.browse(entry.path);
      else if (entry) void this.open(entry.path);
      return;
    }
    const page = Math.max(1, this.browser.viewportHeight - 1);
    if (matchesKey(data, 'up')) this.selected--;
    else if (matchesKey(data, 'down')) this.selected++;
    else if (matchesKey(data, 'pageUp')) this.selected -= page;
    else if (matchesKey(data, 'pageDown')) this.selected += page;
    else if (matchesKey(data, 'home')) this.selected = 0;
    else if (matchesKey(data, 'end')) this.selected = this.entries.length - 1;
    else return;
    this.selected = Math.max(0, Math.min(this.entries.length - 1, this.selected));
    this.revealSelection = true;
    this.options.render();
  }

  private browserRows(width: number): string[] {
    if (this.loading) return [truncateToWidth('Loading files…', width, '')];
    if (!this.entries.length) return [truncateToWidth(this.message || 'Empty directory · Ctrl+N new file', width, '')];
    return this.entries.map((entry, index) => {
      const parent = this.directory !== '.' && index === 0;
      const labelText = label(
        `${index === this.selected ? '> ' : '  '}${entry.kind === 'directory' ? '+ ' : '· '}${parent ? '../' : posix.basename(entry.path) + (entry.kind === 'directory' ? '/' : '')}`,
      );
      return colorText(
        this.options.theme(),
        index === this.selected ? 'accent' : 'foreground',
        truncateToWidth(labelText, width, ''),
      );
    });
  }

  private beginSearch(mode: 'find' | 'replace-find'): void {
    if (this.modal) return;
    if (this.disposed || !this.slots[this.side]) {
      this.tell('Open a file to search.');
      return;
    }
    ++this.openGeneration;
    this.mode = mode;
    this.setPrompt(this.search);
    this.rebuild();
  }

  private setPrompt(text: string): void {
    this.prompt.focus.focused = false;
    this.prompt = createFileEditorPane(text, () => this.options.render(), {
      requestFocus: () => {
        this.options.requestFocus?.();
      },
    });
    this.prompt.document.select(0, text.length);
    this.syncFocus();
  }

  private searchInput(data: string): void {
    if (!matchesKey(data, 'enter')) {
      this.prompt.focus.handleInput?.(data);
      return;
    }
    const document = this.slots[this.side]?.editors[0].document;
    if (!document) return;
    if (this.mode === 'replace-with') {
      this.replacement = this.prompt.document.text;
      try {
        if (document.selectedText !== this.search && !this.findMatch(false)) return;
        document.insert(this.replacement);
        this.findMatch(true);
      } catch (error) {
        this.tell(`Replace failed: ${this.errorText(error)}`);
      }
    } else {
      const query = this.prompt.document.text;
      const repeat = query === this.search && document.selectedText === query;
      this.search = query;
      this.findMatch(repeat);
      if (this.mode === 'replace-find' && this.search) {
        this.mode = 'replace-with';
        this.setPrompt(this.replacement);
        this.rebuild();
      }
    }
    this.options.render();
  }

  private findMatch(advance: boolean): boolean {
    const document = this.slots[this.side]!.editors[0].document;
    if (!this.search) {
      this.tell('Enter a nonempty search query.');
      return false;
    }
    const start = advance ? Math.max(document.anchor, document.cursor) : Math.min(document.anchor, document.cursor);
    const matches: number[] = [];
    let index = document.text.indexOf(this.search);
    while (index !== -1) {
      matches.push(index);
      index = document.text.indexOf(this.search, index + 1);
    }
    const pivot = matches.findIndex((match) => match >= start);
    const ordered = pivot < 0 ? matches : [...matches.slice(pivot), ...matches.slice(0, pivot)];
    for (const match of ordered) {
      // Queries may contain part of a composed grapheme; never select half of one.
      try {
        document.select(match, match + this.search.length);
      } catch (error) {
        if (error instanceof RangeError) continue;
        throw error;
      }
      this.tell(`Match ${matches.indexOf(match) + 1} of ${matches.length}`);
      return true;
    }
    this.tell('No whole-character matches.');
    return false;
  }

  private syncFocus(): void {
    for (const buffer of this.buffers.values()) {
      for (const side of [0, 1] as const)
        buffer.editors[side].focus.focused =
          this.focused && this.mode === 'editor' && this.side === side && this.slots[side] === buffer;
    }
    this.prompt.focus.focused = this.focused && !['editor', 'browser'].includes(this.mode);
  }

  private rebuild(notify = true): void {
    if (!this.modal && this.pendingReport) {
      this.slots[this.side] = this.pendingReport;
      this.pendingReport = undefined;
      this.mode = 'editor';
    }
    this.syncFocus();
    this.body.clear();
    this.frames.clear();
    const rows = this.options.rows ?? (() => 24);
    const compact = () => rows() <= 12;
    this.body.addChild(this.actions, { basis: 1, shrink: 0 });
    this.body.addChild(this.tabs, { basis: 1, shrink: 0, visible: () => this.buffers.size > 0 });
    if (this.mode === 'browser') {
      const frame = new PaneFrame(this.browser, {
        theme: this.options.theme,
        title: () => `Files /${this.directory === '.' ? '' : label(this.directory)}`,
        focused: () => this.focused,
        rows,
        compact,
        onFocus: () => this.options.requestFocus?.(),
      });
      this.frames.add(frame);
      this.body.addChild(frame, { basis: 0, grow: 1, minSize: 1 });
    } else if (this.slots[this.side]) {
      const columns = new HStack([], { gap: 1 });
      for (const side of [0, 1] as const) {
        const buffer = this.slots[side];
        if (!buffer || (side === 1 && !this.divided)) continue;
        const editor = buffer.editors[side];
        const content = new VStack([
          { component: editor.view, basis: 0, grow: 1, minSize: 1 },
          {
            component: {
              invalidate() {},
              render: (width) => [
                colorText(
                  this.options.theme(),
                  'muted',
                  truncateToWidth(
                    `Ln ${editor.position.line}  Col ${editor.position.column}  UTF-8${editor.document.text.startsWith('\ufeff') ? ' BOM' : ''}  ${editor.document.newline === '\r\n' ? 'CRLF' : editor.document.newline === '\r' ? 'CR' : 'LF'}`,
                    width,
                    '',
                  ),
                ),
              ],
            },
            basis: 1,
            shrink: 0,
            visible: () => !compact(),
          },
        ]);
        const frame = new PaneFrame(content, {
          theme: this.options.theme,
          title: () => (this.divided ? `${side === this.side ? '> ' : ''}${label(buffer.path)}` : 'Editor'),
          focused: () => this.focused && !this.modal && side === this.side,
          rows,
          compact,
          onFocus: () => {
            this.pointerEditor(side);
          },
        });
        this.frames.add(frame);
        columns.addChild(frame, {
          basis: 0,
          grow: 1,
          minSize: 1,
          visible: (viewport) => !this.divided || viewport.width >= 40 || side === this.side,
        });
      }
      this.body.addChild(columns, { basis: 0, grow: 1, minSize: 1 });
    } else {
      const content: Component = {
        invalidate() {},
        render: (width) =>
          [
            'No file open',
            'Ctrl+P  Browse files',
            'Ctrl+N  Create a file',
            '/ or Ctrl+K  Commands and help',
            'Ctrl+L  Return to your agent draft',
          ].map((line) => truncateToWidth(line, width, '')),
      };
      const frame = new PaneFrame(content, {
        theme: this.options.theme,
        title: () => 'Editor',
        focused: () => this.focused && !this.modal,
        rows,
        compact,
        onFocus: () => {
          if (!this.modal) this.options.requestFocus?.();
        },
      });
      this.frames.add(frame);
      this.body.addChild(frame, { basis: 0, grow: 1, minSize: 1 });
    }
    if (this.modal) {
      this.body.addChild(
        {
          invalidate() {},
          render: (width) => [
            truncateToWidth(
              this.mode === 'new'
                ? 'New file path (relative to the project):'
                : this.mode === 'close'
                  ? 'Confirm discard'
                  : this.mode === 'replace-with'
                    ? `Replace ${label(this.search, 200)} with:`
                    : this.mode === 'find'
                      ? 'Find (literal, case-sensitive):'
                      : 'Find text to replace:',
              width,
              '',
            ),
          ],
        },
        { basis: 1, shrink: 0 },
      );
      this.body.addChild(this.prompt.view, { basis: 1, shrink: 0 });
    }
    this.body.addChild(
      {
        invalidate() {},
        render: (width) => [
          colorText(
            this.options.theme(),
            this.message ? 'warning' : 'muted',
            truncateToWidth(label(this.message || this.hint), width, ''),
          ),
        ],
      },
      { basis: 1, shrink: 0, visible: () => !compact() || !!this.message },
    );
    if (notify) {
      this.options.focusChanged();
      this.options.render();
    }
  }

  private tell(message: string): void {
    if (this.disposed) return;
    this.message = label(message);
    this.options.notice(this.message);
    this.options.render();
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
