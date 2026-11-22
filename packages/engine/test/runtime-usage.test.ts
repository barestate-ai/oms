import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Api,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { streamSimple as codexStreamSimple } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { streamSimple as anthropicStreamSimple } from '@earendil-works/pi-ai/api/anthropic-messages';
import { streamSimple as openaiStreamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { thinkingBudgetForLevel, MIN_ANSWER_TOKENS } from '@earendil-works/pi-ai/api/simple-options';
import { isRetryableAssistantError } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createBudgetLedger, type BudgetLedgerEvent } from '@oms/core';
import { createMeteredStream, openBudgetJournal, modelReadiness } from '../src/runtime/usage.ts';
import { modelReservationBound, normalizePiUsage } from '@oms/core/usage';
import { createDispatchAllocator } from '@oms/core/dispatch';

const caps = { tokens: 100_000, spendMicroUsd: 1_000_000, wallClockMs: 60_000 };
const model: Model<Api> = {
  id: 'controlled',
  name: 'Controlled',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'http://127.0.0.1:1',
  input: ['text'],
  reasoning: false,
  contextWindow: 1_000,
  maxTokens: 100,
  cost: { input: 2, output: 6, cacheRead: 1, cacheWrite: 3 },
};
function message(): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'visible answer' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason: 'stop',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 2,
      cacheWrite1h: 1,
      reasoning: 2,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function fixture(streamFunction?: StreamFn, customCaps = caps, onBareBadRequest?: () => void) {
  const events: BudgetLedgerEvent[] = [];
  const ledger = createBudgetLedger({
    caps: customCaps,
    clock: Date.now,
    persist: (event) => {
      events.push(event);
    },
  });
  let calls = 0;
  const original: StreamFn =
    streamFunction ??
    (() => {
      calls++;
      const stream = createAssistantMessageEventStream();
      const result = message();
      stream.push({ type: 'start', partial: result });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'visible answer', partial: result });
      stream.push({ type: 'done', reason: 'stop', message: result });
      stream.end();
      return stream;
    });
  const stream = createMeteredStream({
    streamFunction: original,
    ledger,
    allocate: createDispatchAllocator(),
    maxOutputTokens: 50,
    logicalTurnId: () => 'user-run-1',
    onBareBadRequest,
  });
  return { stream, ledger, events, calls: () => calls };
}
async function consume(streamFn: StreamFn, selected = model, signal?: AbortSignal) {
  const stream = await streamFn(selected, normalizeContext({ messages: [] }), { signal });
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

test('Codex reserves its entire catalog output capacity rather than advertising an unenforceable local cap', async () => {
  const codex = { ...model, api: 'openai-codex-responses', provider: 'openai-codex' };
  assert.deepEqual(modelReservationBound(codex, 50), { tokens: 1100, spendMicroUsd: 4600 });
  const f = fixture(async (selected, _context, options) => {
    assert.equal(options?.transport, 'sse');
    assert.equal(options?.maxRetries, 0);
    assert.equal(options?.maxTokens, selected.maxTokens);
    const payload = await options?.onPayload?.({ model: selected.id, store: false }, selected);
    assert.equal('max_output_tokens' in (payload as object), false);
    assert.equal('max_completion_tokens' in (payload as object), false);
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: 'done',
      reason: 'stop',
      message: { ...message(), api: selected.api, provider: selected.provider },
    });
    return stream;
  });
  assert.equal((await consume(f.stream, codex)).result.stopReason, 'stop');
  const reservation = f.events.find((event) => event.type === 'budget_reserve');
  assert.equal(reservation?.reservation.tokens, 1100);
});

test('Codex unknown outcomes retain full output reservation and prevent another dispatch', async () => {
  const codex = { ...model, api: 'openai-codex-responses', provider: 'openai-codex' };
  let calls = 0;
  const f = fixture(() => {
    calls++;
    throw new Error('synthetic provider failure');
  });
  assert.equal((await consume(f.stream, codex)).result.stopReason, 'error');
  assert.equal(f.ledger.snapshot().used.tokens, 1100);
  assert.equal(f.ledger.snapshot().accounting, 'unknown');
  await consume(f.stream, codex);
  assert.equal(calls, 1);
});

const nativeClaude: Model<Api> = {
  ...model,
  provider: 'claude-code',
  api: 'claude-code',
  baseUrl: 'claude-code://local',
  id: 'sonnet',
};

test('native Claude subscription keeps token reservations and accounts receipts at zero API spend in both modes', async () => {
  for (const executionMode of ['interactive', 'bounded'] as const) {
    const events: BudgetLedgerEvent[] = [];
    const ledger = createBudgetLedger({
      caps,
      executionMode,
      clock: Date.now,
      persist: (event) => {
        events.push(event);
      },
    });
    assert.equal(ledger.beginOperation(`native-${executionMode}`).ok, true);
    const stream = createMeteredStream({
      ledger,
      executionMode,
      allocate: createDispatchAllocator(),
      maxOutputTokens: 5,
      logicalTurnId: () => `native-${executionMode}`,
      streamFunction: (selected, _context, options) => {
        assert.equal(options?.maxTokens, selected.maxTokens);
        const source = createAssistantMessageEventStream();
        source.push({
          type: 'done',
          reason: 'stop',
          message: { ...message(), api: selected.api, provider: selected.provider, model: selected.id },
        });
        return source;
      },
    });
    const readiness = modelReadiness(nativeClaude, ledger, 5, executionMode);
    assert.equal(readiness.ready, true);
    assert.match(readiness.detail, /Claude Code subscription/);
    assert.equal((await consume(stream, nativeClaude)).result.stopReason, 'stop');
    assert.equal(ledger.snapshot().used.tokens, 20);
    assert.equal(ledger.snapshot().used.spendMicroUsd, 0);
    const reservation = events.find((event) => event.type === 'budget_reserve')!;
    assert.equal(reservation.reservation.tokens, 1_100);
    assert.equal(reservation.reservation.spendMicroUsd, 0);
    assert.equal(events.filter((event) => event.type === 'budget_settle').length, 1);
  }
});

test('native Claude refuses an unenforceable local input cap before reserving or dispatching', async () => {
  const ledger = createBudgetLedger({ caps, clock: Date.now, persist() {} });
  let calls = 0;
  const stream = createMeteredStream({
    ledger,
    allocate: createDispatchAllocator(),
    maxOutputTokens: 5,
    maxInputTokens: 500,
    logicalTurnId: () => 'native-input-cap',
    streamFunction: () => {
      calls++;
      throw new Error('must not dispatch');
    },
  });
  assert.match(modelReadiness(nativeClaude, ledger, 5, 'bounded', 500).detail, /cannot enforce a local input cap/);
  const result = (await consume(stream, nativeClaude)).result;
  assert.match(result.errorMessage!, /cannot enforce a local input cap/);
  assert.equal(calls, 0);
  assert.equal(ledger.reservations().length, 0);
});

