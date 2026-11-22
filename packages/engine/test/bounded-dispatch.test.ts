import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createBudgetLedger, type BudgetLedgerEvent } from '@oms/core';
import { createDispatchAllocator } from '@oms/core/dispatch';
import { modelReservationBound } from '@oms/core/usage';
import { BYTES_PER_TOKEN } from '../src/runtime/context-trim.ts';
import {
  createMeteredStream,
  modelReadiness,
  payloadWithinInputCap,
  type MeteredStreamOptions,
} from '../src/runtime/usage.ts';

/** $4 and 40 minutes, the Night 1 per-run cap. Token room is not the constraint under test. */
const runCaps = { tokens: 2_000_000_000, spendMicroUsd: 4_000_000, wallClockMs: 40 * 60 * 1000 };
const opus: Model<Api> = {
  id: 'claude-opus-5-5',
  name: 'Opus',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  input: ['text', 'image'],
  reasoning: false,
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, tiers: [] },
};

function doneMessage(selected: Model<Api>, usage: AssistantMessage['usage']): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    timestamp: 0,
    stopReason: 'stop',
    usage,
  };
}

function harness(
  options: {
    maxInputTokens?: number;
    clock?: () => number;
    streamFunction?: StreamFn;
    countProvider?: boolean;
    caps?: typeof runCaps;
    executionMode?: 'bounded' | 'interactive';
  } = {},
) {
  const events: BudgetLedgerEvent[] = [];
  const ledger = createBudgetLedger({
    caps: options.caps ?? runCaps,
    clock: options.clock ?? (() => 0),
    executionMode: options.executionMode ?? 'bounded',
    persist: (event) => {
      events.push(event);
    },
  });
  let calls = 0;
  let fetches = 0;
  const provider = options.streamFunction;
  const original: StreamFn =
    provider && options.countProvider
      ? (...args) => {
          calls += 1;
          return provider(...args);
        }
      : (provider ??
        (async (selected, _context, streamOptions) => {
          calls += 1;
          const payload = await streamOptions?.onPayload?.(
            {
              model: selected.id,
              messages: [{ role: 'user', content: 'hi' }],
              max_tokens: 1,
            },
            selected,
          );
          assert.equal((payload as { model: string }).model, selected.id);
          const stream = createAssistantMessageEventStream();
          stream.push({
            type: 'done',
            reason: 'stop',
            message: doneMessage(selected, {
              input: 12,
              output: 4,
              cacheRead: 8,
              cacheWrite: 2,
              totalTokens: 26,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0000816 },
            }),
          });
          stream.end();
          return stream;
        }));
  const config: MeteredStreamOptions = {
    streamFunction: original,
    ledger,
    allocate: createDispatchAllocator(),
    maxOutputTokens: 1024,
    logicalTurnId: () => 'bounded-run',
    executionMode: options.executionMode ?? 'bounded',
    clock: options.clock,
    ...(options.maxInputTokens === undefined ? {} : { maxInputTokens: options.maxInputTokens }),
  };
  return {
    stream: createMeteredStream(config),
    ledger,
    events,
    calls: () => calls,
    fetches: () => fetches,
    fetch: async () => {
      fetches += 1;
      return new Response('controlled');
    },
  };
}

async function consume(
  subject: ReturnType<typeof harness>,
  selected: Model<Api> = opus,
  messages: Parameters<typeof normalizeContext>[0]['messages'] = [{ role: 'user', timestamp: 1, content: 'hello' }],
) {
  const stream = await subject.stream(selected, normalizeContext({ messages }), { fetch: subject.fetch });
  const received = [];
  for await (const event of stream) received.push(event);
  return { result: await stream.result(), received };
}

test('a small Opus request is admitted under $4 by cloning the catalog window to the input cap', async () => {
  const full = modelReservationBound(opus, 1024);
  assert.ok(full && full.spendMicroUsd > runCaps.spendMicroUsd, 'the catalog window must not fit $4');
  const bounded = modelReservationBound({ ...opus, contextWindow: 20_000 }, 1024);
  assert.ok(bounded && bounded.spendMicroUsd <= runCaps.spendMicroUsd);
  const subject = harness({ maxInputTokens: 20_000 });
  const { result } = await consume(subject);
  assert.equal(result.stopReason, 'stop');
  assert.equal(subject.calls(), 1);
  const reservation = subject.events.find((event) => event.type === 'budget_reserve');
  // The input side is min(local cap, measured transcript bound): inside the cloned window.
  assert.ok(reservation!.reservation.tokens! <= bounded!.tokens);
  assert.ok(reservation!.reservation.tokens! > 1024);
  assert.ok(reservation!.reservation.spendMicroUsd! <= bounded!.spendMicroUsd!);
  assert.ok(reservation!.reservation.spendMicroUsd! <= runCaps.spendMicroUsd);
  assert.equal(modelReadiness(opus, subject.ledger, 1024, 'bounded', 20_000).ready, true);
});

