import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import {
  BYTES_PER_TOKEN,
  createContextTrimmer,
  CONTEXT_TRIM_KEEP,
  CONTEXT_TRIM_START,
  CONTEXT_TRIM_TARGET,
} from '../src/runtime/context-trim.ts';
import { createHarnessFixture } from '../test-support/runtime-fixture.ts';
import { createHarnessSession, type HarnessSession } from '../src/runtime/session.ts';

const CAP = 131_072;
const CAP_TOKENS = Math.ceil(CAP / BYTES_PER_TOKEN);
const call = (n: number) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id: `c${n}`, name: 'bash', arguments: { command: `step ${n}` } }],
});
const result = (n: number, bytes: number, id = `c${n}`) => ({
  role: 'toolResult',
  toolName: 'bash',
  toolCallId: id,
  isError: false,
  content: [{ type: 'text', text: `result-${n}-body ${'x'.repeat(bytes)}` }],
});
const transcript = (count: number, bytes: number) => [
  { role: 'user', content: 'go' },
  ...Array.from({ length: count }, (_, n) => [call(n), result(n, bytes)]).flat(),
];
const size = (messages: unknown[]) => Buffer.byteLength(JSON.stringify(messages));

test('between the target and the trim start a fresh session sends the context unchanged', () => {
  const messages = transcript(5, 12_000);
  assert.ok(size(messages) > CAP * CONTEXT_TRIM_TARGET && size(messages) < CAP * CONTEXT_TRIM_START);
  assert.equal(createContextTrimmer(() => CAP_TOKENS)(messages), messages);
});

test('past the trim start the oldest tool results become stubs until the context is under the target; the newest results and every call stay', () => {
  const messages = transcript(10, 12_000);
  assert.ok(size(messages) > CAP * CONTEXT_TRIM_START);
  const sent = createContextTrimmer(() => CAP_TOKENS)(messages);
  assert.ok(size(sent) <= CAP * CONTEXT_TRIM_TARGET, `trimmed to ${size(sent)}`);
  assert.equal(sent.length, messages.length, 'no message is dropped, so every tool call keeps its result');
  const text = JSON.stringify(sent);
  assert.match(text, /earlier bash result removed to fit the context limit/);
  assert.doesNotMatch(text, /result-0-body/);
  for (let n = 10 - CONTEXT_TRIM_KEEP; n < 10; n++) assert.match(text, new RegExp(`result-${n}-body`));
  for (let n = 0; n < 10; n++) assert.match(text, new RegExp(`step ${n}`));
  assert.ok(
    sent.every(
      (m, i) => (m as { toolCallId?: string }).toolCallId === (messages[i] as { toolCallId?: string }).toolCallId,
    ),
  );
});

test('stubs only grow: after a trim, a call back under the trim start keeps the same stubs, so the prompt prefix is stable', () => {
  const trim = createContextTrimmer(() => CAP_TOKENS);
  const messages = transcript(10, 12_000);
  const first = trim(messages);
  const later = [...messages, call(10), result(10, 10_000)];
  const next = trim(later);
  assert.ok(size(next) < CAP * CONTEXT_TRIM_START, 'the second call alone would not start a trim');
  assert.deepEqual(next.slice(0, first.length), first);
});

test('tool-result details are not sent to the provider, so they neither start a trim nor stay on a stub', () => {
  const messages = transcript(4, 1_000).map((m) =>
    m.role === 'toolResult' ? { ...m, details: { copy: 'd'.repeat(30_000) } } : m,
  );
  assert.ok(size(messages) > CAP * CONTEXT_TRIM_START);
  assert.equal(createContextTrimmer(() => CAP_TOKENS)(messages), messages);
  const big = transcript(10, 12_000).map((m) =>
    m.role === 'toolResult' ? { ...m, details: { copy: 'd'.repeat(12_000) } } : m,
  );
  const sent = createContextTrimmer(() => CAP_TOKENS)(big) as Array<{
    role?: string;
    details?: unknown;
    content: unknown;
  }>;
  const results = sent.filter((m) => m.role === 'toolResult');
  const stubbed = results.filter((m) => /removed to fit the context limit/.test(JSON.stringify(m.content)));
  assert.ok(stubbed.length > 0);
  assert.ok(
    stubbed.every((m) => m.details === undefined),
    'a stub carries no details',
  );
  assert.ok(
    results.filter((m) => !stubbed.includes(m)).every((m) => m.details !== undefined),
    'a full result keeps its details',
  );
});

