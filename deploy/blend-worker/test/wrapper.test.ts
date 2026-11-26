import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { BlendGlobal, BlendUser, createWorker, sha256, type Env } from '../src/wrapper.ts';
import { SqlStore } from '../src/limits.ts';

const TOKEN = 'signed_in_token_1234567890',
  OTHER = 'another_token_1234567890';
const PRIVATE = 'PRIVATE_TASK_ANSWER_ARGUMENT';
function storage() {
  const db = new DatabaseSync(':memory:');
  const value = {
    sql: {
      exec(query: string, ...args: (string | number)[]) {
        const statement = db.prepare(query);
        const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  return { db, state: { storage: value } as DurableObjectState };
}
function setup(vars: Partial<Env> = {}) {
  let now = Date.parse('2026-11-20T12:00:00Z');
  const kv = new Map<string, string>(),
    puts: Array<{ key: string; value: string; ttl: number }> = [],
    logs: string[] = [],
    points: unknown[] = [],
    forwarded: Request[] = [],
    upstream: Request[] = [],
    gateway: Request[] = [];
  let account = (request: Request) =>
    Response.json({
      user: { id: request.headers.get('authorization')?.endsWith(OTHER) ? 'other-user' : 'private-user' },
    });
  let provider: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    upstream.push(request);
    return new URL(request.url).hostname === 'api.anthropic.com'
      ? Response.json({
          content: [{ type: 'text', text: PRIVATE }],
          usage: { input_tokens: 10, output_tokens: 2 },
          stop_reason: 'end_turn',
        })
      : Response.json({
          choices: [{ message: { role: 'assistant', content: PRIVATE }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        });
  };
  const deps = {
    now: () => now,
    log: (line: string) => logs.push(line),
    fetch: ((input, init) => provider(input, init)) as typeof fetch,
  };
  const globalState = storage(),
    users = new Map<string, { instance: BlendUser; disk: ReturnType<typeof storage> }>();
  const env = {
    ...vars,
    CACHE: {
      get: async (key: string, type?: string) => {
        const value = kv.get(key);
        return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
      },
      put: async (key: string, value: string, options: { expirationTtl: number }) => {
        kv.set(key, value);
        puts.push({ key, value, ttl: options.expirationTtl });
      },
    },
    GATEWAY: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        gateway.push(request);
        return account(request);
      },
    },
    USAGE_EVENTS: { writeDataPoint: (point: unknown) => points.push(point) },
    XAI_API_KEY: 'provider_secret_xai',
    ANTHROPIC_API_KEY: 'provider_secret_anthropic',
    OPENCODE_API_KEY: 'provider_secret_go',
    MUSE_API_KEY: 'provider_secret_muse',
  } as unknown as Env;
  const global = new BlendGlobal(globalState.state, env, deps);
  let globalFetch = (request: Request) => global.fetch(request);
  env.GLOBAL = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => globalFetch(new Request(input, init)) }),
  } as unknown as DurableObjectNamespace;
  env.USERS = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        forwarded.push(request);
        let user = users.get(name);
        if (!user) {
          const disk = storage();
          user = { disk, instance: new BlendUser(disk.state, env, deps) };
          users.set(name, user);
        }
        return user.instance.fetch(request);
      },
    }),
  } as unknown as DurableObjectNamespace;
  return {
    env,
    kv,
    puts,
    logs,
    points,
    forwarded,
    upstream,
    gateway,
    users,
    global,
    globalState,
    deps,
    app: createWorker(deps),
    advance: (ms: number) => {
      now += ms;
    },
    account: (fn: typeof account) => {
      account = fn;
    },
    provider: (fn: typeof fetch) => {
      provider = fn;
    },
    globalFetch: (fn: typeof globalFetch) => {
      globalFetch = fn;
    },
  };
}
function request({
  token = TOKEN,
  profile = 'grok-4.3',
  session = 'session',
  messages = [{ role: 'user', content: PRIVATE }],
}: { token?: string; profile?: string; session?: string; messages?: unknown[] } = {}) {
  return new Request('https://barestate.xyz/oms/blend/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-blend-session': session },
    body: JSON.stringify({ model: profile, messages, max_tokens: 64 }),
  });
}
const models = (token = TOKEN) =>
  new Request('https://barestate.xyz/oms/blend/v1/models', { headers: { authorization: `Bearer ${token}` } });
function balance(disk: ReturnType<typeof storage>) {
  return disk.db
    .prepare('SELECT spent,held FROM blend_days')
    .all()
    .reduce<{ spent: number; held: number }>(
      (total, row) => ({ spent: total.spent + Number(row.spent), held: total.held + Number(row.held) }),
      { spent: 0, held: 0 },
    );
}
function onlyUser(s: ReturnType<typeof setup>) {
  return [...s.users.values()][0]!;
}

