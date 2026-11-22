import { realpathSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  type AgentSession,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';
import { createChatExtensions } from '../chat-extensions.ts';
import { defaultDeniedRoots } from '../../oms-extension.ts';
import { KNOWLEDGE_TOOL_NAMES } from '../knowledge-service.ts';
import type { SessionApiParts } from '../session-api.ts';
import { createSessionHooks } from '../session-hooks.ts';
import { readingExtensions } from '../session-tools.ts';
import { sessionToolNames } from '../session-model.ts';
import { harnessPolicySettings } from '../settings-controls.ts';
import { KEY_SAFETY, omsChatPrompt } from '../system-prompt.ts';
import { withToolExecutionModes } from '../tool-execution.ts';
import { createMeteredStream, measuredInputBound, modelReadiness, requestBound } from '../usage.ts';
import { hostSandbox } from '@oms/sandbox';
import { AGENT_TOOL, type AgentDefinition } from './agents.ts';
import { fileToolPath, type Claim, type ClaimTable } from './claims.ts';
import { usageOf } from './records.ts';

export const HELPER_LIMITS = { turns: 40, tokens: 300_000, ms: 10 * 60_000, report: 4000, input: 200_000 } as const;

/**
 * The most text one helper result can put in the parent's transcript: the capped report
 * plus its footer, outside-claim notes and failure prefix. The agent tool truncates what
 * it emits to this, so a pending helper call's transcript growth is provable.
 */
export const HELPER_RESULT_TEXT_MAX = HELPER_LIMITS.report + 4096;

/**
 * Serialized bytes a pending helper result can add to the parent's measured transcript:
 * its text cap at worst-case JSON escaping plus the toolResult envelope, padded for the
 * measured bound's proportional slack. chatHeadroom charges this per pending helper call.
 */
export const HELPER_RESULT_BOUND_BYTES = Math.ceil((HELPER_RESULT_TEXT_MAX * 6 + 256) * 1.25);

/**
 * A request is admitted against the budget at its largest possible size, so a few at once can claim more than the turn's
 * allowance even though each is small. A request that does not fit waits for one in flight to end instead of failing.
 */
export class RequestGate {
  private inflight = 0;
  private waiting: Array<() => void> = [];

  async admit(
    ready: () => boolean,
    start: () => ReturnType<StreamFn>,
    signal: AbortSignal | undefined,
  ): Promise<AssistantMessageEventStream> {
    while (!signal?.aborted && this.inflight > 0 && !ready())
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener('abort', wake);
          resolve();
        };
        signal?.addEventListener('abort', wake, { once: true });
        this.waiting.push(wake);
      });
    const pending = start();
    this.inflight++;
    const ended = () => {
      this.inflight--;
      for (const wake of this.waiting.splice(0)) wake();
    };
    try {
      const stream = await pending;
      void stream.result().then(ended, ended);
      return stream;
    } catch (error) {
      ended();
      throw error;
    }
  }
}

/** A helper's context stays small, so its requests reserve far less than the model's whole window. */
export const helperInputCap = (configured: number | undefined, model: Model<Api>): number =>
  Math.min(configured ?? HELPER_LIMITS.input, HELPER_LIMITS.input, model.contextWindow);

/** Tool calls whose results have not landed. Only the newest assistant message can still be
 * producing results: pi lands a batch's results before the next reply, so an older message's
 * unanswered calls come from an interrupted batch and never produce results. Charging those
 * stale calls to headroom would reserve the whole catalog window for results that never land. */
function unansweredToolCalls(messages: readonly unknown[]): Map<string, string> {
  const pending = new Map<string, string>();
  let last = messages.length - 1;
  while (last >= 0 && (messages[last] as { role?: string }).role !== 'assistant') last--;
  if (last < 0) return pending;
  const answered = new Set<string>();
  for (let i = last + 1; i < messages.length; i++) {
    const record = messages[i] as { role?: string; toolCallId?: unknown };
    if (record.role === 'toolResult' && typeof record.toolCallId === 'string') answered.add(record.toolCallId);
  }
  const content = (messages[last] as { content?: unknown }).content;
  if (!Array.isArray(content)) return pending;
  for (const block of content) {
    const call = block as { type?: string; id?: unknown; name?: unknown };
    if (
      call.type === 'toolCall' &&
      typeof call.id === 'string' &&
      typeof call.name === 'string' &&
      !answered.has(call.id)
    ) {
      pending.set(call.id, call.name);
    }
  }
  return pending;
}

