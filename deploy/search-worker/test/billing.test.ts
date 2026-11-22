import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCRAPE, SEARCH, SESSION, scrapeBody, searchBody, searchResult, setup, sha } from './helpers.ts';

const routes = {
  [SEARCH]: () => searchBody([searchResult('https://example.com/a', 'A')], 1),
  [SCRAPE]: () => scrapeBody('# Page', 'https://docs.example.com/p', 'Docs'),
};

test('an allowed charge serves results; each request charges once, cache hits included', async () => {
  const { userCall, billing, upstream } = setup(routes);
  assert.equal((await userCall('/v1/search', { query: 'anchor idl' })).status, 200);
  const cached = await userCall('/v1/search', { query: 'anchor idl' });
  assert.equal(cached.status, 200);
  assert.equal((await cached.json<any>()).cached, true);
  assert.equal(upstream.calls.filter((c) => c.url === SEARCH).length, 1, 'the second answer came from KV');

  const charges = billing.calls.filter((c) => c.method === 'charge');
  assert.equal(charges.length, 2, 'one charge per request even on a cache hit');
  assert.equal(billing.calls.filter((c) => c.method === 'refund').length, 0);
  for (const charge of charges) {
    assert.equal(charge.input.userId, 'user-1');
    assert.equal(charge.input.kind, 'search');
    assert.match(charge.input.requestId, /^[A-Za-z0-9._:-]{1,128}$/);
  }
  assert.notEqual(charges[0]!.input.requestId, charges[1]!.input.requestId);

  assert.equal((await userCall('/v1/fetch', { url: 'https://docs.example.com/p' })).status, 200);
  const fetchCharge = billing.calls.filter((c) => c.method === 'charge').at(-1)!;
  assert.equal(fetchCharge.input.kind, 'fetch');
});

test('a refused charge is a 402 in the gateway error style and serves nothing upstream', async () => {
  const { userCall, billing, upstream } = setup(routes);
  billing.state.result = { ok: false, code: 'SEARCH_PAYMENT_REQUIRED', message: 'free searches used up' };
  const response = await userCall('/v1/search', { query: 'q' });
  assert.equal(response.status, 402);
  assert.deepEqual(await response.json<any>(), {
    error: {
      code: 'SEARCH_PAYMENT_REQUIRED',
      message:
        'Your free searches for this month are used up. Add credits or upgrade to Pro at https://barestate.xyz/oms/billing',
      billing: 'https://barestate.xyz/oms/billing',
    },
  });
  assert.equal(upstream.calls.length, 0);
  assert.equal(billing.calls.filter((c) => c.method === 'refund').length, 0, 'a refusal is not refunded');

  billing.state.result = { ok: false, code: 'UNFUNDED_USAGE', message: 'unpaid balance' };
  const unfunded = await userCall('/v1/fetch', { url: 'https://docs.example.com/p' });
  assert.equal(unfunded.status, 402);
  const body = await unfunded.json<any>();
  assert.equal(body.error.code, 'UNFUNDED_USAGE');
  assert.match(body.error.message, /unpaid/i);
  assert.match(body.error.message, /https:\/\/barestate\.xyz\/oms\/billing/);
  assert.equal(body.error.billing, 'https://barestate.xyz/oms/billing');
  assert.equal(upstream.calls.length, 0);
});

test('a monthly limit refusal is a 402 naming the UTC reset date; nothing served, nothing refunded', async () => {
  const { userCall, billing, upstream } = setup(routes);
  billing.state.result = {
    ok: false,
    code: 'SEARCH_LIMIT_REACHED',
    message: 'allowance exhausted',
    resetsAt: Date.UTC(2026, 11, 1),
  };
  const response = await userCall('/v1/search', { query: 'q' });
  assert.equal(response.status, 402);
  assert.deepEqual(await response.json<any>(), {
    error: {
      code: 'SEARCH_LIMIT_REACHED',
      message:
        "This month's free hosted searches are used up. They reset on Dec 1. Add your own search key to keep searching.",
      resetsAt: Date.UTC(2026, 11, 1),
      billing: 'https://barestate.xyz/oms/billing',
    },
  });
  assert.equal(upstream.calls.length, 0);
  assert.equal(billing.calls.filter((c) => c.method === 'refund').length, 0, 'a refusal is not refunded');

  billing.state.result = {
    ok: false,
    code: 'SEARCH_LIMIT_REACHED',
    message: 'allowance exhausted',
    resetsAt: Date.UTC(2027, 0, 1),
  };
  const jan = await userCall('/v1/fetch', { url: 'https://docs.example.com/p' });
  assert.equal(jan.status, 402);
  assert.equal(
    (await jan.json<any>()).error.message,
    "This month's free hosted searches are used up. They reset on Jan 1. Add your own search key to keep searching.",
  );
  assert.equal(upstream.calls.length, 0);
});

