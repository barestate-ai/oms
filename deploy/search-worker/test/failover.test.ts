import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Semaphore } from '../src/semaphore.ts';
import { SEARCH, searchBody, searchResult, setup, sleep } from './helpers.ts';

const realSleep = async (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((resolve) => setImmediate(resolve));
};

for (const status of [402, 429, 500, 502, 503]) {
  test(`search: context.dev ${status} returns 503 with Retry-After, pauses context.dev, never echoes the body`, async () => {
    const { call, upstream } = setup({
      [SEARCH]: () => new Response('UPSTREAM-SECRET-BODY', { status, headers: { 'retry-after': '42' } }),
    });
    const response = await call('/search', { query: 'q' });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '42');
    const raw = await response.text();
    assert.ok(!raw.includes('UPSTREAM-SECRET-BODY'));
    assert.deepEqual(JSON.parse(raw), {
      error: 'every search backend failed',
      backends: { contextdev: `HTTP ${status}` },
      answered: [],
    });
    const again = await call('/search', { query: 'other' });
    assert.equal(again.status, 503);
    const wait = Number(again.headers.get('retry-after'));
    assert.ok(wait <= 42 && wait >= 40, String(wait));
    const body = await again.json<any>();
    assert.equal(body.error, 'every search backend is cooling down');
    assert.match(body.backends['contextdev'], /^cooling down 4\d s$/);
    assert.equal(upstream.calls.length, 1);
  });
}

test('search: an unreachable context.dev is a 503 with Retry-After', async () => {
  const { call } = setup({});
  const response = await call('/search', { query: 'q' });
  assert.equal(response.status, 503);
  assert.ok(Number(response.headers.get('retry-after')) >= 1);
  assert.deepEqual((await response.json<any>()).backends, { contextdev: 'unreachable' });
});

test('search: a non-retryable 4xx from context.dev is a 502 and does not pause', async () => {
  const { call, gate } = setup({ [SEARCH]: () => new Response('nope', { status: 401 }) });
  const response = await call('/search', { query: 'q' });
  assert.equal(response.status, 502);
  assert.deepEqual((await response.json<any>()).backends, { contextdev: 'HTTP 401' });
  assert.equal(gate.semaphore.pausedFor(), 0);
});

test('search: a missing API key is a 503, not a crash', async () => {
  const { call } = setup({}, { CONTEXT_DEV_API_KEY: undefined });
  assert.equal((await call('/search', { query: 'q' })).status, 503);
});

test('semaphore: never more than 5 leases out, waiters are served FIFO', async () => {
  const semaphore = new Semaphore(5, 60_000);
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  await Promise.all(
    Array.from({ length: 23 }, async (_, i) => {
      const grant = await semaphore.acquire(5_000);
      assert.ok('lease' in grant);
      order.push(i);
      peak = Math.max(peak, ++active);
      await sleep(5 + (i % 3));
      active--;
      semaphore.release(grant.lease);
    }),
  );
  assert.equal(peak, 5);
  assert.equal(semaphore.peak, 5);
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.equal(semaphore.inFlight, 0);
});

test('semaphore: a full queue gives up after the wait with busy and a Retry-After', async () => {
  const semaphore = new Semaphore(5, 60_000);
  const leases = await Promise.all(Array.from({ length: 5 }, () => semaphore.acquire(10)));
  const started = Date.now();
  const grant = await semaphore.acquire(50);
  assert.ok(Date.now() - started >= 45);
  assert.deepEqual(grant, { retryAfterMs: 2_000, reason: 'busy' });
  assert.equal(semaphore.queued, 0);
  for (const lease of leases) if ('lease' in lease) semaphore.release(lease.lease);
  assert.ok('lease' in (await semaphore.acquire(10)));
});

test('semaphore: an abandoned lease expires so the slot comes back', async () => {
  let now = 0;
  const semaphore = new Semaphore(1, 1_000, () => now);
  assert.ok('lease' in (await semaphore.acquire(10)));
  assert.ok(!('lease' in (await semaphore.acquire(10))));
  now = 1_001;
  assert.ok('lease' in (await semaphore.acquire(10)));
});

test('semaphore: a pause answers paused with the time left', async () => {
  let now = 0;
  const semaphore = new Semaphore(5, 1_000, () => now);
  semaphore.pause(3_000);
  assert.deepEqual(await semaphore.acquire(10), { retryAfterMs: 3_000, reason: 'paused' });
  now = 3_000;
  assert.ok('lease' in (await semaphore.acquire(10)));
});

test('semaphore: waiters resume after a pause that began while a lease was active', async () => {
  const semaphore = new Semaphore(1, 60_000);
  const lease = await semaphore.acquire(1_000);
  assert.ok('lease' in lease);
  let resolved = false;
  const waiter = semaphore.acquire(1_000).then((grant) => {
    resolved = true;
    return grant;
  });
  const started = Date.now();
  semaphore.pause(50);
  semaphore.release(lease.lease);
  await sleep(20);
  assert.equal(resolved, false);
  const grant = await waiter;
  assert.ok('lease' in grant);
  assert.ok(Date.now() - started <= 150);
  assert.ok(semaphore.inFlight === 1);
});

test('semaphore: an early pause wake is retried', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const semaphore = new Semaphore(1, 60_000);
    const lease = await semaphore.acquire(10);
    assert.ok('lease' in lease);
    let resolved = false;
    const waiter = semaphore.acquire(1_000).then((grant) => {
      resolved = true;
      return grant;
    });
    semaphore.pause(25);
    semaphore.release(lease.lease);
    mock.timers.tick(25);
    assert.equal(resolved, false);
    await realSleep(25);
    mock.timers.tick(25);
    if (!resolved) mock.timers.tick(1_000);
    const grant = await waiter;
    assert.ok('lease' in grant);
    assert.equal(semaphore.inFlight, 1);
  } finally {
    mock.timers.reset();
  }
});

test('semaphore: pause wake timers stay within the runtime limit', () => {
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    delays.push(ms ?? 0);
    return originalSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  try {
    new Semaphore(1, 60_000).pause(2_147_483_647 + 1_000);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.deepEqual(delays, [2_147_483_647]);
});

test('worker: 30 concurrent searches put at most 5 calls in flight at context.dev, and all succeed', async () => {
  const { call, upstream, gate } = setup({
    [SEARCH]: async () => {
      await sleep(15);
      return searchBody([searchResult('https://example.com/a')]);
    },
  });
  const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => call('/search', { query: `q${i}` })));
  assert.deepEqual(new Set(responses.map((r) => r.status)), new Set([200]));
  assert.equal(upstream.stats.peakContextDev, 5);
  assert.equal(gate.semaphore.peak, 5);
  assert.equal(gate.semaphore.inFlight, 0);
});

test('worker: when the queue wait runs out, callers get 503 + Retry-After, never a context.dev 429', async () => {
  const { call, upstream, gate } = setup({
    [SEARCH]: async () => {
      await sleep(5_000);
      return searchBody([]);
    },
  });
  const held = Array.from({ length: 5 }, (_, i) => call('/search', { query: `slow${i}` }));
  await sleep(20);
  const response = await call('/search', { query: 'late' });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '2');
  assert.deepEqual((await response.json<any>()).backends, { contextdev: 'cooling down 2 s' });
  assert.equal(upstream.stats.peakContextDev, 5);
  assert.equal(gate.semaphore.peak, 5);
  await Promise.all(held);
});
