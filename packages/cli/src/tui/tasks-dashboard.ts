import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { VStack, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { omsCommand, readTask, type HelperView, type OmsSession } from '@oms/engine';
import { ListView, type ListItem } from './list-view.ts';
import { colorText, type OmsTheme, type ThemeRole } from './theme.ts';
import { displayText } from './transcript.ts';
import { sessionLabel } from './inspect-commands.ts';

const run = promisify(execFile);

export type TaskState = 'working' | 'awaiting' | 'idle' | 'done' | 'failed';
export interface TaskRow {
  key: string;
  kind: 'session' | 'helper' | 'task' | 'worktree';
  state: TaskState;
  name: string;
  /** What it is doing, in a few words. */
  detail: string;
  /** When it started (or, for finished work, ended): epoch milliseconds. */
  since?: number;
}
/** Where the rows come from; tests replace these. */
export interface DashboardSources {
  /** Other tasks of the workspace (a pinned-task session), without the one running. */
  tasks(harness: OmsSession): Array<{ id: string; since?: number }>;
  /** Other git worktrees of the folder (a chat), without this one. */
  worktrees(harness: OmsSession): Promise<Array<{ path: string; branch?: string }>>;
}

const GLYPH: Readonly<Record<TaskState, { glyph: string; role: ThemeRole }>> = {
  working: { glyph: '●', role: 'accent' },
  awaiting: { glyph: '◆', role: 'warning' },
  idle: { glyph: '○', role: 'muted' },
  done: { glyph: '✓', role: 'success' },
  failed: { glyph: '×', role: 'error' },
};

/** 12s, 4m, 3h, 2d: how long ago, in the fewest characters. */
export function age(since: number | undefined, now: number): string {
  if (since === undefined) return '';
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** The chips at the top: how many are waiting for you, working, idle, done and failed. Empty counts are left out. */
export function summary(rows: readonly TaskRow[]): Array<{ state: TaskState; count: number; text: string }> {
  const labels: Record<TaskState, string> = {
    awaiting: 'awaiting',
    working: 'working',
    idle: 'idle',
    done: 'done',
    failed: 'failed',
  };
  return (['awaiting', 'working', 'idle', 'done', 'failed'] as const)
    .map((state) => ({ state, count: rows.filter((row) => row.state === state).length }))
    .filter((chip) => chip.count > 0)
    .map((chip) => ({ ...chip, text: `${GLYPH[chip.state].glyph} ${chip.count} ${labels[chip.state]}` }));
}

const oneLine = (text: string, limit: number): string => displayText(text, limit).replace(/\s+/g, ' ').trim();

function helperRow(helper: HelperView): TaskRow {
  const finished = helper.endedAt !== undefined;
  const state: TaskState =
    helper.status === 'running'
      ? 'working'
      : helper.status === 'done'
        ? 'done'
        : helper.status === 'waiting'
          ? 'idle'
          : 'failed';
  const detail =
    helper.status === 'waiting'
      ? `Waiting${helper.waitingFor ? ` for ${oneLine(helper.waitingFor, 40)}` : ''}`
      : helper.status === 'running'
        ? 'Running'
        : helper.status === 'done'
          ? `Done${helper.summary ? ` · ${oneLine(helper.summary, 60)}` : ''}`
          : helper.status === 'cancelled'
            ? 'Cancelled'
            : helper.status === 'interrupted'
              ? 'Interrupted'
              : `Failed${helper.summary ? ` · ${oneLine(helper.summary, 60)}` : ''}`;
  return {
    key: `helper:${helper.id}`,
    kind: 'helper',
    state,
    name: `${oneLine(helper.agent, 40)} · ${oneLine(helper.task, 80)}`,
    detail,
    since: finished ? helper.endedAt : helper.startedAt,
  };
}

/** Every row: this session first, its helper agents, then the other tasks or worktrees of the project. */
export async function collectRows(options: {
  harness: OmsSession;
  now: number;
  /** The agent or a command is running. */
  busy: boolean;
  /** A host command waits for the user's answer. */
  awaiting: boolean;
  startedAt: number;
  sources: DashboardSources;
}): Promise<TaskRow[]> {
  const { harness, now } = options;
  const rows: TaskRow[] = [];
  let requirements = '';
  let allClosed = false;
  if (harness.kind === 'task') {
    try {
      const state = harness.evaluator.read();
      if (state.ok && state.value.items.length) {
        const closed = state.value.items.filter((item) => item.status === 'closed').length;
        requirements = `${closed}/${state.value.items.length} requirements`;
        allClosed = closed === state.value.items.length;
      }
    } catch {
      // Requirements are optional here.
    }
  }
  const label = sessionLabel(harness);
  rows.push({
    key: 'session',
    kind: 'session',
    state: options.awaiting ? 'awaiting' : options.busy ? 'working' : allClosed ? 'done' : 'idle',
    name: harness.kind === 'task' ? `${label} · ${oneLine(harness.task.id, 60)}` : label,
    detail: options.awaiting
      ? 'Waiting for your answer'
      : options.busy
        ? 'Agent working'
        : [harness.kind === 'task' ? 'This task' : 'This folder', requirements].filter(Boolean).join(' · '),
    since: options.startedAt,
  });
  if (harness.kind === 'chat') {
    try {
      for (const helper of harness.helpers.list()) rows.push(helperRow(helper));
    } catch {
      // No helper list in this session.
    }
  }
  if (harness.kind === 'task') {
    for (const task of options.sources.tasks(harness)) {
      rows.push({
        key: `task:${task.id}`,
        kind: 'task',
        state: 'idle',
        name: oneLine(task.id, 60),
        detail: 'Task',
        since: task.since,
      });
    }
  } else if (harness.folder.git) {
    for (const tree of await options.sources.worktrees(harness).catch(() => [])) {
      rows.push({
        key: `worktree:${tree.path}`,
        kind: 'worktree',
        state: 'idle',
        name: oneLine(tree.branch ?? tree.path, 80),
        detail: `Worktree · ${oneLine(tree.path, 120)}`,
      });
    }
  }
  return rows;
}

/** The real sources: tasks from the workspace's own records (read-only) and worktrees from `git worktree list`. */
export const hostSources: DashboardSources = {
  tasks(harness) {
    if (harness.kind !== 'task') return [];
    let ids: string[] = [];
    try {
      ids = readdirSync(join(harness.workspace.omsDir, 'tasks'));
    } catch {
      return [];
    }
    const found: Array<{ id: string; since?: number }> = [];
    for (const id of ids.sort().slice(0, 50)) {
      if (id === harness.task.id) continue;
      try {
        const task = readTask(harness.workspace, id);
        found.push({ id, since: statSync(task.taskFile).mtimeMs });
      } catch {
        // A task that is not a complete, matching record is not listed.
      }
    }
    return found;
  },
  async worktrees(harness) {
    if (harness.kind !== 'chat') return [];
    const { stdout } = await run(
      'git',
      ['-C', harness.root, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8', timeout: 10_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
    );
    const trees: Array<{ path: string; branch?: string }> = [];
    for (const block of stdout.split('\n\n')) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      if (!path || path === harness.root) continue;
      trees.push({ path, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] });
    }
    return trees.slice(0, 50);
  },
};

/** A helper's conversation as plain text for a read-only report: who said what, tool calls by name only. */
export function transcriptText(messages: readonly unknown[]): string {
  const out: string[] = [];
  for (const raw of messages) {
    const message = (raw ?? {}) as { role?: string; content?: unknown };
    const parts = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
    const text = parts
      .map((part: { type?: string; text?: unknown; name?: unknown }) =>
        part.type === 'text' && typeof part.text === 'string'
          ? part.text
          : part.type === 'toolCall' && typeof part.name === 'string'
            ? `[tool: ${part.name}]`
            : '',
      )
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!text) continue;
    const who = message.role === 'user' ? 'Task' : message.role === 'assistant' ? 'Helper' : 'Result';
    out.push(`${who}\n${text}\n`);
  }
  return displayText(out.join('\n') || 'No messages yet.', 60 * 1024);
}

