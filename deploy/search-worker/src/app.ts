import { authorize, digestList, sha256Hex } from './auth.ts';
import { chargeSearch, refundSearch, type SearchBillingRpc } from './billing.ts';
import { CONTEXT_DEV, contextDevScrape, contextDevSearch, type ContextDevConfig, type Outcome } from './context-dev.ts';
import { capText, GuardError, parseFetchUrl, plainFetch, type Page, type Resolve } from './fetch-guard.ts';
import { canonicalUrl, fuse, type FusedResult } from './fusion.ts';
import { QUEUE_WAIT_MS, type UsageEvent } from './gate.ts';
import { isIP, isPrivateAddress } from './net.ts';
import type { Grant } from './semaphore.ts';

export interface Env {
  CACHE: KVNamespace;
  GATE: DurableObjectNamespace;
  USAGE_EVENTS?: AnalyticsEngineDataset;
  CONTEXT_DEV_API_KEY?: string;
  ACCEPTED_TOKEN_SHA256?: string;
  ADMIN_TOKEN_SHA256?: string;
  /** "enabled" sends zdr: "enabled" on every context.dev request. */
  CONTEXT_DEV_ZDR?: string;
  /** Calls per token per minute (default 60). */
  RATE_PER_MIN?: string;
  /** The `oms` gateway Worker, used only to check OMS session tokens on /oms/search/v1/*. */
  GATEWAY?: Fetcher;
  /** The `oms` gateway's SearchBilling entrypoint: signed-in /search and /fetch calls are charged through it. Unbound fails closed. */
  BILLING?: SearchBillingRpc;
}

/** Who a call is charged to in /usage. */
interface Caller {
  /** First 16 hex characters of the bench/gateway token digest, or "session". */
  token: string;
  user?: string;
}

export interface Deps {
  fetch: typeof fetch;
  resolve: Resolve;
  now: () => number;
}

export const SEARCH_TTL_S = 24 * 60 * 60;
export const FETCH_TTL_S = 7 * 24 * 60 * 60;
export const MAX_RESULTS = 20;
const PREFIX = '/oms-search-api';
const USER_PREFIX = '/oms/search';
/** The gateway's old SEARCH_RATE_LIMIT. */
export const USER_RATE_PER_MIN = 30;
const SESSION_REFUSED_MS = 30_000;
const ME_URL = 'https://barestate.xyz/oms/api/me';
const FETCH_TIMEOUT_MS = 9_000;
const WINDOW_MS = 60_000;

