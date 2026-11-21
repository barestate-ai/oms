import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { AgentCallDetails } from '@oms/engine';
import {
  countLines,
  describe,
  diffStats,
  errorLines,
  flat,
  outcome,
  programErrors,
  shellResult,
  solanaShell,
  str,
  type Described,
  type Group,
  type HelperDisplay,
  type ToolCall,
  type ToolState,
} from './display-tools.ts';
import { ARM_WIDTH, compact, elapsed, HINT, middleEllipsis, plural, type Style } from './transcript-render.ts';
import { colorBg } from './theme.ts';

/** Tool calls as one-line rows: a state dot, a verb and a target, then what happened under an arm. */

export interface RowContext {
  style: Style;
  width: number;
  /** Ctrl+O: show output in full (up to `limit` rows). */
  expanded: boolean;
  /** Whether this is the latest collapsed entry, which names the key that expands it. */
  hint: boolean;
  cwd?: string;
  now: number;
  /** Whether a running dot is drawn filled in this frame. */
  lit: boolean;
  limit: number;
  helpers?: HelperDisplay | undefined;
}
export interface Rendered {
  lines: string[];
  /** Ctrl+O would show more than these lines do. */
  collapsed: boolean;
  /** The rows depend on the clock, so they cannot be reused next frame. */
  volatile: boolean;
}

const running = (state: ToolState): boolean => state === 'pending' || state === 'running';
/** Not finished, whether it is still going or was cut off: it is named by what it was doing. */
const unfinished = (state: ToolState): boolean => state !== 'done' && state !== 'error';
/** Output shown beside a collapsed shell command: the first rows, then the last. */
const HEAD = 2;
const TAIL = 3;
/** A diff longer than this many changed lines shows its first hunk only until expanded. */
const DIFF_COLLAPSE = 40;

function dot(s: Style, state: ToolState, lit: boolean): string {
  if (running(state)) return s.accent(lit ? s.g.dot : s.g.ring);
  if (state === 'done') return s.success(s.g.dot);
  if (state === 'error') return s.theme.depth === 'none' ? s.g.cross : s.error(s.g.dot);
  return s.muted(s.g.ring);
}

function duration(call: ToolCall, now: number): number | undefined {
  return call.durationMs ?? (call.startedAt === undefined ? undefined : Math.max(0, now - call.startedAt));
}

interface HeaderOptions {
  chips?: string[];
  right?: string;
  /** The target is a file path: shortened in the middle and linked. */
  path?: string;
}
/** '● Verb  target  chip …… right', cut to the width. */
function header(ctx: RowContext, state: ToolState, verb: string, target: string, options: HeaderOptions = {}): string {
  const s = ctx.style;
  const chipText = (options.chips ?? []).map((chip) => `  ${chip}`).join('');
  const right = options.right ? s.faint(options.right) : '';
  const lead = `${dot(s, state, ctx.lit)} ${s.bold(verb)}`;
  const room = ctx.width - visibleWidth(lead) - visibleWidth(chipText) - (right ? visibleWidth(right) + 2 : 0) - 2;
  let shown = '';
  if (target && room > 1) {
    const text = options.path ? middleEllipsis(target, room) : truncateToWidth(target, room, '…');
    const link =
      options.path && getCapabilities().hyperlinks ? pathToFileURL(resolve(ctx.cwd ?? '.', options.path)).href : '';
    shown = '  ' + (link ? hyperlink(s.muted(text), link) : s.muted(text));
  }
  const left = lead + shown + chipText;
  return right ? left + ' '.repeat(Math.max(1, ctx.width - visibleWidth(left) - visibleWidth(right))) + right : left;
}

