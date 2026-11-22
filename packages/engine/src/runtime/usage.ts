import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import {
  clampMaxTokensToContext,
  clampThinkingBudgetToAnswerRoom,
  thinkingBudgetForLevel,
} from '@earendil-works/pi-ai/api/simple-options';
import {
  createBudgetLedger,
  formatMicroUsd,
  type BudgetCaps,
  type BudgetLedger,
  type BudgetLedgerEvent,
  type ExecutionMode,
} from '@oms/core';

import {
  describeClaudeCodeAuth,
  describeClaudeCodeLimit,
  describeClaudeCodeNotDispatched,
  describeClaudeCodeRateLimit,
  describeClaudeCodeSignIn,
  describeFailure,
  describeRejection,
  describeTransient,
  isRejectionStatus,
  providerName,
} from './provider-rejection.ts';
import {
  modelOutputCap,
  modelReservationBound,
  normalizePiUsage,
  enforceCachePolicy,
  isClaudeCodeModel,
} from '@oms/core/usage';
import type { DispatchAllocator } from '@oms/core/dispatch';
import {
  CLAUDE_CODE_AUTH,
  CLAUDE_CODE_EMPTY_RESPONSE,
  CLAUDE_CODE_LIMIT,
  CLAUDE_CODE_NOT_DISPATCHED,
  CLAUDE_CODE_RATE_LIMIT,
  CLAUDE_CODE_SIGNIN,
  type ObservedUsage,
} from './claude-code.ts';

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export interface MeteredStreamOptions {
  /** Capture the original agent.streamFunction before replacing it. */
  readonly streamFunction: StreamFn;
  readonly ledger: BudgetLedger;
  readonly maxOutputTokens: number;
  /** Unique per user run, stable across its tool-loop continuations. Never reuse after restart. */
  readonly logicalTurnId: () => string;
  readonly allocate: DispatchAllocator;
  readonly clock?: () => number;
  readonly executionMode?: ExecutionMode;
  /**
   * Opt-in local input cap. Absent preserves the full catalog reservation.
   * When set, admission clones the model window to this cap and the serialized text payload must fit inside it.
   */
  readonly maxInputTokens?: number;
  /** Benchmark runner only: ChatGPT-subscription calls in a bounded run reserve and settle $0 (tokens and wall time stay capped). */
  readonly subscriptionExempt?: boolean;
  /** Whether a provider is signed in with a subscription login, such as SuperGrok; its chat usage is then plan usage. */
  readonly subscribed?: (provider: string) => boolean;
  /** Helpers: other requests are in flight. Each one's reservation already counts against the caps, so an open one does not pause the rest. */
  readonly concurrent?: boolean;
  /** Helpers leave enough budget for the chat to consume their reports. */
  readonly headroom?: () => { tokens: number; spendMicroUsd: number };
  /** Called when the provider rejects a request with a bare 400 that gives no reason, before the turn is retried. */
  readonly onBareBadRequest?: () => void;
}

function cleanMessage(message: AssistantMessage): AssistantMessage {
  const { errorMessage: _error, diagnostics: _diagnostics, rawStopReason: _raw, ...safe } = message;
  return safe;
}

/**
 * `exempt`: a trusted caller on a ChatGPT subscription also lifts the API-dollar bound for bounded runs.
 * `subscribed`: the provider is signed in with a subscription login (pi's isUsingSubscription), such as SuperGrok.
 */
function subscriptionUsage(
  model: Model<Api>,
  mode: ExecutionMode | undefined,
  exempt = false,
  subscribed = false,
): boolean {
  // The native adapter verifies a first-party claude.ai login for every call and refuses API/3p credentials.
  return (
    isClaudeCodeModel(model) ||
    ((mode === 'interactive' || exempt) &&
      ((model.provider === 'openai-codex' &&
        model.api === 'openai-codex-responses' &&
        model.baseUrl === 'https://chatgpt.com/backend-api') ||
        (mode === 'interactive' && subscribed)))
  );
}

export function requestBound(
  model: Model<Api>,
  maxOutputTokens: number,
  mode: ExecutionMode | undefined,
  maxInputTokens?: number,
  exempt = false,
  subscribed = false,
  inputBound?: number,
) {
  // Claude Code adds its own native prompt and protocol overhead outside OMS's payload hook.
  if (isClaudeCodeModel(model) && (maxInputTokens !== undefined || inputBound !== undefined)) return null;
  const priced = maxInputTokens === undefined ? model : { ...model, contextWindow: maxInputTokens };
  const bound = modelReservationBound(priced, maxOutputTokens, inputBound);
  if (bound && subscriptionUsage(model, mode, exempt, subscribed)) bound.spendMicroUsd = 0;
  return bound;
}

/** Pi's measured Anthropic/OpenAI/Codex wrappers on an empty transcript, plus JSON escaping of every text byte. */
const PROTOCOL_ALLOWANCE_BYTES = 12_288;