test('known settlement counts cache read and write once and releases the hold', async () => {
  const subject = harness({ maxInputTokens: 20_000 });
  const { result } = await consume(subject);
  assert.equal(result.stopReason, 'stop');
  assert.equal(result.usage.cacheRead, 8);
  assert.equal(result.usage.cacheWrite, 2);
  const settlement = subject.events.find((event) => event.type === 'budget_settle');
  assert.equal(settlement?.receipt.outcome, 'known');
  assert.equal(settlement?.receipt.tokens, 26);
  assert.equal(settlement?.receipt.usage?.cacheReadTokens, 8);
  assert.equal(settlement?.receipt.usage?.cacheWriteTokens, 2);
  assert.equal(subject.ledger.snapshot().accounting, 'known');
  assert.equal(subject.ledger.snapshot().used.tokens, 26);
  assert.ok(subject.ledger.snapshot().used.spendMicroUsd > 0);
  assert.ok(
    subject.ledger.snapshot().used.spendMicroUsd <
      subject.events.find((event) => event.type === 'budget_reserve')!.reservation.spendMicroUsd!,
  );
});

test('spend exhaustion after one bounded hold admits no further provider call', async () => {
  // One 500069-byte request's measured hold fits; after it settles, a second request whose
  // measured bound still exceeds the remaining spend is refused before dispatch.
  const subject = harness({
    maxInputTokens: 512_357,
    caps: { ...runCaps, spendMicroUsd: 4_119_463 },
    countProvider: true,
    streamFunction: async (selected, _context, streamOptions) => {
      const body = { model: selected.id, messages: [{ role: 'user', content: 'x'.repeat(500_000) }] };
      await streamOptions?.onPayload?.(body, selected);
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: 'done',
        reason: 'stop',
        message: doneMessage(selected, {
          input: 12,
          output: 4,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 16,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000128 },
        }),
      });
      stream.end();
      return stream;
    },
  });
  const first = await consume(subject, opus, [{ role: 'user', timestamp: 1, content: 'x'.repeat(500_000) }]);
  assert.equal(first.result.stopReason, 'stop');
  assert.equal(subject.calls(), 1);
  const second = await consume(subject, opus, [{ role: 'user', timestamp: 1, content: 'x'.repeat(1_300_000) }]);
  assert.equal(second.result.stopReason, 'error');
  assert.match(second.result.errorMessage ?? '', /limit|cannot cover|No provider request sent/i);
  assert.equal(subject.calls(), 1);
  assert.equal(subject.fetches(), 0);
});

test('an unknown outcome retains the bounded hold and blocks another dispatch', async () => {
  const subject = harness({
    maxInputTokens: 20_000,
    countProvider: true,
    streamFunction: async (selected, _context, streamOptions) => {
      // Dispatch first so the failure models a request that reached the provider.
      await streamOptions?.onPayload?.({ model: selected.id, messages: [] }, selected);
      await streamOptions?.fetch?.('http://127.0.0.1:9', {})?.catch(() => {});
      throw new Error('provider-secret-body');
    },
  });
  const failed = await consume(subject);
  assert.equal(failed.result.stopReason, 'error');
  assert.equal(subject.ledger.snapshot().accounting, 'unknown');
  assert.ok(!JSON.stringify(failed.result).includes('provider-secret-body'));
  const held = subject.ledger.snapshot().used.spendMicroUsd;
  const bounded = modelReservationBound({ ...opus, contextWindow: 20_000 }, 1024);
  assert.ok(held <= bounded!.spendMicroUsd!, 'the held charge stays inside the local input cap');
  assert.equal(
    held,
    subject.events.find((event) => event.type === 'budget_reserve')!.reservation.spendMicroUsd,
    'an unknown outcome retains the whole measured bound',
  );
  const next = await consume(subject);
  assert.equal(next.result.stopReason, 'error');
  assert.match(next.result.errorMessage ?? '', /unconfirmed|unknown/i);
  assert.equal(subject.calls(), 1);
  assert.equal(subject.ledger.snapshot().used.spendMicroUsd, held);
});

test('a fake clock stops dispatch on the 40 minute boundary without a provider call', async () => {
  let now = 0;
  const subject = harness({ maxInputTokens: 20_000, clock: () => now });
  now = 40 * 60 * 1000;
  const { result } = await consume(subject);
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage ?? '', /time limit/i);
  assert.equal(subject.calls(), 0);
  assert.equal(subject.fetches(), 0);
  assert.equal(
    subject.events.some((event) => event.type === 'budget_reserve'),
    false,
  );
  assert.equal(modelReadiness(opus, subject.ledger, 1024, 'bounded', 20_000).ready, false);
});

