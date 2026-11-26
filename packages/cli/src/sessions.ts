import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { omsCommand } from '@oms/engine';
import { displayText } from './tui/transcript.ts';

export interface SavedFolder {
  /** The folder oms was run in. */
  path: string;
  scratch: boolean;
  chats: number;
  /** When the newest conversation was last written; absent when there is none. */
  lastUsed?: string;
  /** The project folder is gone. A folder that cannot be read is not reported as gone. */
  missing: boolean;
  /** Where OMS keeps this folder's state. */
  state: string;
}

/** A conversation file is `<timestamp>_<id>.jsonl`; its budget and trace journals are not conversations. */
const CHAT_FILE = /^\d{4}-\d{2}-\d{2}T[^_]+_[^.]+\.jsonl$/;
const KEY = /^[0-9a-f]{40}$/;

function isGone(path: string): boolean {
  try {
    return !statSync(path).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

function entries(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every folder OMS keeps state for, newest conversation first. Records that cannot be read are left alone. */
export function savedFolders(stateRoot: string): SavedFolder[] {
  const folders = entries(join(stateRoot, 'folders')).flatMap((entry) => {
    if (!entry.isDirectory() || !KEY.test(entry.name)) return [];
    const state = join(stateRoot, 'folders', entry.name);
    try {
      const record = JSON.parse(readFileSync(join(state, 'folder.json'), 'utf8')) as Record<string, unknown>;
      if (typeof record.path !== 'string') return [];
      const sessions = join(state, 'sessions');
      const used = entries(sessions)
        .filter((file) => CHAT_FILE.test(file.name))
        .map((file) => statSync(join(sessions, file.name)).mtimeMs);
      return [
        {
          path: record.path,
          scratch: record.scratch === true,
          chats: used.length,
          ...(used.length ? { lastUsed: new Date(Math.max(...used)).toISOString() } : {}),
          missing: isGone(record.path),
          state,
        },
      ];
    } catch {
      return [];
    }
  });
  return folders.sort((a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? ''));
}

export const shortPath = (path: string, home = homedir()): string =>
  displayText(path === home || path.startsWith(home + sep) ? '~' + path.slice(home.length) : path, 400).replace(
    /\s+/g,
    ' ',
  );

export function runSessionsCommand(
  args: string[],
  stateRoot: string,
  log: (line: string) => void,
  error: (line: string) => void,
): number {
  const unknown = args.find((arg) => arg !== '--json');
  if (unknown) {
    error(`oms sessions: unknown option "${unknown}"\nUsage: ${omsCommand()} sessions [--json]`);
    return 2;
  }
  const folders = savedFolders(stateRoot).filter((folder) => folder.chats > 0);
  if (args.includes('--json')) {
    log(JSON.stringify(folders, null, 2));
    return 0;
  }
  if (!folders.length) {
    log(`No saved conversations yet. Run ${omsCommand()} in a project folder to start one.`);
    return 0;
  }
  log('Last used   Chats  Folder');
  for (const folder of folders) {
    const note = folder.missing ? '  (folder deleted)' : folder.scratch ? '  (scratch chat)' : '';
    log(`${folder.lastUsed!.slice(0, 10)}  ${String(folder.chats).padStart(5)}  ${shortPath(folder.path)}${note}`);
  }
  log(`\nRun ${omsCommand()} in a folder to continue its newest conversation.`);
  return 0;
}