function unboundedInput(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(unboundedInput);
  const record = value as Record<string, unknown>;
  // A tool call's arguments are the model's own text (web_fetch's { url } included), never media:
  // Pi's toolCall in history, Anthropic's tool_use in the serialized body (OpenAI sends arguments as a string).
  if (record.type === 'toolCall' || record.type === 'tool_use') return false;
  if (
    record.type === 'image' ||
    record.type === 'image_url' ||
    record.type === 'input_image' ||
    record.type === 'file' ||
    record.type === 'document' ||
    record.type === 'input_file' ||
    typeof record.url === 'string' ||
    typeof record.file_id === 'string' ||
    typeof record.fileId === 'string'
  )
    return true;
  return Object.values(record).some(unboundedInput);
}

/** Text-only serialized body. Media and remote files are not byte-bounded, so they fail closed.
 * The cap is enforced on serialized bytes, not a bytes-per-token estimate: a tokenizer can emit
 * one token per byte, so a denser allowance (e.g. 3 bytes per token) lets a payload carry more
 * tokens than the cap reserves — dense non-Latin text tokenizes at roughly 1-3 bytes a token. */
export function payloadWithinInputCap(payload: unknown, maxInputTokens: number): boolean {
  if (unboundedInput(payload)) return false;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(payload));
  } catch {
    return false;
  }
  return bytes + PROTOCOL_ALLOWANCE_BYTES <= maxInputTokens;
}

/** Slack over serialized-transcript bytes a provider adapter may add re-encoding it (field
 * names, request wrapper, tool conversion): the larger of 32 KB or a quarter of the transcript. */
const WRAPPER_SLACK_BYTES = 32 * 1024;

/** The serialized body must stay inside the measured byte bound — a tokenizer emits at most
 * one token per byte, so `bound` in tokens equals the measured bytes plus wrapper slack. */
function payloadWithinMeasuredBound(payload: unknown, bound: number): boolean {
  if (unboundedInput(payload)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(payload)) <= bound;
  } catch {
    return false;
  }
}

/**
 * The input side of a request's reservation measured from the transcript the provider will
 * receive, or undefined when that input cannot be byte-bounded: Claude Code's native prompt
 * is invisible to OMS, and media/remote-file content has no byte-proportional token count.
 * The catalog window is only a worst case — reserving `window + output` for a 30 KB
 * transcript leaves a failed request holding a bound it could never reach.
 *
 * Worst case: every serialized byte becomes one provider token. No tokenizer emits more
 * than one token per input byte, and non-Latin scripts sit comfortably inside that
 * (multi-byte UTF-8 chars tokenize at roughly one token per 2-4 bytes). That per-byte
 * rate is the hard upper bound — nothing looser (like 3 bytes per token) can be proven.
 *
 * The bound is still probabilistic in one place: tokens a provider bills that are not
 * bytes in the request body — chat-template control tokens, role wrappers, tool-schema
 * expansion, a backend's own injected instructions. The slack term estimates them at
 * 32 KB + 25% of the transcript. The worst case is a transcript of very many small
 * messages (or a provider wrapper heavier than the slack) accruing more structural
 * tokens than the slack covers; the provider receipt then settles above the reservation.
 * The payload hook below holds the serialized body inside this bound, so content bytes
 * can never exceed it — only provider-side framing can.
 */
export function measuredInputBound(model: Model<Api>, context: { messages: readonly unknown[] }): number | undefined {
  if (isClaudeCodeModel(model)) return undefined;
  // Tool-result `details` (pi's read truncation copy, edit diffs) are never sent to providers.
  const sent = context.messages.map((message) => ({ ...(message as object), details: undefined }));
  if (unboundedInput(sent)) return undefined;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(sent));
  } catch {
    return undefined;
  }
  return bytes + Math.max(WRAPPER_SLACK_BYTES, bytes >> 2);
}

