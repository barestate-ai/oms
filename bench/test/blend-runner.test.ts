import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerGate, roundRobin, schedule, settleCalls } from '../blend/schedule.ts';
import { pairedTest, summarize, readResults, table, type Result } from '../blend/report.ts';
import { parseArgs, policyReservationCost } from '../blend/run.ts';
import { infraReason } from '../src/infra.ts';

const row = (config: string, task_id: string, score: number, extra: Partial<Result> = {}): Result => ({
  batch_id: 'batch',
  task_id,
  config,
  rep: 1,
  score,
  passed: score * 10,
  total: 10,
  usd: 2,
  oms_usd: 2,
  input: 100,
  cached: 20,
  output: 10,
  wall_ms: 1000,
  ...extra,
});
test('custom profiles are explicit, resolved and optional', () => {
  const args = ['--batch', 'tune', '--configs', 'blend-tune', '--max-usd', '10'];
  assert.equal(parseArgs(args).profiles, undefined);
  assert.equal(parseArgs([...args, '--profiles', '/private/profiles.json']).profiles, '/private/profiles.json');
  assert.throws(() => parseArgs([...args, '--profiles', '']));
});
test('escalation admission bounds both calls without changing single-model reservations', () => {
  const single = policyReservationCost({ type: 'single', model: 'claude-sonnet-5-5' });
  assert.deepEqual(single, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  const cost = policyReservationCost({
    type: 'escalate',
    cheap: 'claude-haiku-5-5',
    strong: 'claude-sonnet-5-5',
    trigger: { tool_failures: 2, retry_on_error_or_empty: true },
  })!;
  assert.deepEqual(cost, { input: 2.5, output: 12.5, cacheRead: 0.15000000000000002, cacheWrite: 3.125 });
  assert.ok((32768 * cost.cacheWrite + 4096 * cost.output) / 1e6 < 0.6);
  assert.equal(
    policyReservationCost({ type: 'plan-exec', planner: 'claude-haiku-5-5', executor: 'claude-sonnet-5-5' }),
    undefined,
  );
  assert.throws(() => policyReservationCost('unknown'), /Unknown upstream/);
});
test('infra retry overrides preserve the default and allow zero or one budgeted retry', async () => {
  const args = ['--batch', 'expert', '--configs', 'claude-sonnet-5-5', '--max-usd', '3'];
  assert.equal(parseArgs(args).infraRetries, 2);
  for (const limit of [0, 1]) {
    assert.equal(parseArgs([...args, '--infra-retries', String(limit)]).infraRetries, limit);
    const attempts: number[] = [];
    await schedule([{ task_id: 't', config: 'a', rep: 1 }], {
      concurrency: 1,
      maxUsd: 3,
      perRunUsd: 0.6,
      maxRetries: limit,
      retryBackoffMs: 0,
      run: async (_cell, _index, attempt) => {
        attempts.push(attempt);
        return { chargeUsd: 0.1, value: attempt, retry: true };
      },
    });
    assert.deepEqual(
      attempts,
      Array.from({ length: limit + 1 }, (_, i) => i),
    );
  }
  for (const invalid of ['-1', '3', '0.5', 'NaN'])
    assert.throws(() => parseArgs([...args, '--infra-retries', invalid]));
  await assert.rejects(
    schedule([], {
      concurrency: 1,
      maxUsd: 3,
      perRunUsd: 0.6,
      maxRetries: -1,
      run: async () => ({ chargeUsd: 0, value: 0 }),
    }),
    /retry limit/,
  );
});
test('report: scores, solved costs, medians, cached input counted once, empty and unsolved groups', () => {
  const rows = [
    row('a', '1', 1),
    row('a', '2', 0.5, { wall_ms: 3000, input: 200, cached: 50, usd: 4 }),
    row('b', '1', 0),
  ];
  assert.deepEqual(summarize(rows)[0], {
    config: 'a',
    runs: 2,
    mean_score: 0.75,
    solved: 1,
    total_usd: 6,
    usd_per_solved: 6,
    median_wall_ms: 2000,
    mean_tokens: 160,
    mean_input: 150,
    mean_cached: 35,
    mean_output: 10,
  });
  assert.equal(summarize(rows)[1]!.usd_per_solved, null);
  assert.deepEqual(summarize([]), []);
  assert.match(table(rows), /\| a \| 2 \| 0.7500/);
});
test('exact two-sided paired sign flips: three identical nonzero differences give 2/8', () => {
  const rows = ['1', '2', '3'].flatMap((id) => [row('a', id, 1), row('b', id, 0)]);
  assert.deepEqual(pairedTest(rows, 'a', 'b'), {
    a: 'a',
    b: 'b',
    paired_tasks: 3,
    nonzero_tasks: 3,
    mean_difference: 1,
    p_value: 0.25,
  });
  assert.equal(pairedTest(rows, 'b', 'a').p_value, 0.25);
});
test('paired test averages reps per task, drops unpaired tasks and treats ties as zero', () => {
  const rows = [
    row('a', '1', 1),
    row('a', '1', 0, { rep: 2 }),
    row('b', '1', 0),
    row('a', '2', 1),
    row('b', '2', 1),
    row('a', 'unpaired', 0),
  ];
  assert.deepEqual(pairedTest(rows, 'a', 'b'), {
    a: 'a',
    b: 'b',
    paired_tasks: 2,
    nonzero_tasks: 1,
    mean_difference: 0.25,
    p_value: 1,
  });
  assert.equal(pairedTest([row('a', '1', 1), row('b', '1', 1)], 'a', 'b').p_value, 1);
  assert.throws(() => pairedTest([], 'a', 'b'), /No paired/);
  assert.throws(() => pairedTest(rows, 'a', 'a'), /distinct/);
});
test('report reader rejects duplicate/mixed batches and invalid numbers but permits unknown OMS cost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blend-report-')),
    file = join(dir, 'runs.jsonl');
  try {
    writeFileSync(file, '');
    assert.deepEqual(readResults(file), []);
    writeFileSync(file, JSON.stringify(row('a', '1', 0, { oms_usd: null })) + '\n');
    assert.equal(readResults(file).length, 1);
    for (const rows of [
      [row('a', '1', 1), row('a', '1', 1)],
      [row('a', '1', 1), row('b', '1', 1, { batch_id: 'other' })],
      [row('a', '1', 2)],
      [row('a', '1', 1, { cached: 101 })],
    ]) {
      writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
      assert.throws(() => readResults(file));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('matrix order interleaves configs for each task and repetition', () => {
  assert.deepEqual(
    roundRobin(['t1', 't2'], ['a', 'b'], 2).map((c) => `${c.task_id}:${c.rep}:${c.config}`),
    ['t1:1:a', 't1:1:b', 't1:2:a', 't1:2:b', 't2:1:a', 't2:1:b', 't2:2:a', 't2:2:b'],
  );
  assert.throws(() => roundRobin([], ['a', 'a'], 1));
});
test('budget stop reserves in-flight runs and stops at an affordable ordered prefix', async () => {
  const launched: string[] = [];
  const results = await schedule(roundRobin(['t1', 't2'], ['a', 'b'], 1), {
    concurrency: 4,
    maxUsd: 1,
    perRunUsd: 0.6,
    run: async (cell) => {
      launched.push(cell.config);
      return { chargeUsd: 0.3, value: cell };
    },
  });
  assert.equal(results.length, 2);
  assert.deepEqual(launched, ['a', 'b']);
});
test('batch budget admits zero runs below a reservation; exact boundary and refund allow progress', async () => {
  const cells = roundRobin(['1', '2'], ['a'], 1);
  let calls = 0;
  assert.deepEqual(
    await schedule(cells, {
      concurrency: 2,
      maxUsd: 0.59,
      perRunUsd: 0.6,
      run: async () => {
        calls++;
        return { chargeUsd: 0, value: 1 };
      },
    }),
    [],
  );
  assert.equal(calls, 0);
  const values = await schedule(cells, {
    concurrency: 2,
    maxUsd: 0.6,
    perRunUsd: 0.6,
    run: async () => ({ chargeUsd: 0, value: 1 }),
  });
  assert.equal(values.length, 2);
});
test('concurrent reservations never exceed ceiling, including delayed completion', async () => {
  let active = 0,
    maximum = 0,
    paid = 0;
  const values = await schedule(roundRobin(['1', '2', '3', '4'], ['a', 'b'], 1), {
    concurrency: 4,
    maxUsd: 1.5,
    perRunUsd: 0.6,
    run: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      paid += 0.1;
      return { chargeUsd: 0.1, value: 1 };
    },
  });
  assert.equal(values.length, 8);
  assert.equal(maximum, 2);
  assert.ok(paid < 1.5);
});
test('unknown costs/errors stop further launch and await already running cells', async () => {
  let finished = false;
  await assert.rejects(
    schedule(roundRobin(['1', '2', '3'], ['a'], 1), {
      concurrency: 2,
      maxUsd: 2,
      perRunUsd: 0.6,
      run: async (_cell, index) => {
        if (index === 0) throw Error('unknown');
        await new Promise<void>((resolve) => setImmediate(resolve));
        finished = true;
        return { chargeUsd: 0.1, value: 1 };
      },
    }),
    /unknown/,
  );
  assert.ok(finished);
  await assert.rejects(
    schedule(roundRobin(['1'], ['a'], 1), {
      concurrency: 1,
      maxUsd: 1,
      perRunUsd: 0.6,
      run: async () => ({ chargeUsd: NaN, value: 1 }),
    }),
    /Unknown batch spend/,
  );
});
test('CLI defaults, task path override, common caps and input errors', () => {
  const options = parseArgs(['--configs', 'a,b', '--batch', 'pilot', '--max-usd', '1.5', '--tasks', '/custom/tasks']);
  assert.equal(options.tasks, '/custom/tasks');
  assert.equal(options.concurrency, 4);
  assert.equal(options.runUsd, 0.6);
  assert.equal(options.minutes, 12);
  assert.equal(options.tokens, 250000);
  for (const extra of [
    ['--concurrency', '0'],
    ['--tokens', 'NaN'],
    ['--unknown', 'x'],
    ['--backend', 'bad'],
  ])
    assert.throws(() => parseArgs(['--configs', 'a', '--batch', 'pilot', '--max-usd', '1', ...extra]));
  assert.throws(() => parseArgs(['--configs', 'a,a', '--batch', 'pilot', '--max-usd', '1']));
});

test('terminal usage limits and pre-dispatch USD caps are infrastructure, not model zeros', () => {
  assert.equal(infraReason({ reason: 'no-verified-progress' }, [{ status_class: 'rate_limit' }]), 'usage-limit');
  assert.equal(infraReason({ reason: 'HTTP 429' }, []), 'usage-limit');
  assert.equal(infraReason({ status: 'capped', reason: 'capped:usd', dispatches: [] }, []), 'api-budget');
  assert.equal(infraReason({ status: 'capped', reason: 'capped:usd', dispatches: [{}] }, []), null);
  assert.equal(infraReason({ status: 'capped', reason: 'capped:usd' }, []), null);
  assert.equal(infraReason({}, []), null);
  assert.equal(infraReason({}, [{ status_class: 'rate_limit' }, { status_class: 'ok' }]), null);
  assert.equal(infraReason({}, [{ status_class: 'budget' }]), null);
});

test('provider permits cover mixed profiles, release failures, and reject invalid configuration', async () => {
  const acquire = providerGate({ go: 1, other: 2 });
  const first = await acquire('go');
  let admitted = false;
  const second = acquire('go').then((release) => {
    admitted = true;
    return release;
  });
  const other = await acquire('other');
  assert.equal(admitted, false);
  other();
  first();
  const release = await second;
  assert.equal(admitted, true);
  release();
  assert.throws(release, /already released/);
  await assert.rejects(acquire('missing'), /Invalid provider/);
});

test('provider-limited scheduling keeps other providers moving and bounds retries with budgeted backoff', async () => {
  const clock = { time: 0 },
    waits: number[] = [],
    attempts: number[] = [];
  let activeGo = 0,
    maxGo = 0,
    activeAll = 0,
    maxAll = 0;
  const values = await schedule(roundRobin(['1', '2'], ['go', 'other'], 1), {
    concurrency: 3,
    maxUsd: 10,
    perRunUsd: 1,
    provider: (cell) => cell.config,
    providerConcurrency: { go: 1, other: 2 },
    retryBackoffMs: 10,
    now: () => clock.time,
    wait: async (ms) => {
      waits.push(ms);
      clock.time += ms;
    },
    run: async (cell, index, attempt) => {
      attempts.push(attempt);
      activeAll++;
      maxAll = Math.max(maxAll, activeAll);
      if (cell.config === 'go') {
        activeGo++;
        maxGo = Math.max(maxGo, activeGo);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeAll--;
      if (cell.config === 'go') activeGo--;
      return { chargeUsd: 0.1, value: { index, attempt }, retry: index === 0 };
    },
  });
  assert.equal(maxGo, 1);
  assert.ok(maxAll > 1);
  assert.deepEqual(
    values.filter((v) => v.index === 0).map((v) => v.attempt),
    [0, 1, 2],
  );
  assert.deepEqual(waits, [10, 20]);
  assert.equal(attempts.length, 6);
  assert.equal(
    (
      await schedule(roundRobin(['1'], ['go'], 1), {
        concurrency: 1,
        maxUsd: 1,
        perRunUsd: 1,
        run: async () => ({ chargeUsd: 1, value: 1, retry: true }),
      })
    ).length,
    1,
  );
});

test('infra receipts are charged, excluded from scores and pairing, and never displayed as zeros', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blend-infra-')),
    file = join(dir, 'runs.jsonl');
  try {
    const infra = row('a', '1', 0, { score: null, passed: null, total: null, eligible: false, attempt: 0 });
    const good = row('a', '1', 1, { attempt: 1 });
    writeFileSync(file, [infra, good].map((r) => JSON.stringify(r)).join('\n'));
    assert.equal(readResults(file).length, 2);
    assert.equal(summarize([infra, good])[0]!.mean_score, 1);
    assert.equal(summarize([infra, good])[0]!.total_usd, 4);
    assert.match(table([infra]), /\| a \| 0 \| — \|/);
    assert.throws(() => pairedTest([infra, row('b', '1', 1)], 'a', 'b'), /No paired/);
    writeFileSync(file, JSON.stringify({ ...infra, score: 0 }));
    assert.throws(() => readResults(file), /Invalid run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('failed calls settle to reported/estimated cost, keeping only per-call worst-case billing liability', async () => {
  const settled = settleCalls(
    [
      { dispatched: true, status_class: 'transport', usd: 0.002 },
      { dispatched: true, status_class: 'ok', usd: 0.001 },
      { dispatched: false, status_class: 'budget', usd: 0 },
    ],
    [0.01, 0.02],
  );
  assert.deepEqual(settled, { liability: 0.008, released: 0.03, valid: true });
  assert.deepEqual(settleCalls([], []), { liability: 0, released: 0, valid: true });
  assert.equal(settleCalls([{ dispatched: true, status_class: 'ok', usd: 0 }], []).valid, false);
  const values = await schedule(roundRobin(['1', '2', '3', '4', '5', '6', '7', '8', '9'], ['a'], 1), {
    concurrency: 4,
    maxUsd: 1.5,
    perRunUsd: 0.6,
    run: async () => ({ chargeUsd: 0.003 + settled.liability, value: 1 }),
  });
  assert.equal(values.length, 9);
});
