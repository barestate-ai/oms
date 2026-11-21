import { createHash } from 'node:crypto';
import { createApp, type Env, type SearchBillingRpc, type SearchChargeResult } from '../src/app.ts';
import { ContextDevGate } from '../src/gate.ts';

export const TOKEN = 'bench-token-0123456789';
export const GATEWAY_TOKEN = 'gateway-token-abcdef';
export const ADMIN = 'admin-token-xyz-000001';
export const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export class FakeKV {
  readonly data = new Map<string, { value: string; ttl?: number }>();
  gets = 0;
  failPuts = false;
  async get(key: string, type?: string) {
    this.gets++;
    const entry = this.data.get(key);
    if (!entry) return null;
    return type === 'json' ? JSON.parse(entry.value) : entry.value;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    if (this.failPuts) throw new Error('KV put failed');
    this.data.set(key, { value, ttl: options?.expirationTtl });
  }
}

class FakeStorage {
  readonly data = new Map<string, unknown>();
  async get(key: string) {
    return structuredClone(this.data.get(key));
  }
  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async list(options: { prefix: string; reverse?: boolean; limit?: number }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(options.prefix)).sort();
    if (options.reverse) keys.reverse();
    return new Map(keys.slice(0, options.limit).map((k) => [k, structuredClone(this.data.get(k))]));
  }
}

export function fakeGate() {
  const gate = new ContextDevGate({ storage: new FakeStorage() } as any, {});
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (input: string, init?: RequestInit) => gate.fetch(new Request(input, init)) }),
  };
  return { gate, namespace };
}

export type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** A fetch that answers context.dev and page URLs from `routes`, recording every call. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; body?: any; headers: string }[] = [];
  let inFlight = 0;
  const stats = { peakContextDev: 0 };
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: url.href, body, headers: JSON.stringify([...new Headers(init.headers)]) });
    const route = routes[`${url.origin}${url.pathname}`] ?? routes[url.origin];
    if (!route) throw new TypeError('fetch failed');
    const upstream = url.hostname === 'api.context.dev';
    if (upstream) stats.peakContextDev = Math.max(stats.peakContextDev, ++inFlight);
    try {
      return await route(url, init);
    } finally {
      if (upstream) inFlight--;
    }
  }) as typeof fetch;
  return { fn, calls, stats };
}

export const publicResolve = async (host: string) => {
  if (host.endsWith('internal.example')) return ['10.0.0.7'];
  if (host === 'rebind.example') return ['93.184.216.34', '127.0.0.1'];
  if (host === 'nx.example') return [];
  return ['93.184.216.34'];
};

export const SESSION = 'oms_session_token_AAAAAAAAAAAAAAAAAAAAAAAA';
export const OTHER_SESSION = 'oms_session_token_BBBBBBBBBBBBBBBBBBBBBBBB';

/** The `oms` gateway binding: /oms/api/me answers 200 with a user for known sessions, else `refusal`. */
export function fakeGateway(users: Record<string, string> = { [SESSION]: 'user-1', [OTHER_SESSION]: 'user-2' }) {
  const calls: { url: string; authorization: string | null }[] = [];
  const state = { refusal: 401 };
  const gateway = {
    fetch: async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const authorization = new Headers(init.headers).get('authorization');
      calls.push({ url: String(input), authorization });
      const token = authorization?.replace(/^Bearer /, '') ?? '';
      if (users[token]) return Response.json({ user: { id: users[token], email: `${users[token]}@example.com` } });
      return Response.json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in' } }, { status: state.refusal });
    },
  };
  return { gateway, calls, state };
}

/** The `oms` gateway SearchBilling entrypoint: records every call, answers `state.result`, or throws on `state.failure`. */
export function fakeBilling() {
  const calls: { method: 'charge' | 'refund'; input: { userId: string; requestId: string; kind?: string } }[] = [];
  const state: { result: unknown; failure: 'charge' | 'refund' | null } = { result: { ok: true }, failure: null };
  const billing: SearchBillingRpc = {
    charge: async (input) => {
      calls.push({ method: 'charge', input });
      if (state.failure === 'charge') throw new Error('billing unreachable');
      return state.result as SearchChargeResult;
    },
    refund: async (input) => {
      calls.push({ method: 'refund', input });
      if (state.failure === 'refund') throw new Error('refund unreachable');
      return { ok: true };
    },
  };
  return { billing, calls, state };
}

export function setup(routes: Record<string, Route>, overrides: Partial<Env> = {}) {
  const kv = new FakeKV();
  const gateway = fakeGateway();
  const billing = fakeBilling();
  const { gate, namespace } = fakeGate();
  const upstream = fakeFetch(routes);
  const events: unknown[] = [];
  const env: Env = {
    CACHE: kv as unknown as KVNamespace,
    GATE: namespace as unknown as DurableObjectNamespace,
    USAGE_EVENTS: { writeDataPoint: (point: unknown) => events.push(point) } as AnalyticsEngineDataset,
    CONTEXT_DEV_API_KEY: 'ctx-key',
    ACCEPTED_TOKEN_SHA256: `${sha(TOKEN)}, ${sha(GATEWAY_TOKEN)}`,
    ADMIN_TOKEN_SHA256: sha(ADMIN),
    CONTEXT_DEV_ZDR: 'disabled',
    GATEWAY: gateway.gateway as unknown as Fetcher,
    BILLING: billing.billing,
    ...overrides,
  };
  const handle = createApp({ fetch: upstream.fn, resolve: publicResolve, now: Date.now });
  const call = (
    path: string,
    body?: unknown,
    token: string | null = TOKEN,
    method = body === undefined ? 'GET' : 'POST',
  ) =>
    handle(
      new Request(`https://barestate.xyz/oms-search-api${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  /** A signed-in OMS client call to /oms/search/<path>; `authorization` is the raw header (null for none). */
  const userCall = (
    path: string,
    body?: unknown,
    authorization: string | null = `Bearer ${SESSION}`,
    method = 'POST',
  ) =>
    handle(
      new Request(`https://barestate.xyz/oms/search${path}`, {
        method,
        headers: { ...(authorization === null ? {} : { authorization }), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  return { env, kv, gate, upstream, events, call, userCall, gateway, billing };
}

export const searchResult = (url: string, title = url, relevance = 'medium', description = `about ${url}`) => ({
  url,
  title,
  description,
  relevance,
  markdown: { markdown: null, code: 'NOT_REQUESTED' },
  highlights: { highlights: null, code: 'NOT_REQUESTED' },
});

export const searchBody = (results: unknown[], credits = 1) =>
  Response.json({
    query: 'q',
    results,
    cache_metadata: { status: 'miss', age_ms: 0 },
    key_metadata: { credits_consumed: credits, credits_remaining: 1000 },
    request_id: 'r',
  });

export const scrapeBody = (markdown: string, url = 'https://docs.example.com/page', title = 'Docs', credits = 1) =>
  Response.json({
    url,
    markdown: { requested: true, success: true, data: markdown },
    metadata: { title },
    key_metadata: { credits_consumed: credits, credits_remaining: 1000 },
    request_id: 'r',
  });

export const SEARCH = 'https://api.context.dev/v1/web/search';
export const SCRAPE = 'https://api.context.dev/v1/web/scrape';
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
