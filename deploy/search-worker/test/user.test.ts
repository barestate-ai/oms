import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  ADMIN,
  OTHER_SESSION,
  SCRAPE,
  SEARCH,
  SESSION,
  TOKEN,
  fakeGateway,
  scrapeBody,
  searchBody,
  searchResult,
  setup,
  sha,
} from './helpers.ts';

const routes = {
  [SEARCH]: () =>
    searchBody([searchResult('https://example.com/a', 'A'), searchResult('https://solana.com/docs', 'S')], 2),
  [SCRAPE]: () => scrapeBody('# Page', 'https://docs.example.com/p', 'Docs'),
};

let logged: string[] = [];
const originals: Record<string, (...args: unknown[]) => void> = {};
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    originals[level] = console[level];
    console[level] = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  }
});
afterEach(() => {
  for (const [level, fn] of Object.entries(originals)) (console as any)[level] = fn;
});

test('a valid session gets the /search and /fetch shapes from /oms/search/v1/*', async () => {
  const { userCall, call, gateway } = setup(routes);
  const search = await userCall('/v1/search', { query: 'anchor idl', count: 5 });
  assert.equal(search.status, 200);
  const body = await search.json<any>();
  assert.deepEqual(Object.keys(body).sort(), ['answered', 'backends', 'cached', 'query', 'results']);
  assert.deepEqual(body.answered, ['contextdev']);
  assert.equal(body.results[0].url, 'https://solana.com/docs');
  const page = await (await userCall('/v1/fetch', { url: 'https://docs.example.com/p' })).json<any>();
  assert.equal(page.backend, 'contextdev');
  assert.equal(page.text, '# Page');
  assert.deepEqual(gateway.calls, [
    { url: 'https://barestate.xyz/oms/api/me', authorization: `Bearer ${SESSION}` },
    { url: 'https://barestate.xyz/oms/api/me', authorization: `Bearer ${SESSION}` },
  ]);
  const bench = await (await call('/search', { query: 'anchor idl', count: 5 })).json<any>();
  assert.equal(bench.cached, true, 'the KV cache is shared with the bench route');
});

test('KV write failures do not fail search, fetch, or signed-in search responses', async () => {
  const { call, userCall, kv } = setup(routes);
  kv.failPuts = true;
  assert.equal((await call('/search', { query: 'bench' })).status, 200);
  assert.equal((await call('/fetch', { url: 'https://docs.example.com/p' })).status, 200);
  assert.equal((await userCall('/v1/search', { query: 'signed-in' })).status, 200);
});

test('a missing or malformed token is 401 UNAUTHENTICATED and never reaches the gateway', async () => {
  const { userCall, gateway, upstream } = setup(routes);
  for (const authorization of [
    null,
    '',
    `Basic ${SESSION}`,
    `bearer ${SESSION}`,
    'Bearer short',
    `Bearer ${'a'.repeat(513)}`,
    'Bearer has.dots.in.it.0123456789',
    'Bearer has spaces 0123456789abcdef',
    `Bearer ${SESSION} extra`,
  ]) {
    const response = await userCall('/v1/search', { query: 'q' }, authorization);
    assert.equal(response.status, 401, String(authorization));
    assert.deepEqual(await response.json<any>(), {
      error: { code: 'UNAUTHENTICATED', message: 'Sign in to OMS to use hosted search.' },
    });
  }
  assert.equal(gateway.calls.length, 0);
  assert.equal(upstream.calls.length, 0);
});

test('a token the gateway refuses is 401, and the refusal is cached for 30 s', async () => {
  const { userCall, gateway, kv, upstream } = setup(routes);
  const bogus = 'Bearer bogus_token_0123456789abcdef';
  for (let i = 0; i < 3; i++) assert.equal((await userCall('/v1/search', { query: 'q' }, bogus)).status, 401);
  assert.equal(gateway.calls.length, 1);
  const entry = kv.data.get(`session:${sha('bogus_token_0123456789abcdef')}`)!;
  const value = JSON.parse(entry.value);
  assert.equal(value.userId, undefined);
  assert.ok(value.until - Date.now() <= 30_000 && value.until - Date.now() > 25_000);
  assert.equal(upstream.calls.length, 0);
});

test('a gateway failure is 401 but is not cached', async () => {
  const { userCall, gateway } = setup(routes);
  gateway.state.refusal = 503;
  const bogus = 'Bearer bogus_token_0123456789abcdef';
  assert.equal((await userCall('/v1/search', { query: 'q' }, bogus)).status, 401);
  assert.equal((await userCall('/v1/search', { query: 'q' }, bogus)).status, 401);
  assert.equal(gateway.calls.length, 2);
});

test('an approval is revalidated with the gateway on every call; only refusals are cached', async () => {
  const { userCall, gateway, kv } = setup(routes);
  for (let i = 0; i < 4; i++) assert.equal((await userCall('/v1/search', { query: `q${i}` })).status, 200);
  assert.equal(gateway.calls.length, 4, 'a cached approval never authorizes a charge');
  assert.equal(kv.data.get(`session:${sha(SESSION)}`), undefined, 'approvals are not written to KV');
});