interface DashboardOptions {
  theme: () => OmsTheme;
  render: () => void;
  harness: OmsSession;
  busy: () => boolean;
  awaiting: () => boolean;
  startedAt: number;
  sources?: DashboardSources;
  /** The user chose this session's row: go back to work. */
  back: () => void;
  openReport: (id: string, text: string, title: string) => void;
  /** Put text on the clipboard (the command that opens another task). */
  copy: (text: string) => void;
  say: (message: string) => void;
  requestFocus: () => void;
  now?: () => number;
}

/**
 * The tasks dashboard: this session, its helper agents and the project's other tasks or worktrees, one row each with a
 * state glyph, what it is doing and how long ago. Read-only: another task opens in its own session, so Enter on it
 * shows the command that does that.
 */
export class TasksDashboard {
  readonly body = new VStack();
  private rows: TaskRow[] = [];
  private loaded = false;
  private readonly list: ListView;
  private readonly options: DashboardOptions;
  private disposed = false;

  constructor(options: DashboardOptions) {
    this.options = options;
    this.list = new ListView({
      theme: options.theme,
      render: options.render,
      focused: () => true,
      items: () => this.items(),
      activate: (item) => this.activate(this.rows.find((row) => row.key === item.key)),
      requestFocus: options.requestFocus,
      empty: () => ['', `  ${colorText(options.theme(), 'muted', this.loaded ? 'Nothing to show yet.' : 'Looking…')}`],
    });
    const header: Component = {
      invalidate() {},
      render: (width) => [this.header(width)],
    };
    this.body.addChild(header, { basis: 1, shrink: 0 });
    this.body.addChild(this.list.view, { basis: 0, grow: 1, minSize: 1 });
  }