test('native Claude missing usage or cancellation retains the full token reservation and blocks later calls', async () => {
  for (const outcome of ['missing', 'cancelled'] as const) {
    const ledger = createBudgetLedger({ caps, clock: Date.now, persist() {} });
    const controller = new AbortController();
    let calls = 0;
    const stream = createMeteredStream({
      ledger,
      allocate: createDispatchAllocator(),
      maxOutputTokens: 5,
      logicalTurnId: () => `native-${outcome}`,
      streamFunction: (selected) => {
        calls++;
        const source = createAssistantMessageEventStream();
        if (outcome === 'cancelled') controller.abort();
        else
          source.push({
            type: 'done',
            reason: 'stop',
            message: {
              ...message(),
              api: selected.api,
              provider: selected.provider,
              model: selected.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          });
        return source;
      },
    });
    const result = (await consume(stream, nativeClaude, controller.signal)).result;
    assert.equal(result.stopReason, outcome === 'cancelled' ? 'aborted' : 'error');
    assert.equal(ledger.snapshot().accounting, 'unknown');
    assert.equal(ledger.snapshot().used.tokens, 1_100);
    assert.equal(ledger.snapshot().used.spendMicroUsd, 0);
    await consume(stream, nativeClaude);
    assert.equal(calls, 1);
  }
});

test('native Claude refusal with no output releases the reservation and shows the provider reason', async () => {
  const ledger = createBudgetLedger({ caps, clock: Date.now, persist() {} });
  let calls = 0;
  const stream = createMeteredStream({
    ledger,
    allocate: createDispatchAllocator(),
    maxOutputTokens: 5,
    logicalTurnId: () => 'native-refusal',
    streamFunction: (selected) => {
      calls++;
      const source = createAssistantMessageEventStream();
      if (calls === 1) {
        source.push({
          type: 'error',
          reason: 'error',
          error: {
            ...message(),
            api: selected.api,
            provider: selected.provider,
            model: selected.id,
            content: [],
            stopReason: 'error',
            errorMessage:
              'Claude Code native chat stopped: Prompt is too long. No API-key fallback was used.',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        });
        source.end();
      } else {
        const result = {
          ...message(),
          api: selected.api,
          provider: selected.provider,
          model: selected.id,
        };
        source.push({ type: 'start', partial: result });
        source.push({ type: 'done', reason: 'stop', message: result });
        source.end();
      }
      return source;
    },
  });
  const result = (await consume(stream, nativeClaude)).result;
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage!, /too long/);
  assert.equal(ledger.snapshot().accounting, 'known');
  assert.equal(ledger.snapshot().used.tokens, 0);
  const retry = (await consume(stream, nativeClaude)).result;
  assert.equal(retry.stopReason, 'stop');
  assert.equal(calls, 2);
});

test('native Claude failure after streamed output or without refusal words stays unknown', async () => {
  for (const variant of ['content', 'generic'] as const) {
    const ledger = createBudgetLedger({ caps, clock: Date.now, persist() {} });
    let calls = 0;
    const stream = createMeteredStream({
      ledger,
      allocate: createDispatchAllocator(),
      maxOutputTokens: 5,
      logicalTurnId: () => `native-failure-${variant}`,
      streamFunction: (selected) => {
        calls++;
        const source = createAssistantMessageEventStream();
        const error: AssistantMessage = {
          ...message(),
          api: selected.api,
          provider: selected.provider,
          model: selected.id,
          content: variant === 'content' ? message().content : [],
          stopReason: 'error',
          errorMessage:
            variant === 'content'
              ? 'Claude Code native chat stopped: rate limit reached mid-answer. No API-key fallback was used.'
              : 'Claude Code native chat stopped: Unexpected or failed native receipt. No API-key fallback was used.',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        source.push({ type: 'error', reason: 'error', error });
        source.end();
        return source;
      },
    });
    const result = (await consume(stream, nativeClaude)).result;
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage!, /broke off/);
    assert.equal(ledger.snapshot().accounting, 'unknown');
    assert.equal(ledger.snapshot().used.tokens, 1_100);
    await consume(stream, nativeClaude);
    assert.equal(calls, 1);
  }
});

test('custom native Claude identities never gain the subscription transport exemption', async () => {
  const f = fixture();
  for (const candidate of [
    { ...nativeClaude, provider: 'custom' },
    { ...nativeClaude, baseUrl: 'https://example.test' },
    { ...nativeClaude, api: 'unproved-api' },
    { ...nativeClaude, id: 'unrecognized' },
  ])
    assert.equal((await consume(f.stream, candidate)).result.stopReason, 'error');
  assert.equal(f.calls(), 0);
});

test('native Claude keeps the existing bounded-run stop when the explicit API budget is exhausted', async () => {
  const f = fixture(undefined, { ...caps, spendMicroUsd: 0 });
  assert.equal((await consume(f.stream, nativeClaude)).result.stopReason, 'error');
  assert.equal(f.calls(), 0);
  assert.equal(f.ledger.reservations().length, 0);
});

test('budget refusal produces a terminal Pi error without dispatch', async () => {
  const f = fixture(undefined, { ...caps, tokens: 1 });
  const { result, events } = await consume(f.stream);
  assert.equal(result.stopReason, 'error');
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal(f.calls(), 0);
  assert.equal(f.ledger.snapshot().used.tokens, 0);
});

test('normalized usage and terminal receipt are counted exactly once, without cache or reasoning duplication', async () => {
  const f = fixture();
  const { result, events } = await consume(f.stream);
  assert.equal(result.content[0]?.type, 'text');
  assert.ok(events.some((event) => event.type === 'text_delta' && event.delta === 'visible answer'));
  assert.equal(events.at(-1)?.type, 'done');
  assert.equal(f.ledger.snapshot().used.tokens, 20);
  assert.equal(f.ledger.snapshot().used.spendMicroUsd, 60);
  const settlements = f.events.filter((event) => event.type === 'budget_settle');
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0]?.receipt.outcome, 'known');
  const replay = createBudgetLedger({ caps, clock: Date.now, events: f.events, persist: () => {} });
  assert.equal(replay.snapshot().used.tokens, 20);
  assert.equal(replay.settle(settlements[0]!.receipt).ok, true);
  assert.equal(replay.snapshot().used.tokens, 20);
});

