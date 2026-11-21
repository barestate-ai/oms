import { posix } from 'node:path';
import { taskDiff, type OmsSession, type TaskFileAccess } from '@oms/engine';
import type { ChangeMark } from './file-editor.ts';
import type { ChangeMarker } from './explorer.ts';

/** One `@@` block of a patch: the line ranges on both sides and its lines with their ' ', '+', '-' or '\' prefix. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}
export interface FileChange {
  path: string;
  status: ChangeMarker | 'B';
  added: number;
  removed: number;
  hunks: Hunk[];
  /** This file's part of the unified diff; empty for a file git does not track yet. */
  patch: string;
  /** The patch was cut before this file ended, so its hunks cannot be trusted for a revert. */
  cut?: boolean;
}

const HEADER = /^diff --git (.+)$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path of a `diff --git a/x b/x` header (the new name); undefined when git quoted it. */
function headerPath(rest: string): string | undefined {
  if (rest.startsWith('"')) return undefined;
  const same = (rest.length - 5) / 2;
  if (
    Number.isInteger(same) &&
    rest.startsWith('a/') &&
    rest.slice(2, 2 + same) === rest.slice(-same) &&
    rest.slice(2 + same, 5 + same) === ' b/'
  )
    return rest.slice(-same);
  return /^a\/.+ b\/(.+)$/.exec(rest)?.[1];
}

/** Split a `git diff` into files, hunks and counts. Untracked files (no patch) are listed as new. */
export function parsePatch(patch: string, untracked: readonly string[] = [], truncated = false): FileChange[] {
  const changes: FileChange[] = [];
  const lines = patch.split('\n');
  let current: FileChange | undefined;
  let hunk: Hunk | undefined;
  let start = 0;
  const finish = (end: number) => {
    if (current) current.patch = lines.slice(start, end).join('\n') + '\n';
  };
  lines.forEach((line, index) => {
    const header = HEADER.exec(line);
    if (header) {
      finish(index);
      const path = headerPath(header[1]!);
      current = path ? { path, status: 'M', added: 0, removed: 0, hunks: [], patch: '' } : undefined;
      if (current) changes.push(current);
      hunk = undefined;
      start = index;
      return;
    }
    if (!current) return;
    const at = HUNK.exec(line);
    if (at) {
      hunk = {
        oldStart: Number(at[1]),
        oldLines: at[2] === undefined ? 1 : Number(at[2]),
        newStart: Number(at[3]),
        newLines: at[4] === undefined ? 1 : Number(at[4]),
        lines: [],
      };
      current.hunks.push(hunk);
      return;
    }
    if (hunk) {
      // Inside a hunk every line starts with ' ', '+', '-' or '\\'; an empty one is a context line whose space was lost.
      if (line.startsWith('+')) current.added++;
      else if (line.startsWith('-')) current.removed++;
      else if (!line.startsWith(' ') && !line.startsWith('\\') && !(line === '' && index < lines.length - 1)) return;
      hunk.lines.push(line === '' ? ' ' : line);
      return;
    }
    if (line.startsWith('new file mode')) current.status = 'A';
    else if (line.startsWith('deleted file mode')) current.status = 'D';
    else if (line.startsWith('rename to ')) current.status = 'R';
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) current.status = 'B';
  });
  finish(lines.length);
  if (truncated && changes.length) changes[changes.length - 1]!.cut = true;
  for (const path of untracked) {
    if (!changes.some((change) => change.path === path))
      changes.push({ path, status: 'U', added: 0, removed: 0, hunks: [], patch: '' });
  }
  return changes;
}

/** Gutter marks for a file's changed lines, by 0-based row of the new text. A removal marks the line that follows it. */
export function lineMarks(change: FileChange): Map<number, ChangeMark> {
  const marks = new Map<number, ChangeMark>();
  if (change.status === 'U' || change.status === 'A') return marks;
  for (const hunk of change.hunks) {
    let row = hunk.newStart - 1;
    let removed = 0;
    let added: number[] = [];
    const flush = () => {
      if (added.length) for (const at of added) marks.set(at, removed ? 'mod' : 'add');
      else if (removed) marks.set(Math.max(0, row), 'del');
      removed = 0;
      added = [];
    };
    for (const line of hunk.lines) {
      if (line.startsWith('-')) removed++;
      else if (line.startsWith('+')) added.push(row++);
      else if (line.startsWith('\\')) continue;
      else {
        flush();
        row++;
      }
    }
    flush();
  }
  return marks;
}

/** Everything a hunk would put back: its lines on the old side, and what is there now (its lines on the new side). */
function sides(hunk: Hunk): { oldSide: string[]; newSide: string[]; oldNoEol: boolean; newNoEol: boolean } {
  const oldSide: string[] = [];
  const newSide: string[] = [];
  let oldNoEol = false;
  let newNoEol = false;
  let previous = '';
  for (const line of hunk.lines) {
    if (line.startsWith('\\')) {
      if (previous === '-' || previous === ' ') oldNoEol = true;
      if (previous === '+' || previous === ' ') newNoEol = true;
      continue;
    }
    previous = line[0] ?? ' ';
    if (previous !== '+') oldSide.push(line.slice(1));
    if (previous !== '-') newSide.push(line.slice(1));
  }
  return { oldSide, newSide, oldNoEol, newNoEol };
}

export type Reverted = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Put the old lines back in place of the new ones for `hunks` (all of them by default), working from the bottom up.
 * Every hunk's new-side lines must be exactly where the patch says, or nothing changes: the file moved on.
 */