function readinessForBound(
  model: Model<Api>,
  ledger: BudgetLedger,
  bound: ReturnType<typeof requestBound>,
  executionMode: ExecutionMode,
  exempt = false,
  subscribed = false,
  concurrent = false,
  headroom?: { tokens: number; spendMicroUsd: number },
): { ready: boolean; detail: string } {
  if (!bound)
    return { ready: false, detail: 'This model has unsupported usage limits. Choose a supported model in /model.' };
  const snapshot = ledger.snapshot();
  // An interactive chat goes on past an uncertain request, which stays charged at its reservation.
  if (
    (snapshot.accounting === 'pending' && !concurrent) ||
    (snapshot.accounting === 'unknown' && executionMode !== 'interactive')
  )
    return {
      ready: false,
      detail:
        'A previous request has unconfirmed usage. New requests are paused; your work is saved. Open /status for details.',
    };
  if (snapshot.remaining.wallClockMs <= 0)
    return {
      ready: false,
      detail:
        executionMode === 'interactive'
          ? 'This turn reached its execution time limit. Start a new prompt when it has stopped.'
          : 'This bounded run reached its time limit. Reopen without --bounded for normal chat, or start a new bounded run.',
    };
  if (bound.tokens + (headroom?.tokens ?? 0) > snapshot.remaining.tokens || snapshot.remaining.tokens === 0)
    return {
      ready: false,
      detail:
        'This model exceeds the remaining request-size limit. Choose a smaller model in /model or start a new run.',
    };
  if (
    bound.spendMicroUsd + (headroom?.spendMicroUsd ?? 0) > snapshot.remaining.spendMicroUsd ||
    (executionMode === 'bounded' && snapshot.remaining.spendMicroUsd === 0)
  )
    return {
      ready: false,
      detail: `The remaining API limit (${formatMicroUsd(snapshot.remaining.spendMicroUsd)}) cannot cover this model's maximum request cost (${formatMicroUsd(bound.spendMicroUsd)}). Choose another model or change the explicit spending limit.`,
    };
  return {
    ready: true,
    detail: subscriptionUsage(model, executionMode, exempt, subscribed)
      ? `${isClaudeCodeModel(model) ? 'Claude Code' : model.provider === 'openai-codex' ? 'ChatGPT' : providerName(model.provider)} subscription · provider usage limits apply; no OMS API-dollar charge`
      : 'Ready · paid API usage remains protected by the spending limit',
  };
}

/** Provider eligibility and actual dispatch use the same local safety check. */
export function modelReadiness(
  model: Model<Api>,
  ledger: BudgetLedger,
  maxOutputTokens: number,
  executionMode: ExecutionMode = 'bounded',
  maxInputTokens?: number,
  subscriptionExempt = false,
  subscribed = false,
  concurrent = false,
  headroom?: { tokens: number; spendMicroUsd: number },
  inputBound?: number,
): { ready: boolean; detail: string } {
  if (isClaudeCodeModel(model) && (maxInputTokens !== undefined || inputBound !== undefined))
    return {
      ready: false,
      detail: 'Claude Code cannot enforce a local input cap. Omit the input cap or choose a direct API model.',
    };
  return readinessForBound(
    model,
    ledger,
    requestBound(model, maxOutputTokens, executionMode, maxInputTokens, subscriptionExempt, subscribed, inputBound),
    executionMode,
    subscriptionExempt,
    subscribed,
    concurrent,
    headroom,
  );
}

/** Admission is here, not Pi extension hooks (whose exceptions can be swallowed).
 * This is a declared conservative catalog-price bound, not a guarantee about external billing.
 * Auxiliary warming, compaction, retries and other streams must remain disabled by the owner.
 */