/** `answered` names the backends whose output is in the answer, so a run record can say what "OMS search" was. */
interface SearchAnswer {
  results: Omit<FusedResult, 'score'>[];
  backends: Record<string, string>;
  answered: string[];
}
interface PageAnswer {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  truncated: boolean;
  backend: string;
  answered: string[];
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const retryAfter = (ms: number) => ({ 'retry-after': String(Math.max(1, Math.ceil(ms / 1000))) });
const unauthorized = () =>
  new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain;charset=UTF-8' } });
const describe = (error: unknown) =>
  error instanceof Error && error.name === 'TimeoutError'
    ? 'timeout'
    : error instanceof GuardError
      ? error.message.slice(0, 160)
      : 'failed';
const coolingDown = (ms: number) => `cooling down ${Math.ceil(ms / 1000)} s`;

function gate(env: Env) {
  const stub = env.GATE.get(env.GATE.idFromName('context.dev'));
  const post = (path: string, body: unknown) =>
    stub.fetch(`https://gate${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  return {
    acquire: () => post('/acquire', { waitMs: QUEUE_WAIT_MS }) as Promise<Grant>,
    release: (lease: string, usage?: UsageEvent) => post('/release', { lease, usage }),
    pause: (ms: number) => post('/pause', { ms }),
    limit: (key: string, perMinute: number) =>
      (post('/limit', { key, perMinute }) as Promise<{ waitMs: number }>).then((r) => r.waitMs),
    usage: (days: string | null) => stub.fetch(`https://gate/usage?days=${encodeURIComponent(days ?? '')}`),
  };
}

/** Runs `call` in a gate slot, records its credits, and pauses context.dev for the Retry-After it asked for. */
async function throughGate<T>(
  env: Env,
  route: UsageEvent['route'],
  caller: Caller,
  call: () => Promise<Outcome<T>>,
): Promise<{ grant: Grant; outcome?: Outcome<T> }> {
  const slots = gate(env);
  const grant = await slots.acquire();
  if (!('lease' in grant)) return { grant };
  let outcome: Outcome<T> | undefined;
  try {
    outcome = await call();
    return { grant, outcome };
  } finally {
    const credits = outcome?.credits ?? 0;
    const { token, user } = caller;
    if (outcome && !outcome.ok && outcome.pauseMs !== undefined) await slots.pause(outcome.pauseMs);
    await slots.release(grant.lease, { route, token, ...(user ? { user } : {}), credits });
    env.USAGE_EVENTS?.writeDataPoint({
      indexes: [user ?? token],
      blobs: [route, token, outcome?.ok ? 'ok' : 'error', user ?? ''],
      doubles: [credits],
    });
  }
}

function contextDev(env: Env, deps: Deps): ContextDevConfig | undefined {
  return env.CONTEXT_DEV_API_KEY
    ? { apiKey: env.CONTEXT_DEV_API_KEY, zdr: env.CONTEXT_DEV_ZDR === 'enabled', fetch: deps.fetch, now: deps.now }
    : undefined;
}

async function search(
  env: Env,
  deps: Deps,
  caller: Caller,
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<Response> {
  // The key is a digest, so KV never holds query text.
  const key = `search:v2:${await sha256Hex(query.toLowerCase())}`;
  const hit = await env.CACHE.get<SearchAnswer>(key, 'json');
  if (hit)
    return json(200, {
      query,
      results: hit.results.slice(0, count),
      backends: hit.backends,
      answered: hit.answered,
      cached: true,
    });
  const backends: Record<string, string> = {};
  const config = contextDev(env, deps);
  if (!config)
    return json(503, { error: 'no search backend is configured', backends, answered: [] }, retryAfter(60_000));
  const { grant, outcome } = await throughGate(env, 'search', caller, () => contextDevSearch(config, query, signal));
  if (!('lease' in grant)) {
    backends[CONTEXT_DEV] = coolingDown(grant.retryAfterMs);
    return json(
      503,
      { error: 'every search backend is cooling down', backends, answered: [] },
      retryAfter(grant.retryAfterMs),
    );
  }
  if (!outcome?.ok) {
    backends[CONTEXT_DEV] = outcome?.error ?? 'failed';
    if (outcome?.unavailable)
      return json(
        503,
        { error: 'every search backend failed', backends, answered: [] },
        retryAfter(outcome.pauseMs ?? 5_000),
      );
    return json(502, { error: 'every search backend failed', backends, answered: [] });
  }
  backends[CONTEXT_DEV] = `ok (${outcome.value.length})`;
  const results = fuse([{ source: CONTEXT_DEV, hits: outcome.value }], MAX_RESULTS).map(({ score: _score, ...r }) => r);
  const answered = [CONTEXT_DEV];
  if (results.length) {
    try {
      await env.CACHE.put(key, JSON.stringify({ results, backends, answered } satisfies SearchAnswer), {
        expirationTtl: SEARCH_TTL_S,
      });
    } catch {}
  }
  return json(200, { query, results: results.slice(0, count), backends, answered, cached: false });
}

/** The /fetch target checks — https URL, no credentials, public host — run before a call is charged. */
async function validateFetch(raw: string, deps: Deps): Promise<URL | Response> {
  let url: URL;
  try {
    url = parseFetchUrl(raw);
  } catch (error) {
    return json(400, { error: describe(error) });
  }
  // context.dev dials for us, so the host must resolve public before it gets the URL; the plain fetch re-checks every hop.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host)) {
    const addresses = await deps.resolve(host).catch(() => [] as string[]);
    if (!addresses.length) return json(400, { error: 'host does not resolve' });
    if (addresses.some(isPrivateAddress))
      return json(400, { error: 'private, loopback and link-local addresses are refused' });
  }
  return url;
}

async function fetchPage(env: Env, deps: Deps, caller: Caller, url: URL, signal?: AbortSignal): Promise<Response> {
  const key = `page:v2:${await sha256Hex(canonicalUrl(url.href) ?? url.href)}`;
  const hit = await env.CACHE.get<PageAnswer>(key, 'json');
  if (hit) return json(200, { ...hit, cached: true });

  const attempts: Record<string, string> = {};
  const answer = async (backend: string, page: Page) => {
    const capped = capText(page);
    const value: PageAnswer = {
      url: url.href,
      finalUrl: capped.finalUrl,
      title: capped.title,
      text: capped.text,
      truncated: capped.truncated,
      backend,
      answered: [backend],
    };
    try {
      await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: FETCH_TTL_S });
    } catch {}
    return json(200, { ...value, attempts, cached: false });
  };

  const config = contextDev(env, deps);
  if (config) {
    const { grant, outcome } = await throughGate(env, 'fetch', caller, () =>
      contextDevScrape(config, url.href, signal),
    );
    if (!('lease' in grant)) attempts[CONTEXT_DEV] = coolingDown(grant.retryAfterMs);
    else if (outcome?.ok) return answer(CONTEXT_DEV, outcome.value);
    else attempts[CONTEXT_DEV] = outcome?.error ?? 'failed';
  }
  try {
    return await answer(
      'plain',
      await plainFetch(
        url,
        deps.resolve,
        AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]),
        deps.fetch,
      ),
    );
  } catch (error) {
    attempts.plain = describe(error);
  }
  return json(502, { error: 'every fetch backend failed', attempts, answered: [] });
}