function chatHeadroom(parts: SessionApiParts) {
  const model = parts.model.session.model!;
  // The chat's next request is predicted from its current transcript rather than held at
  // the whole catalog window; metered dispatch re-checks the exact body anyway. When no
  // transcript is readable, omitting the bound keeps the conservative catalog reserve.
  const messages = parts.model.session.agent?.state.messages;
  // Results of the tool calls the chat is running land in its transcript before that
  // request is sent. A helper's result text is capped, so each pending helper call is
  // charged against the measured bound; any other pending result cannot be byte-proven,
  // and its presence keeps the conservative catalog reserve instead.
  let helpers = 0;
  let inputBound: number | undefined;
  if (messages) {
    let provable = true;
    for (const name of unansweredToolCalls(messages).values()) {
      if (name === AGENT_TOOL) helpers++;
      else provable = false;
    }
    if (provable) inputBound = measuredInputBound(model, { messages: messages as readonly unknown[] });
  }
  return (
    requestBound(
      model,
      parts.options.maxOutputTokens,
      parts.env.executionMode,
      parts.options.maxInputTokens,
      parts.options.subscriptionSpendExempt,
      parts.model.modelRuntime.isUsingSubscription(model.provider),
      inputBound === undefined ? undefined : inputBound + helpers * HELPER_RESULT_BOUND_BYTES,
    ) ?? { tokens: Infinity, spendMicroUsd: Infinity }
  );
}

export function helperReadiness(parts: SessionApiParts, model: Model<Api>, inputBound?: number) {
  return modelReadiness(
    model,
    parts.env.budget,
    parts.options.maxOutputTokens,
    parts.env.executionMode,
    helperInputCap(parts.options.maxInputTokens, model),
    parts.options.subscriptionSpendExempt,
    parts.model.modelRuntime.isUsingSubscription(model.provider),
    true,
    chatHeadroom(parts),
    inputBound,
  );
}

/** Folders whose files change for reasons that are nobody's edit. */
const SKIPPED = new Set(['.git', 'node_modules', 'target', '.oms-cargo']);
const WALK_LIMIT = 20_000;

/** Files under `root` changed since `since`, as folder-relative paths. */
export function changedSince(root: string, since: number): string[] {
  const changed: string[] = [];
  let seen = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > WALK_LIMIT) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) walk(path);
      } else if (entry.isFile()) {
        try {
          if (statSync(path).mtimeMs >= since) changed.push(relative(root, path));
        } catch {
          // Gone again before it could be read.
        }
      }
    }
  };
  walk(root);
  return changed.sort();
}

export interface HelperRun {
  id: string;
  label: string;
  turnId: string;
  def: AgentDefinition;
  task: string;
  model: Model<Api>;
  claim?: Claim;
  claims: ClaimTable;
  gate: RequestGate;
  signal: AbortSignal;
  /** Called with the child session as soon as it exists, so a caller can show its conversation live. */
  attach(session: AgentSession): void;
}

export interface HelperOutcome {
  status: 'done' | 'failed' | 'cancelled';
  report: string;
  reason?: string;
  tokens: number;
  spendMicroUsd: number;
  outside: string[];
}

