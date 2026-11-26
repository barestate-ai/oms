import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  BlendBudget,
  BLEND_MODELS,
  apiSandboxProbe,
  nextRequestCost,
  startBlendRouter,
  blendProfiles,
} from '../src/blend-router.ts';
import { normalizeContext } from '@earendil-works/pi-ai';
import type { RequestLog } from '../../deploy/blend-worker/src/core/types.ts';
import { chatData } from '../../deploy/blend-worker/test/fixtures.ts';
import { BLEND_PROFILES } from '../../packages/engine/src/runtime/blend.ts';
import { parseContender } from '../src/matrix.ts';
import { onlineStamp, omsWebArgs, runOmsContender } from '../src/oms-run.ts';
import { createEnv, freshWallet } from '../src/solbench-harness/service.ts';
import { summarize, paired, type RunResult } from '../src/solbench-harness/report.ts';
import { retryFork } from '../src/solbench-harness/attempts.ts';

test('only unhealthy-fork slots retry, with a finite limit and a shared dollar ceiling', async () => {
  let calls = 0;
  let notes = 0;
  const result = await retryFork(async () => ({ reason: ++calls === 1 ? 'fork-failure' : null }), {
    canRetry: () => true,
    onRetry: () => notes++,
  });
  assert.equal(result.reason, null);
  assert.equal(calls, 2);
  assert.equal(notes, 1);
  calls = 0;
  await retryFork(
    async () => {
      calls++;
      return { reason: 'fork-failure' };
    },
    { canRetry: () => true, onRetry: () => {} },
  );
  assert.equal(calls, 3);
  calls = 0;
  await retryFork(
    async () => {
      calls++;
      return { reason: 'fork-failure' };
    },
    { canRetry: () => false, onRetry: () => {} },
  );
  assert.equal(calls, 1);
});

test('usage limits and pre-dispatch API caps retry the same slot twice with backoff', async () => {
  for (const reason of ['usage-limit', 'api-budget']) {
    let attempts = 0,
      recorded = 0;
    const waits: number[] = [];
    const result = await retryFork(
      async () => {
        attempts++;
        return { reason };
      },
      {
        canRetry: () => true,
        onRetry: () => {
          recorded++;
        },
        wait: async (ms) => {
          waits.push(ms);
        },
      },
    );
    assert.equal(result.reason, reason);
    assert.equal(attempts, 3);
    assert.equal(recorded, 2);
    assert.deepEqual(waits, [60000, 120000]);
  }
  let attempts = 0;
  await retryFork(async () => ({ reason: ++attempts === 1 ? 'usage-limit' : null }), {
    canRetry: () => true,
    onRetry: () => {},
    wait: async () => {},
  });
  assert.equal(attempts, 2);
});

test('every shipped profile uses the Blend API cell, without subscription or web credentials', () => {
  for (const id of Object.keys(BLEND_MODELS)) {
    const cell = 'oms3:blend/' + id;
    assert.equal(parseContender(cell)?.harness, 'oms3');
    assert.equal(parseContender(cell)?.online, undefined);
    assert.equal(BLEND_MODELS[id]!.provider, 'blend');
    assert.deepEqual(onlineStamp(cell, []), {});
    assert.deepEqual(omsWebArgs(cell, {}), []);
  }
  assert.equal(parseContender('oms3:blend/not-shipped'), null);
  assert.ok(BLEND_MODELS['claude-haiku-5-5']!.cost.input > 0);
});
test('API preflight exercises the shell with the same host glibc overlays as the OMS sandbox', () => {
  const args = apiSandboxProbe('sha256:test');
  assert.ok(args.some((v) => v.includes('/lib/x86_64-linux-gnu/libc.so.6')));
  assert.deepEqual(args.slice(-4), ['sha256:test', '/bin/sh', '-c', 'node --version']);
  assert.equal(args[3], 'none');
});

test('experimental escalation prices the next physical model, including tool triggers and sticky error/empty escalation', () => {
  const id = 'blend-ember-fable';
  assert.equal((BLEND_PROFILES as readonly string[]).includes(id), false);
  assert.deepEqual(blendProfiles[id], {
    type: 'escalate',
    cheap: 'muse-ember-1.0',
    strong: 'claude-fable-5-2',
    trigger: { tool_failures: 2, retry_on_error_or_empty: true },
  });
  const context = (...outputs: string[]) =>
    normalizeContext({
      messages: outputs.map((text, i) => ({
        role: 'toolResult' as const,
        toolCallId: `t${i}`,
        toolName: 'bash',
        content: [{ type: 'text' as const, text }],
        isError: false,
        timestamp: i,
      })),
    });
  const cheap = BLEND_MODELS['muse-ember-1.0']!.cost,
    strong = BLEND_MODELS['claude-fable-5-2']!.cost;
  assert.deepEqual(nextRequestCost(id, context(), []), cheap);
  assert.deepEqual(nextRequestCost(id, context('error'), []), cheap);
  assert.deepEqual(nextRequestCost(id, context('error', 'failed'), []), strong);
  assert.deepEqual(nextRequestCost(id, context('error', '{"exit_code":0}', 'error'), []), cheap);
  const logs: RequestLog[] = [
    {
      ts: '',
      profile: id,
      calls: [
        {
          model: 'claude-fable-5-2',
          in: 0,
          cached: 0,
          out: 0,
          ms: 0,
          usd: 0,
          attempt: 1,
          status_class: 'budget',
          usage_source: 'none',
          dispatched: false,
        },
      ],
      total_usd: 0,
      status: 402,
    },
  ];
  assert.deepEqual(nextRequestCost(id, context(), logs), strong);
  assert.throws(() => nextRequestCost('missing', context(), []), /Unknown/);
});