test('a revoked session is refused and never charged', async () => {
  const users: Record<string, string> = { [SESSION]: 'user-1' };
  const revoked = fakeGateway(users);
  const { userCall, billing } = setup(routes, { GATEWAY: revoked.gateway as unknown as Fetcher });
  assert.equal((await userCall('/v1/search', { query: 'q' })).status, 200);
  delete users[SESSION]; // logout revokes the token
  const response = await userCall('/v1/search', { query: 'q2' });
  assert.equal(response.status, 401);
  assert.equal((await response.json<any>()).error.code, 'UNAUTHENTICATED');
  assert.equal(revoked.calls.length, 2, 'the second call revalidated instead of trusting the approval');
  const charges = billing.calls.filter((c) => c.method === 'charge');
  assert.equal(charges.length, 1, 'the revoked session was never charged');
});

test('the 31st call in a minute is 429 RATE_LIMITED with Retry-After, per user id', async () => {
  const { userCall } = setup(routes);
  for (let i = 0; i < 30; i++)
    assert.equal((await userCall('/v1/search', { query: 'same' })).status, 200, `call ${i + 1}`);
  const limited = await userCall('/v1/search', { query: 'same' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await limited.json<any>()).error.code, 'RATE_LIMITED');
  assert.equal((await userCall('/v1/fetch', { url: 'https://docs.example.com/p' })).status, 429);
  assert.equal((await userCall('/v1/search', { query: 'same' }, `Bearer ${OTHER_SESSION}`)).status, 200);
});

test('failures use the gateway error style', async () => {
  const down = setup({ [SEARCH]: () => new Response('', { status: 503, headers: { 'retry-after': '9' } }) });
  const unavailable = await down.userCall('/v1/search', { query: 'q' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('retry-after'), '9');
  assert.deepEqual(await unavailable.json<any>(), {
    error: { code: 'SEARCH_UNAVAILABLE', message: 'every search backend failed' },
  });
  const { userCall } = setup(routes);
  const bad = await userCall('/v1/search', { query: 'q', count: 99 });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json<any>()).error.code, 'INVALID_REQUEST');
  const ssrf = await userCall('/v1/fetch', { url: 'https://10.0.0.1/' });
  assert.deepEqual(await ssrf.json<any>(), {
    error: { code: 'INVALID_REQUEST', message: 'web_fetch refuses private, loopback and link-local addresses' },
  });
  assert.equal((await userCall('/v1/nope', {})).status, 404);
  const get = await userCall('/v1/search', undefined, `Bearer ${SESSION}`, 'GET');
  assert.equal(get.status, 405);
  assert.equal((await get.json<any>()).error.code, 'METHOD_NOT_ALLOWED');
});

test('the bench-token route is unchanged, and the two kinds of token do not cross', async () => {
  const { call, userCall, gateway } = setup(routes);
  const bench = await call('/search', { query: 'q' });
  assert.equal(bench.status, 200);
  const sessionOnBench = await call('/search', { query: 'q' }, SESSION);
  assert.equal(sessionOnBench.status, 401);
  assert.equal(await sessionOnBench.text(), 'Unauthorized');
  assert.equal(gateway.calls.length, 0);
  assert.equal((await userCall('/v1/search', { query: 'q' }, `Bearer ${TOKEN}`)).status, 401);
  assert.equal(gateway.calls.length, 1);
  assert.deepEqual(await (await call('/health', undefined, null)).json<any>(), { ok: true });
});

test('per-user daily credits are in /usage alongside the per-token totals', async () => {
  const { call, userCall } = setup(routes);
  await userCall('/v1/search', { query: 'one' });
  await userCall('/v1/search', { query: 'two' }, `Bearer ${OTHER_SESSION}`);
  await call('/search', { query: 'three' });
  const [today] = (await (await call('/usage', undefined, ADMIN)).json<any>()).days;
  assert.equal(today.credits, 6);
  assert.deepEqual(today.users, { 'user-1': { requests: 1, credits: 2 }, 'user-2': { requests: 1, credits: 2 } });
  assert.deepEqual(today.tokens, {
    session: { requests: 2, credits: 4 },
    [sha(TOKEN).slice(0, 16)]: { requests: 1, credits: 2 },
  });
});

test('the raw session token never appears in KV, logs, usage or upstream calls', async () => {
  const { userCall, call, kv, upstream, events, billing } = setup(routes);
  await userCall('/v1/search', { query: 'q' });
  await userCall('/v1/fetch', { url: 'https://docs.example.com/p' });
  await userCall('/v1/search', { query: 'q' }, 'Bearer bogus_token_0123456789abcdef');
  const usage = await (await call('/usage', undefined, ADMIN)).text();
  const everything = JSON.stringify([[...kv.data.entries()], logged, usage, events, upstream.calls, billing.calls]);
  for (const secret of [SESSION, 'bogus_token_0123456789abcdef']) assert.ok(!everything.includes(secret), secret);
  assert.ok(upstream.calls.every((c) => !c.headers.includes('oms_session')));
});