/** `rows` under the arm: the first row after it, the others at the same column. Rows are cut at the width, not wrapped. */
function arm(ctx: RowContext, rows: string[], tone?: 'error'): string[] {
  const s = ctx.style;
  const room = Math.max(1, ctx.width - ARM_WIDTH);
  const glyph = tone === 'error' ? '  ' + s.error(s.g.arm) + ' '.repeat(ARM_WIDTH - 2 - s.g.arm.length) : s.arm;
  return rows.map((row, index) => (index === 0 ? glyph : ' '.repeat(ARM_WIDTH)) + truncateToWidth(row, room, '…'));
}
/** Output text as muted rows, with `… +N lines` where rows are left out. */
function outputRows(s: Style, lines: string[], head: number, tail: number): string[] {
  if (lines.length <= head + tail + 1) return lines.map((line) => s.muted(line));
  const hidden = lines.length - head - tail;
  return [
    ...lines.slice(0, head).map((line) => s.muted(line)),
    s.faint(`… +${hidden} lines`),
    ...lines.slice(lines.length - tail).map((line) => s.muted(line)),
  ];
}
const number = (s: Style, value: number, noun: string): string =>
  `${s.bold(String(value))} ${s.muted(value === 1 ? noun : `${noun}s`)}`;

function withHint(ctx: RowContext, rows: string[], collapsed: boolean): string[] {
  if (!collapsed || !ctx.hint || !rows.length) return rows;
  const last = rows.length - 1;
  return [...rows.slice(0, last), `${rows[last]} ${ctx.style.faint(HINT)}`];
}

function failure(ctx: RowContext, call: ToolCall): { rows: string[]; collapsed: boolean } {
  const lines = errorLines(call.text, ctx.expanded ? ctx.limit : 3);
  const total = countLines(call.text);
  const more = !ctx.expanded && total > lines.length;
  const rows = lines.map((line) => ctx.style.error(line));
  if (more) rows.push(ctx.style.faint(`… +${total - lines.length} lines`));
  return { rows, collapsed: more };
}

// ---------------------------------------------------------------- one call

/** Output below a shell-like call: head and tail collapsed, a longer window when expanded. */
function shellBody(ctx: RowContext, call: ToolCall, text: string): { rows: string[]; collapsed: boolean } {
  const s = ctx.style;
  const lines = text ? text.split('\n') : [];
  if (!lines.length) return { rows: call.state === 'done' ? [s.faint('(no output)')] : [], collapsed: false };
  if (running(call.state)) return { rows: lines.slice(-TAIL).map((line) => s.muted(line)), collapsed: false };
  if (ctx.expanded) {
    const half = Math.floor(ctx.limit / 2);
    return { rows: outputRows(s, lines, half, half), collapsed: false };
  }
  return { rows: outputRows(s, lines, HEAD, TAIL), collapsed: lines.length > HEAD + TAIL + 1 };
}

function shell(ctx: RowContext, call: ToolCall): Rendered {
  const s = ctx.style;
  const { output, chip } = shellResult(call.text);
  const failed = call.state === 'error';
  const solana = call.state === 'done' && !chip ? solanaShell(str(call.args.command), output) : undefined;
  const ms = duration(call, ctx.now);
  const shown = running(call.state) ? ms !== undefined && ms >= 2000 : ms !== undefined && ms >= 5000;
  const facts = solana?.facts.map((fact) => (fact.startsWith('✓') ? s.success(fact) : s.muted(fact))) ?? [];
  const chips = chip
    ? [s.error(chip)]
    : failed
      ? [s.error('failed')]
      : facts.length
        ? [facts.join(s.faint(' · '))]
        : [];
  const head = header(
    ctx,
    call.state,
    solana ? solana.verb : unfinished(call.state) ? 'Running' : 'Ran',
    solana ? solana.target : describe(call, ctx.cwd).target,
    { chips, ...(shown ? { right: elapsed(ms!) } : {}) },
  );
  if (call.state === 'pending') return { lines: [head], collapsed: false, volatile: true };
  // A named Solana action is one line; the command's own output is for Ctrl+O.
  const body = solana && !ctx.expanded ? { rows: [], collapsed: output !== '' } : shellBody(ctx, call, output);
  const errors = programErrors(call.text).map((line) => s.error(line));
  const rows = [...body.rows, ...errors];
  if (!rows.length)
    return {
      lines: [ctx.hint && body.collapsed ? `${head} ${s.faint(HINT)}` : head],
      collapsed: body.collapsed,
      volatile: running(call.state),
    };
  const lines = [head, ...arm(ctx, withHint(ctx, rows, body.collapsed), failed ? 'error' : undefined)];
  return { lines, collapsed: body.collapsed, volatile: running(call.state) };
}