test('a web_fetch stub is left as it is, so it still names the URL to fetch again', () => {
  const fetchStub = {
    role: 'toolResult',
    toolName: 'web_fetch',
    toolCallId: 'f0',
    isError: false,
    content: [
      {
        type: 'text',
        text: '[earlier web_fetch of https://docs.example/p1 removed to fit the context limit; call web_fetch again to reread it]',
      },
    ],
  };
  const messages = [{ role: 'user', content: 'go' }, fetchStub, ...transcript(10, 12_000).slice(1)];
  assert.match(
    JSON.stringify(createContextTrimmer(() => CAP_TOKENS)(messages)),
    /web_fetch of https:\/\/docs\.example\/p1/,
  );
});

test('the newest results are stubbed too when they alone exceed the cap, keeping their call ids', () => {
  const messages = transcript(2, 140_000);
  assert.ok(size(messages) > CAP * CONTEXT_TRIM_START);
  const sent = createContextTrimmer(() => CAP_TOKENS)(messages) as typeof messages;
  assert.equal(sent.length, messages.length, 'no message is dropped, so every tool call keeps its result');
  for (const [m, id] of [
    [sent[2]!, 'c0'],
    [sent[4]!, 'c1'],
  ] as const) {
    assert.equal((m as { toolCallId?: string }).toolCallId, id, 'the stub keeps its call id for a smaller re-read');
    assert.match(JSON.stringify(m.content), /removed to fit the context limit; run the tool again on a smaller range/);
  }
  assert.doesNotMatch(JSON.stringify(sent), /result-\d-body/);
});

test('the newest results are kept in full while they fit the budget', () => {
  const messages = transcript(2, 30_000);
  assert.equal(createContextTrimmer(() => CAP_TOKENS)(messages), messages);
});

test('the cap is a token count converted once: the same context that trims at a window of N tokens is left alone at a window 3x larger', () => {
  const messages = transcript(10, 12_000);
  assert.ok(size(messages) > CAP * CONTEXT_TRIM_START);
  assert.notEqual(createContextTrimmer(() => CAP_TOKENS)(messages), messages);
  assert.equal(createContextTrimmer(() => CAP_TOKENS * BYTES_PER_TOKEN)(messages), messages);
});

test('the cap is read per call: a window change moves the threshold, earlier stubs survive, and no window means no trimming', () => {
  let cap: number | undefined = CAP_TOKENS;
  const trim = createContextTrimmer(() => cap);
  const messages = transcript(10, 12_000);
  const first = trim(messages);
  cap = CAP_TOKENS * 10;
  assert.deepEqual(trim(messages), first, 'a larger window keeps the stubs already sent');
  cap = undefined;
  assert.equal(createContextTrimmer(() => cap)(messages), messages);
});

