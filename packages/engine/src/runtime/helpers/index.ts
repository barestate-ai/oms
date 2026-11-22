import { SessionManager, type AgentSession, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { hostSandbox } from '@oms/sandbox';
import { Type } from 'typebox';
import type { HostTrust } from '../host-approval.ts';
import type { SessionApiParts } from '../session-api.ts';
import { AGENT_TOOL, loadAgents, writeAgent, type AgentDefinition, type AgentDirs, type AgentDraft } from './agents.ts';
import { ClaimTable } from './claims.ts';
import { delegationSection } from './prompt.ts';
import {
  foldHelperEntries,
  HELPER_ENTRY,
  usageOf,
  type HelperEntryData,
  type HelperRecord,
  type HelperStatus,
} from './records.ts';
import { HELPER_RESULT_TEXT_MAX, helperReadiness, RequestGate, runHelper } from './runner.ts';

export { AGENT_TOOL } from './agents.ts';
export { SUBAGENT_PROMPT } from './prompt.ts';
export type { AgentDefinition, AgentDraft } from './agents.ts';
export type { HelperRecord, HelperStatus } from './records.ts';

export const HELPER_CAPS = { parallel: 4, perRequest: 12 } as const;

export interface HelperView extends HelperRecord {
  tokens: number;
  spendMicroUsd: number;
  /** The helper this one is queued behind, while it waits for a slot or for files. */
  waitingFor?: string;
}

/** The whole surface the terminal reads. */
export interface Helpers {
  agents(): { agents: AgentDefinition[]; problems: string[] };
  list(): HelperView[];
  createAgent(draft: AgentDraft): string;
  /** A helper's own conversation, live while it runs and from its saved file afterwards. */
  messages(id: string): readonly unknown[];
  cancel(id?: string): Promise<void>;
  /** Whether the agent tool is offered with the model selected now. */
  available(): { ok: true } | { ok: false; reason: string };
}

/** What the tool puts in `details`, for the one-line transcript entry. */
export interface AgentCallDetails {
  id: string;
  agent: string;
  status: HelperStatus;
  elapsedMs: number;
  tokens: number;
  summary?: string;
  waitingFor?: string;
}

const CLAUDE_CODE_REASON =
  'Helpers need a direct model. Claude Code runs as one chat, so pick another model with /model.';

const firstLine = (text: string): string => (text.split('\n').find((line) => line.trim()) ?? '').trim().slice(0, 160);

export const formatElapsed = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))}s`;
export const formatTokens = (tokens: number): string =>
  tokens >= 1000 ? `${Math.round(tokens / 1000)}k tokens` : `${tokens} tokens`;

interface Live {
  ac: AbortController;
  session?: AgentSession;
  done: Promise<unknown>;
}

const parameters = Type.Object({
  agent: Type.String({ description: 'The agent to use: explore, build, review, or a custom agent.' }),
  task: Type.String({ description: 'A self-contained task. The helper sees none of this chat.' }),
  files: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'For an agent that edits: the files or globs (like src/**) it may change. Omit for the whole folder.',
    }),
  ),
});

export function createHelpers(config: { dirs: AgentDirs; trust: HostTrust }): {
  api: Helpers;
  extension: ExtensionFactory;
  bind(parts: SessionApiParts): void;
  abortAll(): Promise<void>;
} {
  let bound: SessionApiParts | undefined;
  const records = new Map<string, HelperRecord>();
  const waiting = new Map<string, string>();
  const live = new Map<string, Live>();
  let claims: ClaimTable;
  const gate = new RequestGate();
  let requestStarted = 0;
  const slots: Array<() => void> = [];
  let running = 0;
  let sequence = 0;
  const noticed = new Set<'read' | 'edit'>();

  const parts = (): SessionApiParts => {
    if (!bound) throw new Error('Helpers are not ready yet');
    return bound;
  };
  const currentModel = () => bound?.model.session.model;
  const available = (): ReturnType<Helpers['available']> =>
    currentModel()?.provider === 'claude-code' ? { ok: false, reason: CLAUDE_CODE_REASON } : { ok: true };

  const acquireSlot = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    if (running < HELPER_CAPS.parallel) {
      running++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const turn = () => {
        signal.removeEventListener('abort', abort);
        running++;
        resolve();
      };
      const abort = () => {
        slots.splice(slots.indexOf(turn), 1);
        reject(signal.reason ?? new Error('Cancelled'));
      };
      signal.addEventListener('abort', abort, { once: true });
      slots.push(turn);
    });
  };
  const releaseSlot = () => {
    running--;
    slots.shift()?.();
  };

  const record = (id: string, change: Partial<HelperRecord>): HelperRecord => {
    const next = { ...records.get(id)!, ...change };
    records.set(id, next);
    return next;
  };
  const entry = (data: HelperEntryData) => parts().env.manager.appendCustomEntry(HELPER_ENTRY, data);

  const view = (item: HelperRecord): HelperView => ({
    ...item,
    ...(bound ? usageOf(bound.env.budget, item.turnId) : { tokens: 0, spendMicroUsd: 0 }),
    ...(waiting.has(item.id) ? { waitingFor: waiting.get(item.id) } : {}),
  });

  const execute = async (
    params: { agent: string; task: string; files?: string[] },
    signal: AbortSignal | undefined,
    onUpdate: ((update: { content: { type: 'text'; text: string }[]; details: AgentCallDetails }) => void) | undefined,
  ) => {
    const p = parts();
    const unavailable = available();
    if (!unavailable.ok) throw new Error(unavailable.reason);
    const { agents } = loadAgents(config.dirs);
    const def = agents.find((agent) => agent.name === params.agent);
    if (!def)
      throw new Error(`No agent named "${params.agent}". Available: ${agents.map((agent) => agent.name).join(', ')}.`);
    if (!params.task?.trim()) throw new Error('Give the helper a task.');
    if (requestStarted >= HELPER_CAPS.perRequest)
      throw new Error(`At most ${HELPER_CAPS.perRequest} helpers can start for one request. Do the rest yourself.`);

    const chat = p.model.session.model!;
    const model = def.model
      ? p.model.modelRuntime.getModel(...(def.model.split(/\/(.+)/).slice(0, 2) as [string, string]))
      : chat;
    if (!model) throw new Error(`The model ${def.model} of agent ${def.name} is not available.`);
    if (model.provider === 'claude-code') throw new Error(CLAUDE_CODE_REASON);
    const readiness = helperReadiness(p, model);
    if (!readiness.ready) throw new Error(readiness.detail);

    requestStarted++;
    const id = `${def.name}#${++sequence}`;
    const ac = new AbortController();
    const outer = AbortSignal.any([ac.signal, ...(signal ? [signal] : [])]);
    const startedAt = Date.now();
    const turnId = crypto.randomUUID();
    records.set(id, {
      id,
      agent: def.name,
      task: params.task.trim().slice(0, 300),
      model: `${model.provider}/${model.id}`,
      status: 'waiting',
      startedAt,
      turnId,
      sessionFile: '',
    });
    const details = (status: HelperStatus, extra: Partial<AgentCallDetails> = {}): AgentCallDetails => ({
      id,
      agent: def.name,
      status,
      elapsedMs: Date.now() - startedAt,
      tokens: usageOf(p.env.budget, turnId).tokens,
      ...(waiting.has(id) ? { waitingFor: waiting.get(id) } : {}),
      ...extra,
    });
    const push = () => {
      const now = details(records.get(id)!.status);
      onUpdate?.({
        content: [{ type: 'text', text: `${def.name} ${now.status} ${formatElapsed(now.elapsedMs)}` }],
        details: now,
      });
    };
    const ticker = setInterval(push, 1000);
    const slotted = (async () => {
      let claim;
      let held = false;
      try {
        if (running >= HELPER_CAPS.parallel) waiting.set(id, 'a free slot');
        push();
        await acquireSlot(outer);
        held = true;
        waiting.delete(id);
        if (def.tools === 'edit') {
          claim = await claims.acquire(id, params.files ?? [], outer, (holder) => {
            waiting.set(id, holder);
            push();
          });
          waiting.delete(id);
        }
        record(id, { status: 'running' });
        push();
        const outcome = await runHelper(p, {
          id,
          label: id,
          turnId,
          def,
          task: params.task,
          model,
          claim,
          claims,
          gate,
          signal: outer,
          attach(session) {
            const l = live.get(id);
            if (l) l.session = session;
            const file = session.sessionManager.getSessionFile() ?? '';
            const next = record(id, { sessionFile: file });
            entry({ phase: 'start', record: next });
          },
        });
        return outcome;
      } finally {
        claim?.release();
        if (held) releaseSlot();
        waiting.delete(id);
      }
    })();
    live.set(id, { ac, done: slotted.catch(() => {}) });
    try {
      const outcome = await slotted;
      const status: HelperStatus = outcome.status;
      const summary = firstLine(outcome.report) || outcome.reason;
      const ended = record(id, { status, endedAt: Date.now(), ...(summary ? { summary } : {}) });
      if (ended.sessionFile) entry({ phase: 'end', id, status, endedAt: ended.endedAt!, summary });
      const footer = `[${def.name} | ${formatElapsed(ended.endedAt! - startedAt)} | ${formatTokens(outcome.tokens)}]`;
      const notes: string[] = [];
      if (outcome.outside.length)
        notes.push(
          `${def.tools === 'edit' ? 'touched outside claim' : 'changed files (read-only agent)'}: ${outcome.outside
            .slice(0, 10)
            .join(', ')
            .slice(0, 2048)}${outcome.outside.length > 10 ? ', ...' : ''}`,
        );
      if (!noticed.has(def.tools) && (hostSandbox() !== 'seatbelt' || config.trust.yolo)) {
        noticed.add(def.tools);
        notes.push(
          `${def.tools === 'read' ? 'read-only is' : 'claims are'} not enforced for commands here (${hostSandbox() !== 'seatbelt' ? 'no sandbox on this system' : 'YOLO is on'})`,
        );
      }
      // The result text is capped so the transcript growth a pending helper call can cause stays provable.
      const text = [footer, ...notes, `Helper report:\n${outcome.report}`]
        .filter(Boolean)
        .join('\n')
        .slice(0, HELPER_RESULT_TEXT_MAX);
      if (outcome.status === 'failed')
        throw new Error(
          `${def.name} failed after ${formatElapsed(ended.endedAt! - startedAt)}: ${outcome.reason}\n${text}`.slice(
            0,
            HELPER_RESULT_TEXT_MAX,
          ),
        );
      if (outcome.status === 'cancelled')
        return {
          content: [{ type: 'text' as const, text: `${def.name} was cancelled.` }],
          details: details('cancelled', { elapsedMs: ended.endedAt! - startedAt, tokens: outcome.tokens }),
        };
      return {
        content: [{ type: 'text' as const, text }],
        details: details('done', { elapsedMs: ended.endedAt! - startedAt, tokens: outcome.tokens, summary }),
      };
    } catch (error) {
      const known = records.get(id)!;
      if (known.endedAt === undefined) {
        const status: HelperStatus = outer.aborted ? 'cancelled' : 'failed';
        const ended = record(id, {
          status,
          endedAt: Date.now(),
          summary: String((error as Error).message).slice(0, 160),
        });
        if (ended.sessionFile) entry({ phase: 'end', id, status, endedAt: ended.endedAt!, summary: ended.summary });
      }
      throw error;
    } finally {
      clearInterval(ticker);
      live.delete(id);
    }
  };

  const extension: ExtensionFactory = (pi) => {
    let applied = '';
    const register = () =>
      pi.registerTool({
        name: AGENT_TOOL,
        label: 'Helper',
        description: `Hand a self-contained task to a helper agent and get its report. Available: ${loadAgents(
          config.dirs,
        )
          .agents.map(
            (agent) =>
              `${agent.name} (${agent.tools === 'read' ? 'read-only' : 'edits the files you list'}: ${agent.description})`,
          )
          .join(', ')}. Call it several times in one turn to run helpers together.`,
        parameters,
        executionMode: 'parallel',
        async execute(_callId, params, signal, onUpdate) {
          return execute(params, signal, onUpdate as never) as never;
        },
      });
    register();
    pi.on('before_agent_start', (event, ctx) => {
      if (event.messageType === 'user') requestStarted = 0;
      register();
      const offered = ctx.model?.provider !== 'claude-code';
      const active = pi.getActiveTools();
      const listed = active.includes(AGENT_TOOL);
      if (offered && !listed) pi.setActiveTools([...active, AGENT_TOOL]);
      if (!offered && listed) pi.setActiveTools(active.filter((name) => name !== AGENT_TOOL));
      const section = offered ? delegationSection(loadAgents(config.dirs).agents) : '';
      if (section && event.systemPrompt.endsWith(section)) {
        applied = section;
        return undefined;
      }
      const base =
        applied && event.systemPrompt.endsWith(applied)
          ? event.systemPrompt.slice(0, -applied.length)
          : event.systemPrompt;
      applied = section;
      return section === '' && base === event.systemPrompt ? undefined : { systemPrompt: base + section };
    });
  };

  const abortAll = async () => {
    const all = [...live.values()];
    for (const item of all) item.ac.abort(new Error('Cancelled'));
    await Promise.allSettled(all.map((item) => item.done));
  };

  const api: Helpers = {
    agents: () => loadAgents(config.dirs),
    list: () => [...records.values()].map(view),
    createAgent: (draft) => writeAgent(config.dirs, draft),
    messages(id) {
      const item = live.get(id);
      if (item?.session) return item.session.messages;
      const file = records.get(id)?.sessionFile;
      if (!file) return [];
      try {
        return SessionManager.open(file).buildSessionContext().messages;
      } catch {
        return [];
      }
    },
    async cancel(id) {
      const targets = id ? [live.get(id)] : [...live.values()];
      for (const item of targets) item?.ac.abort(new Error('Cancelled'));
      await Promise.allSettled(targets.map((item) => item?.done));
    },
    available,
  };

  return {
    api,
    extension,
    abortAll,
    bind(next) {
      bound = next;
      claims = new ClaimTable(next.tools?.taskRoot);
      for (const item of foldHelperEntries(next.env.manager.getEntries())) records.set(item.id, item);
      sequence = Math.max(0, ...[...records.keys()].map((key) => Number(key.split('#')[1]) || 0));
    },
  };
}