test('another billable attempt uses a distinct dispatch while preserving logical user run identity', async () => {
  const f = fixture();
  await consume(f.stream);
  await consume(f.stream);
  const reservations = f.events.filter((event) => event.type === 'budget_reserve');
  assert.equal(reservations.length, 2);
  assert.notEqual(reservations[0]!.reservation.dispatchId, reservations[1]!.reservation.dispatchId);
  assert.deepEqual(
    reservations.map((event) => event.reservation.attempt),
    [1, 2],
  );
  assert.ok(reservations.every((event) => event.reservation.logicalTurnId === 'user-run-1'));
  assert.equal(f.ledger.snapshot().used.tokens, 40);
});

test('partial provider error preserves the reservation and hides raw diagnostics', async () => {
  let calls = 0;
  const f = fixture(() => {
    calls++;
    const stream = createAssistantMessageEventStream();
    const partial = message();
    stream.push({ type: 'text_delta', contentIndex: 0, delta: 'partial', partial });
    stream.push({
      type: 'error',
      reason: 'error',
      error: { ...partial, stopReason: 'error', errorMessage: 'secret-token-provider-body' },
    });
    stream.end();
    return stream;
  });
  const first = await consume(f.stream);
  assert.equal(first.result.stopReason, 'error');
  assert.match(first.result.errorMessage!, /counted at its maximum cost/);
  assert.ok(!JSON.stringify(first).includes('secret-token-provider-body'));
  assert.equal(f.ledger.snapshot().accounting, 'unknown');
  assert.equal(f.ledger.snapshot().used.tokens, 1050);
  assert.equal((await consume(f.stream)).result.stopReason, 'error');
  assert.equal(calls, 1);
});

test('terminal output without usage is uncertain rather than a free success', async () => {
  const f = fixture(() => {
    const stream = createAssistantMessageEventStream();
    const result = message();
    result.usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    stream.push({ type: 'done', reason: 'stop', message: result });
    return stream;
  });
  assert.match((await consume(f.stream)).result.errorMessage!, /unknown/i);
  assert.equal(f.ledger.snapshot().accounting, 'unknown');
});

test('wall deadline aborts a stalled provider and resolves the consumer terminal result', async () => {
  let signal: AbortSignal | undefined;
  const f = fixture(
    (_model, _context, options) => {
      signal = options?.signal;
      return createAssistantMessageEventStream();
    },
    { ...caps, wallClockMs: 40 },
  );
  const { result } = await consume(f.stream);
  assert.equal(result.stopReason, 'aborted');
  assert.equal(signal?.aborted, true);
  assert.equal(f.ledger.snapshot().accounting, 'unknown');
});

test('caller cancellation terminates even an unresolved provider stream promise', async () => {
  const abort = new AbortController();
  const f = fixture(() => new Promise(() => {}));
  const pending = consume(f.stream, model, abort.signal);
  abort.abort();
  const { result } = await pending;
  assert.equal(result.stopReason, 'aborted');
  assert.equal(f.ledger.snapshot().accounting, 'unknown');
});

test('unknown/all-zero prices and unsupported APIs refuse without dispatch', async () => {
  const f = fixture();
  for (const selected of [
    { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { ...model, cost: { ...model.cost, output: Number.NaN } },
    { ...model, api: 'unproved-api' },
  ]) {
    assert.equal((await consume(f.stream, selected)).result.stopReason, 'error');
  }
  assert.equal(f.calls(), 0);
});

test('transport options disable retries and enforce the final output cap after payload hooks', async () => {
  const f = fixture(async (selected, _context, options) => {
    assert.equal(options?.maxRetries, 0);
    assert.equal(options?.transport, 'sse');
    assert.equal(options?.maxTokens, 50);
    const payload = (await options!.onPayload!(
      { model: selected.id, max_completion_tokens: 9999 },
      selected,
    )) as Record<string, unknown>;
    assert.equal(payload.max_completion_tokens, 50);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: message() });
    return stream;
  });
  assert.equal((await consume(f.stream)).result.stopReason, 'stop');
});

test('a duplicate reservation never authorizes another dispatch', async () => {
  const f = fixture();
  const original = f.ledger.reserve.bind(f.ledger);
  f.ledger.reserve = (reservation) => {
    const first = original(reservation);
    return first.ok ? { ...first, duplicate: true } : first;
  };
  assert.equal((await consume(f.stream)).result.stopReason, 'error');
  assert.equal(f.calls(), 0);
});

function journalFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'oms-usage-')));
  chmodSync(directory, 0o700);
  return {
    directory,
    path: join(directory, 'budget.jsonl'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('durable replay preserves known spend and rejects changed budget configuration', async () => {
  const f = journalFixture();
  try {
    const first = openBudgetJournal({ path: f.path, caps, clock: Date.now });
    const stream = createMeteredStream({
      streamFunction: fixture().stream,
      ledger: first.ledger,
      allocate: createDispatchAllocator(first.ledger.reservations()),
      maxOutputTokens: 50,
      logicalTurnId: () => 'durable-run',
    });
    assert.equal((await consume(stream)).result.stopReason, 'stop');
    first.close();
    const reopened = openBudgetJournal({ path: f.path, caps, clock: Date.now });
    assert.equal(reopened.ledger.snapshot().used.tokens, 20);
    reopened.close();
    assert.throws(
      () => openBudgetJournal({ path: f.path, caps: { ...caps, tokens: caps.tokens + 1 }, clock: Date.now }),
      /journal/i,
    );
  } finally {
    f.cleanup();
  }
});

test('crashed pending dispatch is replayed as unknown and cannot be admitted again', () => {
  const f = journalFixture();
  try {
    const first = openBudgetJournal({ path: f.path, caps, clock: Date.now });
    assert.equal(
      first.ledger.reserve({ dispatchId: 'lost', logicalTurnId: 'run', attempt: 1, tokens: 100, spendMicroUsd: 200 })
        .ok,
      true,
    );
    first.close();
    const recovered = openBudgetJournal({ path: f.path, caps, clock: Date.now });
    assert.equal(recovered.ledger.snapshot().accounting, 'unknown');
    assert.equal(recovered.ledger.snapshot().used.spendMicroUsd, 200);
    assert.equal(
      recovered.ledger.reserve({
        dispatchId: 'next',
        logicalTurnId: 'run',
        attempt: 2,
        tokens: 100,
        spendMicroUsd: 200,
      }).ok,
      false,
    );
    recovered.close();
  } finally {
    f.cleanup();
  }
});

test('torn, empty-existing, symlinked and unsafe-mode journals are refused', () => {
  const f = journalFixture();
  try {
    writeFileSync(f.path, '{"type":"budget_open"', { mode: 0o600 });
    assert.throws(() => openBudgetJournal({ path: f.path, caps, clock: Date.now }), /journal/i);
    writeFileSync(f.path, '');
    assert.throws(() => openBudgetJournal({ path: f.path, caps, clock: Date.now }), /journal/i);
    chmodSync(f.path, 0o644);
    assert.throws(() => openBudgetJournal({ path: f.path, caps, clock: Date.now }), /journal/i);
    const link = join(f.directory, 'link.jsonl');
    symlinkSync(f.path, link);
    assert.throws(() => openBudgetJournal({ path: link, caps, clock: Date.now }), /journal/i);
  } finally {
    f.cleanup();
  }
});

test('external journal mutation is a durable admission failure rather than overwritten history', () => {
  const f = journalFixture();
  try {
    const journal = openBudgetJournal({ path: f.path, caps, clock: Date.now });
    writeFileSync(f.path, readFileSync(f.path, 'utf8') + '{}\n');
    const result = journal.ledger.reserve({
      dispatchId: 'next',
      logicalTurnId: 'run',
      attempt: 1,
      tokens: 100,
      spendMicroUsd: 200,
    });
    assert.equal(result.ok, false);
    assert.equal(journal.ledger.snapshot().admissionBlocked, true);
    journal.close();
  } finally {
    f.cleanup();
  }
});

test('cache support stays unknown and tiered prices use normalized disjoint token categories', () => {
  const selected = {
    ...model,
    cost: { ...model.cost, tiers: [{ inputTokensAbove: 10, input: 4, output: 8, cacheRead: 2, cacheWrite: 6 }] },
  };
  assert.deepEqual(normalizePiUsage(selected, message().usage), { tokens: 20, spendMicroUsd: 100 });
});

test('already cancelled calls never acquire a reservation or contact the provider', async () => {
  const abort = new AbortController();
  abort.abort();
  const f = fixture();
  assert.equal((await consume(f.stream, model, abort.signal)).result.stopReason, 'aborted');
  assert.equal(f.calls(), 0);
  assert.equal(f.events.filter((event) => event.type === 'budget_reserve').length, 0);
});

test('thrown/rejected request failures become safe unknown errors', async () => {
  const providers: StreamFn[] = [
    () => {
      throw new Error('provider-secret');
    },
    async () => {
      throw new Error('provider-secret');
    },
  ];
  for (const provider of providers) {
    const f = fixture(provider);
    const { result, events } = await consume(f.stream);
    assert.equal(result.stopReason, 'error');
    assert.equal(events.at(-1)?.type, 'error');
    assert.ok(!JSON.stringify(result).includes('provider-secret'));
    assert.equal(f.ledger.snapshot().accounting, 'unknown');
  }
});

test('hidden provider payload retries fail closed instead of creating an unreserved call', async () => {
  const f = fixture(async (selected, _context, options) => {
    await options!.onPayload!({ model: selected.id }, selected);
    await options!.onPayload!({ model: selected.id }, selected);
    throw new Error('unreachable');
  });
  assert.equal((await consume(f.stream)).result.stopReason, 'error');
  assert.equal(f.ledger.snapshot().accounting, 'unknown');
  assert.equal(f.events.filter((event) => event.type === 'budget_reserve').length, 1);
});

test('cache token usage with unknown zero cache pricing cannot become free known usage', () => {
  assert.equal(normalizePiUsage({ ...model, cost: { ...model.cost, cacheRead: 0 } }, message().usage), null);
});

test('payloads cannot enable separately priced provider tools, routing fallbacks or premium service', async () => {
  for (const additions of [
    { tools: [{ type: 'web_search_preview' }] },
    { fallbacks: [{ model: 'other-model' }] },
    { service_tier: 'priority' },
  ]) {
    const f = fixture(async (selected, _context, options) => {
      await options!.onPayload!({ model: selected.id, ...additions }, selected);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: message() });
      return stream;
    });
    assert.equal((await consume(f.stream)).result.stopReason, 'error');
    assert.equal(f.ledger.snapshot().accounting, 'unknown');
  }
});

test('the single-request transport refuses hidden retries and does not call fetch twice', async () => {
  let requests = 0;
  const f = fixture(async (_selected, _context, options) => {
    await options!.fetch!('http://127.0.0.1:1');
    await options!.fetch!('http://127.0.0.1:1');
    throw new Error('unreachable');
  });
  const stream = await f.stream(model, normalizeContext({ messages: [] }), {
    fetch: async () => {
      requests++;
      return new Response('controlled');
    },
  });
  const result = await stream.result();
  assert.equal(result.stopReason, 'error');
  assert.equal(requests, 1);
  assert.equal(f.ledger.snapshot().accounting, 'unknown');
});

