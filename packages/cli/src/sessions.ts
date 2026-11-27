import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { inspectMutationLease, omsCommand } from '@oms/engine';
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

export interface SessionsIo {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Absent when there is no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>;
}

/** Deletes OMS's saved state for folders that no longer exist. Nothing a running or crashed window holds is touched. */
async function prune(stateRoot: string, yes: boolean, { log, error, confirm }: SessionsIo): Promise<number> {
  const removable = (folder: SavedFolder) =>
    inspectMutationLease(join(folder.state, 'session.lease')).status === 'absent';
  const gone = savedFolders(stateRoot).filter((folder) => folder.missing);
  const found = gone.filter(removable);
  const held = gone.length - found.length;
  if (held) log(`Skipping ${held} deleted folder${held === 1 ? '' : 's'} whose state is still held by an oms process.`);
  if (!found.length) {
    log('Nothing to remove.');
    return 0;
  }
  log('These folders no longer exist. Their saved conversations will be deleted:');
  for (const folder of found) log(`  ${String(folder.chats).padStart(3)} chats  ${shortPath(folder.path)}`);
  if (!yes) {
    if (!confirm) {
      error('oms: nothing removed. There is no terminal to confirm on; add --yes.');
      return 1;
    }
    if (!(await confirm('Delete them?'))) {
      log('Nothing removed.');
      return 1;
    }
  }
  // The answer can take a while, so each folder is checked again just before it goes.
  const still = found.filter((folder) => isGone(folder.path) && removable(folder));
  for (const folder of still) rmSync(folder.state, { recursive: true, force: true });
  log(`Removed saved state for ${still.length} folder${still.length === 1 ? '' : 's'}.`);
  return 0;
}

export async function runSessionsCommand(args: string[], stateRoot: string, io: SessionsIo): Promise<number> {
  const { log, error } = io;
  const unknown = args.find((arg) => !['--json', '--prune', '--yes'].includes(arg));
  if (unknown) {
    error(`oms sessions: unknown option "${unknown}"\nUsage: ${omsCommand()} sessions [--json] [--prune [--yes]]`);
    return 2;
  }
  if (args.includes('--prune')) return prune(stateRoot, args.includes('--yes'), io);
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
  const deleted = folders.filter((folder) => folder.missing).length;
  if (deleted) log(`Remove state for deleted folders: ${omsCommand()} sessions --prune`);
  return 0;
}
