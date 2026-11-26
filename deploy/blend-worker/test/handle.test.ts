import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle } from '../src/core/handle.ts';
import { parseInput } from '../src/core/input.ts';
import { costUsd } from '../src/core/pricing.ts';
import { createNodeServer, costLogger } from '../src/node-server.ts';
import { call, chatData, chatStream, dependencies, messages, request, SECRET } from './fixtures.ts';

test('models lists declarative profiles', async () => {
  const { deps, logs } = dependencies();
  const r = await handle(new Request('http://localhost/v1/models'), deps);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { data: { id: string }[] }).data[0]?.id, 'single');
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0]?.calls, []);
});
test('non-stream response includes usage, model, exact cost and safe structured log', async () => {
  const { deps, logs } = dependencies();
  const response = await handle(request(), deps);
  const body = (await response.json()) as Record<string, any>;
  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, 'ok');
  assert.equal(response.headers.get('x-blend-model'), 'grok-4.3');
  const cost = costUsd('grok-4.3', { input: 100, cached: 20, output: 30, cacheWrite: 0 }, deps.now!());
  assert.equal(Number(response.headers.get('x-blend-cost-usd')), cost);
  assert.equal(body.blend.cost_usd, cost);
  assert.equal(body.blend.calls.length, 1);
  assert.equal(body.usage.total_tokens, 130);
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]!).sort(), ['calls', 'profile', 'status', 'total_usd', 'ts']);
  assert.deepEqual(
    Object.keys(logs[0]!.calls[0]!).sort(),
    [
      'attempt',
      'cached',
      'dispatched',
      'finish_reason',
      'in',
      'model',
      'ms',
      'out',
      'reasoning_chars',
      'status_class',
      'text_chars',
      'tool_calls',
      'upstream_status',
      'usage_source',
      'usd',
    ].sort(),
  );
  assert.equal(JSON.stringify(logs).includes(SECRET), false);
  assert.equal(JSON.stringify(logs).includes('read_file'), false);
});
test('streaming final chunk contains usage and blend; tool fragments reconstruct valid calls', async () => {
  const { deps } = dependencies();
  deps.fetch = async () => chatStream();
  const response = await handle(request({ stream: true }), deps);
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const events = (await response.text())
    .split('\n\n')
    .filter(Boolean)
    .map((x) => x.slice(6));
  assert.equal(events.pop(), '[DONE]');
  const chunks = events.map((x) => JSON.parse(x));
  const final = chunks.at(-1);
  assert.equal(final.choices.length, 0);
  assert.equal(final.usage.total_tokens, 130);
  assert.equal(final.blend.model, 'grok-4.3');
  assert.equal(String(final.blend.cost_usd), response.headers.get('x-blend-cost-usd'));
  const parts = chunks.flatMap((c) => c.choices).flatMap((c) => c.delta.tool_calls ?? []);
  assert.equal(parts.map((p) => p.function?.arguments ?? '').join(''), call.function.arguments);
  assert.equal(JSON.stringify(chunks).includes(SECRET), false);
});
test('classifier call is counted in cost and usage once per session', async () => {
  const { deps, logs } = dependencies();
  deps.profiles.single = {
    type: 'classify',
    classifier: 'mimo-v2.6-flash',
    routes: { easy: 'grok-4.3', medium: 'grok-4.3', hard: 'grok-4.3' },
  };
  const seen: string[] = [];
  deps.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    seen.push(body.model);
    return Response.json(chatData(body.model === 'mimo-v2.6-flash' ? 'easy' : 'ok'));
  };
  const a = (await (await handle(request({}, 'session'), deps)).json()) as Record<string, any>;
  await handle(request({}, 'session'), deps);
  assert.deepEqual(seen, ['mimo-v2.6-flash', 'grok-4.3', 'grok-4.3']);
  assert.equal(a.blend.calls.length, 2);
  assert.equal(a.usage.total_tokens, 260);
  assert.equal(
    a.blend.cost_usd,
    logs[0]!.calls.reduce((n, c) => n + c.usd, 0),
  );
});
test('errored cheap call retries on strong and logs both without raw upstream error', async () => {
  const { deps, logs } = dependencies();
  deps.profiles.single = {
    type: 'escalate',
    cheap: 'mimo-v2.6-flash',
    strong: 'grok-4.3',
    trigger: { retry_on_error_or_empty: true },
  };
  deps.fetch = async (_url, init) =>
    JSON.parse(String(init?.body)).model === 'mimo-v2.6-flash'
      ? new Response(SECRET, { status: 500 })
      : Response.json(chatData());
  const r = await handle(request({}, 's'), deps);
  assert.equal(r.status, 200);
  assert.equal(logs[0]!.calls.length, 3);
  assert.deepEqual(
    logs[0]!.calls.map((c) => c.model),
    ['mimo-v2.6-flash', 'mimo-v2.6-flash', 'grok-4.3'],
  );
  assert.equal(JSON.stringify(logs).includes(SECRET), false);
});
test('partial-stream usage is charged even when the upstream stream then errors', async () => {
  const { deps, logs } = dependencies();
  deps.fetch = async () => {
    const { sse } = await import('./fixtures.ts');
    return sse([{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }, { error: { message: SECRET } }]);
  };
  const r = await handle(request({ stream: true }), deps);
  assert.equal(r.status, 502);
  assert.equal(logs[0]?.calls[0]?.out, 2);
  assert.ok(Number(r.headers.get('x-blend-cost-usd')) > 0);
  assert.equal((await r.text()).includes(SECRET), false);
});
test('invalid requests, methods, profiles, transport failures and missing keys return sanitized errors and one log each', async () => {
  const { deps, logs } = dependencies();
  for (const req of [
    new Request('http://localhost/missing'),
    new Request('http://localhost/v1/chat/completions'),
    request({ messages: [] }),
    request({ model: SECRET }),
    new Request('http://localhost/v1/chat/completions', { method: 'POST', body: SECRET }),
  ]) {
    const before = logs.length;
    const r = await handle(req, deps);
    assert.ok(r.status >= 400);
    assert.equal((await r.text()).includes(SECRET), false);
    assert.equal(logs.length, before + 1);
  }
  deps.keys = {};
  assert.equal((await handle(request(), deps)).status, 503);
  deps.keys = { xai: SECRET };
  deps.fetch = async () => {
    throw Error(SECRET);
  };
  const r = await handle(request(), deps);
  assert.equal(r.status, 502);
  assert.equal((await r.text()).includes(SECRET), false);
  const aborted = new AbortController();
  aborted.abort();
  deps.fetch = async () => {
    throw Error(SECRET);
  };
  assert.equal((await handle(new Request(request(), { signal: aborted.signal }), deps)).status, 504);
});
test('core rejects malformed message/tool/token fields and unsupported multimodal content', () => {
  for (const body of [
    { messages: [] },
    { max_tokens: 0 },
    { max_completion_tokens: 1.5 },
    { stream: 'yes' },
    { n: 2 },
    { messages: [{ role: 'tool', content: 'x' }] },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'x' }] }] },
    { tools: [{ type: 'function', function: { name: 'bad name', parameters: {} } }] },
  ])
    assert.throws(() => parseInput({ model: 'single', messages, ...body }));
  assert.equal(parseInput({ model: 'single', messages, max_tokens: 3 }).maxTokens, 3);
});
test('logging failure is a sanitized unavailable response', async () => {
  const { deps } = dependencies();
  deps.log = () => {
    throw Error(SECRET);
  };
  const r = await handle(request(), deps);
  assert.equal(r.status, 503);
  assert.equal((await r.text()).includes(SECRET), false);
});
test('Node host binds loopback, serves the seam and appends concurrent JSONL lines without text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blend-host-test-'));
  const { deps } = dependencies();
  const file = join(root, 'cost.jsonl');
  deps.log = costLogger(file);
  const server = createNodeServer(deps);
  try {
    await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1');
    const url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    const replies = await Promise.all(
      Array.from({ length: 4 }, () =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'single', messages }),
        }),
      ),
    );
    for (const r of replies) {
      assert.equal(r.status, 200);
      await r.text();
    }
    const text = await readFile(file, 'utf8');
    const lines = text
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    assert.equal(lines.length, 4);
    assert.equal(text.includes(SECRET), false);
    assert.ok(lines.every((l) => l.status === 200 && l.calls.length === 1));
  } finally {
    await new Promise<void>((accept, reject) => server.close((e) => (e ? reject(e) : accept())));
    await rm(root, { recursive: true, force: true });
  }
});