test('orchestrate admission bounds every model including planner, judge, validator and repair', () => {
  const cost = nextRequestCost('blend-compete', normalizeContext({ messages: [] }), []);
  for (const id of ['muse-wonder-1.0', 'claude-opus-5-5', 'grok-4.7', 'muse-ember-1.0']) {
    const physical = BLEND_MODELS[id]!.cost;
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
      assert.ok(cost[field] >= physical[field]);
  }
});

test('router admits cheap requests under the strong bound, but reserves strong before trigger or empty fallback', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'solbench-active-'));
  const previous = process.env.MUSE_API_KEY;
  process.env.MUSE_API_KEY = 'test';
  t.after(() => {
    if (previous === undefined) delete process.env.MUSE_API_KEY;
    else process.env.MUSE_API_KEY = previous;
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const empty of [false, true]) {
    let dispatched = 0;
    const budget = new BlendBudget(join(dir, `${empty}.ledger`), 0.1);
    const router = await startBlendRouter(join(dir, `${empty}.log`), budget, async () => {
      dispatched++;
      const data = chatData();
      if (empty) data.choices[0]!.message.content = '';
      return Response.json(data);
    });
    try {
      const messages: Array<Record<string, unknown>> = [{ role: 'user', content: 'work' }];
      const post = () =>
        fetch(`${router.url}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-blend-session': 'test' },
          body: JSON.stringify({ model: 'blend-ember-fable', messages, max_tokens: 32000 }),
        });
      assert.equal((await post()).status, empty ? 402 : 200);
      if (!empty) {
        messages.push(
          { role: 'tool', tool_call_id: 't1', content: 'error' },
          { role: 'tool', tool_call_id: 't2', content: 'failed' },
        );
        assert.equal((await post()).status, 402);
      }
      assert.equal(dispatched, 1);
      assert.equal(router.logs.at(-1)!.calls.at(-1)!.model, 'claude-fable-5-2');
      assert.equal(router.logs.at(-1)!.calls.at(-1)!.dispatched, false);
      assert.ok(budget.used <= budget.maximum);
    } finally {
      await router.close();
    }
  }
});
test('durable dollar cap refunds successful holds, retains failed exposure and includes interrupted attempts on resume', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'solbench-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.jsonl');
  const budget = new BlendBudget(file, 1),
    a = budget.reserve(0.6);
  assert.throws(() => budget.reserve(0.5), /cap reached/);
  budget.settle(a, 0.1, false);
  assert.equal(budget.remainingUsd, 0.9);
  const b = budget.reserve(0.5);
  budget.settle(b, 0.2, true);
  assert.equal(budget.used, 600000);
  budget.reserve(0.3);
  const resumed = new BlendBudget(file, 1);
  assert.equal(resumed.used, 900000);
  assert.throws(() => resumed.reserve(0.2), /cap reached/);
  assert.ok(!readFileSync(file, 'utf8').includes('secret'));
  assert.equal(new BlendBudget(join(dir, 'empty.jsonl'), 1).used, 0);
  assert.throws(() => new BlendBudget(file, NaN), /Invalid/);
});
test('API cell refuses subscription credentials before starting a harness', async () => {
  await assert.rejects(
    runOmsContender({
      contender: 'oms3:blend/claude-haiku-5-5',
      runIndex: 0,
      selection: { provider: 'blend', id: 'claude-haiku-5-5' },
      claudeHome: '/private',
      jsonOut: '/unused',
      args: [],
    }),
    /not a subscription/,
  );
});
test('fork health failures are counted independently of transaction program failures', async (t) => {
  let unhealthy = true;
  const server = createServer((_req, res) =>
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: unhealthy
          ? { code: -32005, message: 'Node is unhealthy' }
          : { code: -32002, message: 'Transaction simulation failed' },
      }),
    ),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const env = createEnv({
    upstream: `http://127.0.0.1:${address.port}`,
    wallet: freshWallet(),
    deadlineMs: Date.now() + 60000,
    record: () => {},
  });
  for (let i = 0; i < 3; i++) await env.handle({ id: i, jsonrpc: '2.0', method: 'getSlot' });
  assert.equal(env.forkFailures(), 3);
  unhealthy = false;
  await env.handle({ id: 4, jsonrpc: '2.0', method: 'getSlot' });
  assert.equal(env.forkFailures(), 3);
});
test('set-aside fork attempts cannot enter summary or paired comparisons', () => {
  const run = (cell: string, reason: string | null): RunResult => ({
    cell,
    variant: 'basic',
    runIndex: 0,
    reason,
    wallMs: 0,
    forkSlot: 1,
    tokens: null,
    tokensComplete: true,
    score: { headline: 99, raw: 99, programs: 1, failed: 0, submissions: 1, arbitrary: 0, memo: 0, pairs: [] },
    identities: { commit: 'a', image: 'b', goal: 'c' },
  });
  const bad = run('a', 'fork-failure'),
    good = run('b', null);
  assert.equal(summarize([bad, good]).runs, 1);
  assert.equal(paired([bad, good], 'a', 'b').pairs.length, 0);
});