  /** Read the rows again. */
  async refresh(): Promise<void> {
    const { options } = this;
    const rows = await collectRows({
      harness: options.harness,
      now: (options.now ?? Date.now)(),
      busy: options.busy(),
      awaiting: options.awaiting(),
      startedAt: options.startedAt,
      sources: options.sources ?? hostSources,
    });
    if (this.disposed) return;
    this.rows = rows;
    this.loaded = true;
    options.render();
  }

  dispose(): void {
    this.disposed = true;
  }

  get hint(): string {
    return '↑↓ choose · Enter open · r refresh · Esc back';
  }

  handleInput(data: string): boolean {
    if (this.list.handleInput(data)) return true;
    if (data === 'r') {
      void this.refresh();
      return true;
    }
    return false;
  }

  private header(width: number): string {
    const theme = this.options.theme();
    const chips = summary(this.rows)
      .map((chip) => colorText(theme, GLYPH[chip.state].role, chip.text))
      .join(colorText(theme, 'muted', ' · '));
    return truncateToWidth(` ${colorText(theme, 'foreground', 'Tasks')}   ${chips}`, width, '');
  }

  private items(): ListItem[] {
    const theme = this.options.theme();
    const now = (this.options.now ?? Date.now)();
    // Free columns: the age sits at the right; name and detail share the rest.
    return this.rows.map((row) => {
      const mark = GLYPH[row.state];
      const text =
        `${colorText(theme, mark.role, mark.glyph)} ${colorText(theme, 'foreground', row.name)}` +
        `   ${colorText(theme, 'muted', row.detail)}`;
      return { key: row.key, text: ' ' + text, right: colorText(theme, 'muted', age(row.since, now)) };
    });
  }

  private activate(row: TaskRow | undefined): void {
    if (!row) return;
    const { options } = this;
    if (row.kind === 'session') {
      options.back();
    } else if (row.kind === 'helper') {
      const id = row.key.slice('helper:'.length);
      try {
        const harness = options.harness;
        if (harness.kind !== 'chat') return;
        options.openReport(`helper-${id}`, transcriptText(harness.helpers.messages(id)), `helper ${id}`);
      } catch {
        options.say('That helper has no conversation to show.');
      }
    } else {
      const command =
        row.kind === 'task' && options.harness.kind === 'task'
          ? `${omsCommand()} run --workspace ${options.harness.workspace.root} --task ${row.key.slice('task:'.length)}`
          : `cd ${row.key.slice('worktree:'.length)} && ${omsCommand()}`;
      options.copy(command);
      options.say(`Another task opens in its own session. Copied: ${command}`);
    }
  }
}