/** A unified diff, gutter and sign beside each row, additions and removals on their tinted backgrounds. */
function diffRows(ctx: RowContext, diff: string, collapse: boolean): { rows: string[]; hidden: string } {
  const s = ctx.style;
  type Row = { sign: string; num: string; text: string } | undefined;
  // undefined marks the gap between two hunks.
  const parsed: Row[] = diff.split('\n').flatMap((line): Row[] => {
    const match = /^([+\- ])(\s*\d*) (.*)$/.exec(line);
    if (!match) return line.trim() ? [{ sign: ' ', num: '', text: line }] : [];
    const text = match[3]!.replace(/\t/g, '   ');
    if (!match[2]!.trim() && match[1] === ' ')
      return text.trim() === '...' ? [undefined] : [{ sign: ' ', num: '', text }];
    return [{ sign: match[1]!, num: match[2]!.trim(), text }];
  });
  // A single removed line followed by a single added line: show what changed inside the line in bold.
  const marked = new Map<number, string>();
  parsed.forEach((row, index) => {
    const next = parsed[index + 1];
    if (!row || !next || row.sign !== '-' || next.sign !== '+') return;
    if (parsed[index - 1]?.sign === '-' || parsed[index + 2]?.sign === '+') return;
    const [a, b] = [row.text, next.text];
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    if (!start && !end) return;
    const mark = (text: string) => {
      const middle = text.slice(start, text.length - end);
      return middle.trim() ? text.slice(0, start) + s.bold(middle) + text.slice(text.length - end) : text;
    };
    marked.set(index, mark(a));
    marked.set(index + 1, mark(b));
  });
  const numbers = Math.max(2, ...parsed.map((row) => row?.num.length ?? 0));
  const room = Math.max(1, ctx.width - ARM_WIDTH);
  const code = Math.max(1, room - numbers - 3);
  const rows: string[] = [];
  const hunks: number[] = [0];
  for (const [index, row] of parsed.entries()) {
    if (!row) {
      hunks.push(rows.length);
      rows.push(' '.repeat(numbers + 1) + s.faint(s.g.more));
      continue;
    }
    const added = row.sign === '+';
    const removed = row.sign === '-';
    const sign = added ? s.fg('diffAdded', '+') : removed ? s.fg('diffRemoved', s.g.minus) : ' ';
    wrapTextWithAnsi(marked.get(index) ?? (row.text || ' '), code).forEach((part, at) => {
      // Numbers on a tinted row use the muted tone: the faint one is about 1.5:1 against the 256-color tints.
      const number = (text: string) => (added || removed ? s.muted(text) : s.faint(text));
      const lead = at === 0 ? `${number(row.num.padStart(numbers))} ${sign} ` : ' '.repeat(numbers + 3);
      const body = lead + (added || removed ? part : s.muted(part));
      rows.push(
        s.paints && (added || removed) ? colorBg(s.theme, added ? 'diffAdded' : 'diffRemoved', body, room) : body,
      );
    });
  }
  const changed = parsed.filter((row) => row && row.sign !== ' ').length;
  if (!collapse || changed <= DIFF_COLLAPSE) return { rows, hidden: '' };
  if (hunks.length > 1)
    return {
      rows: rows.slice(0, hunks[1]),
      hidden: `+${hunks.length - 1} more ${hunks.length === 2 ? 'hunk' : 'hunks'}`,
    };
  return { rows: rows.slice(0, DIFF_COLLAPSE), hidden: `+${rows.length - DIFF_COLLAPSE} lines` };
}

