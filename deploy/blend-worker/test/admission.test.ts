import assert from 'node:assert/strict';
import test from 'node:test';
import { handle } from '../src/core/handle.ts';
import { BlendError } from '../src/core/types.ts';
import { dependencies, request, SECRET } from './fixtures.ts';
import { costUsd } from '../src/core/pricing.ts';

test('pricing uses dispatch time when reservation latency crosses a Go peak-rate boundary', async () => {
  const { deps, logs } = dependencies();
  let now = Date.parse('2026-11-20T00:59:59Z');
  deps.now = () => now;
  deps.profiles = { deepseek: { type: 'single', model: 'deepseek-v4-pro' } };
  deps.beforeCall = async () => {
    now = Date.parse('2026-11-20T01:00:01Z');
  };
  deps.fetch = async () =>
    Response.json({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
  assert.equal((await handle(request({ model: 'deepseek' }), deps)).status, 200);
  assert.equal(logs[0]!.total_usd, costUsd('deepseek-v4-pro', { input: 10, cached: 0, output: 2, cacheWrite: 0 }, now));
});

test('a failed reservation never dispatches, bills input or invokes settlement', async () => {
  const { deps, logs } = dependencies();
  let dispatched = 0,
    settled = 0;
  deps.beforeCall = async () => {
    throw Error(SECRET);
  };
  deps.fetch = async () => {
    dispatched++;
    throw Error('unexpected');
  };
  deps.afterCall = async () => {
    settled++;
  };
  const response = await handle(request(), deps);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('x-blend-cost-usd'), '0');
  assert.equal(dispatched, 0);
  assert.equal(settled, 0);
  assert.equal(logs[0]!.calls[0]!.dispatched, false);
  assert.equal(logs[0]!.calls[0]!.usage_source, 'none');
  assert.equal(logs[0]!.total_usd, 0);
  assert.ok(!JSON.stringify(logs).includes(SECRET));
});
test('each retry receives and settles its own reservation before another attempt', async () => {
  const { deps, logs } = dependencies();
  deps.retryDelayMs = 0;
  const order: string[] = [];
  let count = 0;
  deps.beforeCall = async () => {
    const id = String(++count);
    order.push('reserve:' + id);
    return id;
  };
  deps.fetch = async () => {
    if (count === 1) throw TypeError(SECRET);
    return Response.json({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
  };
  deps.afterCall = async (call, id) => {
    order.push(`settle:${id}:${call.status_class}`);
  };
  assert.equal((await handle(request(), deps)).status, 200);
  assert.deepEqual(order, ['reserve:1', 'settle:1:transport', 'reserve:2', 'settle:2:ok']);
  assert.equal(logs[0]!.calls.length, 2);
});
test('a pre-dispatch provider refusal releases an acquired reservation with zero cost', async () => {
  const { deps } = dependencies();
  deps.keys = {};
  let settled = false;
  deps.beforeCall = async () => 42;
  deps.afterCall = async (call, id) => {
    assert.equal(id, 42);
    assert.equal(call.dispatched, false);
    assert.equal(call.usd, 0);
    settled = true;
  };
  assert.equal((await handle(request(), deps)).status, 503);
  assert.equal(settled, true);
});
test('settlement failure preserves the actual upstream cost receipt and does not redispatch', async () => {
  const { deps, logs } = dependencies();
  let count = 0;
  deps.beforeCall = async () => 42;
  deps.afterCall = async () => {
    throw new BlendError(503, 'Budget settlement is unavailable.');
  };
  deps.fetch = async () => {
    count++;
    return Response.json({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
  };
  const response = await handle(request(), deps);
  assert.equal(response.status, 503);
  assert.equal(count, 1);
  assert.ok(Number(response.headers.get('x-blend-cost-usd')) > 0);
  assert.equal(logs[0]!.calls[0]!.status_class, 'ok');
});