test('real Codex adapter uses one metered SSE fetch and normalized final usage without live credentials', async () => {
  const codex: Model<'openai-codex-responses'> = { ...model, api: 'openai-codex-responses', provider: 'openai-codex' };
  const token = `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64')}.synthetic`;
  let requests = 0;
  const f = fixture((selected, context, options) =>
    codexStreamSimple({ ...selected, api: 'openai-codex-responses' }, context, options),
  );
  const source = await f.stream(codex, normalizeContext({ messages: [] }), {
    apiKey: token,
    fetch: async (url, init) => {
      requests++;
      assert.equal(String(url), 'http://127.0.0.1:1/codex/responses');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      const event = {
        type: 'response.completed',
        response: {
          id: 'controlled-response',
          status: 'completed',
          output: [],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
      };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const result = await source.result();
  assert.equal(result.stopReason, 'stop');
  assert.equal(requests, 1);
  assert.equal(f.ledger.snapshot().used.tokens, 15);
  assert.equal(f.ledger.snapshot().used.spendMicroUsd, Math.ceil(Math.max(47, result.usage.cost.total * 1_000_000)));
});

test('real Codex adapter cannot retry a metered rate-limit response', async () => {
  const codex: Model<'openai-codex-responses'> = { ...model, api: 'openai-codex-responses', provider: 'openai-codex' };
  const token = `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64')}.synthetic`;
  let requests = 0;
  const f = fixture((selected, context, options) =>
    codexStreamSimple({ ...selected, api: 'openai-codex-responses' }, context, options),
  );
  const source = await f.stream(codex, normalizeContext({ messages: [] }), {
    apiKey: token,
    fetch: async () => {
      requests++;
      return new Response('controlled rate limit', { status: 429 });
    },
  });
  assert.equal((await source.result()).stopReason, 'error');
  assert.equal(requests, 1);
  assert.equal(f.ledger.snapshot().used.tokens, 1100);
  // A 429 is transient: settled at the reserved bound so the turn can be retried.
  assert.equal(f.ledger.snapshot().accounting, 'known');
});

function anthropicResponse(id: string): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'synthetic',
        type: 'message',
        role: 'assistant',
        model: id,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('real Anthropic adapter fits canonical medium thinking inside the total OMS output cap', async () => {
  const selected: Model<'anthropic-messages'> = {
    ...model,
    id: 'synthetic-thinking',
    api: 'anthropic-messages',
    compat: undefined,
    provider: 'anthropic',
    reasoning: true,
    maxTokens: 16_384,
    contextWindow: 32_768,
  };
  const events: BudgetLedgerEvent[] = [];
  const ledger = createBudgetLedger({
    caps,
    clock: Date.now,
    persist: (event) => {
      events.push(event);
    },
  });
  const stream = createMeteredStream({
    ledger,
    allocate: createDispatchAllocator(),
    maxOutputTokens: 2048,
    logicalTurnId: () => 'thinking',
    streamFunction: (selected, context, options) =>
      anthropicStreamSimple({ ...selected, api: 'anthropic-messages', compat: undefined }, context, options),
  });
  let requests = 0;
  const source = await stream(
    selected,
    normalizeContext({ messages: [{ role: 'user', content: 'synthetic', timestamp: 0 }] }),
    {
      reasoning: 'medium',
      apiKey: 'synthetic-offline',
      fetch: async (_url, init) => {
        requests++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.max_tokens, 2048);
        assert.equal(body.thinking.type, 'enabled');
        assert.equal(body.thinking.budget_tokens, 2048 - MIN_ANSWER_TOKENS);
        assert.ok(body.thinking.budget_tokens >= thinkingBudgetForLevel('minimal'));
        return anthropicResponse(selected.id);
      },
    },
  );
  assert.equal((await source.result()).stopReason, 'stop');
  assert.equal(requests, 1);
  assert.equal(ledger.snapshot().accounting, 'known');
  assert.equal(
    events.find((event) => event.type === 'budget_reserve')?.reservation.tokens,
    selected.contextWindow + 2048,
  );
});

test('incompatible thinking is refused before reservation and the real adapter can still run with thinking explicitly off', async () => {
  const selected: Model<'anthropic-messages'> = {
    ...model,
    id: 'synthetic-thinking',
    api: 'anthropic-messages',
    compat: undefined,
    provider: 'anthropic',
    reasoning: true,
    maxTokens: 16_384,
    contextWindow: 32_768,
  };
  const events: BudgetLedgerEvent[] = [];
  const ledger = createBudgetLedger({
    caps,
    clock: Date.now,
    persist: (event) => {
      events.push(event);
    },
  });
  let calls = 0;
  let requests = 0;
  const stream = createMeteredStream({
    ledger,
    allocate: createDispatchAllocator(),
    maxOutputTokens: 1024,
    logicalTurnId: () => 'low-cap',
    streamFunction: (selected, context, options) => {
      calls++;
      return anthropicStreamSimple({ ...selected, api: 'anthropic-messages', compat: undefined }, context, options);
    },
  });
  const context = normalizeContext({ messages: [{ role: 'user', content: 'synthetic', timestamp: 0 }] });
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    requests++;
    assert.equal(JSON.parse(String(init?.body)).thinking.type, 'disabled');
    return anthropicResponse(selected.id);
  };
  const refused = await stream(selected, context, { reasoning: 'medium', apiKey: 'synthetic-offline', fetch });
  assert.match((await refused.result()).errorMessage!, /thinking.*output cap/i);
  assert.equal(calls, 0);
  assert.equal(requests, 0);
  assert.equal(events.filter((event) => event.type === 'budget_reserve').length, 0);
  assert.equal(ledger.snapshot().accounting, 'known');
  const allowed = await stream(selected, context, { apiKey: 'synthetic-offline', fetch });
  assert.equal((await allowed.result()).stopReason, 'stop');
  assert.equal(requests, 1);
});

test('real OpenAI adapter rejects post-hook 12h cache overrides before HTTP dispatch', async () => {
  for (const override of [
    { prompt_cache_options: { ttl: '12h' } },
    {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'synthetic', prompt_cache_breakpoint: { ttl: '12h' } }] },
      ],
    },
  ]) {
    const selected = { ...model, api: 'openai-responses', provider: 'openai' };
    const f = fixture((model, context, options) =>
      openaiStreamSimple({ ...model, api: 'openai-responses' }, context, options),
    );
    let requests = 0;
    const stream = await f.stream(
      selected,
      normalizeContext({ messages: [{ role: 'user', content: 'synthetic', timestamp: 0 }] }),
      {
        apiKey: 'synthetic-offline',
        onPayload: (payload) => ({ ...(payload as object), ...override }),
        fetch: async () => {
          requests++;
          throw Error('unexpected HTTP');
        },
      },
    );
    assert.equal((await stream.result()).stopReason, 'error');
    assert.equal(requests, 0);
  }
});

test('normal ChatGPT Sol uses subscription limits without an API-dollar admission charge', async () => {
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
    credentials: {
      async read() {
        return undefined;
      },
      async list() {
        return [];
      },
      async modify() {
        throw new Error('No credentials may be saved');
      },
      async delete() {},
    },
  });
  const selected = runtime.getPhysicalModel('openai-codex', 'gpt-6.1-sol')!;
  const events: BudgetLedgerEvent[] = [];
  const ledger = createBudgetLedger({
    caps: { tokens: 2_000_000, spendMicroUsd: 5_000_000, wallClockMs: 1_800_000 },
    clock: Date.now,
    persist: (event) => {
      events.push(event);
    },
  });
  const stream = createMeteredStream({
    ledger,
    allocate: createDispatchAllocator(),
    executionMode: 'interactive',
    maxOutputTokens: 2048,
    logicalTurnId: () => 'normal-chat',
    streamFunction: (model, context, options) =>
      codexStreamSimple({ ...model, api: 'openai-codex-responses' }, context, options),
  });
  assert.equal(ledger.beginOperation('normal-chat-turn').ok, true);
  const token = `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64')}.synthetic`;
  let requests = 0;
  const result = await (
    await stream(selected, normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }), {
      apiKey: token,
      fetch: async (url, init) => {
        requests++;
        assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('content-encoding'), 'zstd');
        assert.match(headers.get('authorization') ?? '', /^Bearer /);
        const completed = {
          type: 'response.completed',
          response: {
            id: 'normal-chat',
            status: 'completed',
            output: [],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        };
        return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    })
  ).result();
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.equal(requests, 1);
  assert.equal(ledger.snapshot().used.tokens, 15);
  assert.equal(ledger.snapshot().used.spendMicroUsd, 0);
  const reservation = events.find((event) => event.type === 'budget_reserve')!;
  assert.equal(reservation.reservation.tokens, selected.contextWindow + selected.maxTokens);
  assert.equal(reservation.reservation.spendMicroUsd, 0);
});