function edit(ctx: RowContext, call: ToolCall): Rendered {
  const s = ctx.style;
  const described = describe(call, ctx.cwd);
  const diff = str(call.details?.diff);
  const stats = diff ? diffStats(diff) : undefined;
  const chips = stats
    ? [`${s.fg('diffAdded', `+${stats.added}`)} ${s.fg('diffRemoved', `${s.g.minus}${stats.removed}`)}`]
    : [];
  const head = header(ctx, call.state, unfinished(call.state) ? described.doing : described.did, described.target, {
    chips,
    path: described.target,
  });
  if (call.state === 'error') {
    const body = failure(ctx, call);
    return {
      lines: [head, ...arm(ctx, withHint(ctx, body.rows, body.collapsed), 'error')],
      collapsed: body.collapsed,
      volatile: false,
    };
  }
  if (running(call.state)) return { lines: [head], collapsed: false, volatile: true };
  if (diff) {
    const { rows, hidden } = diffRows(ctx, diff, !ctx.expanded);
    const tail = hidden ? [s.faint(`… ${hidden}`)] : [];
    return {
      lines: [head, ...arm(ctx, withHint(ctx, [...rows, ...tail], !!hidden))],
      collapsed: !!hidden,
      volatile: false,
    };
  }
  // A new file: how long it is, and the content itself when expanded.
  const content = str(call.args.content);
  const total = call.details?.lines === undefined ? countLines(content) : Number(call.details.lines);
  const summary = number(s, total, 'line');
  const body =
    ctx.expanded && content
      ? outputRows(s, content.replace(/\n$/, '').split('\n'), Math.floor(ctx.limit / 2), Math.floor(ctx.limit / 2))
      : [];
  const collapsed = !ctx.expanded && content !== '';
  return { lines: [head, ...arm(ctx, withHint(ctx, [summary, ...body], collapsed))], collapsed, volatile: false };
}

function agent(ctx: RowContext, call: ToolCall): Rendered {
  const s = ctx.style;
  const details = call.details as Partial<AgentCallDetails> | undefined;
  const failed = call.state === 'error' || details?.status === 'failed';
  const ms = details?.elapsedMs ?? duration(call, ctx.now);
  const first = flat(
    call.text.split('\n').find((line) => line.trim()),
    70,
  );
  let status: string;
  if (failed) status = `failed · ${first}`;
  else if (details?.status === 'waiting')
    status = `waiting${details.waitingFor ? ` for ${flat(details.waitingFor, 60)}` : ''}`;
  else if (details?.status === 'running' || !details?.status) status = 'running';
  else
    status = `${flat(details.status, 20)} · ${compact(Number(details.tokens) || 0)} tokens${details.summary ? ` · ${flat(details.summary, 60)}` : ''}`;
  const state: ToolState = failed ? 'error' : call.state;
  const head = header(
    ctx,
    state,
    'Agent',
    describe(call, ctx.cwd).target,
    ms === undefined || ms < 1000 ? {} : { right: elapsed(ms) },
  );
  const transcript = ctx.expanded && details?.id ? ctx.helpers?.transcript(details.id) : undefined;
  const nested = transcript
    ? transcript.render(Math.max(1, ctx.width - ARM_WIDTH)).map((line) => ' '.repeat(ARM_WIDTH) + line)
    : [];
  const collapsed = !ctx.expanded && !!details?.id && !!ctx.helpers;
  const rows = withHint(ctx, [failed ? s.error(status) : s.muted(status)], collapsed);
  return {
    lines: [head, ...arm(ctx, rows, failed ? 'error' : undefined), ...nested],
    collapsed,
    volatile: running(call.state),
  };
}

