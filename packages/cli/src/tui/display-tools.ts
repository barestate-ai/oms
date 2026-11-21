import { basename, isAbsolute, relative } from 'node:path';
import type { Component } from '@earendil-works/pi-tui';
import { AGENT_TOOL, decodeProgramError, parseErrorCode } from '@oms/engine';

/**
 * What the transcript says about each tool call: its verb, its target and what it came to, as text. Display only: the
 * calls and results come from the event stream already masked, and nothing here reaches the model.
 */

/** Where a helper's own conversation comes from, for Ctrl+O. */
export interface HelperDisplay {
  transcript(id: string): Component | undefined;
}

export type ToolState = 'pending' | 'running' | 'done' | 'error' | 'interrupted';
export type Args = Record<string, unknown>;
/** One tool call as the transcript tracks it. Strings are already masked and free of terminal sequences. */
export interface ToolCall {
  id: string;
  name: string;
  args: Args;
  state: ToolState;
  /** The result text so far (partial while running). */
  text: string;
  details?: Record<string, unknown> | undefined;
  startedAt?: number;
  durationMs?: number;
  /** A command the user ran themselves, not one the model chose. */
  user?: boolean;
}
type Kind = 'read' | 'list' | 'search' | 'fetch' | 'lookup' | 'shell' | 'edit' | 'write' | 'agent' | 'other';
/** What a read-only call counts as in an 'Explored' line. */
export type Group = 'files' | 'searches' | 'pages';

export const str = (value: unknown): string => (typeof value === 'string' ? value : '');
/** One line of at most `limit` characters. */
export function flat(value: unknown, limit = 120): string {
  const line = str(value).replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}
const quoted = (value: unknown): string => `"${flat(value, 80)}"`;

/** A path as the model wrote it, relative to the folder when it is inside it. */
function shownPath(value: unknown, cwd?: string): string {
  const path = str(value);
  if (cwd && isAbsolute(path)) {
    const rel = relative(cwd, path);
    if (rel && !rel.startsWith('..')) return flat(rel, 200);
  }
  return flat(path, 200);
}
const host = (value: unknown): string =>
  flat(
    str(value)
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, ''),
    80,
  );

interface Spec {
  kind: Kind;
  group?: Group;
  doing: string;
  did: string;
  target: (args: Args, cwd?: string) => string;
  /** The name in an 'Explored' sub-line. */
  short?: (args: Args, cwd?: string) => string;
}
const where = (args: Args, cwd?: string): string => (str(args.path) ? ` in ${shownPath(args.path, cwd)}` : '');
const lookup = (
  doing: string,
  did: string,
  group: Group | undefined,
  target: Spec['target'],
  short?: Spec['short'],
): Spec => ({
  kind: group === 'pages' ? 'fetch' : 'lookup',
  ...(group ? { group } : {}),
  doing,
  did,
  target,
  ...(short ? { short } : {}),
});