test('a limit refusal without a usable resetsAt fails closed: 503, nothing served', async () => {
  const { userCall, billing, upstream } = setup(routes);
  for (const resetsAt of [undefined, 'Dec 1', -5, 0, Number.NaN]) {
    billing.state.result = { ok: false, code: 'SEARCH_LIMIT_REACHED', message: 'x', resetsAt };
    const response = await userCall('/v1/search', { query: 'q' });
    assert.equal(response.status, 503, JSON.stringify(resetsAt));
    assert.equal((await response.json<any>()).error.code, 'SEARCH_BILLING_UNAVAILABLE');
  }
  assert.equal(upstream.calls.length, 0);
});

test('a failed upstream call refunds the charge with the same requestId', async () => {
  const { userCall, billing } = setup({
    [SEARCH]: () => new Response('', { status: 503, headers: { 'retry-after': '9' } }),
  });
  const response = await userCall('/v1/search', { query: 'q' });
  assert.equal(response.status, 503);
  const charge = billing.calls.find((c) => c.method === 'charge')!;
  const refund = billing.calls.find((c) => c.method === 'refund');
  assert.ok(refund, 'the charge was refunded');
  assert.deepEqual(refund.input, { userId: 'user-1', requestId: charge.input.requestId });
});

test('malformed calls are refused before billing: no charge, nothing to refund', async () => {
  const { userCall, billing, upstream } = setup(routes);
  assert.equal((await userCall('/v1/fetch', { url: 'https://10.0.0.1/' })).status, 400);
  assert.equal((await userCall('/v1/search', { query: 'q', count: 99 })).status, 400);
  assert.equal((await userCall('/v1/search')).status, 400, 'no JSON body');
  assert.equal(billing.calls.length, 0, 'a malformed request is never billed');
  assert.equal(upstream.calls.length, 0, 'all three requests were refused before any backend call');
});

test('a malformed call is 400 even when billing is down', async () => {
  const { userCall, billing } = setup(routes);
  billing.state.failure = 'charge';
  const response = await userCall('/v1/search', { query: 'q', count: 99 });
  assert.equal(response.status, 400);
  assert.equal((await response.json<any>()).error.code, 'INVALID_REQUEST');
  assert.equal(billing.calls.length, 0);
});

test('a refund that keeps failing still serves the real error, and is retried once and recorded', async () => {
  const { userCall, billing, events } = setup({
    [SEARCH]: () => new Response('', { status: 503 }),
  });
  billing.state.failure = 'refund';
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  try {
    const response = await userCall('/v1/search', { query: 'q' });
    assert.equal(response.status, 503);
    assert.equal((await response.json<any>()).error.code, 'SEARCH_UNAVAILABLE');
  } finally {
    console.error = original;
  }
  const charge = billing.calls.find((c) => c.method === 'charge')!;
  const refunds = billing.calls.filter((c) => c.method === 'refund');
  assert.equal(refunds.length, 2, 'the refund was retried once');
  for (const refund of refunds) assert.deepEqual(refund.input, { userId: 'user-1', requestId: charge.input.requestId });
  const marker = events.find((e) => (e as { blobs?: string[] }).blobs?.[0] === 'refund_failed');
  assert.deepEqual(marker, {
    indexes: ['user-1'],
    blobs: ['refund_failed', 'search', charge.input.requestId],
    doubles: [1],
  });
  const line = logged.find((l) => l.includes('refund_failed'))!;
  assert.ok(line, 'the failure was logged');
  assert.match(line, /"route":"search"/);
  assert.ok(line.includes(charge.input.requestId));
  assert.ok(line.includes(sha('user-1')), 'the user id is logged as a hash');
  assert.ok(!line.includes('user-1'), 'the raw user id is not logged');
});

test('a 2xx cache hit stays charged and is not refunded', async () => {
  const { userCall, billing } = setup(routes);
  assert.equal((await userCall('/v1/search', { query: 'anchor idl' })).status, 200);
  const cached = await userCall('/v1/search', { query: 'anchor idl' });
  assert.equal(cached.status, 200);
  assert.equal((await cached.json<any>()).cached, true);
  assert.equal(billing.calls.filter((c) => c.method === 'charge').length, 2);
  assert.equal(billing.calls.filter((c) => c.method === 'refund').length, 0);
});