test('an oversized serialized payload is rejected before fetch and does not reserve', async () => {
  const subject = harness({
    maxInputTokens: 20_000,
    countProvider: true,
    streamFunction: async (selected, _context, streamOptions) => {
      const body = { model: selected.id, messages: [{ role: 'user', content: 'x'.repeat(70_000) }] };
      await streamOptions?.onPayload?.(body, selected);
      await streamOptions?.fetch?.('http://127.0.0.1:9', { method: 'POST', body: JSON.stringify(body) });
      throw new Error('provider should not run');
    },
  });
  const { result } = await consume(subject, opus, [{ role: 'user', timestamp: 1, content: 'x'.repeat(70_000) }]);
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage ?? '', /input|payload|request size|No provider request sent/i);
  assert.equal(subject.fetches(), 0);
  assert.equal(subject.calls(), 1);
  assert.equal(subject.events.filter((event) => event.type === 'budget_reserve').length, 1);
  assert.equal(subject.ledger.snapshot().accounting, 'known');
  assert.equal(subject.ledger.snapshot().used.spendMicroUsd, 0);
});

test('media and remote-file inputs are rejected because their tokens are not byte bounded', async () => {
  const subject = harness({ maxInputTokens: 20_000 });
  const image = await consume(subject, { ...opus, input: ['text', 'image'] }, [
    {
      role: 'user',
      timestamp: 1,
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', data: 'aaaa', mimeType: 'image/png' },
      ],
    },
  ]);
  assert.equal(image.result.stopReason, 'error');
  assert.match(image.result.errorMessage ?? '', /media|image|not byte|No provider request sent/i);
  assert.equal(subject.calls(), 0);
  assert.equal(subject.fetches(), 0);
});

test('omitting the input cap reserves the measured transcript bound, below the full catalog reservation', async () => {
  const subject = harness({});
  const full = modelReservationBound(opus, 1024);
  // Readiness without a serialized transcript still estimates at the catalog window.
  assert.equal(modelReadiness(opus, subject.ledger, 1024, 'bounded').ready, false);
  const admitted = await consume(subject);
  assert.equal(admitted.result.stopReason, 'stop', admitted.result.errorMessage);
  assert.equal(subject.calls(), 1);
  const reservation = subject.events.find((event) => event.type === 'budget_reserve')!.reservation;
  assert.ok(reservation.tokens! < full!.tokens);
  assert.ok(reservation.spendMicroUsd! < full!.spendMicroUsd);
});

test('a web_fetch tool call carries a url argument, which is model text, not a remote file: the next turn is admitted', async () => {
  const subject = harness({
    maxInputTokens: 20_000,
    caps: { tokens: 2_000_000_000, spendMicroUsd: 20_000_000_000, wallClockMs: 40 * 60 * 1000 },
  });
  const { result } = await consume(subject, opus, [
    { role: 'user', timestamp: 1, content: 'read the docs' },
    {
      role: 'assistant',
      timestamp: 2,
      api: opus.api,
      provider: opus.provider,
      model: opus.id,
      stopReason: 'toolUse',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [{ type: 'toolCall', id: 'c1', name: 'web_fetch', arguments: { url: 'https://example.com/error.rs' } }],
    },
    {
      role: 'toolResult',
      timestamp: 3,
      toolCallId: 'c1',
      toolName: 'web_fetch',
      isError: true,
      content: [{ type: 'text', text: 'web_fetch got HTTP 404' }],
    },
  ] as never);
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.equal(subject.calls(), 1);
});

test('the input cap is in tokens: a payload of that many tokens at 3 bytes each is accepted, one clearly over is refused', () => {
  const cap = 20_000;
  const payload = (bytes: number) => ({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(bytes) }] });
  assert.equal(BYTES_PER_TOKEN, 3);
  assert.equal(payloadWithinInputCap(payload(cap * 2), cap), true, 'about 2 bytes per token is well inside the cap');
  assert.equal(
    payloadWithinInputCap(payload(cap * BYTES_PER_TOKEN), cap),
    false,
    'the protocol allowance no longer fits',
  );
  assert.equal(payloadWithinInputCap(payload(cap * 4), cap), false);
});

test('a default-sized output cap is lowered to a smaller model maximum and stays ready; a larger model keeps the cap', async () => {
  const small = { ...opus, maxTokens: 8_192 };
  const large = { ...opus, maxTokens: 128_000 };
  const ledger = () =>
    createBudgetLedger({ caps: runCaps, clock: () => 0, executionMode: 'bounded', persist: () => {} });
  assert.equal(modelReadiness(small, ledger(), 32_768, 'bounded', 200_000).ready, true);
  for (const [model, expected] of [
    [small, 8_192],
    [large, 32_768],
  ] as const) {
    let requested: unknown;
    const stream = createMeteredStream({
      ledger: ledger(),
      allocate: createDispatchAllocator(),
      maxOutputTokens: 32_768,
      executionMode: 'bounded',
      logicalTurnId: () => 'turn',
      maxInputTokens: 200_000,
      streamFunction: async (selected, _context, options) => {
        const body = await options?.onPayload?.(
          { model: selected.id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
          selected,
        );
        requested = (body as { max_tokens: number }).max_tokens;
        const out = createAssistantMessageEventStream();
        out.push({
          type: 'done',
          reason: 'stop',
          message: doneMessage(selected, {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          }),
        });
        out.end();
        return out;
      },
    });
    const source = await stream(
      model,
      normalizeContext({ messages: [{ role: 'user', timestamp: 1, content: 'hello' }] }),
      {},
    );
    const result = await source.result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(requested, expected);
  }
});
