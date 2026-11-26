import assert from 'node:assert/strict';
import test from 'node:test';
import { handle } from '../src/core/handle.ts';
import { callUpstream, estimatedInput } from '../src/core/adapters.ts';
import { costUsd } from '../src/core/pricing.ts';
import { parseInput } from '../src/core/input.ts';
import { UpstreamError } from '../src/core/types.ts';

test('finish-reason diagnostics cannot copy arbitrary provider text into logs', async () => {
  const { deps, logs } = dependencies();
  deps.fetch = async () =>
    Response.json({
      choices: [{ message: { role: 'assistant', content: SECRET }, finish_reason: SECRET }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
  assert.equal((await handle(request(), deps)).status, 200);
  assert.equal(logs[0]!.calls[0]!.finish_reason, 'other');
  assert.ok(!JSON.stringify(logs).includes(SECRET));
});
import { chatData, dependencies, input, request, sse, SECRET, call } from './fixtures.ts';

for (const kind of ['transport', '500', '429'] as const)
  test(`one buffered retry with a settled estimated receipt after ${kind}`, async () => {
    const { deps, logs } = dependencies();
    deps.retryDelayMs = 0;
    let attempts = 0;
    deps.fetch = async () => {
      if (++attempts === 1) {
        if (kind === 'transport') throw Error(SECRET);
        return new Response(SECRET, { status: Number(kind) });
      }
      return Response.json(chatData());
    };
    const response = await handle(request(), deps);
    assert.equal(response.status, 200);
    assert.equal(attempts, 2);
    assert.equal(response.headers.get('x-blend-receipt'), 'settled');
    const calls = logs[0]!.calls;
    assert.deepEqual(
      calls.map((c) => c.attempt),
      [1, 2],
    );
    assert.equal(calls[0]!.usage_source, 'estimated');
    assert.equal(calls[0]!.in, estimatedInput('grok-4.3', parseInput(await request().json())));
    assert.equal(calls[1]!.usage_source, 'reported');
    assert.equal(
      calls[0]!.usd,
      costUsd('grok-4.3', { input: calls[0]!.in, cached: 0, cacheWrite: 0, output: 0 }, deps.now!()),
    );
    assert.ok(Number(response.headers.get('x-blend-cost-usd')) > calls[1]!.usd);
    assert.ok(!JSON.stringify(logs).includes(SECRET));
  });
test('failed retry retains reported usage and returns a settled error receipt, not an unknown reservation', async () => {
  const { deps, logs } = dependencies();
  deps.retryDelayMs = 0;
  let attempts = 0;
  deps.fetch = async () => {
    attempts++;
    return Response.json(
      { error: { message: SECRET }, usage: { prompt_tokens: 10, completion_tokens: 2 } },
      { status: 503 },
    );
  };
  const response = await handle(request(), deps);
  assert.equal(attempts, 2);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-blend-receipt'), 'settled');
  assert.equal(logs[0]!.calls.length, 2);
  assert.ok(
    logs[0]!.calls.every(
      (c) =>
        c.status_class === 'http_5xx' &&
        c.upstream_status === 503 &&
        c.usage_source === 'reported' &&
        c.in === 10 &&
        c.out === 2,
    ),
  );
  assert.equal((await response.text()).includes(SECRET), false);
});
test('a provider error inside HTTP 200 is not mislabelled as a parser failure', async () => {
  const { deps, logs } = dependencies();
  deps.retryDelayMs = 0;
  deps.fetch = async () =>
    Response.json({ error: { message: SECRET }, usage: { prompt_tokens: 10, completion_tokens: 0 } });
  const response = await handle(request(), deps);
  assert.equal(response.status, 502);
  assert.equal(logs[0]!.calls.length, 2);
  assert.ok(
    logs[0]!.calls.every(
      (c) => c.status_class === 'provider_error' && c.usage_source === 'reported' && c.upstream_status === 200,
    ),
  );
});
test('timeouts, cancellation and event-size limits are distinguishable without response bodies', async () => {
  for (const kind of ['timeout', 'cancelled', 'stream_limit']) {
    const { deps, logs } = dependencies();
    deps.retryDelayMs = 0;
    const controller = new AbortController();
    if (kind === 'cancelled') controller.abort();
    deps.fetch = async () => {
      if (kind === 'stream_limit') return new Response(`data: ${'x'.repeat(8 * 1024 * 1024 + 1)}\n\n`);
      if (kind === 'timeout') throw new UpstreamError(504, 'Upstream request timed out.', 'timeout', true);
      throw new DOMException('cancelled', 'AbortError');
    };
    await handle(new Request(request({ stream: true }), { signal: controller.signal }), deps);
    assert.equal(logs[0]!.calls.length, kind === 'timeout' ? 2 : 1);
    assert.ok(logs[0]!.calls.every((c) => c.status_class === kind));
  }
});
test('nonretryable 4xx, parse errors and pre-dispatch budget refusals are distinct', async () => {
  for (const kind of ['400', 'parse', 'budget']) {
    const { deps, logs } = dependencies();
    deps.retryDelayMs = 0;
    let attempts = 0;
    deps.fetch = async () => {
      attempts++;
      if (kind === 'budget') throw new UpstreamError(429, 'Run spend guard.', 'budget');
      return kind === 'parse' ? new Response('invalid') : new Response(SECRET, { status: 400 });
    };
    const response = await handle(request(), deps);
    assert.equal(attempts, 1);
    assert.ok(response.status >= 400);
    const c = logs[0]!.calls[0]!;
    assert.equal(c.status_class, kind === '400' ? 'http_4xx' : kind === 'parse' ? 'parse_error' : 'budget');
    assert.equal(c.dispatched, kind !== 'budget');
    assert.equal(c.usd === 0, kind === 'budget');
  }
});
test('truncated and upstream-error streams retry, malformed JSON does not', async () => {
  for (const kind of ['truncated_stream', 'stream_error', 'parse_error']) {
    const { deps, logs } = dependencies();
    deps.retryDelayMs = 0;
    deps.fetch = async () =>
      kind === 'truncated_stream'
        ? sse([{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }])
        : kind === 'stream_error'
          ? sse([{ error: { message: SECRET } }])
          : sse(['invalid']);
    await handle(request({ stream: true }), deps);
    assert.equal(logs[0]!.calls.length, kind === 'parse_error' ? 1 : 2);
    assert.ok(logs[0]!.calls.every((c) => c.status_class === kind));
  }
});
for (const model of [
  'mimo-v2.6-flash',
  'mimo-v2.6-pro',
  'deepseek-v4-pro',
  'deepseek-v4.1-flash',
  'qwen3.8-flash',
  'muse-spark-1.3',
  'muse-ember-1.0',
  'muse-wonder-1.0',
])
  test(`${model}: reasoning-only length vs subsequent well-formed tools and tool-result continuation`, async () => {
    for (const tools of [false, true]) {
      const body = input(true);
      body.messages.push(
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: 'safe-result' },
      );
      const result = await callUpstream(model, body, {
        key: SECRET,
        session: 's',
        signal: new AbortController().signal,
        onUsage() {},
        fetch: async (_url, init) => {
          const sent = JSON.parse(String(init?.body));
          assert.equal(sent.messages.at(-1).tool_call_id, call.id);
          assert.equal(sent.messages.at(-1).content, 'safe-result');
          if (model.startsWith('muse')) assert.equal(sent.store, false);
          return sse([
            { choices: [{ delta: { reasoning_content: SECRET } }] },
            ...(tools ? [{ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] } }] }] : []),
            { choices: [{ delta: {}, finish_reason: tools ? 'tool_calls' : 'length' }] },
            {
              choices: [],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 4096,
                completion_tokens_details: { reasoning_tokens: tools ? 4000 : 4096 },
              },
            },
            '[DONE]',
          ]);
        },
      });
      assert.equal(result.reasoningChars, SECRET.length);
      assert.equal(result.finishReason, tools ? 'tool_calls' : 'length');
      assert.equal(result.usage.output, 4096);
      assert.equal(result.message.tool_calls?.length ?? 0, tools ? 1 : 0);
      assert.equal(result.message.content, null);
      assert.ok(!JSON.stringify(result).includes(SECRET));
    }
  });