test('subscription exemption cannot cover bounded runs, other providers or custom endpoints', async () => {
  const selected = {
    ...model,
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    contextWindow: 500_000,
    maxTokens: 128_000,
    cost: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
  };
  for (const [candidate, executionMode] of [
    [selected, 'bounded'],
    [{ ...selected, provider: 'custom' }, 'interactive'],
    [{ ...selected, baseUrl: 'https://example.test' }, 'interactive'],
  ] as const) {
    const ledger = createBudgetLedger({
      caps: { tokens: 2_000_000, spendMicroUsd: 5_000_000, wallClockMs: 60_000 },
      clock: Date.now,
      persist() {},
    });
    let calls = 0;
    const stream = createMeteredStream({
      ledger,
      executionMode,
      allocate: createDispatchAllocator(),
      maxOutputTokens: 2048,
      logicalTurnId: () => 'boundary',
      streamFunction: () => {
        calls++;
        throw new Error('Unexpected dispatch');
      },
    });
    assert.equal((await consume(stream, candidate)).result.stopReason, 'error');
    assert.equal(calls, 0);
    assert.equal(ledger.reservations().length, 0);
  }
});

test('normal subscription failures retain token reservation and cannot dispatch again', async () => {
  const selected = {
    ...model,
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
  };
  const ledger = createBudgetLedger({ caps, clock: Date.now, persist() {} });
  let calls = 0;
  const stream = createMeteredStream({
    ledger,
    executionMode: 'interactive',
    allocate: createDispatchAllocator(),
    maxOutputTokens: 50,
    logicalTurnId: () => 'unknown-subscription',
    streamFunction: () => {
      calls++;
      throw new Error('Interrupted');
    },
  });
  assert.equal(ledger.beginOperation('unknown-subscription-turn').ok, true);
  assert.equal((await consume(stream, selected)).result.stopReason, 'error');
  assert.equal(ledger.snapshot().accounting, 'unknown');
  assert.equal(ledger.snapshot().used.tokens, 1100);
  assert.equal(ledger.snapshot().used.spendMicroUsd, 0);
  await consume(stream, selected);
  assert.equal(calls, 1);
});

test('a trusted subscription exemption lets a bounded ChatGPT-subscription run dispatch at $0; without it the run is refused', async () => {
  // GPT-6 Astra list price: one worst-case request alone exceeds a $4 bounded cap.
  const selected = {
    ...model,
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    contextWindow: 272_000,
    maxTokens: 128_000,
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 10 },
  };
  for (const subscriptionExempt of [false, true]) {
    const ledger = createBudgetLedger({
      caps: { tokens: 2_000_000, spendMicroUsd: 4_000_000, wallClockMs: 60_000 },
      clock: Date.now,
      persist() {},
    });
    assert.equal(ledger.beginOperation(`exempt-${subscriptionExempt}`).ok, true);
    let calls = 0;
    const stream = createMeteredStream({
      ledger,
      executionMode: 'bounded',
      allocate: createDispatchAllocator(),
      subscriptionExempt,
      maxOutputTokens: 128_000,
      logicalTurnId: () => `exempt-${subscriptionExempt}`,
      streamFunction: () => {
        calls++;
        throw new Error('dispatched');
      },
    });
    await consume(stream, selected);
    assert.equal(calls, subscriptionExempt ? 1 : 0, `exempt=${subscriptionExempt}`);
    assert.equal(ledger.snapshot().used.spendMicroUsd, 0);
  }
  // The exemption never covers another provider or endpoint.
  const ledger = createBudgetLedger({
    caps: { tokens: 2_000_000, spendMicroUsd: 4_000_000, wallClockMs: 60_000 },
    clock: Date.now,
    persist() {},
  });
  assert.equal(ledger.beginOperation('custom').ok, true);
  let calls = 0;
  const stream = createMeteredStream({
    ledger,
    executionMode: 'bounded',
    allocate: createDispatchAllocator(),
    subscriptionExempt: true,
    maxOutputTokens: 128_000,
    logicalTurnId: () => 'custom',
    streamFunction: () => {
      calls++;
      throw new Error('dispatched');
    },
  });
  await consume(stream, { ...selected, baseUrl: 'https://example.test' });
  assert.equal(calls, 0);
});

test('real Anthropic adapter: a { url } tool call in history (tool_use input) passes the input cap and the next turn is sent', async () => {
  const selected: Model<'anthropic-messages'> = {
    ...model,
    id: 'synthetic-web',
    api: 'anthropic-messages',
    compat: undefined,
    provider: 'anthropic',
    reasoning: false,
    maxTokens: 16_384,
    contextWindow: 32_768,
  };
  const ledger = createBudgetLedger({ caps, clock: Date.now, persist: () => {} });
  const stream = createMeteredStream({
    ledger,
    allocate: createDispatchAllocator(),
    maxOutputTokens: 2048,
    logicalTurnId: () => 'web',
    maxInputTokens: 20_000,
    streamFunction: (selected, context, options) =>
      anthropicStreamSimple({ ...selected, api: 'anthropic-messages', compat: undefined }, context, options),
  });
  let requests = 0;
  const source = await stream(
    selected,
    normalizeContext({
      messages: [
        { role: 'user', timestamp: 1, content: 'read the docs' },
        {
          role: 'assistant',
          timestamp: 2,
          api: selected.api,
          provider: selected.provider,
          model: selected.id,
          stopReason: 'toolUse',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          content: [
            { type: 'toolCall', id: 'c1', name: 'web_fetch', arguments: { url: 'https://example.com/error.rs' } },
          ],
        },
        {
          role: 'toolResult',
          timestamp: 3,
          toolCallId: 'c1',
          toolName: 'web_fetch',
          isError: true,
          content: [{ type: 'text', text: 'HTTP 404' }],
        },
      ],
    } as never),
    {
      apiKey: 'synthetic-offline',
      fetch: async (_url, init) => {
        requests++;
        assert.ok(String(init?.body).includes('"type":"tool_use"'));
        return anthropicResponse(selected.id);
      },
    },
  );
  const result = await source.result();
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.equal(requests, 1);
});