export function createMeteredStream(config: MeteredStreamOptions): StreamFn {
  if (!count(config.maxOutputTokens) || config.maxOutputTokens === 0)
    throw new Error('explicit positive output cap required');
  if (config.maxInputTokens !== undefined && !count(config.maxInputTokens))
    throw new Error('explicit input cap required');
  const clock = config.clock ?? Date.now;
  const streamAttempt = (
    selectedModel: Parameters<StreamFn>[0],
    context: Parameters<StreamFn>[1],
    options: Parameters<StreamFn>[2],
    retries = 2,
  ) => {
    const output = createAssistantMessageEventStream();
    let model = selectedModel;
    let dispatchId: string | undefined;
    let dispatched = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    const failed = (text: string, aborted = false): void => {
      const message: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: model.api,
        model: model.id,
        provider: model.provider,
        timestamp: clock(),
        stopReason: aborted ? 'aborted' : 'error',
        errorMessage: text,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      output.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
      output.end();
    };
    const uncertain = (): boolean => {
      if (!dispatchId || settled) return false;
      settled = true;
      // A failure before the single metered request proves nothing reached an API provider,
      // so that reservation is released rather than retained as unknown usage. Claude Code's
      // native channel is outside this counter, so its failures stay fail-closed.
      const sent = dispatched && reachedProvider();
      config.ledger.settle({
        dispatchId,
        receiptId: randomUUID(),
        outcome: sent ? 'uncertain' : 'not_dispatched',
        tokens: sent ? null : 0,
        spendMicroUsd: sent ? null : 0,
      });
      return !sent;
    };
    // A transport-level failure (dropped stream, 5xx, overload) proves nothing about usage but cannot exceed what admission
    // reserved, so it is settled at that bound: the ledger stays consistent, nothing is under-counted, and later requests
    // (Pi's turn retry) are admitted against what remains. The failure text then reads as transient so Pi retries the turn.
    let reserved: { tokens: number; spendMicroUsd: number } | undefined;
    // The ChatGPT subscription backend also answers a valid request now and then with a bare 400 that carries no reason;
    // it is retried like a dropped stream (a request it really rejects fails the same way each time and then stops).
    const BARE_BAD_REQUEST = /^\{"detail":"Bad Request"\}$/;
    const bare = (cause: string): boolean => {
      if (!BARE_BAD_REQUEST.test(cause.trim())) return false;
      config.onBareBadRequest?.();
      return true;
    };
    const transient = (cause: string | undefined): boolean =>
      !controller.signal.aborted &&
      !!cause &&
      (isRetryableAssistantError({ stopReason: 'error', errorMessage: cause } as AssistantMessage) || bare(cause));
    const settleAtBound = (): boolean => {
      if (!dispatchId || settled || !reserved) return false;
      const receipt = config.ledger.settle({ dispatchId, receiptId: randomUUID(), outcome: 'known', ...reserved });
      if (!receipt.ok) return false;
      settled = true;
      return true;
    };
    // A failed attempt whose adapter could publish provider-reported usage (`observedUsage`)
    // settles at that usage instead of its reservation bound: zero when the receipt showed no
    // new tokens, otherwise the normalized amount. Usage no receipt establishes stays fail-closed.
    const settleObserved = (error: AssistantMessage): boolean => {
      if (!dispatchId || settled || !reserved) return false;
      const observed = (error as AssistantMessage & ObservedUsage).observedUsage;
      const usage = observed === undefined ? null : normalizePiUsage(model, observed);
      const zero =
        observed !== undefined &&
        count(observed.input) &&
        count(observed.output) &&
        count(observed.cacheRead) &&
        count(observed.cacheWrite) &&
        observed.totalTokens === 0 &&
        observed.input + observed.output + observed.cacheRead + observed.cacheWrite === 0;
      if (usage === null && !zero) return false;
      const receipt = config.ledger.settle({
        dispatchId,
        receiptId: randomUUID(),
        outcome: 'known',
        tokens: usage?.tokens ?? 0,
        spendMicroUsd: subscriptionUsage(
          model,
          config.executionMode,
          config.subscriptionExempt,
          config.subscribed?.(model.provider) ?? false,
        )
          ? 0
          : (usage?.spendMicroUsd ?? 0),
        ...(usage && observed
          ? {
              usage: {
                inputTokens: observed.input,
                outputTokens: observed.output,
                cacheReadTokens: observed.cacheRead,
                cacheWriteTokens: observed.cacheWrite,
              },
            }
          : {}),
      });
      if (!receipt.ok) return false;
      settled = true;
      return true;
    };
    let httpRequests = 0;
    // Under `transport: 'sse'` an API provider can only be reached through the single metered
    // request below; a failure with zero issued requests provably sent nothing, so it settles
    // `not_dispatched` and frees the reservation. Claude Code's native channel is not metered
    // here, so it always counts as possibly sent.
    const reachedProvider = (): boolean => isClaudeCodeModel(model) || httpRequests > 0;
    const releaseUndispatched = (): boolean => {
      if (!dispatchId || settled) return false;
      const released = config.ledger.settle({
        dispatchId,
        receiptId: randomUUID(),
        outcome: 'not_dispatched',
        tokens: 0,
        spendMicroUsd: 0,
      });
      if (!released.ok) return false;
      settled = true;
      return true;
    };
    const interrupted = (cause: string | undefined): boolean => {
      if (!transient(cause)) return false;
      if (!(reachedProvider() ? settleAtBound() : releaseUndispatched())) return false;
      failed(describeTransient(model.provider, cause));
      return true;
    };
    let capRefused = false;
    // The provider answered 4xx before streaming anything: it did no work, so nothing was charged.
    let rejection: string | undefined;
    const releaseRejected = (): boolean => {
      if (!rejection || !dispatchId || settled) return false;
      const released = config.ledger.settle({
        dispatchId,
        receiptId: randomUUID(),
        outcome: 'not_dispatched',
        tokens: 0,
        spendMicroUsd: 0,
      });
      if (!released.ok) return false;
      settled = true;
      failed(rejection);
      return true;
    };
    // The input cap refuses the payload before any HTTP request exists: nothing was sent, so the reservation is released
    // rather than retained as unknown usage.
    const releaseUnsent = (): boolean => {
      if (!capRefused || httpRequests !== 0 || !dispatchId || settled) return false;
      const released = config.ledger.settle({
        dispatchId,
        receiptId: randomUUID(),
        outcome: 'not_dispatched',
        tokens: 0,
        spendMicroUsd: 0,
      });
      if (!released.ok) return false;
      dispatchId = undefined;
      settled = true;
      failed('Serialized text payload exceeds the local input cap. No provider request sent.');
      return true;
    };
    // Claude Code's sign-in check and startup guards run before any native model request exists:
    // like a 4xx refusal, nothing was sent.
    const releaseNotDispatched = (text: string): boolean => {
      if (!dispatchId || settled) return false;
      const released = config.ledger.settle({
        dispatchId,
        receiptId: randomUUID(),
        outcome: 'not_dispatched',
        tokens: 0,
        spendMicroUsd: 0,
      });
      if (!released.ok) return false;
      settled = true;
      failed(text);
      return true;
    };
    const releaseClaudeSignIn = (): boolean => releaseNotDispatched(describeClaudeCodeSignIn(model.provider));
    const run = async (): Promise<void> => {
      let onAbort: (() => void) | undefined;
      try {
        // Snapshot pricing inside the error boundary: malformed model metadata must also yield a Pi error.
        model = {
          ...selectedModel,
          cost: { ...selectedModel.cost, tiers: selectedModel.cost?.tiers?.map((tier) => ({ ...tier })) },
        };
        if (options?.signal?.aborted) {
          failed('Request cancelled before dispatch; no provider usage.', true);
          return;
        }
        const subscribed = config.subscribed?.(model.provider) ?? false;
        const inputBound = measuredInputBound(model, context);
        const bound = requestBound(
          model,
          config.maxOutputTokens,
          config.executionMode,
          config.maxInputTokens,
          config.subscriptionExempt,
          subscribed,
          inputBound,
        );
        const readiness = modelReadiness(
          model,
          config.ledger,
          config.maxOutputTokens,
          config.executionMode ?? 'bounded',
          config.maxInputTokens,
          config.subscriptionExempt,
          subscribed,
          config.concurrent,
          config.headroom?.(),
          inputBound,
        );
        if (!bound || !readiness.ready) {
          failed(`${readiness.detail} No provider request sent.`);
          return;
        }
        if (config.maxInputTokens !== undefined && unboundedInput(context.messages)) {
          failed(
            'Media or remote-file input is not byte bounded. Send text only, or omit the local input cap. No provider request sent.',
          );
          return;
        }
        let payloadAccepted = inputBound === undefined && config.maxInputTokens === undefined;
        const modelCap = modelOutputCap(model, config.maxOutputTokens);
        const outputCap =
          model.api === 'anthropic-messages' ? clampMaxTokensToContext(model, context, modelCap) : modelCap;
        if (
          model.api === 'anthropic-messages' &&
          model.reasoning &&
          options?.reasoning &&
          !(model.compat && 'forceAdaptiveThinking' in model.compat && model.compat.forceAdaptiveThinking === true) &&
          !(model.compat && 'supportsMidConvoEffort' in model.compat && model.compat.supportsMidConvoEffort === true)
        ) {
          const thinkingBudget = clampThinkingBudgetToAnswerRoom(
            thinkingBudgetForLevel(options.reasoning, options.thinkingBudgets),
            outputCap,
          );
          if (!count(thinkingBudget) || thinkingBudget < thinkingBudgetForLevel('minimal')) {
            failed(
              'Thinking is incompatible with the total output cap or remaining context. Select thinking off or a compatible output cap before retrying. No provider request sent.',
            );
            return;
          }
        }
        const identity = config.allocate(config.logicalTurnId(), 'worker', {
          provider: model.provider,
          modelId: model.id,
          endpointId: model.baseUrl,
        });
        const id = identity.dispatchId;
        const admission = config.ledger.reserve({
          dispatchId: id,
          logicalTurnId: identity.logicalTurnId,
          attempt: identity.attempt,
          provenance: identity,
          ...bound,
        });
        if (!admission.ok || admission.duplicate) {
          const reason = admission.ok
            ? 'This request was already recorded and was not sent again. Open /status before retrying.'
            : admission.code === 'E_BUDGET'
              ? modelReadiness(
                  model,
                  config.ledger,
                  config.maxOutputTokens,
                  config.executionMode,
                  config.maxInputTokens,
                  config.subscriptionExempt,
                  subscribed,
                  config.concurrent,
                  undefined,
                  inputBound,
                ).detail
              : admission.code === 'E_UNKNOWN'
                ? 'A previous request has unconfirmed usage. Open /status; its usage record has been retained.'
                : admission.code === 'E_PERSIST'
                  ? 'OMS could not safely save the request record. Check disk space and file permissions, then reopen OMS.'
                  : 'This request conflicts with its saved usage record. Reopen OMS before retrying.';
          failed(`${reason} No provider request sent.`);
          return;
        }
        dispatchId = id;
        reserved = { tokens: bound.tokens, spendMicroUsd: bound.spendMicroUsd };
        const remaining = config.ledger.snapshot().remaining.wallClockMs;
        if (remaining <= 0) {
          uncertain();
          failed('Wall budget exhausted before dispatch; no provider usage.', true);
          return;
        }
        options?.signal?.addEventListener('abort', onCallerAbort, { once: true });
        if (options?.signal?.aborted) controller.abort();
        if (controller.signal.aborted) {
          uncertain();
          failed('Request cancelled before dispatch; no provider usage.', true);
          return;
        }
        // ES2023 is the package's declared library baseline (Promise.withResolvers requires ES2024).
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error('request cancelled'));
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        // Keep the deadline live even if a provider ignores cancellation or never resolves its stream.
        const deadline = performance.now() + remaining;
        const armDeadline = (): void => {
          const left = deadline - performance.now();
          if (left <= 0) controller.abort();
          else timer = setTimeout(armDeadline, Math.min(Math.ceil(left), 2_147_483_647));
        };
        armDeadline();
        let payloads = 0;
        const fetchRequest = options?.fetch ?? globalThis.fetch;
        const providerOptions = {
          ...options,
          signal: controller.signal,
          maxTokens: model.api === 'openai-codex-responses' || isClaudeCodeModel(model) ? model.maxTokens : modelCap,
          transport: 'sse' as const,
          maxRetries: 0,
          // Leave an absent timeout to Pi's per-request settings resolver (including its
          // saved zero/disabled semantics). The independent wall deadline above always applies.
          ...(options?.timeoutMs === 0 ? { timeoutMs: remaining } : {}),
          // Real provider adapters accept this fetch. It also refuses hidden SDK fallback/retry HTTP calls.
          fetch: (async (input, init) => {
            if (!payloadAccepted) throw new Error('metered transport refused before the input cap was checked');
            if (controller.signal.aborted || ++httpRequests !== 1)
              throw new Error('metered transport refused another request');
            const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
            const response = await fetchRequest(input, { ...init, signal, redirect: 'error' });
            if (isRejectionStatus(response.status)) {
              const text = await Promise.race([
                response
                  .clone()
                  .text()
                  .catch(() => ''),
                new Promise<string>((resolve) => setTimeout(resolve, 3_000, '')),
              ]);
              rejection = describeRejection(model.provider, response.status, text);
            }
            return response;
          }) as typeof globalThis.fetch,
          onPayload: async (payload: unknown, payloadModel: Model<Api>): Promise<unknown> => {
            if (controller.signal.aborted || ++payloads !== 1 || payloadModel.id !== model.id)
              throw new Error('metered payload refused');
            if (
              (inputBound !== undefined && !payloadWithinMeasuredBound(payload, inputBound)) ||
              (config.maxInputTokens !== undefined && !payloadWithinInputCap(payload, config.maxInputTokens))
            ) {
              capRefused = true;
              throw new Error('serialized payload exceeds the local input cap');
            }
            payloadAccepted = true;
            const replacement = await options?.onPayload?.(payload, payloadModel);
            const value = replacement === undefined ? payload : replacement;
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('metered payload refused');
            const body = { ...value } as Record<string, unknown>;
            if (body.model !== model.id) throw new Error('metered model substitution refused');
            // Catalog token rates do not price hosted tools, premium speed, or server-side model fallback.
            if (
              body.fallbacks !== undefined ||
              body.speed !== undefined ||
              (body.service_tier !== undefined &&
                body.service_tier !== 'default' &&
                body.service_tier !== 'standard_only')
            ) {
              throw new Error('unpriced provider capability refused');
            }
            if (
              body.tools !== undefined &&
              (!Array.isArray(body.tools) ||
                body.tools.some((tool: unknown) => {
                  if (!tool || typeof tool !== 'object') return true;
                  const type = 'type' in tool ? tool.type : undefined;
                  return model.api === 'anthropic-messages'
                    ? type !== undefined && type !== 'custom'
                    : type !== 'function' && type !== 'custom';
                }))
            )
              throw new Error('unpriced provider tool refused');
            if (model.api === 'anthropic-messages') {
              body.max_tokens = outputCap;
              const thinking = body.thinking as { budget_tokens?: unknown } | undefined;
              if (thinking?.budget_tokens !== undefined) {
                if (!count(thinking.budget_tokens)) throw new Error('invalid thinking budget');
                const budget = clampThinkingBudgetToAnswerRoom(thinking.budget_tokens, outputCap);
                if (budget < thinkingBudgetForLevel('minimal')) throw new Error('thinking exceeds output cap');
                body.thinking = { ...thinking, budget_tokens: budget };
              }
            } else if (model.api === 'openai-responses') {
              body.max_output_tokens = modelCap;
              // Deferred results escape this stream's receipt lifecycle. Only OpenAI defers; xAI rejects the field.
              if (model.provider === 'openai') body.background = false;
            } else if (model.api === 'openai-codex-responses') {
              // The subscription endpoint rejects max_output_tokens; do not pretend to enforce it.
              delete body.max_output_tokens;
              delete body.max_completion_tokens;
              delete body.max_tokens;
              body.store = false;
              delete body.background;
            } else {
              if ('max_tokens' in body) body.max_tokens = modelCap;
              else body.max_completion_tokens = modelCap;
              if ('max_completion_tokens' in body) body.max_completion_tokens = modelCap;
              body.n = 1;
            }
            enforceCachePolicy(model, body);
            return body;
          },
        };
        // Even a synchronous failure may occur after submission; never infer a refund from an exception.
        dispatched = true;
        const request = Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return config.streamFunction(model, context, providerOptions);
        });
        const source = await Promise.race([request, aborted]);
        const iterator = source[Symbol.asyncIterator]();
        for (;;) {
          const next = await Promise.race([iterator.next(), aborted]);
          if (next.done) break;
          const event = next.value;
          if (event.type === 'error') {
            // Operator diagnostics only (never in the transcript): the raw cause behind the plain user-facing message.
            const errorMessage = (event as { error?: { errorMessage?: string } }).error?.errorMessage;
            if (process.env.OMS_STREAM_DEBUG)
              console.error(
                'oms stream error',
                JSON.stringify({ reason: event.reason, message: errorMessage }).slice(0, 600),
              );
            if (releaseUnsent() || releaseRejected()) return;
            // A failed attempt that carries provider-reported usage settles at that usage.
            const observedSettled = settleObserved(event.error);
            if (
              isClaudeCodeModel(model) &&
              event.error.rawStopReason === CLAUDE_CODE_EMPTY_RESPONSE &&
              event.reason !== 'aborted' &&
              !controller.signal.aborted &&
              retries > 0 &&
              (observedSettled || settleAtBound())
            ) {
              // Charge the failed attempt at the usage its provider reported — or its full bound
              // when no receipt exists — then admit the retry against the remaining budget.
              await delay(3_000, undefined, { signal: controller.signal });
              const retry = streamAttempt(
                selectedModel,
                context,
                { ...options, signal: controller.signal },
                retries - 1,
              );
              for await (const next of retry) output.push(next);
              output.end();
              return;
            }
            // Refusals the native transport already classified get their own outcomes, not the generic broke-off text.
            // rawStopReason carries the kind, a |pending flag for an interrupted tool batch, then :detail (reset/step).
            if (isClaudeCodeModel(model) && event.reason !== 'aborted' && !controller.signal.aborted) {
              const stop = event.error.rawStopReason;
              const colon = stop?.indexOf(':') ?? -1;
              const parts = (colon < 0 ? (stop ?? '') : stop!.slice(0, colon)).split('|');
              const detail = colon < 0 ? undefined : stop!.slice(colon + 1);
              const base = parts[0] ?? '';
              const interruptedBatch = parts.includes('pending');
              if (base === CLAUDE_CODE_SIGNIN && releaseClaudeSignIn()) return;
              if (
                base === CLAUDE_CODE_NOT_DISPATCHED &&
                releaseNotDispatched(describeClaudeCodeNotDispatched(model.provider, detail))
              )
                return;
              if (base === CLAUDE_CODE_AUTH) {
                uncertain();
                failed(describeClaudeCodeAuth(model.provider, interruptedBatch));
                return;
              }
              // A bare 429 is back-pressure, not plan exhaustion: settle at the receipt's usage
              // when provable, else the bound, and let Pi retry after backoff.
              if (base === CLAUDE_CODE_RATE_LIMIT && !interruptedBatch && (observedSettled || settleAtBound())) {
                failed(describeTransient(model.provider, 'rate limit'));
                return;
              }
              if (base === CLAUDE_CODE_LIMIT || base === CLAUDE_CODE_RATE_LIMIT) {
                uncertain();
                failed(
                  base === CLAUDE_CODE_LIMIT
                    ? describeClaudeCodeLimit(model.provider, detail, interruptedBatch)
                    : describeClaudeCodeRateLimit(model.provider, interruptedBatch),
                );
                return;
              }
            }
            if (!isClaudeCodeModel(model) && event.reason !== 'aborted' && interrupted(errorMessage)) return;
            const released = !observedSettled && uncertain();
            failed(
              observedSettled
                ? 'The provider request failed after reporting its usage; that usage was counted.'
                : released
                  ? 'The request failed before reaching the provider; the reservation was released and nothing was charged.'
                  : describeFailure(model.provider),
              event.reason === 'aborted',
            );
            return;
          }
          if (event.type === 'done') {
            const usage =
              event.reason !== 'deferred' && (!event.message.responseModel || event.message.responseModel === model.id)
                ? normalizePiUsage(model, event.message.usage)
                : null;
            if (!usage) {
              const released = uncertain();
              failed(
                released
                  ? 'Provider finished without trustworthy usage, but no request reached it; the reservation was released.'
                  : 'Provider finished without trustworthy final usage; budget usage is unknown and its reservation is retained.',
              );
              return;
            }
            const receipt = config.ledger.settle({
              dispatchId: id,
              receiptId: randomUUID(),
              outcome: 'known',
              tokens: usage.tokens,
              spendMicroUsd: subscriptionUsage(model, config.executionMode, config.subscriptionExempt, subscribed)
                ? 0
                : usage.spendMicroUsd,
              usage: {
                inputTokens: event.message.usage.input,
                outputTokens: event.message.usage.output,
                cacheReadTokens: event.message.usage.cacheRead,
                cacheWriteTokens: event.message.usage.cacheWrite,
              },
            });
            if (!receipt.ok) {
              uncertain();
              failed(
                'Budget receipt could not be durably recorded; usage is unknown. Reopen and reconcile the journal.',
              );
              return;
            }
            settled = true;
            output.push({ ...event, message: cleanMessage(event.message) });
            output.end();
            return;
          }
          output.push({ ...event, partial: cleanMessage(event.partial) });
        }
        if (!isClaudeCodeModel(model) && interrupted('stream disconnected before completion')) return;
        const released = uncertain();
        failed(
          released
            ? 'Provider stream ended before any request was sent; the reservation was released.'
            : 'Provider stream ended without a final receipt; budget usage is unknown and its reservation is retained.',
        );
      } catch (error) {
        if (controller.signal.aborted && settled) {
          failed('Request cancelled during retry backoff; the failed attempt was counted at its settled usage.', true);
          return;
        }
        if (releaseUnsent() || releaseRejected()) return;
        if (!isClaudeCodeModel(model) && dispatched && interrupted(error instanceof Error ? error.message : undefined))
          return;
        const released = uncertain();
        failed(
          dispatched
            ? released
              ? 'Provider request was never sent; the reservation was released and nothing was charged.'
              : 'Provider request interrupted; budget usage is unknown and its reservation is retained.'
            : 'OMS could not prepare this request safely. No provider request sent; your saved work is unchanged.',
          controller.signal.aborted,
        );
      } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onCallerAbort);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        controller.abort();
      }
    };
    void run();
    return output;
  };
  return streamAttempt;
}