/** Fixed one-minute window per token digest, per isolate. Returns 0 when allowed, else ms until the window resets. */
function rateLimiter(now: () => number): (digest: string, perMinute: number) => number {
  const windows = new Map<string, { start: number; count: number }>();
  return (digest, perMinute) => {
    const at = now();
    let window = windows.get(digest);
    if (!window || at - window.start >= WINDOW_MS) windows.set(digest, (window = { start: at, count: 0 }));
    if (window.count >= perMinute) return window.start + WINDOW_MS - at;
    window.count++;
    return 0;
  };
}

/** A validated /search or /fetch call; `kind` is what the call is billed as. */
type Input = { kind: 'search'; query: string; count: number } | { kind: 'fetch'; url: URL };

/** Body and route validation for /search and /fetch, run before any charge; a Response is the refusal. */
async function readInput(pathname: '/search' | '/fetch', request: Request, deps: Deps): Promise<Input | Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'body must be JSON' });
  }
  if (pathname === '/search') {
    const query = typeof body?.query === 'string' ? body.query.replace(/\s+/g, ' ').trim() : '';
    if (!query || query.length > 400) return json(400, { error: 'query must be 1-400 characters' });
    const count = body.count ?? 10;
    if (!Number.isInteger(count) || count < 1 || count > MAX_RESULTS)
      return json(400, { error: `count must be an integer 1-${MAX_RESULTS}` });
    return { kind: 'search', query, count };
  }
  if (typeof body?.url !== 'string' || body.url.length > 2048)
    return json(400, { error: 'url must be a string of at most 2048 characters' });
  const url = await validateFetch(body.url, deps);
  return url instanceof Response ? url : { kind: 'fetch', url };
}

/** Runs a validated input; an internal failure is a bare 500, like the pre-charge refusals above. */
async function dispatch(input: Input, env: Env, deps: Deps, caller: Caller, signal?: AbortSignal): Promise<Response> {
  try {
    return input.kind === 'search'
      ? await search(env, deps, caller, input.query, input.count, signal)
      : await fetchPage(env, deps, caller, input.url, signal);
  } catch {
    return json(500, { error: 'internal error' });
  }
}

/** Parses the body and runs /search or /fetch; the answers are the oms-search shapes. */
async function serve(pathname: '/search' | '/fetch', request: Request, env: Env, deps: Deps, caller: Caller) {
  const input = await readInput(pathname, request, deps).catch(() => json(500, { error: 'internal error' }));
  if (input instanceof Response) return input;
  return dispatch(input, env, deps, caller, request.signal);
}

const gatewayError = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  json(status, { error: { code, message } }, headers);

const UNAUTHENTICATED = () => gatewayError(401, 'UNAUTHENTICATED', 'Sign in to OMS to use hosted search.');

/** Rewrites a failed oms-search answer into the gateway's {"error":{"code","message"}} style, keeping Retry-After. */
async function gatewayStyle(response: Response): Promise<Response> {
  if (response.ok) return response;
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  const message = typeof body.error === 'string' ? body.error : 'request failed';
  const { status } = response;
  const code = status === 400 ? 'INVALID_REQUEST' : status === 429 ? 'RATE_LIMITED' : 'SEARCH_UNAVAILABLE';
  const retry = response.headers.get('retry-after');
  return gatewayError(status, code, message, retry ? { 'retry-after': retry } : {});
}

/**
 * The OMS user behind a session token, checked with the gateway's /api/me. Only the token's SHA-256 is
 * cached — and only a refusal, for 30 seconds. An approval is verified live on every call: a cached one
 * can outlive the session it came from (logout revokes the token) and would keep authorizing charges.
 * Gateway failures other than 401/403 are not cached either.
 */
