import rawProfiles from '../profiles.json' with { type: 'json' };
import { handle } from './core/handle.ts';
import { estimatedInput } from './core/adapters.ts';
import { validateProfiles } from './core/policies.ts';
import { modelSpec } from './core/pricing.ts';
import { BlendError, UpstreamError } from './core/types.ts';
import type { SessionState, SessionStore, RequestLog } from './core/types.ts';
import { SqlStore, limit, micro, dailyCap } from './limits.ts';

export interface Env {
  CACHE: KVNamespace;
  GATEWAY: Fetcher;
  USERS: DurableObjectNamespace;
  GLOBAL: DurableObjectNamespace;
  USAGE_EVENTS?: AnalyticsEngineDataset;
  ANTHROPIC_API_KEY?: string;
  XAI_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  MUSE_API_KEY?: string;
  RATE_PER_MIN?: string;
  MAX_CONCURRENT?: string;
  USER_DAILY_USD?: string;
  GLOBAL_DAILY_USD?: string;
}
type Deps = { fetch: typeof fetch; now: () => number; log: (line: string) => void };
const defaults: Deps = { fetch: (input, init) => fetch(input, init), now: Date.now, log: (line) => console.log(line) };
const profiles = validateProfiles(rawProfiles);
const DEADLINE = 600000;
const PREFIX = '/oms/blend';
const USER_HEADER = 'x-blend-user-hash';
const zeroHeaders = {
  'x-blend-cost-usd': '0',
  'x-blend-receipt': 'settled',
  'x-blend-usage': '{"input":0,"cached":0,"output":0}',
};
export function errorResponse(status: number, message: string, reason: string, settled = true) {
  return Response.json(
    { error: { message, type: status === 402 ? 'insufficient_quota' : 'blend_error', code: reason } },
    { status, headers: { ...(settled ? zeroHeaders : {}), ...(status === 429 ? { 'retry-after': '60' } : {}) } },
  );
}
export async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
function emit(
  env: Env,
  deps: Deps,
  user: string | null,
  profile: string | null,
  model: string | null,
  input: number,
  cached: number,
  output: number,
  usd: number,
  status: number,
  ms: number,
) {
  const event = {
    user_hash: user,
    profile,
    model,
    input_tokens: input,
    cached_tokens: cached,
    output_tokens: output,
    usd,
    status,
    ms,
  };
  deps.log(JSON.stringify(event));
  try {
    env.USAGE_EVENTS?.writeDataPoint({
      indexes: [user ?? 'anonymous'],
      blobs: [profile ?? '', model ?? ''],
      doubles: [input, cached, output, usd, status, ms],
    });
  } catch {}
}
async function sessionUser(request: Request, env: Env, deps: Deps): Promise<string | undefined> {
  const token = /^Bearer ([A-Za-z0-9_-]{16,512})$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token || !env.GATEWAY) return undefined;
  const key = `session:${await sha256(token)}`;
  const cached = await env.CACHE.get<{ userId?: string; until: number }>(key, 'json');
  if (cached && cached.until > deps.now()) return cached.userId;
  let userId: string | undefined,
    settled = false;
  try {
    const response = await env.GATEWAY.fetch('https://barestate.xyz/oms/api/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 200) {
      const id = ((await response.json().catch(() => undefined)) as { user?: { id?: unknown } } | undefined)?.user?.id;
      if (typeof id === 'string' && id.length >= 1 && id.length <= 256) userId = id;
      settled = true;
    } else {
      void response.body?.cancel().catch(() => {});
      settled = response.status === 401 || response.status === 403;
    }
  } catch {}
  if (settled) {
    const ms = userId ? 300000 : 30000;
    try {
      await env.CACHE.put(key, JSON.stringify({ ...(userId ? { userId } : {}), until: deps.now() + ms }), {
        expirationTtl: Math.max(60, ms / 1000),
      });
    } catch {}
  }
  return userId;
}
export function createWorker(deps: Deps = defaults) {
  return async (request: Request, env: Env): Promise<Response> => {
    const start = deps.now();
    let user: string | null = null;
    const deny = (status: number, message: string, reason: string, settled = true) => {
      emit(env, deps, user, null, null, 0, 0, 0, 0, status, Math.max(0, deps.now() - start));
      return errorResponse(status, message, reason, settled);
    };
    let forwarded = false;
    try {
      if ((await env.CACHE.get('blend:disabled')) !== null)
        return deny(503, 'Blend is temporarily disabled.', 'disabled');
      const url = new URL(request.url);
      if (!url.pathname.startsWith(PREFIX + '/')) return deny(404, 'Not found.', 'not_found');
      const id = await sessionUser(request, env, deps);
      if (!id)
        return deny(
          request.headers.has('authorization') ? 403 : 401,
          'Blend requires a signed-in invited OMS account. Sign in with /login.',
          'forbidden',
        );
      user = await sha256(`user:${id}`);
      url.pathname = url.pathname.slice(PREFIX.length);
      const next = new Request(url, request);
      next.headers.delete('authorization');
      next.headers.set(USER_HEADER, user);
      forwarded = true;
      return await env.USERS.get(env.USERS.idFromName(user)).fetch(next);
    } catch {
      return deny(503, 'Blend admission is unavailable. Try again later.', 'admission_unavailable', !forwarded);
    }
  };
}
async function rpc(env: Env, path: string, body: unknown): Promise<Response> {
  return env.GLOBAL.get(env.GLOBAL.idFromName('global')).fetch(`https://blend-global/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
function budgetError(message: string) {
  const error = new UpstreamError(402, message, 'budget');
  error.type = 'insufficient_quota';
  return error;
}

export class BlendGlobal {
  private readonly store: SqlStore;
  private readonly env: Env;
  private readonly deps: Deps;
  constructor(state: DurableObjectState, env: Env, deps: Deps = defaults) {
    this.env = env;
    this.deps = deps;
    this.store = new SqlStore(state.storage);
  }
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== 'POST') return errorResponse(405, 'Use POST.', 'method_not_allowed');
      const body = (await request.json()) as { id: unknown; amount: unknown; retain?: unknown };
      if (
        typeof body.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(body.id) ||
        !Number.isSafeInteger(body.amount) ||
        Number(body.amount) < 0 ||
        (typeof body.retain !== 'boolean' && body.retain !== undefined)
      )
        return errorResponse(400, 'Invalid reservation.', 'invalid_reservation');
      const path = new URL(request.url).pathname;
      if (path === '/reserve')
        return this.store.reserve(
          body.id,
          Number(body.amount),
          dailyCap(this.env.GLOBAL_DAILY_USD, 50),
          this.deps.now(),
        )
          ? Response.json({ ok: true })
          : errorResponse(402, 'Global daily spend limit reached.', 'global_daily_limit');
      if (path === '/settle') {
        this.store.settle(body.id, Number(body.amount), body.retain ?? false);
        return Response.json({ ok: true });
      }
      return errorResponse(404, 'Not found.', 'not_found');
    } catch {
      return errorResponse(503, 'Global budget storage is unavailable.', 'global_unavailable', false);
    }
  }
}

export class BlendUser implements SessionStore {
  private readonly store: SqlStore;
  private readonly env: Env;
  private readonly deps: Deps;
  private readonly queues = new Map<string, Promise<void>>();
  constructor(state: DurableObjectState, env: Env, deps: Deps = defaults) {
    this.env = env;
    this.deps = deps;
    this.store = new SqlStore(state.storage);
  }
  async run<T>(key: string, operation: (state: SessionState) => Promise<T>): Promise<T> {
    const hash = await sha256(key),
      previous = this.queues.get(hash) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(hash, tail);
    await previous;
    try {
      const state = this.store.get<SessionState>(`session:${hash}`) ?? {
        escalated: {},
        labels: {},
        executorTurns: {},
        orchestrations: {},
      };
      try {
        return await operation(state);
      } finally {
        this.store.put(`session:${hash}`, state);
      }
    } finally {
      release();
      if (this.queues.get(hash) === tail) this.queues.delete(hash);
    }
  }
  async fetch(request: Request): Promise<Response> {
    const user = request.headers.get(USER_HEADER);
    if (!user || !/^[a-f0-9]{64}$/.test(user)) return errorResponse(403, 'User admission is required.', 'forbidden');
    const id = crypto.randomUUID(),
      start = this.deps.now();
    let active = false;
    const deny = (status: number, message: string, reason: string) => {
      emit(this.env, this.deps, user, null, null, 0, 0, 0, 0, status, Math.max(0, this.deps.now() - start));
      return errorResponse(status, message, reason);
    };
    try {
      const userDaily = dailyCap(this.env.USER_DAILY_USD, 5);
      const refused = this.store.acquire(
        id,
        start,
        DEADLINE,
        limit(this.env.RATE_PER_MIN, 30, true),
        limit(this.env.MAX_CONCURRENT, 2, true),
      );
      if (refused)
        return deny(
          429,
          refused === 'rate' ? 'Requests per minute limit reached.' : 'Concurrent request limit reached.',
          refused === 'rate' ? 'rate_limit' : 'concurrency_limit',
        );
      active = true;
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(DEADLINE)]);
      if (request.body) {
        const reader = request.body.getReader();
        let size = 0;
        const chunks: Uint8Array[] = [];
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          signal.throwIfAborted();
          for (;;) {
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            size += value.byteLength;
            if (size > 2 * 1024 * 1024) {
              void reader.cancel().catch(() => {});
              return deny(413, 'Request body exceeds 2 MiB.', 'body_limit');
            }
            chunks.push(value);
          }
        } finally {
          signal.removeEventListener('abort', cancel);
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        request = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: bytes.buffer,
          signal,
        });
      } else request = new Request(request, { signal });
      const log = (line: RequestLog) => {
        if (!line.calls.length)
          emit(
            this.env,
            this.deps,
            user,
            line.profile,
            null,
            0,
            0,
            0,
            0,
            line.status,
            Math.max(0, this.deps.now() - start),
          );
        for (const c of line.calls)
          emit(this.env, this.deps, user, line.profile, c.model, c.in, c.cached, c.out, c.usd, line.status, c.ms);
      };
      return await handle(request, {
        fetch: this.deps.fetch,
        profiles,
        sessions: this,
        now: this.deps.now,
        log,
        keys: {
          anthropic: this.env.ANTHROPIC_API_KEY,
          xai: this.env.XAI_API_KEY,
          'opencode-go': this.env.OPENCODE_API_KEY,
          muse: this.env.MUSE_API_KEY,
        },
        beforeCall: async (model, input) => {
          if (signal.aborted) throw new BlendError(504, 'Blend request deadline reached.');
          const spec = modelSpec(model),
            multiplier = spec.peak ? 2 : 1;
          const inputRate =
            Math.max(spec.rates.input, spec.high?.input ?? 0) * (spec.provider === 'anthropic' ? 1.25 : 1) * multiplier;
          const outputRate = Math.max(spec.rates.output, spec.high?.output ?? 0) * multiplier;
          const amount = micro((estimatedInput(model, input) * inputRate + input.maxTokens * outputRate) / 1e6),
            ticket = crypto.randomUUID();
          if (!this.store.reserve(ticket, amount, userDaily, this.deps.now()))
            throw budgetError('User daily spend limit reached.');
          let global: Response;
          try {
            global = await rpc(this.env, 'reserve', { id: ticket, amount });
          } catch {
            throw new BlendError(503, 'Global budget admission is unavailable.');
          }
          if (!global.ok) {
            if (global.status === 402) {
              this.store.settle(ticket, 0, false);
              throw budgetError('Global daily spend limit reached.');
            }
            throw new BlendError(503, 'Global budget admission is unavailable.');
          }
          void global.body?.cancel().catch(() => {});
          return ticket;
        },
        afterCall: async (call, reservation) => {
          const ticket = String(reservation),
            amount = micro(call.usd),
            retain = call.dispatched && call.status_class !== 'ok';
          const response = await rpc(this.env, 'settle', { id: ticket, amount, retain });
          if (!response.ok) throw new BlendError(503, 'Budget settlement is unavailable.');
          void response.body?.cancel().catch(() => {});
          this.store.settle(ticket, amount, retain);
        },
      });
    } catch {
      return errorResponse(503, 'Blend request admission failed.', 'admission_unavailable', false);
    } finally {
      if (active) this.store.release(id);
    }
  }
}