test(
  'a capped session never sends the model more than the trim start of messages; the session transcript keeps every result',
  { timeout: 60_000 },
  async () => {
    const f = await createHarnessFixture({
      backend: 'host',
      binary: process.env.SURFPOOL_BINARY ?? join(homedir(), '.local/bin/surfpool'),
      image: '',
      forwarderImage: '',
    });
    let harness: HarnessSession | undefined;
    try {
      for (let n = 0; n < 10; n++)
        writeFileSync(join(f.task.codeRoot, `big${n}.txt`), `result-${n}-body ${'x'.repeat(14_000)}\n`);
      harness = await createHarnessSession({
        ...f.options,
        modelRuntime: f.modelRuntime,
        model: f.model,
        // The cap is enforced on serialized bytes (one byte can be one token), so CAP bytes of
        // message budget asks for CAP input tokens; the measured prompt and fixed overhead share it.
        maxInputTokens: CAP,
        caps: { ...f.caps, tokens: 2_000_000 },
      });
      let sent = '';
      f.faux.setResponses([
        ...Array.from({ length: 10 }, (_, n) =>
          fauxAssistantMessage(fauxToolCall('read', { path: `big${n}.txt` }), { stopReason: 'toolUse' }),
        ),
        (context) => {
          sent = JSON.stringify(context.messages);
          return fauxAssistantMessage('Done.');
        },
      ]);
      await harness.session.prompt('Read the ten files.');
      // The faux provider adds the system prompt to the messages; the hook (and so the trimmer) never sees it.
      const messages = Buffer.byteLength(
        JSON.stringify(JSON.parse(sent).filter((m: { role: string }) => m.role !== 'system')),
      );
      assert.ok(messages <= CAP * CONTEXT_TRIM_START, `sent ${messages} bytes of messages`);
      assert.doesNotMatch(sent, /result-0-body/);
      assert.match(sent, /earlier read result removed to fit the context limit/);
      assert.match(sent, /result-9-body/);
      const kept = JSON.stringify(harness.session.messages);
      for (let n = 0; n < 10; n++)
        assert.match(kept, new RegExp(`result-${n}-body`), 'the session transcript keeps every result');
    } finally {
      await harness?.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  },
);

test('an interactive session with no input cap trims by the live model window', { timeout: 60_000 }, async () => {
  const f = await createHarnessFixture({
    backend: 'host',
    binary: process.env.SURFPOOL_BINARY ?? join(homedir(), '.local/bin/surfpool'),
    image: '',
    forwarderImage: '',
  });
  let harness: HarnessSession | undefined;
  try {
    for (let n = 0; n < 6; n++)
      writeFileSync(join(f.task.codeRoot, `big${n}.txt`), `result-${n}-body ${'x'.repeat(4_000)}\n`);
    harness = await createHarnessSession({
      ...f.options,
      modelRuntime: f.modelRuntime,
      model: f.model,
      caps: { ...f.caps, tokens: 2_000_000 },
    });
    assert.ok(
      f.model.contextWindow * BYTES_PER_TOKEN * CONTEXT_TRIM_START < 6 * 4_000,
      'the fixture window is small enough to trim',
    );
    let sent = '';
    f.faux.setResponses([
      ...Array.from({ length: 6 }, (_, n) =>
        fauxAssistantMessage(fauxToolCall('read', { path: `big${n}.txt` }), { stopReason: 'toolUse' }),
      ),
      (context) => {
        sent = JSON.stringify(context.messages);
        return fauxAssistantMessage('Done.');
      },
    ]);
    await harness.session.prompt('Read the six files.');
    assert.doesNotMatch(sent, /result-0-body/);
    assert.match(sent, /earlier read result removed to fit the context limit/);
    assert.match(sent, /result-5-body/);
  } finally {
    await harness?.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('old assistant reasoning is trimmed with the tool results, and its paired item ids go with it, while calls and arguments stay', () => {
  const sig = (n: number) =>
    JSON.stringify({ type: 'reasoning', id: `rs_${n}`, encrypted_content: 'e'.repeat(12_000) });
  const thinkingCall = (n: number) => ({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'plan', thinkingSignature: sig(n) },
      { type: 'toolCall', id: `c${n}|fc_${n}`, name: 'bash', arguments: { command: `step ${n}` } },
    ],
  });
  const messages = [
    { role: 'user', content: 'go' },
    ...Array.from({ length: 10 }, (_, n) => [thinkingCall(n), result(n, 200, `c${n}|fc_${n}`)]).flat(),
  ];
  assert.ok(size(messages) > CAP * CONTEXT_TRIM_START, 'reasoning alone passes the trim start');
  const sent = createContextTrimmer(() => CAP_TOKENS)(messages) as typeof messages;
  assert.ok(size(sent) <= CAP * CONTEXT_TRIM_TARGET, `trimmed to ${size(sent)}`);
  assert.equal(sent.length, messages.length);
  const first = sent[1] as { content: Array<{ type: string; id?: string }> };
  assert.deepEqual(
    first.content.map((b) => b.type),
    ['toolCall'],
  );
  assert.equal(first.content[0]!.id, 'c0');
  const last = sent[sent.length - 2] as { content: Array<{ type: string; id?: string }> };
  assert.deepEqual(
    last.content.map((b) => b.type),
    ['thinking', 'toolCall'],
    'the newest reasoning is kept',
  );
  assert.equal(last.content[1]!.id, 'c9|fc_9');
  assert.equal((sent[2] as { toolCallId: string }).toolCallId, 'c0', 'the result of a renamed call is renamed with it');
  assert.equal((sent[sent.length - 1] as { toolCallId: string }).toolCallId, 'c9|fc_9');
  for (let n = 0; n < 10; n++) assert.match(JSON.stringify(sent), new RegExp(`step ${n}`));
});

test('after forgetReasoning, every message sent so far goes without reasoning and with renamed ids; newer messages keep theirs', () => {
  const sig = (n: number) => JSON.stringify({ type: 'reasoning', id: `rs_${n}`, encrypted_content: 'e' });
  const step = (n: number) => [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'p', thinkingSignature: sig(n) },
        { type: 'toolCall', id: `c${n}|fc_${n}`, name: 'bash', arguments: { command: `step ${n}` } },
      ],
    },
    result(n, 10, `c${n}|fc_${n}`),
  ];
  const trim = createContextTrimmer(() => CAP_TOKENS);
  const before = [{ role: 'user', content: 'go' }, ...step(0), ...step(1)];
  assert.equal(trim(before), before, 'small context: unchanged');
  trim.forgetReasoning();
  const after = trim(before) as Array<{ content?: Array<{ type: string; id?: string }>; toolCallId?: string }>;
  assert.equal(JSON.stringify(after).includes('thinkingSignature'), false);
  assert.equal(after[1]!.content![0]!.id, 'c0');
  assert.equal(after[4]!.toolCallId, 'c1');
  const later = trim([...before, ...step(2)]) as typeof after;
  assert.deepEqual(
    later[5]!.content!.map((b) => b.type),
    ['thinking', 'toolCall'],
    'a message after the rejection keeps its reasoning',
  );
  assert.equal(later[6]!.toolCallId, 'c2|fc_2');
});