async function sessionUser(request: Request, env: Env, deps: Deps): Promise<string | undefined> {
  const token = /^Bearer ([A-Za-z0-9_-]{16,512})$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token || !env.GATEWAY) return undefined;
  const key = `session:${await sha256Hex(token)}`;
  const cached = await env.CACHE.get<{ userId?: string; until: number }>(key, 'json');
  if (cached && !cached.userId && cached.until > deps.now()) return undefined;
  let userId: string | undefined;
  let settled = false;
  try {
    const response = await env.GATEWAY.fetch(ME_URL, { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 200) {
      const id = ((await response.json().catch(() => undefined)) as { user?: { id?: unknown } } | undefined)?.user?.id;
      if (typeof id === 'string' && id.length >= 1 && id.length <= 256) userId = id;
      settled = true;
    } else {
      void response.body?.cancel().catch(() => {});
      settled = response.status === 401 || response.status === 403;
    }
  } catch {
    /* the gateway is unreachable: refuse, uncached */
  }
  if (settled && !userId) {
    // KV expiry has a 60 s floor, so `until` carries the exact lifetime.
    try {
      await env.CACHE.put(key, JSON.stringify({ until: deps.now() + SESSION_REFUSED_MS }), {
        expirationTtl: Math.max(60, SESSION_REFUSED_MS / 1000),
      });
    } catch {}
  }
  return userId;
}

/** POST /oms/search/v1/search and /v1/fetch for signed-in OMS users. */
async function userRoute(
  subpath: string,
  request: Request,
  env: Env,
  deps: Deps,
  ctx?: ExecutionContext,
): Promise<Response> {
  const pathname = subpath === '/v1/search' ? '/search' : subpath === '/v1/fetch' ? '/fetch' : undefined;
  if (!pathname) return gatewayError(404, 'NOT_FOUND', 'not found');
  if (request.method !== 'POST') return gatewayError(405, 'METHOD_NOT_ALLOWED', 'use POST', { allow: 'POST' });
  const user = await sessionUser(request, env, deps);
  if (!user) return UNAUTHENTICATED();
  const wait = await gate(env).limit(`user:${user}`, USER_RATE_PER_MIN);
  if (wait) return gatewayError(429, 'RATE_LIMITED', 'Too many search calls; slow down.', retryAfter(wait));
  // The request is validated before it is charged, so a malformed call is refused with no charge+refund pair.
  const input = await readInput(pathname, request, deps).catch(() => json(500, { error: 'internal error' }));
  if (input instanceof Response) return gatewayStyle(input);
  // Charged once per request, cache hits included; a call that does not answer 2xx is refunded below.
  const requestId = crypto.randomUUID();
  const refusal = await chargeSearch(env, user, input.kind, requestId);
  if (refusal) return refusal;
  // Settlement must outlive the request: a client disconnect cancels the request and drops
  // request-scoped work, so the dispatch and its refund run as one task registered with waitUntil
  // before it is awaited. A charged call that never produces a 2xx answer refunds the charge inside
  // it; the request signal reaches the upstream calls so a dead client also stops the work.
  const settled = (async (): Promise<Response> => {
    let response: Response;
    try {
      response = await dispatch(input, env, deps, { token: 'session', user }, request.signal);
    } catch {
      await refundSearch(env, user, requestId, input.kind);
      return gatewayError(500, 'SEARCH_UNAVAILABLE', 'internal error');
    }
    if (!response.ok) await refundSearch(env, user, requestId, input.kind);
    return response;
  })();
  ctx?.waitUntil(settled);
  return gatewayStyle(await settled);
}

export function createApp(deps: Deps) {
  const limit = rateLimiter(deps.now);
  return async function handle(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(`${USER_PREFIX}/`))
      return userRoute(url.pathname.slice(USER_PREFIX.length), request, env, deps, ctx);
    const pathname = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || '/' : url.pathname;
    if (pathname === '/health' && request.method === 'GET') return json(200, { ok: true });
    if (pathname === '/usage') {
      if (!(await authorize(request, digestList(env.ADMIN_TOKEN_SHA256)))) return unauthorized();
      if (request.method !== 'GET') return json(405, { error: 'use GET' }, { allow: 'GET' });
      return gate(env).usage(url.searchParams.get('days'));
    }
    if (pathname !== '/search' && pathname !== '/fetch') return json(404, { error: 'not found' });
    const digest = await authorize(request, digestList(env.ACCEPTED_TOKEN_SHA256));
    if (!digest) return unauthorized();
    if (request.method !== 'POST') return json(405, { error: 'use POST' }, { allow: 'POST' });
    const wait = limit(digest, Number(env.RATE_PER_MIN) || 60);
    if (wait) return json(429, { error: 'rate limit exceeded' }, retryAfter(wait));
    return serve(pathname, request, env, deps, { token: digest.slice(0, 16) });
  };
}