function erroring(message: string, events = 0): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    const partial = message_();
    for (let i = 0; i < events; i++) stream.push({ type: 'text_delta', contentIndex: 0, delta: 'x', partial });
    stream.push({ type: 'error', reason: 'error', error: { ...partial, stopReason: 'error', errorMessage: message } });
    stream.end();
    return stream;
  };
}
const message_ = message;

test('a dropped stream is settled at its reserved bound, then the next attempt is admitted and succeeds', async () => {
  let calls = 0;
  const f = fixture((selected, context, options) => {
    calls++;
    if (calls === 1) return erroring('terminated')(selected, context, options);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: message() });
    return stream;
  });
  const first = await consume(f.stream);
  assert.equal(first.result.stopReason, 'error');
  assert.ok(isRetryableAssistantError(first.result), 'the failure must read as transient so the turn is retried');
  assert.ok(!first.result.errorMessage!.includes('terminated'));
  let snapshot = f.ledger.snapshot();
  const bound = modelReservationBound(model, 50)!;
  assert.equal(snapshot.accounting, 'known');
  assert.equal(snapshot.used.tokens, bound.tokens);
  assert.equal(snapshot.used.spendMicroUsd, bound.spendMicroUsd);
  assert.equal((await consume(f.stream)).result.stopReason, 'stop');
  snapshot = f.ledger.snapshot();
  assert.equal(calls, 2);
  assert.deepEqual(
    f.events.filter((event) => event.type === 'budget_reserve').map((event) => event.reservation.attempt),
    [1, 2],
  );
  // Never under-counted: the failed attempt at its full bound plus the true usage of the success.
  assert.equal(snapshot.used.tokens, bound.tokens + 20);
  assert.ok(snapshot.used.spendMicroUsd > bound.spendMicroUsd);
});

test('transient causes (including after partial output) are settled at their bound; the stream ending silently too', async () => {
  const causes = [
    'terminated',
    'read ECONNRESET: socket hang up',
    '503 Service Unavailable',
    'overloaded_error',
    'fetch failed',
    '{"detail":"Bad Request"}',
  ];
  for (const cause of causes) {
    const f = fixture(erroring(cause, 2));
    assert.ok(isRetryableAssistantError((await consume(f.stream)).result), cause);
    assert.equal(f.ledger.snapshot().accounting, 'known', cause);
  }
  let forgotten = 0;
  const bare = fixture(erroring('{"detail":"Bad Request"}', 2), caps, () => {
    forgotten++;
  });
  assert.ok(isRetryableAssistantError((await consume(bare.stream)).result));
  assert.equal(forgotten, 1, 'a bare 400 asks the session to resend without old reasoning');
  const silent = fixture(() => {
    const stream = createAssistantMessageEventStream();
    stream.end();
    return stream;
  });
  assert.ok(isRetryableAssistantError((await consume(silent.stream)).result));
  assert.equal(silent.ledger.snapshot().accounting, 'known');
  assert.equal(silent.ledger.snapshot().used.tokens, modelReservationBound(model, 50)!.tokens);
});

test('retries are capped by the retry budget: every failed attempt stays charged at its bound', async () => {
  let calls = 0;
  const f = fixture((selected, context, options) => {
    calls++;
    return erroring('terminated')(selected, context, options);
  });
  const bound = modelReservationBound(model, 50)!;
  // Pi allows one initial call plus three retries per failure; the fourth failure is surfaced.
  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.equal((await consume(f.stream)).result.stopReason, 'error');
    assert.equal(f.ledger.snapshot().used.tokens, bound.tokens * attempt);
  }
  assert.equal(calls, 4);
  assert.equal(f.ledger.snapshot().accounting, 'known');
});

test('a transient failure that would exceed the remaining budget is refused, not retried for free', async () => {
  const bound = modelReservationBound(model, 50)!;
  let calls = 0;
  const f = fixture(
    (selected, context, options) => {
      calls++;
      return erroring('terminated')(selected, context, options);
    },
    { ...caps, tokens: bound.tokens + 10 },
  );
  await consume(f.stream);
  const second = await consume(f.stream);
  assert.equal(calls, 1);
  assert.equal(second.result.stopReason, 'error');
  assert.ok(!isRetryableAssistantError(second.result));
});

test('non-transient failures stay unknown, are not retryable, and block further dispatch', async () => {
  for (const cause of [
    '401 invalid x-api-key',
    'secret-token-provider-body',
    '400 {"error":{"message":"Invalid input"}}',
    'unpriced provider capability refused',
    'metered model substitution refused',
  ]) {
    let calls = 0;
    const f = fixture((selected, context, options) => {
      calls++;
      return erroring(cause)(selected, context, options);
    });
    const first = await consume(f.stream);
    assert.ok(!isRetryableAssistantError(first.result), cause);
    assert.equal(f.ledger.snapshot().accounting, 'unknown', cause);
    assert.ok(!isRetryableAssistantError((await consume(f.stream)).result), cause);
    assert.equal(calls, 1, cause);
  }
});

test('missing or mismatched final usage stays unknown and is not retryable', async () => {
  const mismatched = fixture(() => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: { ...message(), responseModel: 'something-else' } });
    return stream;
  });
  const result = (await consume(mismatched.stream)).result;
  assert.ok(!isRetryableAssistantError(result));
  assert.equal(mismatched.ledger.snapshot().accounting, 'unknown');
});

test('caller abort and an unpersistable bound are never converted into a conservative settle', async () => {
  const controller = new AbortController();
  const aborted = fixture(() => {
    controller.abort();
    return erroring('terminated')(model, normalizeContext({ messages: [] }), {});
  });
  const result = (await consume(aborted.stream, model, controller.signal)).result;
  assert.ok(!isRetryableAssistantError(result));
  assert.equal(aborted.ledger.snapshot().accounting, 'unknown');
  // The journal cannot record the receipt: usage is unknown rather than silently dropped.
  const persisted: string[] = [];
  const ledger = createBudgetLedger({
    caps,
    clock: Date.now,
    persist: (event) => {
      if (event.type === 'budget_settle') throw new Error('disk full');
      persisted.push(event.type);
    },
  });
  const stream = createMeteredStream({
    streamFunction: erroring('terminated'),
    ledger,
    allocate: createDispatchAllocator(),
    maxOutputTokens: 50,
    logicalTurnId: () => 'persist-fail',
  });
  assert.ok(!isRetryableAssistantError((await consume(stream)).result));
  assert.equal(ledger.snapshot().used.tokens, modelReservationBound(model, 50)!.tokens);
  assert.notEqual(ledger.snapshot().accounting, 'known');
});

