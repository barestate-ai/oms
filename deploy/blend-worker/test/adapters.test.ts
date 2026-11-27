import assert from 'node:assert/strict';
import test from 'node:test';
import { anthropicBody, callUpstream, chatUsage, ENDPOINTS } from '../src/core/adapters.ts';
import { parseInput } from '../src/core/input.ts';
import { modelSpec } from '../src/core/pricing.ts';
import { BlendError } from '../src/core/types.ts';
import type { Usage } from '../src/core/types.ts';
import { anthropicData, anthropicStream, call, chatData, chatStream, input, SECRET, sse, tool } from './fixtures.ts';

const models = [
  'claude-fable-5-2',
  'claude-haiku-5-5',
  'grok-4.3',
  'mimo-v2.6-flash',
  'muse-ember-1.0',
  'muse-spark-1.3-contributor',
];
for (const model of models)
  for (const stream of [false, true]) {
    test(`${model} ${stream ? 'stream' : 'JSON'} translates tools, usage, auth and reasoning`, async () => {
      const provider = modelSpec(model).provider;
      const body = input(stream);
      body.messages.push(
        { role: 'assistant', content: 'visible', tool_calls: [call] },
        { role: 'tool', content: 'file content', tool_call_id: call.id },
      );
      const before = structuredClone(body);
      const usages: Usage[] = [];
      const result = await callUpstream(model, body, {
        key: SECRET,
        session: 'stable-session',
        signal: new AbortController().signal,
        onUsage: (u) => usages.push(u),
        fetch: async (url, init) => {
          assert.equal(url, ENDPOINTS[provider]);
          const headers = new Headers(init?.headers);
          const sent = JSON.parse(String(init?.body));
          assert.equal(sent.stream, stream);
          assert.equal(sent.model, model);
          if (provider === 'anthropic') {
            assert.equal(headers.get('x-api-key'), SECRET);
            assert.equal(headers.get('anthropic-version'), '2023-06-01');
            assert.equal(sent.max_tokens, 1024);
            assert.equal(sent.messages.at(-1).content[0].type, 'tool_result');
            assert.equal(sent.messages.at(-2).content[1].type, 'tool_use');
            assert.equal(sent.tools[0].input_schema.type, 'object');
            assert.deepEqual(sent.system[0].cache_control, { type: 'ephemeral', ttl: '5m' });
            assert.equal(sent.messages.at(-1).content.at(-1).cache_control.type, 'ephemeral');
            assert.equal(sent.messages.at(-2).content.at(-1).cache_control.type, 'ephemeral');
            return stream ? anthropicStream() : Response.json(anthropicData());
          }
          assert.equal(headers.get('authorization'), `Bearer ${SECRET}`);
          assert.equal(sent.max_completion_tokens, 1024);
          assert.equal(sent.messages.at(-1).role, 'tool');
          assert.equal(sent.tools[0].function.name, 'read_file');
          if (provider === 'muse') assert.equal(sent.store, false);
          if (provider === 'opencode-go') {
            assert.equal(headers.get('x-opencode-session'), 'stable-session');
            assert.match(headers.get('user-agent')!, /coding-agent/);
          }
          if (stream) assert.equal(sent.stream_options.include_usage, true);
          return stream ? chatStream() : Response.json(chatData('ok', true));
        },
      });
      assert.deepEqual(result.message.tool_calls, [call]);
      assert.equal(result.finishReason, 'tool_calls');
      assert.equal(result.usage.input, provider === 'anthropic' ? 130 : 100);
      assert.equal(result.usage.cached, 20);
      assert.equal(result.usage.output, provider === 'anthropic' ? 40 : 30);
      assert.deepEqual(usages.at(-1), result.usage);
      assert.equal(JSON.stringify(result).includes(SECRET), false);
      assert.deepEqual(body, before);
      if (stream)
        assert.equal(
          result.deltas
            .flatMap((d) => d.tool_calls ?? [])
            .map((c) => c.function?.arguments ?? '')
            .join(''),
          call.function.arguments,
        );
    });
    test(`${model} ${stream ? 'stream' : 'JSON'} upstream errors are sanitized`, async () => {
      await assert.rejects(
        callUpstream(model, input(stream), {
          key: SECRET,
          session: 's',
          signal: new AbortController().signal,
          onUsage: () => {},
          fetch: async () => new Response(SECRET, { status: 429 }),
        }),
        (e) => e instanceof BlendError && e.status === 429 && !e.message.includes(SECRET),
      );
    });
  }
