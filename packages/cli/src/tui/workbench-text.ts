import { posix } from 'node:path';
import { displayText } from './transcript.ts';

/** How a workbench message is colored and how long it stays. */
export type MessageKind = 'info' | 'success' | 'warning' | 'error';
export interface Message {
  kind: MessageKind;
  text: string;
}

const KIB_LIMIT = '64 KiB';

/** A path as the user wrote it, without the task's absolute host root or the sandbox's /work prefix. */
export function projectPath(text: string, root?: string): string {
  let result = text;
  if (root)
    result = result
      .split(root.replace(/\/$/, '') + '/')
      .join('')
      .split(root)
      .join('.');
  return result.replace(/\/work\//g, '').replace(/\/work\b/g, '.');
}

const name = (path: string | undefined): string => (path ? posix.basename(path) : 'This file');

/**
 * Short product wording for what the engine's file helper and the editor can refuse, with a next step. Unknown errors are
 * cleaned of host paths and cut short; nothing here ever shows an absolute path from the user's machine.
 */
export function friendlyError(error: unknown, context: { path?: string; root?: string } = {}): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong';
  const text = displayText(raw, 600).replace(/\s+/g, ' ').trim();
  const file = name(context.path);
  if (/no larger than 64 KiB|exceeds 64 KiB|exceeds the 64 KiB|write exceeds/i.test(text))
    return `${file} is larger than ${KIB_LIMIT}, the most the editor can open or save.`;
  if (/Binary task files/i.test(text)) return `${file} is a binary file; it can't be edited here.`;
  if (/requires valid UTF-8/i.test(text)) return `${file} isn't valid UTF-8 text; it can't be edited here.`;
  if (/512-entry listing limit/i.test(text))
    return 'This folder has more than 512 entries. Open a file in it by name with Ctrl+P.';
  if (/64 KiB output limit|exceeds its output limit/i.test(text))
    return 'This folder is too large to list. Open a file in it by name with Ctrl+P.';
  if (/Stop the host terminal/i.test(text))
    return 'The terminal is running, so commands and file saves are paused. Stop it (■ stop in the panel, or /terminal stop), then try again.';
  if (/file changed (after|before|during)|file disappeared/i.test(text))
    return `${file} changed on disk. Reload it with Ctrl+R, or keep your version.`;
  if (/already exists/i.test(text)) return `${file} already exists. Open it, or choose a different name.`;
  if (/pinned verifier files/i.test(text)) return `${file} is part of the task's checks and can't be edited.`;
  if (/outside the admitted|escapes the task|outside the selected task|limited to the selected task/i.test(text))
    return 'That path is outside the project.';
  if (/private\/control path|private directories/i.test(text)) return "That path is private; it can't be opened here.";
  if (/ENOENT|no such file|not found/i.test(text)) return `${file} doesn't exist.`;
  if (/EACCES|EPERM|permission denied/i.test(text)) return `${file} isn't readable or writable.`;
  if (/not a regular|ordinary task file|symlink/i.test(text))
    return `${file} isn't an ordinary file; it can't be edited here.`;
  if (/cancelled/i.test(text)) return 'That was cancelled.';
  if (/timed out/i.test(text)) return 'That took too long and was stopped.';
  const cleaned = projectPath(text, context.root).replace(
    /'?\/(?:Users|home|private|var|tmp|opt)\/[^\s'"]*'?/g,
    'a file',
  );
  return cleaned.length > 160 ? cleaned.slice(0, 159) + '…' : cleaned;
}

/** Human sizes for the file-info messages: 190 B, 1.5 KB, 190 KB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 10 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** Parse `path`, `path:12` or `path:12:5` into a path and a position. A trailing :number is a line, not part of the name. */
export function parsePathLine(text: string): { path: string; line?: number; column?: number } {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(text.trim());
  if (!match || !match[1]) return { path: text.trim() };
  return { path: match[1], line: Number(match[2]), ...(match[3] ? { column: Number(match[3]) } : {}) };
}

/**
 * Tab names: the file name, plus its folder when two open files share the name (state/mod.rs and instructions/mod.rs)
 * and more folders until they differ.
 */
export function tabLabels(paths: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  const parts = paths.map((path) => path.split('/'));
  paths.forEach((path, index) => {
    let depth = 1;
    const mine = parts[index]!;
    while (
      depth < mine.length &&
      parts.some(
        (other, otherIndex) => otherIndex !== index && other.slice(-depth).join('/') === mine.slice(-depth).join('/'),
      )
    )
      depth++;
    labels.set(path, mine.slice(-depth).join('/'));
  });
  return labels;
}