function claimGuard(folder: string, claim: Claim, claims: ClaimTable): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', (event) => {
      if (event.toolName !== 'edit' && event.toolName !== 'write') return undefined;
      const path = (event.input as { path?: unknown }).path;
      if (typeof path === 'string') {
        const lexical = resolve(folder, fileToolPath(path));
        let ancestor = lexical;
        try {
          let canonical: string;
          while (true) {
            try {
              canonical = resolve(realpathSync.native(ancestor), relative(ancestor, lexical));
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
              ancestor = dirname(ancestor);
            }
          }
          const rel = relative(folder, lexical);
          if (canonical === lexical && !rel.startsWith('..') && claims.covers(claim, rel)) return undefined;
        } catch {
          // An unresolved destination cannot be authorized against a lexical claim.
        }
      }
      return {
        block: true,
        reason: `blocked: ${typeof path === 'string' ? path : 'that path'} is outside the files you may change (${claim.patterns.join(', ')}). Say in your report that it needs a change.`,
      };
    });
  };
}

function helperPrompt(parts: SessionApiParts, def: AgentDefinition): string {
  const folder = parts.tools.taskRoot;
  const framing = `You are a helper of another agent. Do only the task you are given, in ${folder}, and answer with your report.`;
  if (def.tools === 'edit') {
    return omsChatPrompt(folder, parts.tools.toolchainSummary, `\n\n${framing}\n${def.instructions}`);
  }
  return [framing, def.instructions, KEY_SAFETY].join('\n\n');
}