test('billing that throws or is not bound fails closed: 503 SEARCH_BILLING_UNAVAILABLE, nothing served', async () => {
  const { userCall, billing, upstream } = setup(routes);
  billing.state.failure = 'charge';
  const down = await userCall('/v1/search', { query: 'q' });
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json<any>(), {
    error: { code: 'SEARCH_BILLING_UNAVAILABLE', message: 'search billing is unavailable' },
  });
  assert.equal(upstream.calls.length, 0);
  const charge = billing.calls.find((c) => c.method === 'charge')!;
  const refunds = billing.calls.filter((c) => c.method === 'refund');
  assert.equal(refunds.length, 1, 'a thrown charge is uncertain: it is refunded once before the 503');
  assert.deepEqual(refunds[0]!.input, { userId: 'user-1', requestId: charge.input.requestId });

  const unbound = setup(routes, { BILLING: undefined });
  const missing = await unbound.userCall('/v1/search', { query: 'q' });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json<any>()).error.code, 'SEARCH_BILLING_UNAVAILABLE');
  assert.equal(unbound.upstream.calls.length, 0);
});

test('a malformed billing answer fails closed too, and is refunded as uncertain', async () => {
  const { userCall, billing, upstream } = setup(routes);
  billing.state.result = 'garbage';
  const response = await userCall('/v1/search', { query: 'q' });
  assert.equal(response.status, 503);
  assert.equal((await response.json<any>()).error.code, 'SEARCH_BILLING_UNAVAILABLE');
  assert.equal(upstream.calls.length, 0);
  const charge = billing.calls.find((c) => c.method === 'charge')!;
  const refunds = billing.calls.filter((c) => c.method === 'refund');
  assert.equal(refunds.length, 1, 'an unreadable charge answer is an uncertain charge: refund it once');
  assert.deepEqual(refunds[0]!.input, { userId: 'user-1', requestId: charge.input.requestId });
});

test('INVALID_REQUEST from billing is not a paywall: 503 SEARCH_BILLING_UNAVAILABLE, nothing served', async () => {
  const { userCall, billing, upstream } = setup(routes);
  billing.state.result = { ok: false, code: 'INVALID_REQUEST', message: 'bad charge input' };
  const response = await userCall('/v1/search', { query: 'q' });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json<any>(), {
    error: { code: 'SEARCH_BILLING_UNAVAILABLE', message: 'search billing is unavailable' },
  });
  assert.equal(upstream.calls.length, 0);
  assert.equal(billing.calls.filter((c) => c.method === 'refund').length, 0, 'no charge to refund');
});

test('the bench token path is never billed', async () => {
  const { call, billing } = setup(routes);
  assert.equal((await call('/search', { query: 'q' })).status, 200);
  assert.equal((await call('/fetch', { url: 'https://docs.example.com/p' })).status, 200);
  assert.equal(billing.calls.length, 0);
});

test('a charge that throws is refunded once with the same requestId, then refused 503', async () => {
  const { userCall, billing, upstream } = setup(routes);
  billing.state.failure = 'charge';
  const response = await userCall('/v1/search', { query: 'q' });
  assert.equal(response.status, 503);
  assert.equal((await response.json<any>()).error.code, 'SEARCH_BILLING_UNAVAILABLE');
  assert.equal(upstream.calls.length, 0);
  const charge = billing.calls.find((c) => c.method === 'charge')!;
  const refunds = billing.calls.filter((c) => c.method === 'refund');
  assert.equal(refunds.length, 1, 'exactly one refund is attempted for the uncertain charge');
  assert.deepEqual(refunds[0]!.input, { userId: 'user-1', requestId: charge.input.requestId });
});

test('a clean charge refusal is a 402 and never refunded', async () => {
  const { userCall, billing, upstream } = setup(routes);
  billing.state.result = { ok: false, code: 'SEARCH_PAYMENT_REQUIRED', message: 'free searches used up' };
  assert.equal((await userCall('/v1/search', { query: 'q' })).status, 402);
  assert.equal(billing.calls.filter((c) => c.method === 'refund').length, 0, 'a refusal is not a charge');
  assert.equal(upstream.calls.length, 0);
});