const SPECS: Record<string, Spec> = {
  read: {
    kind: 'read',
    group: 'files',
    doing: 'Reading',
    did: 'Read',
    target: (a, cwd) => {
      const path = shownPath(a.path ?? a.file_path, cwd);
      const from = Number(a.offset);
      const count = Number(a.limit);
      return Number.isFinite(from) && from > 0
        ? `${path}:${from}${Number.isFinite(count) && count > 0 ? `-${from + count - 1}` : ''}`
        : path;
    },
    short: (a, cwd) => basename(shownPath(a.path ?? a.file_path, cwd)),
  },
  ls: {
    kind: 'list',
    group: 'searches',
    doing: 'Listing',
    did: 'Listed',
    target: (a, cwd) => shownPath(a.path, cwd) || '.',
    short: (a, cwd) => shownPath(a.path, cwd) || '.',
  },
  find: {
    kind: 'search',
    group: 'searches',
    doing: 'Finding',
    did: 'Found',
    target: (a, cwd) => `${flat(a.pattern, 80)}${where(a, cwd)}`,
    short: (a) => flat(a.pattern, 40),
  },
  grep: {
    kind: 'search',
    group: 'searches',
    doing: 'Searching',
    did: 'Searched',
    target: (a, cwd) => `${quoted(a.pattern)}${where(a, cwd)}`,
    short: (a) => quoted(a.pattern),
  },
  web_search: lookup(
    'Searching',
    'Searched',
    'searches',
    (a) => `the web ${quoted(a.query)}`,
    (a) => quoted(a.query),
  ),
  web_fetch: lookup(
    'Fetching',
    'Fetched',
    'pages',
    (a) => host(a.url),
    (a) => host(a.url),
  ),
  source_fetch: lookup(
    'Fetching',
    'Fetched',
    'pages',
    (a) => `source ${host(a.url ?? a.source)}`,
    (a) => host(a.url ?? a.source),
  ),
  solana_docs_search: lookup(
    'Searching',
    'Searched',
    'searches',
    (a) => `Solana docs ${quoted(a.query)}`,
    (a) => quoted(a.query),
  ),
  search_docs: lookup(
    'Searching',
    'Searched',
    'searches',
    (a) => `Solana docs ${quoted(a.query)}`,
    (a) => quoted(a.query),
  ),
  solana_ask: lookup(
    'Asking',
    'Asked',
    'searches',
    (a) => `Solana docs ${quoted(a.question ?? a.query)}`,
    (a) => quoted(a.question ?? a.query),
  ),
  solana_list_sections: lookup('Listing', 'Listed', 'searches', () => 'Solana doc sections'),
  solana_get_documentation: lookup(
    'Reading',
    'Read',
    'pages',
    (a) => `Solana docs ${flat(a.section ?? a.name ?? a.path, 120)}`.trim(),
    (a) => flat(a.section ?? a.name ?? a.path, 40),
  ),
  read_doc: lookup(
    'Reading',
    'Read',
    'pages',
    (a) => `doc ${flat(a.id ?? a.path ?? a.url, 160)}`,
    (a) => flat(a.id ?? a.path ?? a.url, 40),
  ),
  list_sources: lookup('Listing', 'Listed', 'searches', () => 'doc sources'),
  idl_lookup: lookup(
    'Looking up',
    'Looked up',
    'searches',
    (a) => `IDL ${flat(a.program ?? a.name ?? a.query, 120)}`,
    (a) => flat(a.program ?? a.name ?? a.query, 40),
  ),
  api_lookup: lookup(
    'Looking up',
    'Looked up',
    'searches',
    (a) => `API ${flat(a.name ?? a.query ?? a.symbol, 120)}`,
    (a) => flat(a.name ?? a.query ?? a.symbol, 40),
  ),
  detect_topics: lookup('Detecting', 'Detected', 'searches', () => 'Solana topics'),
  list_topics: lookup('Listing', 'Listed', 'searches', () => 'Solana topics'),
  get_topic: lookup(
    'Reading',
    'Read',
    'pages',
    (a) => `topic ${flat(a.name ?? a.id ?? a.topic, 120)}`,
    (a) => flat(a.name ?? a.id ?? a.topic, 40),
  ),
  decode_error: lookup(
    'Decoding',
    'Decoded',
    undefined,
    (a) => `error ${flat(a.code, 40)}${a.program ? ` of ${flat(a.program, 60)}` : ''}`,
  ),
  toolchain_check: lookup('Checking', 'Checked', undefined, () => 'the Solana toolchain'),
  deps_fetch: lookup('Fetching', 'Fetched', undefined, () => 'dependencies'),
  read_log: lookup('Reading', 'Read', undefined, (a) => `command log ${flat(a.id, 40)}`),
  bash: {
    kind: 'shell',
    doing: 'Running',
    did: 'Ran',
    // The first line of the command; a script of several lines ends in an ellipsis.
    target: (a) => {
      const lines = str(a.command)
        .split('\n')
        .filter((line) => line.trim());
      return flat(lines[0], 400) + (lines.length > 1 ? ' …' : '');
    },
  },
  edit: { kind: 'edit', doing: 'Editing', did: 'Edited', target: (a, cwd) => shownPath(a.path ?? a.file_path, cwd) },
  write: { kind: 'write', doing: 'Writing', did: 'Wrote', target: (a, cwd) => shownPath(a.path ?? a.file_path, cwd) },
  [AGENT_TOOL]: {
    kind: 'agent',
    doing: 'Working',
    did: 'Worked',
    target: (a) => `${flat(a.agent, 32)} · ${flat(a.task, 300)}`,
  },
};

/** How the transcript names a call: its kind, its verbs and the text after them. */
export interface Described {
  kind: Kind;
  group?: Group;
  doing: string;
  did: string;
  target: string;
  /** For an 'Explored' sub-line. */
  short: string;
}
export function describe(call: ToolCall, cwd?: string): Described {
  const spec = SPECS[call.name];
  if (spec) {
    const target = spec.target(call.args, cwd);
    return {
      kind: spec.kind,
      ...(spec.group ? { group: spec.group } : {}),
      doing: spec.doing,
      did: spec.did,
      target,
      short: spec.short?.(call.args, cwd) ?? target,
    };
  }
  const first = Object.values(call.args).find((value) => typeof value === 'string');
  const target = first ? quoted(first) : '';
  return { kind: 'other', doing: call.name, did: call.name, target, short: target };
}

// ---------------------------------------------------------------- results

/** Lines in a text, not counting a trailing newline. */
export const countLines = (text: string): number => {
  const body = text.replace(/\n+$/, '');
  return body ? body.split('\n').length : 0;
};
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const STATUS =
  /\n*(Command exited with code (\d+)|Command timed out after \d+ seconds|Command aborted|Command terminated without an exit code)\s*$/;
