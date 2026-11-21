import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCRAPE, SEARCH, scrapeBody, searchBody, searchResult, setup } from './helpers.ts';

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

test('any non-2xx answer refunds the charge: a blocked /fetch and a malformed /search', async () => {
  const { userCall, billing, upstream } = setup(routes);
  const fetch4xx = await userCall('/v1/fetch', { url: 'https://10.0.0.1/' });
  assert.equal(fetch4xx.status, 400);
  const search4xx = await userCall('/v1/search', { query: 'q', count: 99 });
  assert.equal(search4xx.status, 400);
  const charges = billing.calls.filter((c) => c.method === 'charge');
  const refunds = billing.calls.filter((c) => c.method === 'refund');
  assert.equal(charges.length, 2);
  assert.equal(refunds.length, 2);
  for (const refund of refunds) {
    assert.equal(refund.input.userId, 'user-1');
    assert.ok(
      charges.some((c) => c.input.requestId === refund.input.requestId),
      'each refund names its charge requestId',
    );
  }
  assert.equal(upstream.calls.length, 0, 'both requests were refused before any backend call');
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

  const unbound = setup(routes, { BILLING: undefined });
  const missing = await unbound.userCall('/v1/search', { query: 'q' });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json<any>()).error.code, 'SEARCH_BILLING_UNAVAILABLE');
  assert.equal(unbound.upstream.calls.length, 0);
});

test('a malformed billing answer fails closed too', async () => {
  const { userCall, billing, upstream } = setup(routes);
  billing.state.result = 'garbage';
  const response = await userCall('/v1/search', { query: 'q' });
  assert.equal(response.status, 503);
  assert.equal((await response.json<any>()).error.code, 'SEARCH_BILLING_UNAVAILABLE');
  assert.equal(upstream.calls.length, 0);
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