export function reverseApply(current: string, change: FileChange, hunks: readonly Hunk[] = change.hunks): Reverted {
  let endsWithNewline = current.endsWith('\n');
  const lines = current === '' ? [] : (endsWithNewline ? current.slice(0, -1) : current).split('\n');
  const ordered = [...hunks].sort((a, b) => b.newStart - a.newStart);
  for (const hunk of ordered) {
    const { oldSide, newSide, oldNoEol } = sides(hunk);
    const at = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    if (at < 0 || at + newSide.length > lines.length || newSide.some((line, offset) => lines[at + offset] !== line))
      return { ok: false, reason: 'The file changed since this diff was read. Refresh the changes and try again.' };
    lines.splice(at, newSide.length, ...oldSide);
    if (at + oldSide.length >= lines.length) endsWithNewline = !oldNoEol;
  }
  return { ok: true, text: lines.join('\n') + (endsWithNewline && lines.length ? '\n' : '') };
}

/** Where `taskDiff` runs for this session: the task's worktree against its base, or a folder chat's repository against HEAD. */
export function diffTarget(harness: OmsSession): { root: string; base: string; branch?: string } | undefined {
  if (harness.kind === 'chat') return harness.folder.git ? { root: harness.root, base: 'HEAD' } : undefined;
  return { root: harness.task.codeRoot, base: harness.task.baseOid, branch: harness.task.branch };
}

export interface ChangeReport {
  changes: FileChange[];
  /** Why the list is empty or short, in plain words. */
  note?: string;
}

/** The files changed since the diff base, read-only through git. */
export async function readChanges(harness: OmsSession): Promise<ChangeReport> {
  const target = diffTarget(harness);
  if (!target) return { changes: [], note: 'This folder is not a git repository, so changes are not tracked.' };
  try {
    const diff = await taskDiff(target.root, target.base);
    return {
      changes: parsePatch(diff.patch, diff.untracked, diff.truncated),
      ...(diff.truncated ? { note: 'Very large change; the list is cut short.' } : {}),
    };
  } catch (error) {
    if (/unknown revision|ambiguous argument|bad revision/.test(String(error)))
      return { changes: [], note: 'This repository has no commits yet, so there is nothing to compare with.' };
    throw error;
  }
}

/** Revert a file (or one hunk of it) through the guarded task files. A file git does not track cannot be reverted. */
export async function revert(
  change: FileChange,
  files: Pick<TaskFileAccess, 'read' | 'write' | 'create' | 'makeDirectory'>,
  hunks: readonly Hunk[] = change.hunks,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (change.status === 'U' || change.status === 'A')
    return {
      ok: false,
      reason: 'A new file cannot be reverted here. Delete it from the terminal if you do not want it.',
    };
  if (change.status === 'B') return { ok: false, reason: 'A binary file cannot be reverted here.' };
  if (change.cut) return { ok: false, reason: 'This change is too large to revert here. Use git in the terminal.' };
  if (change.status === 'D') {
    const restored = reverseApply('', change, hunks);
    if (!restored.ok) return restored;
    const folder = posix.dirname(change.path);
    if (folder !== '.') await files.makeDirectory(folder, signal);
    await files.create(change.path, Buffer.from(restored.text, 'utf8'), signal);
    return restored;
  }
  const snapshot = await files.read(change.path, signal);
  const reverted = reverseApply(snapshot.bytes.toString('utf8'), change, hunks);
  if (!reverted.ok) return reverted;
  await files.write(change.path, Buffer.from(reverted.text, 'utf8'), snapshot.revision, signal);
  return reverted;
}

/** The list of changes the explorer, gutter, panel and status row share. Refreshes never overlap. */
export class ChangesStore {
  private list: FileChange[] = [];
  private noteText: string | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private loaded = false;
  private readonly reviewed = new Set<string>();
  private readonly marks = new Map<string, { patch: string; marks: Map<number, ChangeMark> }>();
  private readonly source: () => Promise<ChangeReport>;
  private readonly changed: () => void;

  constructor(source: () => Promise<ChangeReport>, changed: () => void) {
    this.source = source;
    this.changed = changed;
  }

  get files(): readonly FileChange[] {
    return this.list;
  }
  get note(): string | undefined {
    return this.noteText;
  }
  get ready(): boolean {
    return this.loaded;
  }
  get count(): number {
    return this.list.length;
  }
  get unreviewed(): number {
    return this.list.filter((change) => !this.isReviewed(change)).length;
  }

  /** Path to status, for the explorer's markers. */
  markers(): Map<string, ChangeMarker> {
    const map = new Map<string, ChangeMarker>();
    for (const change of this.list) if (change.status !== 'B') map.set(change.path, change.status);
    return map;
  }

  marksFor(path: string): ReadonlyMap<number, ChangeMark> | undefined {
    const change = this.list.find((item) => item.path === path);
    if (!change?.hunks.length) return undefined;
    const known = this.marks.get(path);
    if (known?.patch === change.patch) return known.marks;
    const marks = lineMarks(change);
    this.marks.set(path, { patch: change.patch, marks });
    return marks;
  }

  private key(change: FileChange): string {
    // A new patch for the same file is new work to review.
    let hash = 0;
    for (const character of change.patch) hash = (hash * 31 + character.charCodeAt(0)) | 0;
    return `${change.path}#${change.patch.length}:${hash}`;
  }
  isReviewed(change: FileChange): boolean {
    return this.reviewed.has(this.key(change));
  }
  toggleReviewed(change: FileChange): void {
    const key = this.key(change);
    if (!this.reviewed.delete(key)) this.reviewed.add(key);
    this.changed();
  }

  /** Read the changes again. A refresh asked for while one runs makes the running one go round once more. */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          try {
            const report = await this.source();
            this.list = report.changes;
            this.noteText = report.note;
          } catch (error) {
            this.noteText =
              `Changes unavailable: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`.slice(
                0,
                160,
              );
          }
          this.loaded = true;
          this.changed();
        } while (this.again);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }
}
