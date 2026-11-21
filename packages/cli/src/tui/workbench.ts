import { posix } from 'node:path';
import {
  HStack,
  VStack,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import type { TaskFileAccess } from '@oms/engine';
import { createFileEditorPane, type ChangeMark, type EditorClipboard, type FileEditorPane } from './file-editor.ts';
import { colorBg, colorText, type OmsTheme } from './theme.ts';
import { displayText } from './transcript.ts';
import type { FileDocument } from './document.ts';
import { languageOf, LANGUAGE_NAMES, type Language } from './syntax.ts';
import { TabStrip, type TabItem } from './tabs.ts';
import { verticalRule } from './rules.ts';
import { friendlyError, parsePathLine, tabLabels, type Message, type MessageKind } from './workbench-text.ts';

interface OpenBuffer {
  readOnly?: boolean;
  path: string;
  /** What the tab shows for an in-memory report. */
  title?: string;
  language?: Language;
  revision: string | undefined;
  editors: [FileEditorPane, FileEditorPane];
  saving?: Promise<void>;
  /** The file on disk is different from what this buffer was read from, and the buffer has edits of its own. */
  conflict?: { revision: string | undefined; text: string | undefined };
  /** The first Ctrl+S on a conflict only warns; this is set so the second one overwrites. */
  overwriteArmed?: boolean;
}
/** A line the welcome view offers when no file is open. */
export interface WelcomeAction {
  label: string;
  keys: string;
  run: () => void;
}
export interface WorkbenchOptions {
  theme: () => OmsTheme;
  render: () => void;
  notice: (message: string, kind?: MessageKind) => void;
  focusChanged: () => void;
  requestFocus?: () => void;
  rows?: () => number;
  /** The project's absolute host root, removed from any message so a path from the user's machine never shows. */
  root?: string;
  clipboard?: EditorClipboard;
  /** Gutter marks for a file's changed lines, by 0-based row. */
  marks?: (path: string) => ReadonlyMap<number, ChangeMark> | undefined;
  /** A file became the active one in its tab (not for reports). */
  opened?: (path: string) => void;
  /** A file was written: the change list and file index are stale. */
  saved?: (path: string) => void;
  /** Names that match a path the user typed (`/open lib.rs`), best first. */
  suggest?: (name: string) => Promise<readonly string[]>;
  /** Several files match: let the user pick one. */
  pick?: (query: string, matches: readonly string[]) => void;
  /** The lines the empty editor offers. */
  welcome?: () => readonly WelcomeAction[];
}
type Mode = 'editor' | 'new' | 'find' | 'replace-find' | 'replace-with' | 'close';

function label(value: string, limit = 1000): string {
  return displayText(value, limit).replace(/[\r\n]/g, ' ');
}

function bufferDirty(buffer: OpenBuffer): boolean {
  return !buffer.readOnly && (buffer.revision === undefined || buffer.editors[0].document.dirty);
}

const PRIVATE_NAMES = ['.git', '.oms', '.keys', '.env.agent'];
const MESSAGE_SECONDS = 4;

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
  private loading = false;
  private current: Message | undefined;
  private messageTimer: NodeJS.Timeout | undefined;
  private search = '';
  private replacement = '';
  private caseSensitive = false;
  private prompt = createFileEditorPane('', () => this.options.render(), {
    requestFocus: () => {
      this.options.requestFocus?.();
    },
  });
  private readonly tabs: TabStrip;
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
    this.tabs = new TabStrip(() => this.tabItems(), { theme: options.theme, render: options.render });
    this.rebuild(false);
  }

  get dirty(): boolean {
    return [...this.buffers.values()].some(bufferDirty);
  }
  /** Names of the files with unsaved changes, for the quit warning. */
  get dirtyNames(): string[] {
    const labels = tabLabels([...this.buffers.keys()]);
    return [...this.buffers.values()].filter(bufferDirty).map((buffer) => buffer.title ?? labels.get(buffer.path)!);
  }
  /** Showing the editors with no prompt or confirmation open: Esc has nothing here to close. */
  get atRest(): boolean {
    return this.mode === 'editor';
  }
  get acceptsText(): boolean {
    return this.mode !== 'editor' || !!this.slots[this.side];
  }
  /** What the footer shows: the latest message, until it expires or a key is pressed. */
  get message(): Message | undefined {
    return this.current;
  }
  /** Key hints for what is on screen now. */
  get hint(): string {
    if (this.mode === 'new') return 'Enter opens a new unsaved file · Ctrl+S saves it · Esc cancels';
    if (this.mode === 'close') return 'S save and close · D close without saving · Esc keep editing';
    if (this.mode === 'find') return 'Enter next match · Alt+C match case · Esc back to the file';
    if (this.mode === 'replace-find') return 'Enter choose the replacement · Esc back to the file';
    if (this.mode === 'replace-with')
      return 'Enter replace and find next · Alt+Enter replace all · Esc back to the file';
    const buffer = this.slots[this.side];
    if (buffer?.conflict) return 'Ctrl+R reload from disk · Ctrl+S twice overwrites it with yours';
    if (!buffer) return 'Ctrl+K commands · Ctrl+P open a file · Ctrl+N new file';
    if (buffer.readOnly) return 'Ctrl+K commands · Read-only · Ctrl+F find · Ctrl+C copy · Ctrl+W close';
    return (
      'Ctrl+K commands · Ctrl+P open · Ctrl+S save · Ctrl+F find · Ctrl+/ comment' +
      (this.divided ? ' · Ctrl+\\ other side' : '')
    );
  }

  /** The active file, for the status row. */
  get active():
    | {
        path: string;
        label: string;
        language: string | undefined;
        line: number;
        column: number;
        dirty: boolean;
        readOnly: boolean;
        saving: boolean;
        newline: 'LF' | 'CRLF' | 'CR';
        bom: boolean;
      }
    | undefined {
    const buffer = this.slots[this.side];
    if (!buffer) return undefined;
    const editor = buffer.editors[this.side];
    const document = editor.document;
    return {
      path: buffer.path,
      label: buffer.title ?? buffer.path,
      language: buffer.language ? LANGUAGE_NAMES[buffer.language] : undefined,
      ...editor.position,
      dirty: bufferDirty(buffer),
      readOnly: !!buffer.readOnly,
      saving: !!buffer.saving,
      newline: document.newline === '\r\n' ? 'CRLF' : document.newline === '\r' ? 'CR' : 'LF',
      bom: document.text.startsWith('﻿'),
    };
  }
  /** Open files in tab order, for the explorer's open section. */
  get openFiles(): Array<{ path: string; label: string; dirty: boolean; active: boolean; readOnly: boolean }> {
    const labels = tabLabels([...this.buffers.keys()]);
    return [...this.buffers.values()].map((buffer) => ({
      path: buffer.path,
      label: (buffer.language === 'diff' ? '± ' : '') + (buffer.title ?? labels.get(buffer.path) ?? buffer.path),
      dirty: bufferDirty(buffer),
      active: this.slots[this.side] === buffer,
      readOnly: !!buffer.readOnly,
    }));
  }
  /** Where the user is, as a short reference the agent can follow: a path and the lines in view or selected. */
  askContext():
    | {
        path: string;
        label: string;
        from: number;
        to: number;
        selected: boolean;
        text: string;
        dirty: boolean;
        readOnly: boolean;
      }
    | undefined {
    const buffer = this.slots[this.side];
    if (!buffer) return undefined;
    const editor = buffer.editors[this.side];
    const { from, to } = editor.selectedLines();
    const selected = editor.document.selectedText !== '';
    const lines = editor.document.text.split(/\r\n|\r|\n/);
    return {
      path: buffer.path,
      label: buffer.title ?? posix.basename(buffer.path),
      from,
      to,
      selected,
      // A report is not on disk, so the agent can only read it from here.
      text: selected ? lines.slice(from - 1, to).join('\n') : buffer.readOnly ? editor.document.text : '',
      dirty: bufferDirty(buffer),
      readOnly: !!buffer.readOnly,
    };
  }
  /** Lines in the active file. */
  get lineCount(): number | undefined {
    const text = this.slots[this.side]?.editors[this.side].document.text;
    return text === undefined ? undefined : text.split(/\r\n|\r|\n/).length;
  }
  /** The text of the selection (or the whole file's text for a report), for copying or asking. */
  get selectionText(): string {
    return this.slots[this.side]?.editors[this.side].document.selectedText ?? '';
  }
  private get modal(): boolean {
    return this.mode !== 'editor';
  }

  /** Keep renderer focus on the stable owner instead of a transient nested editor. */
  resolveMouseFocus(component: Component): Component | undefined {
    if (
      component === this.tabs ||
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
      this.clearMessage();
    }
    const changed = side !== this.side;
    this.side = side;
    this.syncFocus();
    if (changed) this.options.render();
    return true;
  }

  private pointerEditor(side: 0 | 1): boolean {
    if (!this.selectPointerSide(side)) return false;
    this.options.requestFocus?.();
    this.options.render();
    return true;
  }

  private newPane(
    source: string | FileDocument,
    side: 0 | 1,
    readOnly: boolean,
    buffer: () => OpenBuffer | undefined,
  ): FileEditorPane {
    return createFileEditorPane(source, () => this.options.render(), {
      readOnly,
      lineNumbers: true,
      requestFocus: () => this.pointerEditor(side),
      code: {
        theme: this.options.theme,
        language: () => buffer()?.language,
        marks: () => {
          const target = buffer();
          return target && !readOnly ? this.options.marks?.(target.path) : undefined;
        },
        clipboard: this.options.clipboard,
        notice: (message: string) => this.tell(message, 'info'),
      },
    });
  }

  private makeBuffer(
    path: string,
    text: string,
    revision: string | undefined,
    extra: Partial<OpenBuffer> = {},
  ): OpenBuffer {
    const readOnly = !!extra.readOnly;
    const get = () => buffers.get(path);
    const first = this.newPane(text, 0, readOnly, get);
    const second = this.newPane(first.document, 1, readOnly, get);
    const buffers = this.buffers;
    return { path, revision, language: languageOf(path), ...extra, editors: [first, second] };
  }

  private tabItems(): TabItem[] {
    const labels = tabLabels([...this.buffers.keys()].filter((path) => !this.buffers.get(path)!.title));
    return [...this.buffers.values()].map((buffer) => ({
      id: buffer.path,
      label: buffer.title ?? labels.get(buffer.path) ?? buffer.path,
      glyph: buffer.language === 'diff' ? '±' : undefined,
      active: this.slots[this.side] === buffer,
      dirty: bufferDirty(buffer) || !!buffer.saving,
      onClose: () => {
        this.closeBuffer(buffer);
        this.options.requestFocus?.();
      },
      onSelect: () => {
        if (this.modal) return;
        ++this.openGeneration;
        this.activate(buffer);
        this.options.requestFocus?.();
      },
    }));
  }

  async open(path?: string, position?: { line?: number; column?: number }): Promise<void> {
    if (this.disposed || this.modal) return;
    if (path === undefined) {
      this.options.pick?.('', []);
      return;
    }
    const parsed = parsePathLine(path);
    const at = position ?? { line: parsed.line, column: parsed.column };
    const generation = ++this.openGeneration;
    let key = parsed.path;
    try {
      const absolute = posix.resolve('/work', parsed.path);
      if (!absolute.startsWith('/work/')) throw new Error('Choose a file inside the project');
      key = absolute.slice('/work/'.length);
      const existing = this.buffers.get(key);
      if (existing) {
        this.activate(existing);
        this.jump(existing, at);
        return;
      }
      this.loading = true;
      this.tell(`Opening ${key}…`);
      let snapshot;
      try {
        snapshot = await this.harness.files.read(key, this.lifetime.signal);
      } catch (error) {
        // A bare name such as `lib.rs` finds its file; several matches are offered as a list.
        const missing = /ENOENT|no such file|not found|admitted|outside/i.test(
          error instanceof Error ? error.message : '',
        );
        const matches = missing && !parsed.path.includes('/') ? await this.options.suggest?.(parsed.path) : undefined;
        if (matches?.length && !this.disposed && generation === this.openGeneration) {
          this.loading = false;
          if (matches.length === 1) {
            await this.open(matches[0], at);
          } else {
            this.clearMessage();
            this.options.pick?.(parsed.path, matches);
          }
          return;
        }
        throw error;
      }
      if (this.disposed || generation !== this.openGeneration) return;
      const buffer = this.makeBuffer(key, snapshot.bytes.toString('utf8'), snapshot.revision);
      this.buffers.set(key, buffer);
      this.activate(buffer);
      this.jump(buffer, at);
    } catch (error) {
      if (!this.disposed && generation === this.openGeneration)
        this.tell(friendlyError(error, { path: key, root: this.options.root }), 'error');
    } finally {
      if (!this.disposed && generation === this.openGeneration) {
        this.loading = false;
        this.options.render();
      }
    }
  }

  /** Open a file with the caret on a line (and column). */
  openAt(path: string, line: number, column?: number): Promise<void> {
    return this.open(path, { line, column });
  }

  /** Move the caret in the active file to a 1-based line. */
  goToLine(line: number, column?: number): boolean {
    const buffer = this.slots[this.side];
    if (!buffer || this.modal) return false;
    buffer.editors[this.side].goTo(line, column);
    return true;
  }

  private jump(buffer: OpenBuffer, at: { line?: number; column?: number }): void {
    if (at.line === undefined) return;
    for (const side of [0, 1] as const) buffer.editors[side].goTo(at.line, at.column);
  }

  /** In-memory report; never mapped to task file IO. `language` colors it (a diff, for example). */
  openReport(id: string, text: string, folder = 'review', options: { title?: string; language?: Language } = {}): void {
    if (this.disposed) return;
    const key = `\0${folder}/${id}/report.md`;
    ++this.openGeneration;
    const existing = this.buffers.get(key);
    if (existing) {
      if (this.modal) this.pendingReport = existing;
      else this.activate(existing);
      return;
    }
    const buffer = this.makeBuffer(key, text, undefined, {
      readOnly: true,
      title: options.title ?? (folder === 'review' ? 'report' : folder),
      language: options.language,
    });
    this.buffers.set(key, buffer);
    if (this.modal) {
      this.pendingReport = buffer;
      this.tell('Review saved; close this prompt to view the read-only report.', 'info');
    } else this.activate(buffer);
  }

  /** Replace an open report's text, or open it (a diff that is refreshed in place). */
  updateReport(id: string, text: string, folder: string, options: { title?: string; language?: Language } = {}): void {
    const key = `\0${folder}/${id}/report.md`;
    const existing = this.buffers.get(key);
    if (!existing) {
      this.openReport(id, text, folder, options);
      return;
    }
    existing.editors[0].document.reload(text);
    this.options.render();
  }

  /** Create a new unsaved file; with no path, ask for one (starting from `prefix`, such as a folder). */
  newFile(path?: string, prefix = ''): void {
    if (this.disposed || (this.modal && this.mode !== 'new')) return;
    ++this.openGeneration;
    this.loading = false;
    if (path === undefined) {
      this.mode = 'new';
      this.setPrompt(prefix);
      this.clearMessage();
      this.rebuild();
      return;
    }
    try {
      const absolute = posix.resolve('/work', path);
      if (
        !path.trim() ||
        /[\r\n\0]/.test(path) ||
        path.endsWith('/') ||
        !absolute.startsWith('/work/') ||
        absolute.split('/').some((part) => PRIVATE_NAMES.includes(part))
      ) {
        throw new Error('Choose a single-line file path inside the project, outside private directories');
      }
      const key = absolute.slice('/work/'.length);
      if (this.buffers.has(key)) throw new Error(`${key} is already open; use its tab instead`);
      const buffer = this.makeBuffer(key, '', undefined);
      this.buffers.set(key, buffer);
      this.activate(buffer);
      this.tell(`New file ${key}. Ctrl+S creates it.`, 'info');
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.tell(
        /already open/.test(text)
          ? text
          : `That name can't be used: ${friendlyError(error, { root: this.options.root })}`,
        'error',
      );
    }
  }

  async save(): Promise<void> {
    const buffer = this.slots[this.side];
    if (!buffer || this.disposed || this.modal) return;
    if (buffer.readOnly) {
      this.tell('This report is read-only.', 'info');
      return;
    }
    if (buffer.saving) {
      await buffer.saving;
      return;
    }
    if (!bufferDirty(buffer)) {
      this.tell('Nothing to save.', 'info');
      return;
    }
    if (buffer.conflict && !buffer.overwriteArmed) {
      buffer.overwriteArmed = true;
      this.tell(
        `${posix.basename(buffer.path)} was changed on disk. Press Ctrl+S again to overwrite it with your version, or Ctrl+R to reload.`,
        'warning',
      );
      return;
    }
    await this.write(buffer);
  }

  /** Save every file with unsaved changes. */
  async saveAll(): Promise<void> {
    if (this.disposed || this.modal) return;
    const dirty = [...this.buffers.values()].filter((buffer) => bufferDirty(buffer) && !buffer.conflict);
    if (!dirty.length) {
      this.tell('Nothing to save.', 'info');
      return;
    }
    let saved = 0;
    for (const buffer of dirty) {
      await (buffer.saving ?? this.write(buffer, true));
      if (!bufferDirty(buffer)) saved++;
    }
    if (saved === dirty.length) this.tell(`Saved ${saved} file${saved === 1 ? '' : 's'}.`, 'success');
  }

  private async write(buffer: OpenBuffer, quiet = false): Promise<void> {
    const document = buffer.editors[0].document;
    const snapshot = document.text;
    const name = buffer.path;
    if (!quiet) this.tell(`Saving ${name}…`, 'info');
    buffer.saving = (async () => {
      try {
        const bytes = Buffer.from(snapshot, 'utf8');
        let revision: string;
        if (buffer.revision === undefined || (buffer.conflict?.text === undefined && buffer.conflict)) {
          // A new file can sit in a folder that does not exist yet.
          const folder = posix.dirname(buffer.path);
          if (folder !== '.') await this.harness.files.makeDirectory(folder, this.lifetime.signal);
          revision = await this.harness.files.create(buffer.path, bytes, this.lifetime.signal);
        } else {
          // Keeping your version adopts the revision found on disk, so this write replaces it on purpose.
          revision = await this.harness.files.write(
            buffer.path,
            bytes,
            buffer.conflict?.revision ?? buffer.revision,
            this.lifetime.signal,
          );
        }
        buffer.revision = revision;
        buffer.conflict = undefined;
        buffer.overwriteArmed = false;
        document.markSaved(snapshot);
        this.options.saved?.(buffer.path);
        if (!this.disposed && !quiet)
          this.tell(
            document.dirty ? `Saved ${name}; newer edits remain unsaved.` : `Saved ${name}`,
            document.dirty ? 'warning' : 'success',
          );
      } catch (error) {
        if (!this.disposed)
          this.tell(`Not saved: ${friendlyError(error, { path: name, root: this.options.root })}`, 'error');
      } finally {
        buffer.saving = undefined;
        if (!this.disposed) this.options.render();
      }
    })();
    await buffer.saving;
  }

  /** Close a tab (the active one by default). Unsaved changes ask first. */
  closeBuffer(target?: OpenBuffer): void {
    const buffer = target ?? this.slots[this.side];
    if (!buffer || this.disposed || this.modal) return;
    if (buffer.saving) {
      this.tell('Saving. Wait a moment before closing this file.', 'info');
      return;
    }
    if (bufferDirty(buffer)) {
      ++this.openGeneration;
      this.loading = false;
      this.mode = 'close';
      this.closing = buffer;
      this.clearMessage();
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
      this.tell('This report is read-only.', 'info');
      return;
    }
    this.beginSearch('replace-find');
  }

  nextBuffer(step = 1): void {
    if (this.disposed || this.modal) return;
    const buffers = [...this.buffers.values()];
    if (!buffers.length) return;
    const index = buffers.indexOf(this.slots[this.side]!);
    ++this.openGeneration;
    this.activate(buffers[(index + step + buffers.length) % buffers.length]!);
  }

  /** Show the n-th open tab (1-based). */
  showTab(number: number): void {
    if (this.disposed || this.modal) return;
    const buffer = [...this.buffers.values()][number - 1];
    if (!buffer) return;
    ++this.openGeneration;
    this.activate(buffer);
  }

  split(): void {
    if (this.disposed || this.modal) return;
    if (!this.slots[this.side]) {
      this.tell('Open a file before splitting the editor.', 'info');
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

  /** Re-read open files after the agent (or a command) may have changed them; unsaved edits are never replaced. */
  async refreshFromDisk(paths?: readonly string[]): Promise<void> {
    if (this.disposed) return;
    const targets = [...this.buffers.values()].filter(
      (buffer) =>
        !buffer.readOnly && buffer.revision !== undefined && !buffer.saving && (!paths || paths.includes(buffer.path)),
    );
    for (const buffer of targets) {
      let snapshot;
      try {
        snapshot = await this.harness.files.read(buffer.path, this.lifetime.signal);
      } catch (error) {
        if (this.disposed) return;
        const gone = /ENOENT|no such file|not found/i.test(error instanceof Error ? error.message : '');
        // Too large, terminal running and the like: leave the buffer as it is.
        if (gone && !buffer.conflict && bufferDirty(buffer)) {
          buffer.conflict = { revision: undefined, text: undefined };
          this.tell(`${buffer.path} was deleted on disk. Saving it again would create it.`, 'warning');
        }
        continue;
      }
      if (this.disposed || buffer.saving || !this.buffers.has(buffer.path)) continue;
      if (snapshot.revision === buffer.revision || snapshot.revision === buffer.conflict?.revision) continue;
      const text = snapshot.bytes.toString('utf8');
      const document = buffer.editors[0].document;
      if (!document.dirty) {
        try {
          document.reload(text);
        } catch {
          continue;
        }
        buffer.revision = snapshot.revision;
        buffer.conflict = undefined;
        this.tell(`${posix.basename(buffer.path)} was updated on disk.`, 'info');
      } else if (document.text === text) {
        buffer.revision = snapshot.revision;
        document.markSaved(text);
      } else {
        buffer.conflict = { revision: snapshot.revision, text };
        buffer.overwriteArmed = false;
        this.tell(
          `${posix.basename(buffer.path)} was changed on disk and you have unsaved edits. Ctrl+R reloads it.`,
          'warning',
        );
      }
    }
    this.options.render();
  }

  /** Reload the active file from disk, dropping its unsaved edits. */
  async reload(): Promise<void> {
    const buffer = this.slots[this.side];
    if (!buffer || buffer.readOnly || buffer.revision === undefined || this.disposed || this.modal) return;
    try {
      const snapshot = await this.harness.files.read(buffer.path, this.lifetime.signal);
      if (this.disposed) return;
      buffer.editors[0].document.reload(snapshot.bytes.toString('utf8'));
      buffer.revision = snapshot.revision;
      buffer.conflict = undefined;
      buffer.overwriteArmed = false;
      this.tell(`Reloaded ${posix.basename(buffer.path)} from disk.`, 'success');
    } catch (error) {
      this.tell(friendlyError(error, { path: buffer.path, root: this.options.root }), 'error');
    }
    this.options.render();
  }

  handleInput(data: string): void {
    if (this.disposed || isKeyRelease(data)) return;
    if (matchesKey(data, 'escape')) {
      ++this.openGeneration;
      this.loading = false;
      this.mode = 'editor';
      this.closing = undefined;
      this.clearMessage();
      this.rebuild();
      return;
    }
    // Confirmation is modal: tab switching cannot redirect a pending close.
    if (this.mode === 'close') {
      const buffer = this.closing;
      const key = data.toLowerCase();
      if (!buffer || buffer.saving) return;
      if (key === 'd') this.removeBuffer(buffer);
      else if (key === 's' || matchesKey(data, 'enter') || matchesKey(data, 'ctrl+s')) {
        this.mode = 'editor';
        void this.write(buffer).then(() => {
          if (!bufferDirty(buffer)) this.removeBuffer(buffer);
          else this.rebuild();
        });
        this.rebuild();
      }
      return;
    }
    if (this.mode === 'new') {
      if (matchesKey(data, 'enter')) this.newFile(this.prompt.document.text);
      else if (matchesKey(data, 'shift+enter') || /[\r\n]/.test(data))
        this.tell('A file path must fit on one line.', 'warning');
      else this.prompt.focus.handleInput?.(data);
      return;
    }
    if (this.modal) {
      this.searchInput(data);
      return;
    }
    if (this.current && this.current.kind !== 'warning') this.clearMessage();
    if (matchesKey(data, 'ctrl+n')) {
      this.newFile();
      return;
    }
    if (matchesKey(data, 'ctrl+s')) {
      void this.save();
      return;
    }
    if (matchesKey(data, 'ctrl+r')) {
      void this.reload();
      return;
    }
    if (matchesKey(data, 'ctrl+w')) {
      this.closeBuffer();
      return;
    }
    if (matchesKey(data, 'ctrl+tab') || matchesKey(data, 'ctrl+pageDown') || matchesKey(data, 'alt+]')) {
      this.nextBuffer(1);
      return;
    }
    if (matchesKey(data, 'ctrl+shift+tab') || matchesKey(data, 'ctrl+pageUp') || matchesKey(data, 'alt+[')) {
      this.nextBuffer(-1);
      return;
    }
    for (let digit = 1; digit <= 9; digit++) {
      if (matchesKey(data, `alt+${digit}` as 'alt+1')) {
        this.showTab(digit);
        return;
      }
    }
    if (matchesKey(data, 'ctrl+f')) {
      this.find();
      return;
    }
    if (matchesKey(data, 'ctrl+h')) {
      this.replace();
      return;
    }
    if (matchesKey(data, 'ctrl+\\')) {
      if (this.divided) {
        ++this.openGeneration;
        this.loading = false;
        this.clearMessage();
        this.side = this.side === 0 ? 1 : 0;
        this.mode = 'editor';
        this.rebuild();
      } else this.split();
      return;
    }
    this.slots[this.side]?.editors[this.side].focus.handleInput?.(data);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.openGeneration;
    clearTimeout(this.messageTimer);
    this.lifetime.abort();
    this.focused = false;
    this.syncFocus();
  }

  private activate(buffer: OpenBuffer): void {
    this.slots[this.side] = buffer;
    if (!buffer.readOnly) this.options.opened?.(buffer.path);
    this.mode = 'editor';
    this.loading = false;
    this.clearMessage();
    this.rebuild();
  }

  private removeBuffer(buffer: OpenBuffer): void {
    ++this.openGeneration;
    const order = [...this.buffers.keys()];
    const at = order.indexOf(buffer.path);
    this.buffers.delete(buffer.path);
    const rest = [...this.buffers.values()];
    // The neighbor to the left (or the first) takes the pane the closed file was in.
    const next = rest[Math.min(Math.max(0, at - 1), rest.length - 1)];
    for (const side of [0, 1] as const) if (this.slots[side] === buffer) this.slots[side] = next;
    if (!next) {
      this.divided = false;
      this.side = 0;
      this.slots[1] = undefined;
    }
    this.mode = 'editor';
    this.closing = undefined;
    this.clearMessage();
    this.rebuild();
  }

  private beginSearch(mode: 'find' | 'replace-find'): void {
    if (this.modal) return;
    if (this.disposed || !this.slots[this.side]) {
      this.tell('Open a file to search in it.', 'info');
      return;
    }
    ++this.openGeneration;
    this.mode = mode;
    // Selected text becomes the query, like most editors.
    const selected = this.slots[this.side]!.editors[this.side].document.selectedText;
    this.setPrompt(selected && !/[\r\n]/.test(selected) ? selected : this.search);
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
    if (matchesKey(data, 'alt+c') && this.mode === 'find') {
      this.caseSensitive = !this.caseSensitive;
      this.tell(this.caseSensitive ? 'Matching case.' : 'Ignoring case.', 'info');
      return;
    }
    const replaceAll = this.mode === 'replace-with' && matchesKey(data, 'alt+enter');
    if (!matchesKey(data, 'enter') && !replaceAll) {
      this.prompt.focus.handleInput?.(data);
      return;
    }
    const document = this.slots[this.side]?.editors[0].document;
    if (!document) return;
    if (this.mode === 'replace-with') {
      this.replacement = this.prompt.document.text;
      try {
        if (replaceAll) this.replaceEverywhere(document);
        else {
          if (!this.isMatch(document.selectedText) && !this.findMatch(false)) return;
          document.insert(this.replacement);
          this.findMatch(true);
        }
      } catch (error) {
        this.tell(`Replace failed: ${friendlyError(error, { root: this.options.root })}`, 'error');
      }
    } else {
      const query = this.prompt.document.text;
      const repeat = query === this.search && this.isMatch(document.selectedText);
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

  private isMatch(text: string): boolean {
    return (
      text !== '' && (this.caseSensitive ? text === this.search : text.toLowerCase() === this.search.toLowerCase())
    );
  }

  /** Every start offset of the search text; case-insensitive unless Alt+C turned matching case on. */
  private matchOffsets(text: string): number[] {
    const matches: number[] = [];
    if (!this.search) return matches;
    const pattern = new RegExp(this.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), this.caseSensitive ? 'gu' : 'giu');
    for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
      matches.push(found.index);
      pattern.lastIndex = found.index + 1;
    }
    return matches;
  }

  private replaceEverywhere(document: FileEditorPane['document']): void {
    const offsets = this.matchOffsets(document.text);
    if (!offsets.length) {
      this.tell('No matches to replace.', 'info');
      return;
    }
    // Matches that overlap are replaced once; the whole change is one undo step.
    let result = '';
    let from = 0;
    let count = 0;
    for (const offset of offsets) {
      if (offset < from) continue;
      result += document.text.slice(from, offset) + this.replacement;
      from = offset + this.search.length;
      count++;
    }
    result += document.text.slice(from);
    document.replaceRange(0, document.text.length, result, { anchor: 0, cursor: 0 });
    this.tell(`Replaced ${count} match${count === 1 ? '' : 'es'}. Ctrl+Z undoes all of them.`, 'success');
  }

  private findMatch(advance: boolean): boolean {
    const document = this.slots[this.side]!.editors[0].document;
    if (!this.search) {
      this.tell('Type something to look for.', 'info');
      return false;
    }
    const start = advance ? Math.max(document.anchor, document.cursor) : Math.min(document.anchor, document.cursor);
    const matches = this.matchOffsets(document.text);
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
      this.slots[this.side]?.editors[this.side].goTo(document.text.slice(0, match).split(/\r\n|\r|\n/).length, 0);
      document.select(match, match + this.search.length);
      this.tell(`${matches.indexOf(match) + 1} of ${matches.length}`, 'info');
      return true;
    }
    this.tell(`No matches for ${label(this.search, 60)}.`, 'warning');
    return false;
  }

  private syncFocus(): void {
    for (const buffer of this.buffers.values()) {
      for (const side of [0, 1] as const)
        buffer.editors[side].focus.focused =
          this.focused && this.mode === 'editor' && this.side === side && this.slots[side] === buffer;
    }
    this.prompt.focus.focused = this.focused && !['editor', 'close'].includes(this.mode);
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
    const theme = this.options.theme;
    this.body.addChild(this.tabs, { basis: 1, shrink: 0, visible: () => this.buffers.size > 0 && !compact() });
    this.body.addChild(this.banner(), { basis: 'auto', shrink: 0, visible: () => !!this.slots[this.side]?.conflict });
    if (this.slots[this.side]) {
      const columns = new HStack([], { gap: 0 });
      for (const side of [0, 1] as const) {
        const buffer = this.slots[side];
        if (!buffer || (side === 1 && !this.divided)) continue;
        if (side === 1) {
          columns.addChild(
            verticalRule(theme, () => (this.focused && this.side === 1 ? 'accent' : 'border'), rows),
            { basis: 1, shrink: 0, visible: (viewport) => viewport.width >= 40 },
          );
        }
        const editor = buffer.editors[side];
        // A split names each side's file above it; one editor is named by its tab.
        const column = new VStack(
          this.divided
            ? [
                {
                  component: {
                    invalidate() {},
                    render: (width: number) => [
                      truncateToWidth(
                        colorText(
                          theme(),
                          this.focused && this.side === side ? 'accent' : 'muted',
                          ` ${label(buffer.title ?? buffer.path)}${bufferDirty(buffer) ? ' ●' : ''}`,
                        ),
                        width,
                        '',
                      ),
                    ],
                  },
                  basis: 1,
                  shrink: 0,
                },
                { component: editor.view, basis: 0, grow: 1, minSize: 1 },
              ]
            : [{ component: editor.view, basis: 0, grow: 1, minSize: 1 }],
        );
        this.frames.add(column);
        columns.addChild(column, {
          basis: 0,
          grow: 1,
          minSize: 1,
          visible: (viewport) => !this.divided || viewport.width >= 40 || side === this.side,
        });
      }
      this.body.addChild(columns, { basis: 0, grow: 1, minSize: 1 });
    } else {
      this.body.addChild(this.welcome(), { basis: 0, grow: 1, minSize: 1 });
    }
    if (this.mode === 'close') {
      this.body.addChild(
        {
          invalidate() {},
          render: (width) => {
            const name = label(this.closing?.path ?? '', 200);
            return [
              truncateToWidth(
                colorText(theme(), 'warning', `Save changes to ${name} before closing?  `) +
                  colorText(theme(), 'foreground', 'S') +
                  colorText(theme(), 'muted', ' save · ') +
                  colorText(theme(), 'foreground', 'D') +
                  colorText(theme(), 'muted', " don't save · ") +
                  colorText(theme(), 'foreground', 'Esc') +
                  colorText(theme(), 'muted', ' cancel'),
                width,
                '',
              ),
            ];
          },
        },
        { basis: 1, shrink: 0 },
      );
    } else if (this.modal) {
      this.body.addChild(
        {
          invalidate() {},
          render: (width) => [
            truncateToWidth(
              colorText(
                theme(),
                'accent',
                this.mode === 'new'
                  ? 'New file name (relative to the project, e.g. src/lib.rs):'
                  : this.mode === 'replace-with'
                    ? `Replace ${label(this.search, 200)} with:`
                    : this.mode === 'find'
                      ? `Find${this.caseSensitive ? ' (match case)' : ''}:`
                      : 'Find text to replace:',
              ),
              width,
              '',
            ),
          ],
        },
        { basis: 1, shrink: 0 },
      );
      this.body.addChild(this.prompt.view, { basis: 1, shrink: 0 });
    }
    if (notify) {
      this.options.focusChanged();
      this.options.render();
    }
  }

  /** The row above the editor when the file on disk differs from the one being edited. */
  private banner(): Component {
    return {
      invalidate() {},
      render: (width) => {
        const buffer = this.slots[this.side];
        if (!buffer?.conflict) return [];
        const text = buffer.conflict.text === undefined ? 'deleted on disk' : 'changed on disk';
        const line = ` ${label(posix.basename(buffer.path), 80)} ${text} · Ctrl+R reload · Ctrl+S twice overwrite`;
        return [
          colorBg(
            this.options.theme(),
            'surface',
            colorText(this.options.theme(), 'warning', truncateToWidth(line, width, '', true)),
          ),
        ];
      },
    };
  }

  /** What the editor shows with no file open: the few things to do first, each clickable. */
  private welcome(): Component {
    const actions = (): readonly WelcomeAction[] =>
      this.options.welcome?.() ?? [
        { label: 'Open a file', keys: 'Ctrl+P', run: () => this.options.pick?.('', []) },
        { label: 'New file', keys: 'Ctrl+N', run: () => this.newFile() },
        { label: 'Commands', keys: 'Ctrl+K', run: () => {} },
        { label: 'Ask the agent', keys: 'Ctrl+L', run: () => {} },
      ];
    const component: Component = {
      invalidate() {},
      render: (width) => {
        const theme = this.options.theme();
        const list = actions();
        const pad = Math.max(...list.map((action) => action.label.length)) + 3;
        return [
          '',
          truncateToWidth(`  ${colorText(theme, 'muted', 'No file open')}`, width, ''),
          '',
          ...list.map((action) =>
            truncateToWidth(
              `  ${colorText(theme, 'foreground', action.label.padEnd(pad))}${colorText(theme, 'accent', action.keys)}`,
              width,
              '',
            ),
          ),
        ];
      },
      handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
        if (event.button !== 'left') return undefined;
        const action = actions()[event.y - 3];
        if (event.type === 'click') {
          this.options.requestFocus?.();
          if (action) action.run();
          return { handled: true, focus: true };
        }
        return event.type === 'press' ? { handled: true, focus: true } : undefined;
      },
    };
    this.frames.add(component);
    return component;
  }

  /** Show a message; success and info fade after a few seconds, warnings and errors stay until the next key. */
  say(message: string, kind: MessageKind = 'info'): void {
    this.tell(message, kind);
  }

  private tell(message: string, kind: MessageKind = 'info'): void {
    if (this.disposed) return;
    clearTimeout(this.messageTimer);
    this.current = { kind, text: label(message) };
    if (kind === 'success' || kind === 'info') {
      this.messageTimer = setTimeout(() => {
        this.current = undefined;
        if (!this.disposed) this.options.render();
      }, MESSAGE_SECONDS * 1000);
      this.messageTimer.unref();
    }
    this.options.notice(this.current.text, kind);
    this.options.render();
  }

  private clearMessage(): void {
    clearTimeout(this.messageTimer);
    this.current = undefined;
  }
}