test('a refund answered ok:false is a failed refund: retried once, logged and metered', async () => {
  const { userCall, billing, events } = setup({
    [SEARCH]: () => new Response('', { status: 503 }),
  });
  billing.state.refundResult = { ok: false };
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  try {
    const response = await userCall('/v1/search', { query: 'q' });
    assert.equal(response.status, 503);
    assert.equal((await response.json<any>()).error.code, 'SEARCH_UNAVAILABLE');
  } finally {
    console.error = original;
  }
  const charge = billing.calls.find((c) => c.method === 'charge')!;
  const refunds = billing.calls.filter((c) => c.method === 'refund');
  assert.equal(refunds.length, 2, 'the refused refund was retried once');
  for (const refund of refunds) assert.deepEqual(refund.input, { userId: 'user-1', requestId: charge.input.requestId });
  const marker = events.find((e) => (e as { blobs?: string[] }).blobs?.[0] === 'refund_failed');
  assert.deepEqual(marker, {
    indexes: ['user-1'],
    blobs: ['refund_failed', 'search', charge.input.requestId],
    doubles: [1],
  });
  const line = logged.find((l) => l.includes('refund_failed'))!;
  assert.ok(line, 'the failure was logged');
  assert.ok(line.includes(charge.input.requestId));
});

test('a limit refusal with resetsAt beyond the Date range fails closed: 503, never NaN', async () => {
  const { userCall, billing, upstream } = setup(routes);
  for (const resetsAt of [8_640_000_000_000_001, 9e15, Number.POSITIVE_INFINITY]) {
    billing.state.result = { ok: false, code: 'SEARCH_LIMIT_REACHED', message: 'x', resetsAt };
    const response = await userCall('/v1/search', { query: 'q' });
    assert.equal(response.status, 503, JSON.stringify(resetsAt));
    const body = await response.json<any>();
    assert.equal(body.error.code, 'SEARCH_BILLING_UNAVAILABLE');
    assert.ok(!JSON.stringify(body).includes('NaN'), `no NaN leaks into the message for ${resetsAt}`);
  }
  assert.equal(upstream.calls.length, 0);
  billing.state.result = {
    ok: false,
    code: 'SEARCH_LIMIT_REACHED',
    message: 'x',
    resetsAt: 8_640_000_000_000_000,
  };
  const boundary = await userCall('/v1/search', { query: 'q' });
  assert.equal(boundary.status, 402, 'the boundary epoch itself is still a usable reset date');
  assert.match((await boundary.json<any>()).error.message, /Sep 13/);
});

test('a failed upstream fetch refunds the charge with the same requestId', async () => {
  const { userCall, billing } = setup({
    [SCRAPE]: () => new Response('', { status: 503 }),
  });
  const response = await userCall('/v1/fetch', { url: 'https://docs.example.com/p' });
  assert.equal(response.status, 502);
  const charge = billing.calls.find((c) => c.method === 'charge')!;
  assert.equal(charge.input.kind, 'fetch');
  const refunds = billing.calls.filter((c) => c.method === 'refund');
  assert.equal(refunds.length, 1, 'the fetch charge was refunded');
  assert.deepEqual(refunds[0]!.input, { userId: 'user-1', requestId: charge.input.requestId });
});

test('a client that disconnects after the charge still gets the refund via waitUntil', async () => {
  const { env, billing, handle } = setup({
    [SEARCH]: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const drop = () => reject(new DOMException('aborted', 'AbortError'));
        if (init.signal?.aborted) return drop();
        init.signal?.addEventListener('abort', drop);
      }),
  });
  const controller = new AbortController();
  const charge = billing.billing.charge.bind(billing.billing);
  billing.billing.charge = async (input) => {
    const result = await charge(input);
    controller.abort(); // the client is gone the moment the debit lands
    return result;
  };
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) } as unknown as ExecutionContext;
  const response = await handle(
    new Request('https://barestate.xyz/oms/search/v1/search', {
      method: 'POST',
      headers: { authorization: `Bearer ${SESSION}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'q' }),
      signal: controller.signal,
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json<any>()).error.code, 'SEARCH_UNAVAILABLE');
  await Promise.all(waited);
  assert.equal(waited.length, 1, 'settlement was registered with ctx.waitUntil');
  const charged = billing.calls.find((c) => c.method === 'charge')!;
  const refunds = billing.calls.filter((c) => c.method === 'refund');
  assert.equal(refunds.length, 1, 'the charge was refunded even though the client was gone');
  assert.deepEqual(refunds[0]!.input, { userId: 'user-1', requestId: charged.input.requestId });
});