/** Anything else with a name: reads, listings, searches, fetches and lookups. */
function plain(ctx: RowContext, call: ToolCall, described: Described): Rendered {
  const s = ctx.style;
  const isPath = described.kind === 'read' || described.kind === 'list';
  const head = header(
    ctx,
    call.state,
    unfinished(call.state) ? described.doing : described.did,
    described.target,
    isPath ? { path: str(call.args.path ?? call.args.file_path) } : {},
  );
  if (call.state === 'pending' || call.state === 'running' || call.state === 'interrupted')
    return { lines: [head], collapsed: false, volatile: running(call.state) };
  if (call.state === 'error') {
    const body = failure(ctx, call);
    return {
      lines: [head, ...arm(ctx, withHint(ctx, body.rows, body.collapsed), 'error')],
      collapsed: body.collapsed,
      volatile: false,
    };
  }
  const summary = outcome(call, described);
  const counted = /^(\d+) (lines?|entr(?:y|ies)|match(?:es)?|files?|results?)$/.exec(summary);
  const first = counted ? `${s.bold(counted[1]!)} ${s.muted(counted[2]!)}` : s.muted(summary);
  const text = call.text.trim();
  const full =
    ctx.expanded && text ? outputRows(s, text.split('\n'), Math.floor(ctx.limit / 2), Math.floor(ctx.limit / 2)) : [];
  const collapsed = !ctx.expanded && text !== '' && countLines(text) > 1;
  return { lines: [head, ...arm(ctx, withHint(ctx, [first, ...full], collapsed))], collapsed, volatile: false };
}

/** One tool call as rows; a call cut off before it finished says so under its name. */
export function renderTool(call: ToolCall, ctx: RowContext): Rendered {
  const described = describe(call, ctx.cwd);
  let drawn: Rendered;
  switch (described.kind) {
    case 'shell':
      drawn = shell(ctx, call);
      break;
    case 'edit':
    case 'write':
      drawn = edit(ctx, call);
      break;
    case 'agent':
      drawn = agent(ctx, call);
      break;
    default:
      drawn = plain(ctx, call, described);
  }
  if (call.state !== 'interrupted') return drawn;
  const note = ctx.style.muted('interrupted');
  return { ...drawn, lines: [...drawn.lines, (drawn.lines.length > 1 ? ' '.repeat(ARM_WIDTH) : ctx.style.arm) + note] };
}

// ---------------------------------------------------------------- a run of read-only calls

/** Whether a call may join an 'Explored' group: read-only, and finished or still going well. */
export function groupable(call: ToolCall, cwd?: string): boolean {
  return !!describe(call, cwd).group && call.state !== 'error' && call.state !== 'interrupted';
}

const SUBLINE: Record<Group, string> = { files: 'Read', searches: 'Searched', pages: 'Opened' };
/** '● Explored  3 files · 2 searches' with what was read and searched under it. */
export function renderExplore(calls: ToolCall[], ctx: RowContext): Rendered {
  const s = ctx.style;
  const described = calls.map((call) => describe(call, ctx.cwd));
  const live = calls.some((call) => running(call.state));
  const by = (group: Group) => described.filter((entry) => entry.group === group);
  const counts = [
    by('files').length && plural(by('files').length, 'file'),
    by('searches').length && plural(by('searches').length, 'search', 'searches'),
    by('pages').length && plural(by('pages').length, 'page'),
  ].filter(Boolean);
  const head = header(
    ctx,
    live ? 'running' : 'done',
    live ? 'Exploring' : 'Explored',
    counts.join(' · ') + (live ? '…' : ''),
  );
  let rows: string[];
  if (ctx.expanded) {
    rows = calls.map((call, index) => {
      const entry = described[index]!;
      const result = call.state === 'done' ? outcome(call, entry) : '';
      return (
        s.muted(`${running(call.state) ? entry.doing : entry.did} ${entry.target}`) +
        (result ? s.muted(` · ${result}`) : '')
      );
    });
  } else {
    rows = (['files', 'searches', 'pages'] as const).flatMap((group) => {
      const names = [...new Set(by(group).map((entry) => entry.short))];
      if (!names.length) return [];
      const room = Math.max(10, ctx.width - ARM_WIDTH - SUBLINE[group].length - 1);
      let list = names.join(', ');
      if (visibleWidth(list) > room) {
        let used = 0;
        const fit = names.filter((name) => (used += visibleWidth(name) + 2) <= room - 10);
        list = `${fit.join(', ')}${fit.length ? ', ' : ''}+${names.length - fit.length} more`;
      }
      return [s.muted(`${SUBLINE[group]} ${list}`)];
    });
  }
  return { lines: [head, ...arm(ctx, withHint(ctx, rows, !ctx.expanded))], collapsed: !ctx.expanded, volatile: live };
}