/** A shell result split into its output and the status line pi appends to it ('exit 1', 'timed out'). */
export function shellResult(text: string): { output: string; chip?: string } {
  const match = STATUS.exec(text);
  if (!match) return { output: text.replace(/\s+$/, '') };
  const output = text.slice(0, match.index).replace(/\s+$/, '');
  const status = match[1]!;
  const chip = match[2]
    ? `exit ${match[2]}`
    : status.includes('timed out')
      ? 'timed out'
      : status.includes('aborted')
        ? 'aborted'
        : 'no exit code';
  return { output, chip };
}

/** Added and removed lines of a diff in pi's format ('+12 text', '-12 text', ' 12 text'). */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

const count = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;
const COUNTED = ['results', 'hits', 'matches', 'items', 'sections', 'topics', 'docs', 'sources', 'entries'];
/** What a lookup or fetch came to in a few words: '3 results', '12 KB', or the first line of the answer. */
export function outcome(call: ToolCall, described: Described): string {
  const text = call.text.trim();
  if (!text) return 'no output';
  switch (described.kind) {
    case 'read':
      return count(countLines(text), 'line');
    case 'list':
      return count(countLines(text), 'entry', 'entries');
    case 'fetch':
      return formatBytes(Buffer.byteLength(text));
    case 'search':
      if (call.name === 'grep' || call.name === 'find')
        return /^no matches|^no files/i.test(text)
          ? 'no matches'
          : call.name === 'grep'
            ? count(countLines(text), 'match', 'matches')
            : count(countLines(text), 'file');
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const value: unknown = JSON.parse(text);
      const list = Array.isArray(value) ? value : COUNTED.map((key) => (value as Args)[key]).find(Array.isArray);
      if (Array.isArray(list)) return count(list.length, 'result');
    } catch {
      // Not JSON: the first line says it.
    }
  }
  return flat(
    text.split('\n').find((line) => line.trim()),
    100,
  );
}

/** The first few lines of an error text, one per row. */
export function errorLines(text: string, count = 3): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(0, count);
}

// ---------------------------------------------------------------- Solana

/** 7xKXtg2C…9fGh: the first and last four characters of an address or signature. */
const shortKey = (key: string): string => (key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key);
const ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const SIGNATURE = /\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/;

/** A shell command that does one of the Solana things people care about, named for what it did. */
interface SolanaShell {
  verb: string;
  target: string;
  /** Plain facts after the target: '✓ confirmed', 'slot 1,204'. */
  facts: string[];
}
export function solanaShell(command: string, output: string): SolanaShell | undefined {
  const line = command.trim();
  const airdrop = /^solana\s+airdrop\s+([\d.]+)(?:\s+([1-9A-HJ-NP-Za-km-z]{32,44}))?/.exec(line);
  if (airdrop)
    return {
      verb: 'Airdropped',
      target: `${airdrop[1]} SOL${airdrop[2] ? ` → ${shortKey(airdrop[2])}` : ''}`,
      facts: [],
    };
  if (/^(?:anchor\s+deploy|solana\s+program\s+deploy)\b/.test(line)) {
    const id = /Program Id:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(output)?.[1] ?? ADDRESS.exec(output)?.[0];
    const name = /--program-name\s+(\S+)/.exec(line)?.[1] ?? /deploy\s+(?:\S*\/)?([\w-]+)\.so\b/.exec(line)?.[1];
    return { verb: 'Deployed', target: [name, id ? shortKey(id) : ''].filter(Boolean).join('  '), facts: [] };
  }
  if (/^solana\s+(?:transfer|confirm)\b/.test(line)) {
    const signature =
      /Signature:\s*(\S+)/.exec(output)?.[1] ?? SIGNATURE.exec(line)?.[0] ?? SIGNATURE.exec(output)?.[0];
    if (!signature) return undefined;
    const slot = /Slot:\s*(\d+)/.exec(output)?.[1];
    const units = /Compute Units Consumed:\s*(\d+)/i.exec(output)?.[1];
    return {
      verb: 'Sent tx',
      target: shortKey(signature),
      facts: [
        ...(/\b(?:Finalized|Confirmed)\b/i.test(output) ? ['✓ confirmed'] : []),
        ...(slot ? [`slot ${Number(slot).toLocaleString('en-US')}`] : []),
        ...(units ? [`CU ${Number(units).toLocaleString('en-US')}`] : []),
      ],
    };
  }
  return undefined;
}

/** 'custom program error 0x1771 → ConstraintSeeds' for each program error code in a result the offline tables name. */
export function programErrors(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/custom program error:\s*(0x[0-9a-f]+|\d+)/gi)) {
    const code = parseErrorCode(match[1]!);
    if (code === undefined) continue;
    const { matches } = decodeProgramError(code, undefined, []);
    const names = new Set(matches.map((entry) => entry.name));
    if (names.size === 1) found.add(`custom program error ${match[1]} → ${[...names][0]}`);
    if (found.size === 2) break;
  }
  return [...found];
}