test('only OpenAI itself is asked for background: false; xAI rejects the field', async () => {
  const sent: Record<string, Record<string, unknown>> = {};
  for (const provider of ['openai', 'xai']) {
    const f = fixture((model, context, options) =>
      openaiStreamSimple({ ...model, api: 'openai-responses' }, context, options),
    );
    const stream = await f.stream(
      { ...model, api: 'openai-responses', provider },
      normalizeContext({ messages: [{ role: 'user', content: 'synthetic', timestamp: 0 }] }),
      {
        apiKey: 'synthetic-offline',
        fetch: async (_url: unknown, init?: { body?: unknown }) => {
          sent[provider] = JSON.parse(String(init?.body));
          throw Error('offline');
        },
      },
    );
    await stream.result();
  }
  assert.equal(sent.openai?.background, false);
  assert.ok(sent.xai && !('background' in sent.xai), 'xAI request carries no background field');
});

async function rejectedWith(status: number, body: string, provider = 'xai') {
  const f = fixture((selected, context, options) =>
    openaiStreamSimple({ ...selected, api: 'openai-responses' }, context, options),
  );
  const selected = { ...model, api: 'openai-responses' as const, provider };
  const send = async () => {
    const stream = await f.stream(
      selected,
      normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }),
      {
        apiKey: 'synthetic-offline',
        fetch: async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }),
      },
    );
    return stream.result();
  };
  return { f, send };
}

test('a 4xx rejection before any output is shown in the provider words and releases the reservation', async () => {
  const { f, send } = await rejectedWith(
    400,
    JSON.stringify({ code: 'Client specified an invalid argument', error: 'Argument not supported: background' }),
  );
  const result = await send();
  assert.equal(result.stopReason, 'error');
  assert.equal(result.errorMessage, 'xAI rejected the request: Argument not supported: background');
  assert.ok(!isRetryableAssistantError(result));
  const snapshot = f.ledger.snapshot();
  assert.equal(snapshot.accounting, 'known');
  assert.equal(snapshot.used.tokens, 0);
  assert.equal(snapshot.used.spendMicroUsd, 0);
  assert.ok(
    !/unknown|No provider request sent/.test((await send()).errorMessage ?? ''),
    'the next message is admitted',
  );
});

test('a rejected key reads as an invalid key and points at /connect', async () => {
  const { f, send } = await rejectedWith(
    401,
    '{"error":{"message":"Incorrect API key provided: xai-abcdefghijklmnop"}}',
  );
  const result = await send();
  assert.equal(result.errorMessage, 'xAI says the API key is invalid. /connect to fix it.');
  assert.equal(f.ledger.snapshot().accounting, 'known');
});

test('a 4xx message never carries raw JSON or a key', async () => {
  const { send } = await rejectedWith(
    404,
    '{"error":{"message":"model sk-abcdefghijklmnopqrstu not found"}}',
    'openai',
  );
  const text = (await send()).errorMessage!;
  assert.match(text, /^OpenAI rejected the request: /);
  assert.ok(!text.includes('{') && !text.includes('sk-abcdefghijklmnopqrstu'), text);
});

test('a rate limit or a server error stays charged at its bound and says what happened', async () => {
  const limited = await rejectedWith(429, 'slow down');
  const rate = await limited.send();
  assert.equal(rate.errorMessage, 'xAI is rate limiting requests. Wait a moment and try again.');
  assert.ok(isRetryableAssistantError(rate), 'a rate limit is retried');
  assert.ok(limited.f.ledger.snapshot().used.tokens > 0, 'a 429 stays charged at the reserved bound');
  const broken = await rejectedWith(500, 'boom');
  const server = await broken.send();
  assert.equal(server.errorMessage, 'xAI reported a server error. Try again in a moment.');
  assert.ok(isRetryableAssistantError(server));
  assert.ok(broken.f.ledger.snapshot().used.tokens > 0, 'a 5xx stays charged at the reserved bound');
});

test('a dropped network says so in plain words and is retried', async () => {
  const f = fixture((selected, context, options) =>
    openaiStreamSimple({ ...selected, api: 'openai-responses' }, context, options),
  );
  const stream = await f.stream(
    { ...model, api: 'openai-responses', provider: 'xai' },
    normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }),
    {
      apiKey: 'synthetic-offline',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    },
  );
  const result = await stream.result();
  assert.equal(result.errorMessage, 'Network error reaching xAI. Check your connection and try again.');
  assert.ok(isRetryableAssistantError(result));
});

test('a Grok subscription sign-in is plan usage in a chat, while an xAI API key stays under the dollar cap', () => {
  const grok: Model<Api> = {
    ...model,
    id: 'grok-big',
    provider: 'xai',
    api: 'openai-responses',
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    cost: { input: 5, output: 15, cacheRead: 1, cacheWrite: 1 },
  };
  const ledger = createBudgetLedger({
    caps: { tokens: 10_000_000, spendMicroUsd: 1_000_000, wallClockMs: 60_000 },
    executionMode: 'interactive',
    clock: () => 0,
    persist() {},
  });
  const subscribed = modelReadiness(grok, ledger, 64_000, 'interactive', undefined, false, true);
  assert.equal(subscribed.ready, true);
  assert.match(subscribed.detail, /xAI subscription/);
  const apiKey = modelReadiness(grok, ledger, 64_000, 'interactive', undefined, false, false);
  assert.equal(apiKey.ready, false);
  assert.match(apiKey.detail, /cannot cover this model's maximum request cost/);
});

test('a chat request on a subscription login settles at no dollar charge; the same request on an API key is charged', async () => {
  const spent: Record<string, number> = {};
  for (const subscribed of [true, false]) {
    const ledger = createBudgetLedger({ caps, executionMode: 'interactive', clock: Date.now, persist() {} });
    assert.equal(ledger.beginOperation('turn').ok, true);
    const stream = createMeteredStream({
      streamFunction: () => {
        const stream = createAssistantMessageEventStream();
        const result = message();
        stream.push({ type: 'start', partial: result });
        stream.push({ type: 'done', reason: 'stop', message: result });
        stream.end();
        return stream;
      },
      ledger,
      allocate: createDispatchAllocator(),
      executionMode: 'interactive',
      maxOutputTokens: 50,
      subscribed: (provider) => subscribed && provider === 'xai',
      logicalTurnId: () => 'turn',
    });
    assert.equal((await consume(stream, { ...model, provider: 'xai' })).result.stopReason, 'stop');
    spent[String(subscribed)] = ledger.snapshot().used.spendMicroUsd;
  }
  assert.equal(spent.true, 0);
  assert.ok(spent.false! > 0, 'an API-key request is charged');
});