export interface BudgetJournalOptions {
  /** Under an existing trusted external task-state directory; task lease is owned by the caller. */
  readonly path: string;
  readonly caps: BudgetCaps;
  readonly clock: () => number;
  readonly startedAt?: number;
  readonly executionMode?: ExecutionMode;
}
export interface BudgetJournal {
  ledger: BudgetLedger;
  close(): void;
}

function safeStat(stat: Stats, directory = false): boolean {
  return (
    (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) &&
    (stat.mode & 0o777) === (directory ? 0o700 : 0o600) &&
    stat.uid === process.getuid?.()
  );
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Strict JSONL opener: no repair/truncation, no symlinks, no stale writes. fsync precedes admission.
 * This is not a lease: the parent must hold the task mutation lease for the entire open lifetime.
 */
export function openBudgetJournal(options: BudgetJournalOptions): BudgetJournal {
  const path = resolve(options.path);
  const directory = dirname(path);
  let fd: number | undefined;
  try {
    if (realpathSync(directory) !== directory || !safeStat(lstatSync(directory), true))
      throw new Error('unsafe directory');
    let created = false;
    try {
      fd = openSync(
        path,
        constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      if (!safeStat(lstatSync(path))) throw new Error('unsafe file');
      fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    }
    let expected = fstatSync(fd);
    if (!safeStat(expected) || !sameFile(expected, lstatSync(path))) throw new Error('unsafe file');
    const contents = readFileSync(fd, 'utf8');
    if (!created && (contents.length === 0 || !contents.endsWith('\n'))) throw new Error('torn or empty journal');
    const events: BudgetLedgerEvent[] =
      contents === ''
        ? []
        : contents
            .slice(0, -1)
            .split('\n')
            .map((line) => JSON.parse(line));
    if (!sameFile(expected, fstatSync(fd)) || !sameFile(expected, lstatSync(path))) throw new Error('stale journal');
    let closed = false;
    const descriptor = fd;
    const ledger = createBudgetLedger({
      caps: options.caps,
      clock: options.clock,
      startedAt: options.startedAt,
      executionMode: options.executionMode,
      events,
      persist(event) {
        if (closed || realpathSync(directory) !== directory || !safeStat(lstatSync(directory), true))
          throw new Error('journal closed or moved');
        const current = fstatSync(descriptor);
        const named = lstatSync(path);
        if (!safeStat(current) || !safeStat(named) || !sameFile(current, expected) || !sameFile(named, expected))
          throw new Error('stale journal');
        const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
        let written = 0;
        while (written < bytes.length) {
          const length = writeSync(descriptor, bytes, written, bytes.length - written);
          if (length === 0) throw new Error('incomplete journal append');
          written += length;
        }
        fsyncSync(descriptor);
        expected = fstatSync(descriptor);
      },
    });
    if (created) {
      const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
    // A process restart cannot establish whether an admitted-but-unsettled call reached its provider.
    // Keep its full bound charged and block admission until an explicit trusted reconciliation.
    for (const dispatchId of ledger.snapshot().pendingDispatchIds) {
      const last = events.findLast(
        (event) => event.type === 'budget_settle' && event.receipt.dispatchId === dispatchId,
      );
      if (last?.type === 'budget_settle' && last.receipt.outcome === 'uncertain') continue;
      const result = ledger.settle({
        dispatchId,
        receiptId: randomUUID(),
        outcome: 'uncertain',
        tokens: null,
        spendMicroUsd: null,
      });
      if (!result.ok) throw new Error('recovery receipt failed');
    }
    return {
      ledger,
      close() {
        if (!closed) {
          closed = true;
          closeSync(descriptor);
        }
      },
    };
  } catch {
    if (fd !== undefined) closeSync(fd);
    throw new Error(
      'Budget journal refused: unsafe, stale, malformed, torn or incompatible state; trusted recovery required.',
    );
  }
}
