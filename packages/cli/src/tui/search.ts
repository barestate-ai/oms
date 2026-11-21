import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import type { TaskFileAccess } from '@oms/engine';

const run = promisify(execFile);

export interface TextMatch {
  path: string;
  line: number;
  column: number;
  /** The matching line, trimmed. */
  text: string;
}
export interface TextSearch {
  matches: TextMatch[];
  /** Why the search did not run, or ran short, in plain words. */
  note?: string;
}

const PRIVATE = new Set(['.git', '.oms', '.keys', '.env.agent']);
const SKIPPED = new Set(['node_modules', 'target', 'dist', '.next', '.cache', 'build']);
const FILE_LIMIT = 20_000;
const MATCH_LIMIT = 500;
const WALK_LIMIT = 2_000;

/** A path with a private segment is never listed or searched, whatever the tools returned. */
export const isPrivatePath = (path: string): boolean => path.split('/').some((part) => PRIVATE.has(part));

/** The tools run on the host, read-only, with argv only (never a shell) and git's configuration that could run code off. */
async function tool(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = 10_000,
): Promise<string> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } as NodeJS.ProcessEnv;
  delete env.RIPGREP_CONFIG_PATH;
  const { stdout } = await run(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout,
    signal,
  });
  return stdout;
}
const git = (root: string, args: string[], signal?: AbortSignal, timeout?: number) =>
  tool('git', ['-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...args], root, signal, timeout);

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** `rg --json` output as matches. */
export function parseRipgrepJson(output: string): TextMatch[] {
  const matches: TextMatch[] = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: {
      type?: string;
      data?: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
        submatches?: Array<{ start: number }>;
      };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const data = event.data;
    if (event.type !== 'match' || !data?.path?.text || !data.line_number) continue;
    const path = data.path.text.replace(/^\.\//, '');
    if (isPrivatePath(path)) continue;
    matches.push({
      path,
      line: data.line_number,
      column: (data.submatches?.[0]?.start ?? 0) + 1,
      text: (data.lines?.text ?? '')
        .replace(/[\r\n]+$/, '')
        .trim()
        .slice(0, 200),
    });
    if (matches.length >= MATCH_LIMIT) break;
  }
  return matches;
}

/** Smart case, as `rg --smart-case`: a capital letter in the query makes it match case. */
const caseSensitive = (query: string) => query !== query.toLowerCase();

/** `git grep -n` output (`path:line:text`) as matches. */
export function parseGitGrep(output: string, query: string): TextMatch[] {
  const matches: TextMatch[] = [];
  for (const line of output.split('\n')) {
    const found = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!found || isPrivatePath(found[1]!)) continue;
    matches.push({
      path: found[1]!,
      line: Number(found[2]),
      column: Math.max(0, caseSensitive(query) ? found[3]!.indexOf(query) : found[3]!.toLowerCase().indexOf(query)) + 1,
      text: found[3]!.trim().slice(0, 200),
    });
    if (matches.length >= MATCH_LIMIT) break;
  }
  return matches;
}

/**
 * The project's files and a text search over them, for quick open and project search. Listing prefers git (tracked and
 * untracked files, ignored ones left out), then ripgrep, then the guarded task files. Opening and saving still go
 * through the guarded task files: this is only for finding names and lines.
 */
export class ProjectIndex {
  private readonly root: string;
  private readonly files: Pick<TaskFileAccess, 'list'>;
  private cache: Promise<string[]> | undefined;

  constructor(options: { root: string; files: Pick<TaskFileAccess, 'list'> }) {
    this.root = options.root;
    this.files = options.files;
  }

  /** Forget the list: a file was saved or created, or the agent finished a turn. */
  invalidate(): void {
    this.cache = undefined;
  }

  /** Every project file, sorted. Computed once until invalidated. */
  list(signal?: AbortSignal): Promise<string[]> {
    this.cache ??= this.build(signal).catch((error) => {
      this.cache = undefined;
      throw error;
    });
    return this.cache;
  }

  /** Files whose name is `name` (or ends with `/name`), shortest path first, for `/open lib.rs`. */
  async named(name: string): Promise<string[]> {
    const all = await this.list();
    return all.filter((path) => path === name || path.endsWith('/' + name)).sort((a, b) => a.length - b.length);
  }

  private async build(signal?: AbortSignal): Promise<string[]> {
    let paths: string[] | undefined;
    try {
      const out = await git(this.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal);
      paths = out.split('\0').filter(Boolean);
    } catch {
      // Not a repository, or no git: try ripgrep's own listing, then the task files.
    }
    if (!paths) {
      try {
        const out = await tool(
          'rg',
          ['--files', '--no-config', '--hidden', '-g', '!.git', '-g', '!node_modules', '-g', '!target'],
          this.root,
          signal,
        );
        paths = out.split('\n').filter(Boolean);
      } catch {
        paths = await this.walk(signal);
      }
    }
    return [...new Set(paths.map((path) => path.replace(/^\.\//, '')))]
      .filter((path) => !isPrivatePath(path))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .slice(0, FILE_LIMIT);
  }

  /** The guarded task files, breadth first, bounded: slow (one process per folder) but needs nothing on the host. */
  private async walk(signal?: AbortSignal): Promise<string[]> {
    const found: string[] = [];
    const queue = ['.'];
    let visited = 0;
    while (queue.length && found.length < WALK_LIMIT && visited < 200) {
      const directory = queue.shift()!;
      visited++;
      try {
        for (const entry of await this.files.list(directory, signal)) {
          if (entry.kind === 'file') found.push(entry.path);
          else if (!SKIPPED.has(posix.basename(entry.path))) queue.push(entry.path);
        }
      } catch {
        // A folder that cannot be listed (too many entries, a symlink) is skipped.
      }
    }
    return found;
  }

  /** Lines containing `query` (literal; case-insensitive unless the query has capitals), 500 at most. */
  async search(query: string, signal?: AbortSignal): Promise<TextSearch> {
    if (!query.trim()) return { matches: [] };
    const ignore = [
      '-g',
      '!.git',
      '-g',
      '!.oms',
      '-g',
      '!.keys',
      '-g',
      '!.env.agent',
      '-g',
      '!node_modules',
      '-g',
      '!target',
    ];
    try {
      const out = await tool(
        'rg',
        [
          '--json',
          '--no-config',
          '--fixed-strings',
          '--smart-case',
          '--max-count',
          '50',
          '--max-columns',
          '200',
          '--max-filesize',
          '1M',
          ...ignore,
          '-e',
          query,
          '--',
          '.',
        ],
        this.root,
        signal,
      ).catch((error: { code?: number | string; stdout?: string }) => {
        // rg exits 1 when nothing matched.
        if (error.code === 1) return '';
        throw error;
      });
      return { matches: parseRipgrepJson(out) };
    } catch (error) {
      if (signal?.aborted) return { matches: [] };
      if (!missing(error)) return { matches: [], note: 'The search could not run.' };
    }
    try {
      const out = await git(
        this.root,
        [
          'grep',
          '-n',
          '-I',
          '-F',
          ...(caseSensitive(query) ? [] : ['-i']),
          '--no-color',
          '--max-count',
          '50',
          '-e',
          query,
          '--',
          '.',
        ],
        signal,
      ).catch((error: { code?: number | string }) => {
        if (error.code === 1) return '';
        throw error;
      });
      return { matches: parseGitGrep(out, query) };
    } catch {
      return { matches: [], note: 'Project search needs ripgrep or a git repository.' };
    }
  }
}