test('cross-provider transcripts discard reasoning fields and blocks', async () => {
  const value = parseInput({
    model: 'single',
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
      {
        role: 'assistant',
        reasoning_content: SECRET,
        thinking: SECRET,
        content: [
          { type: 'thinking', thinking: SECRET },
          { type: 'text', text: 'visible' },
        ],
        tool_calls: [{ ...call, reasoning: SECRET }],
      },
      { role: 'tool', tool_call_id: call.id, content: 'result' },
    ],
    tools: [tool],
    max_tokens: 5,
    max_completion_tokens: 7,
  });
  assert.equal(value.maxTokens, 7);
  assert.equal(JSON.stringify(value).includes(SECRET), false);
  assert.equal(JSON.stringify(anthropicBody(value, 'claude-haiku-5-5')).includes(SECRET), false);
  assert.equal(
    parseInput({ model: 's', messages: [{ role: 'assistant', content: `<think>${SECRET}</think>ok` }] }).messages[0]
      ?.content,
    'ok',
  );
});
test('Anthropic tool-choice translation and invalid JSON arguments', () => {
  const body = input();
  body.toolChoice = { type: 'function', function: { name: 'read_file' } };
  assert.deepEqual(anthropicBody(body, 'm').tool_choice, { type: 'tool', name: 'read_file' });
  body.toolChoice = 'required';
  assert.deepEqual(anthropicBody(body, 'm').tool_choice, { type: 'any' });
  body.messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [{ ...call, function: { ...call.function, arguments: 'not JSON' } }],
  });
  assert.throws(
    () => anthropicBody(body, 'm'),
    (e) => e instanceof BlendError && e.status === 400,
  );
});
test('xAI additive reasoning is charged once, inclusive reasoning is not duplicated', () => {
  assert.equal(
    chatUsage({ prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 20, total_tokens: 35 }).output,
    25,
  );
  assert.equal(
    chatUsage({
      prompt_tokens: 10,
      completion_tokens: 25,
      completion_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 35,
    }).output,
    25,
  );
  assert.throws(() =>
    chatUsage({ prompt_tokens: 2, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 3 } }),
  );
});
for (const provider of ['chat', 'anthropic'])
  test(`${provider} rejects malformed, empty, missing-usage and truncated streams`, async () => {
    const model = provider === 'chat' ? 'grok-4.3' : 'claude-haiku-5-5';
    for (const response of [
      new Response(''),
      new Response(SECRET),
      sse([{ error: { message: SECRET } }]),
      sse(['[DONE]']),
      sse([{ type: 'message_start', message: { usage: { input_tokens: 1 } } }]),
    ]) {
      await assert.rejects(
        callUpstream(model, input(true), {
          key: SECRET,
          session: 's',
          signal: new AbortController().signal,
          onUsage: () => {},
          fetch: async () => response,
        }),
        (e) => e instanceof BlendError && !e.message.includes(SECRET),
      );
    }
  });
test('embedded thinking split across SSE chunks cannot leak to a different provider', async () => {
  const response = sse([
    { choices: [{ delta: { content: '<think>PRIVATE' } }] },
    { choices: [{ delta: { content: '</think>ok' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    '[DONE]',
  ]);
  const result = await callUpstream('grok-4.3', input(true), {
    key: SECRET,
    session: 's',
    signal: new AbortController().signal,
    onUsage: () => {},
    fetch: async () => response,
  });
  assert.equal(result.message.content, 'ok');
  assert.deepEqual(result.deltas, [{ content: 'ok' }]);
});
test('network exceptions and absent credentials never expose upstream details', async () => {
  for (const key of [SECRET, undefined])
    await assert.rejects(
      callUpstream('grok-4.3', input(), {
        key,
        session: 's',
        signal: new AbortController().signal,
        onUsage: () => {},
        fetch: async () => {
          throw Error(SECRET);
        },
      }),
      (e) => e instanceof BlendError && !e.message.includes(SECRET),
    );
});