/** Builds the helper's own pi session over the same sandbox, ledger and guards as the chat, runs the task, and tears it down. */
export async function runHelper(parts: SessionApiParts, run: HelperRun): Promise<HelperOutcome> {
  const { options, life, env, tools, model: chat } = parts;
  const { def } = run;
  const readOnly = def.tools === 'read';
  const folder = tools.taskRoot;
  const lane = tools.sandboxTools.helperTools({
    label: run.label,
    readOnly,
    ...(run.claim
      ? {
          onWrite: (path) => run.claims.recordWrite(run.claim!, path),
          protectedPaths: () => run.claims.protectedPrefixes(run.claim!).map((path) => join(folder, path)),
        }
      : {}),
  });
  let child: AgentSession | undefined;
  try {
    const hooks = createSessionHooks(
      { ...options, maxInputTokens: helperInputCap(options.maxInputTokens, run.model) },
      life,
      env,
      tools,
    );
    hooks.turn.id = run.turnId;
    const extensions: ExtensionFactory[] = createChatExtensions({
      guards: { approveHostCommands: tools.backend.approvesCommands },
      cwd: folder,
      trace: life.trace!,
      protectedPaths: env.protectedFiles.map((file) => join(folder, file)),
      extra: [
        lane.extension,
        hooks.policy,
        ...readingExtensions(env, tools),
        ...(run.claim ? [claimGuard(folder, run.claim, run.claims)] : []),
      ],
    });
    const known = tools.knowledgeSource() !== undefined;
    const toolNames = [
      ...sessionToolNames(false, options.outputMode, 'chat').filter(
        (name) => !(readOnly && (name === 'edit' || name === 'write')),
      ),
      ...(known ? KNOWLEDGE_TOOL_NAMES : []),
    ];
    const settingsManager = SettingsManager.inMemory(harnessPolicySettings());
    const resourceLoader = new DefaultResourceLoader({
      cwd: env.root.codeRoot,
      agentDir: env.root.agentRoot,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: [],
      extensionFactories: extensions.map(withToolExecutionModes),
      systemPrompt: helperPrompt(parts, def),
    });
    await resourceLoader.reload();
    const helperDir = join(env.root.stateDir, 'helpers', env.sessionId);
    const sessionManager = SessionManager.create(env.root.codeRoot, helperDir);
    const { session } = await createAgentSession({
      cwd: env.root.codeRoot,
      agentDir: env.root.agentRoot,
      modelRuntime: chat.modelRuntime,
      model: run.model,
      thinkingLevel: chat.session.thinkingLevel,
      settingsManager,
      sessionManager,
      resourceLoader,
      noTools: 'builtin',
      tools: toolNames,
    });
    child = session;
    run.attach(session);
    session.agent.toolExecution = 'parallel';
    const original: StreamFn = session.agent.streamFunction;
    const metered = createMeteredStream({
      streamFunction: original,
      ledger: env.budget,
      allocate: env.allocate,
      executionMode: env.executionMode,
      maxOutputTokens: options.maxOutputTokens,
      maxInputTokens: helperInputCap(options.maxInputTokens, run.model),
      subscriptionExempt: options.subscriptionSpendExempt,
      subscribed: (provider) => chat.modelRuntime.isUsingSubscription(provider),
      logicalTurnId: () => run.turnId,
      concurrent: true,
      headroom: () => chatHeadroom(parts),
      onBareBadRequest: () => hooks.trim.forgetReasoning(),
    });
    const stop = new AbortController();
    session.agent.streamFunction = (model, context, streamOptions) => {
      const signal = AbortSignal.any([
        stop.signal,
        ...(life.executionController ? [life.executionController.signal] : []),
        ...(streamOptions?.signal ? [streamOptions.signal] : []),
      ]);
      // The gate measures the same normalized body metered dispatch will send.
      const ready = () => helperReadiness(parts, model, measuredInputBound(model, context)).ready;
      return run.gate.admit(ready, () => metered(model, context, { ...streamOptions, signal }), signal);
    };
    await session.bindExtensions({});

    const startedAt = Date.now();
    let limit: string | undefined;
    let grace: NodeJS.Timeout | undefined;
    const hardStop = () => {
      stop.abort();
      void session.abort().catch(() => {});
    };
    const halt = (why: string) => {
      if (limit) return;
      limit = why;
      // Let the current request settle its usage before stopping at turn_end.
      grace = setTimeout(hardStop, 30_000);
    };
    const onAbort = () => {
      stop.abort();
      void session.abort().catch(() => {});
    };
    run.signal.addEventListener('abort', onAbort, { once: true });
    if (run.signal.aborted) onAbort();
    const timer = setTimeout(() => halt(`stopped after ${HELPER_LIMITS.ms / 60_000} minutes`), HELPER_LIMITS.ms);
    let turns = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'agent_start' && stop.signal.aborted) hardStop();
      if (event.type !== 'turn_end') return;
      turns++;
      if (turns >= HELPER_LIMITS.turns) halt(`stopped after ${HELPER_LIMITS.turns} turns`);
      else if (usageOf(env.budget, run.turnId).tokens >= HELPER_LIMITS.tokens)
        halt(`stopped after ${HELPER_LIMITS.tokens / 1000}k tokens`);
      if (limit) hardStop();
    });
    try {
      const note = run.claim ? `\n\nFiles you may change: ${run.claim.patterns.join(', ')}` : '';
      if (!stop.signal.aborted) await session.prompt(`${run.task}${note}`);
      const usage = usageOf(env.budget, run.turnId);
      const last = [...session.messages].reverse().find((message) => message.role === 'assistant') as
        { stopReason?: string; errorMessage?: string } | undefined;
      const report = (session.getLastAssistantText() ?? '').trim().slice(0, HELPER_LIMITS.report);
      const outside =
        readOnly && hostSandbox() === 'seatbelt' && !options.hostTrust?.yolo
          ? []
          : outsideClaim(folder, startedAt, run);
      if (limit) return { status: 'failed', report, reason: limit, ...usage, outside };
      if (run.signal.aborted || last?.stopReason === 'aborted')
        return { status: 'cancelled', report, ...usage, outside };
      if (last?.stopReason === 'error')
        return { status: 'failed', report, reason: last.errorMessage ?? 'the model request failed', ...usage, outside };
      return { status: 'done', report: report || '(no report)', ...usage, outside };
    } finally {
      clearTimeout(timer);
      clearTimeout(grace);
      unsubscribe();
      run.signal.removeEventListener('abort', onAbort);
    }
  } finally {
    lane.close();
    child?.dispose();
  }
}

/** Files that changed during the run and belong to nobody who was running: bash wrote them, or a read-only agent wrote at all. */
function outsideClaim(folder: string, since: number, run: HelperRun): string[] {
  return changedSince(folder, since - 10).filter(
    (path) => !(run.claim && run.claims.covers(run.claim, path)) && !run.claims.writtenByOthers(run.claim, path, since),
  );
}