test('gateway bearer auth, prefix stripping, token hashing and provider secret isolation', async () => {
  const s = setup();
  assert.equal((await s.app(request(), s.env)).status, 200);
  assert.equal(s.gateway[0]!.url, 'https://barestate.xyz/oms/api/me');
  assert.equal(s.gateway[0]!.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(s.forwarded[0]!.headers.get('authorization'), null);
  assert.equal(new URL(s.forwarded[0]!.url).pathname, '/v1/chat/completions');
  assert.equal(s.forwarded[0]!.headers.get('x-blend-user-hash'), await sha256('user:private-user'));
  assert.equal(s.upstream[0]!.headers.get('authorization'), 'Bearer provider_secret_xai');
  assert.equal(s.puts[0]!.key, `session:${await sha256(TOKEN)}`);
  assert.equal(s.puts[0]!.ttl, 300);
  assert.ok(!JSON.stringify(s.puts).includes(TOKEN));
  assert.equal((await s.app(models(), s.env)).status, 200);
  assert.equal(s.gateway.length, 1);
});
test('allowed auth expires at five minutes; refusals expire at thirty seconds with KV sixty-second floor', async () => {
  const s = setup();
  await s.app(models(), s.env);
  s.account(() => new Response(null, { status: 403 }));
  s.advance(299999);
  assert.equal((await s.app(models(), s.env)).status, 200);
  assert.equal(s.gateway.length, 1);
  s.advance(2);
  assert.equal((await s.app(models(), s.env)).status, 403);
  assert.equal(s.puts.at(-1)!.ttl, 60);
  s.account(() => Response.json({ user: { id: 'private-user' } }));
  s.advance(29999);
  assert.equal((await s.app(models(), s.env)).status, 403);
  s.advance(2);
  assert.equal((await s.app(models(), s.env)).status, 200);
  assert.equal(s.gateway.length, 3);
});
test('bad/missing bearer, malformed identity and gateway failures fail closed; transient gateway failures are not cached', async () => {
  const unsigned = setup(),
    unsignedRequest = models();
  unsignedRequest.headers.delete('authorization');
  assert.equal((await unsigned.app(unsignedRequest, unsigned.env)).status, 401);
  const missing = setup();
  await missing.app(models(), missing.env);
  delete (missing.env as Partial<Env>).GATEWAY;
  assert.equal((await missing.app(models(), missing.env)).status, 403);
  for (const token of ['', 'bad', 'has illegal spaces_12345']) {
    const s = setup();
    assert.equal((await s.app(models(token), s.env)).status, 403);
    assert.equal(s.gateway.length, 0);
    assert.equal(s.users.size, 0);
  }
  for (const status of [401, 403, 500]) {
    const s = setup();
    s.account(() => new Response(null, { status }));
    assert.equal((await s.app(models(), s.env)).status, 403);
    assert.equal(s.puts.length, status === 500 ? 0 : 1);
  }
  const s = setup();
  s.account(() => Response.json({ user: { id: 3 } }));
  assert.equal((await s.app(models(), s.env)).status, 403);
  assert.equal(s.puts.length, 1);
  const down = setup();
  down.account(() => {
    throw Error(PRIVATE);
  });
  assert.equal((await down.app(models(), down.env)).status, 403);
  assert.equal(down.puts.length, 0);
});
test('kill switch applies before auth to every route, including an empty KV value; KV outage fails closed', async () => {
  const s = setup();
  s.kv.set('blend:disabled', '');
  for (const req of [models(), request(), new Request('https://barestate.xyz/other')])
    assert.equal((await s.app(req, s.env)).status, 503);
  assert.equal(s.gateway.length, 0);
  assert.equal(s.users.size, 0);
  assert.equal(s.upstream.length, 0);
  s.kv.delete('blend:disabled');
  assert.equal((await s.app(models(), s.env)).status, 200);
  s.env.CACHE.get = async () => {
    throw Error(PRIVATE);
  };
  assert.equal((await s.app(models(), s.env)).status, 503);
});
test('sliding per-user minute limit survives DO recreation and shares the limit across tokens for one account', async () => {
  const s = setup({ RATE_PER_MIN: '1' });
  s.account(() => Response.json({ user: { id: 'private-user' } }));
  assert.equal((await s.app(models(), s.env)).status, 200);
  const user = onlyUser(s);
  user.instance = new BlendUser(user.disk.state, s.env, s.deps);
  const denied = await s.app(models(OTHER), s.env);
  assert.equal(denied.status, 429);
  assert.equal(s.users.size, 1);
  assert.equal(denied.headers.get('retry-after'), '60');
  s.advance(60000);
  assert.equal((await s.app(models(), s.env)).status, 200);
});
test(
  'concurrent in-flight requests are limited and slots are released after settlement',
  { timeout: 5000 },
  async () => {
    const s = setup();
    let release!: () => void,
      ready!: () => void,
      entered = 0;
    const wait = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        ready = r;
      });
    s.provider(async () => {
      if (++entered === 2) ready();
      await wait;
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
    });
    const a = s.app(request({ session: 'a' }), s.env),
      b = s.app(request({ session: 'b' }), s.env);
    await started;
    assert.equal((await s.app(request({ session: 'c' }), s.env)).status, 429);
    assert.equal(entered, 2);
    release();
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 200);
    assert.equal((await s.app(request({ session: 'c' }), s.env)).status, 200);
  },
);
test('user and global daily reservations refuse before dispatch; global refusal refunds the user hold', async () => {
  for (const vars of [{ USER_DAILY_USD: '0' }, { GLOBAL_DAILY_USD: '0' }]) {
    const s = setup(vars);
    const response = await s.app(request(), s.env);
    assert.equal(response.status, 402);
    assert.equal(s.upstream.length, 0);
    assert.match(
      ((await response.json()) as { error: { message: string } }).error.message,
      vars.USER_DAILY_USD ? /User daily/ : /Global daily/,
    );
    assert.deepEqual(balance(onlyUser(s).disk), { spent: 0, held: 0 });
    assert.deepEqual(balance(s.globalState), { spent: 0, held: 0 });
  }
  const s = setup({ USER_DAILY_USD: '0.001' });
  assert.equal((await s.app(request(), s.env)).status, 402);
  assert.equal(s.upstream.length, 0);
});
test('successful settlement refunds unused reservation and persists exact integer-micro costs across restart', async () => {
  const s = setup({ USER_DAILY_USD: '0.004', GLOBAL_DAILY_USD: '0.004' });
  for (let i = 0; i < 10; i++) assert.equal((await s.app(request(), s.env)).status, 200);
  assert.deepEqual(balance(onlyUser(s).disk), { spent: 180, held: 0 });
  assert.deepEqual(balance(s.globalState), { spent: 180, held: 0 });
  const user = onlyUser(s);
  user.instance = new BlendUser(user.disk.state, s.env, s.deps);
  assert.equal((await s.app(request(), s.env)).status, 200);
  assert.deepEqual(balance(user.disk), { spent: 198, held: 0 });
});
test('global in-flight reservations bound combined spend across different users', { timeout: 5000 }, async () => {
  const s = setup({ GLOBAL_DAILY_USD: '0.008' });
  let release!: () => void,
    ready!: () => void,
    count = 0;
  const wait = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      ready = r;
    });
  s.provider(async () => {
    if (++count === 2) ready();
    await wait;
    return Response.json({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
  });
  const a = s.app(request({ session: 'a' }), s.env),
    b = s.app(request({ token: OTHER, session: 'b' }), s.env);
  await started;
  s.account(() => Response.json({ user: { id: 'third-user' } }));
  const c = request({ token: 'third_token_1234567890' });
  assert.equal((await s.app(c, s.env)).status, 402);
  assert.equal(count, 2);
  release();
  await Promise.all([a, b]);
  assert.equal((await s.app(request({ token: 'third_token_1234567890' }), s.env)).status, 200);
});
test('failed attempts retry once, assess input and retain only failed-call billing exposure', async () => {
  const s = setup({ USER_DAILY_USD: '0.008', GLOBAL_DAILY_USD: '0.008' });
  let calls = 0;
  s.provider(async () => {
    calls++;
    throw TypeError(PRIVATE);
  });
  const response = await s.app(request(), s.env);
  assert.equal(response.status, 502);
  assert.equal(calls, 2);
  assert.equal(response.headers.get('x-blend-receipt'), 'settled');
  const user = balance(onlyUser(s).disk);
  assert.ok(user.spent > 0 && user.held > 0);
  assert.deepEqual(balance(s.globalState), user);
  assert.equal((await s.app(request(), s.env)).status, 402);
  assert.equal(calls, 2);
});
test('global transport uncertainty and settlement failure retain conservative holds and never permit an unreserved call', async () => {
  const s = setup();
  s.globalFetch(async () => {
    throw Error(PRIVATE);
  });
  assert.equal((await s.app(request(), s.env)).status, 503);
  assert.equal(s.upstream.length, 0);
  assert.ok(balance(onlyUser(s).disk).held > 0);
  const t = setup();
  t.globalFetch(async (request) =>
    new URL(request.url).pathname === '/settle' ? new Response(null, { status: 503 }) : t.global.fetch(request),
  );
  const response = await t.app(request(), t.env);
  assert.equal(response.status, 503);
  assert.equal(t.upstream.length, 1);
  assert.ok(Number(response.headers.get('x-blend-cost-usd')) > 0);
  assert.ok(balance(onlyUser(t).disk).held > 0);
  assert.ok(balance(t.globalState).held > 0);
});
test('SQLite reservations settle idempotently to their original UTC day, including midnight and retained failure liabilities', () => {
  const disk = storage(),
    book = new SqlStore(disk.state.storage),
    at = Date.parse('2026-11-20T23:59:59Z');
  assert.ok(book.reserve('first', 100, 100, at));
  assert.equal(book.reserve('another', 1, 100, at), false);
  assert.ok(book.reserve('next-day', 100, 100, at + 2000));
  book.settle('first', 20, true);
  book.settle('first', 20, true);
  assert.throws(() => book.settle('first', 21, true), /conflict/);
  assert.deepEqual(
    disk.db
      .prepare('SELECT day,spent,held FROM blend_days ORDER BY day')
      .all()
      .map((r) => ({ ...r })),
    [
      { day: '2026-11-20', spent: 20, held: 80 },
      { day: '2026-11-21', spent: 0, held: 100 },
    ],
  );
});
test('sticky policy state is durable across DO recreation and isolated by user; no transcript text is stored', async () => {
  const s = setup();
  let model = '';
  s.provider(async (input, init) => {
    model = JSON.parse(String(init?.body)).model;
    return model.startsWith('claude')
      ? Response.json({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 2 },
          stop_reason: 'end_turn',
        })
      : Response.json({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        });
  });
  const messages = [
    { role: 'user', content: PRIVATE },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'one', type: 'function', function: { name: 'test', arguments: '{}' } },
        { id: 'two', type: 'function', function: { name: 'test', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'one', content: 'exit code 1' },
    { role: 'tool', tool_call_id: 'two', content: 'exit code 1' },
  ];
  assert.equal((await s.app(request({ profile: 'blend-auto', messages }), s.env)).status, 200);
  assert.equal(model, 'claude-fable-5-2');
  const user = onlyUser(s);
  user.instance = new BlendUser(user.disk.state, s.env, s.deps);
  assert.equal((await s.app(request({ profile: 'blend-auto' }), s.env)).status, 200);
  assert.equal(model, 'claude-fable-5-2');
  assert.equal((await s.app(request({ profile: 'blend-auto', token: OTHER }), s.env)).status, 200);
  assert.equal(model, 'muse-ember-1.0');
  const stored = JSON.stringify(user.disk.db.prepare('SELECT * FROM blend_state').all());
  assert.ok(!stored.includes(PRIVATE));
  assert.ok(!stored.includes(TOKEN));
  assert.ok(!stored.includes('session:blend-auto:session'));
});
test('cost log and Analytics Engine contain only allowlisted fields, never identity, bearer, prompt, response or arguments', async () => {
  const s = setup();
  await s.app(request(), s.env);
  s.kv.set('blend:disabled', '1');
  await s.app(models(), s.env);
  const keys = [
    'user_hash',
    'profile',
    'model',
    'input_tokens',
    'cached_tokens',
    'output_tokens',
    'usd',
    'status',
    'ms',
  ].sort();
  for (const line of s.logs) assert.deepEqual(Object.keys(JSON.parse(line)).sort(), keys);
  const serialized = JSON.stringify([s.logs, s.points]);
  for (const secret of [TOKEN, PRIVATE, 'private-user', 'provider_secret_xai']) assert.ok(!serialized.includes(secret));
  assert.equal(s.points.length, s.logs.length);
  assert.equal(JSON.parse(s.logs[0]!).usd, 0.0000175);
  s.kv.delete('blend:disabled');
  s.env.USAGE_EVENTS!.writeDataPoint = () => {
    throw Error(PRIVATE);
  };
  assert.equal((await s.app(request(), s.env)).status, 200);
});
test('oversized input, unknown routes and invalid configured limits fail closed without upstream requests', async () => {
  const s = setup();
  assert.equal(
    (await s.app(request({ messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024 + 1) }] }), s.env)).status,
    413,
  );
  assert.equal(s.upstream.length, 0);
  assert.equal((await s.app(new Request('https://barestate.xyz/not-blend'), s.env)).status, 404);
  for (const vars of [{ MAX_CONCURRENT: 'NaN' }, { USER_DAILY_USD: '-1' }, { GLOBAL_DAILY_USD: 'Infinity' }]) {
    const t = setup(vars);
    assert.equal((await t.app(request(), t.env)).status, 503);
    assert.equal(t.upstream.length, 0);
  }
});
