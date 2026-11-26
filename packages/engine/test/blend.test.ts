import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { normalizeContext, type AssistantMessage, type CredentialStore } from '@earendil-works/pi-ai';
import { normalizePiUsage } from '@oms/core/usage';
import { BLEND_SIGN_IN, blendBaseUrl, blendModel, blendToken, registerBlend } from '../src/runtime/blend.ts';
import { createProviderControls } from '../src/runtime/provider-controls.ts';
import { createBudgetLedger } from '@oms/core';
import { createDispatchAllocator } from '@oms/core/dispatch';
import { createMeteredStream } from '../src/runtime/usage.ts';
import { describeRejection } from '../src/runtime/provider-rejection.ts';

const credentials: CredentialStore = {
  async read() {
    return undefined;
  },
  async list() {
    return [];
  },
  async modify() {
    throw Error('must not persist account tokens');
  },
  async delete() {},
};
const createRuntime = () =>
  ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
function response(cost: string | null = '0.000042') {
  const events = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    {
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14, prompt_tokens_details: { cached_tokens: 3 } },
    },
  ];
  return new Response(
    events.map((e) => `data: ${JSON.stringify({ ...e, model: 'upstream-real-model' })}\n\n`).join('') +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream', ...(cost === null ? {} : { 'x-blend-cost-usd': cost }) } },
  );
}
test('Blend endpoint defaults, loopback override and bearer source reuse OMS search credential', () => {
  const account = { searchCredential: () => ({ origin: 'https://barestate.xyz/oms', token: 'account-token' }) };
  assert.equal(blendBaseUrl({}), 'https://barestate.xyz/oms/blend/v1');
  assert.equal(blendBaseUrl({ OMS_BLEND_URL: 'http://127.0.0.1:8788/' }), 'http://127.0.0.1:8788/v1');
  assert.equal(blendToken(account, {}), 'account-token');
  assert.equal(blendToken(account, { OMS_BLEND_TOKEN: 'override' }), 'override');
  assert.equal(blendToken({ searchCredential: () => undefined }, {}), undefined);
  for (const url of ['http://remote.test/v1', 'https://user:pass@remote.test/v1', 'https://remote.test/v1?token=bad'])
    assert.throws(() => blendBaseUrl({ OMS_BLEND_URL: url }));
});
test('native Blend registration exposes conservative shipped models and forwards live token/session headers with authoritative final cost', async () => {
  const runtime = await createRuntime();
  let token = 'signed-in-token';
  registerBlend(
    runtime,
    { searchCredential: () => ({ origin: 'https://barestate.xyz/oms', token }) },
    'oms-session-123',
    {},
  );
  await runtime.refresh({ allowNetwork: false });
  const models = runtime.getModels('blend');
  assert.deepEqual(
    models.map((m) => m.id),
    ['blend-auto', 'blend-pro', 'blend-flash'],
  );
  const model = runtime.getModel('blend', 'blend-auto')!;
  assert.equal(model.api, 'openai-completions');
  assert.equal(model.contextWindow, 200000);
  assert.equal(model.maxTokens, 32000);
  assert.equal(runtime.getProvider('blend')!.name, 'Blend');
  for (const current of ['first-token', 'refreshed-token']) {
    token = current;
    let requests = 0;
    const stream = runtime.getProvider('blend')!.streamSimple!(
      model,
      normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }),
      {
        headers: { authorization: 'must-be-overridden', 'x-blend-session': 'wrong' },
        fetch: async (url, init) => {
          requests++;
          assert.equal(String(url), 'https://barestate.xyz/oms/blend/v1/chat/completions');
          const headers = new Headers(init?.headers);
          assert.equal(headers.get('authorization'), `Bearer ${current}`);
          assert.equal(headers.get('x-blend-session'), 'oms-session-123');
          assert.equal(JSON.parse(String(init?.body)).model, 'blend-auto');
          return response();
        },
      },
    );
    const message = await stream.result();
    assert.equal(requests, 1);
    assert.equal(message.stopReason, 'stop');
    assert.equal(message.responseModel, 'blend-auto');
    assert.equal(message.usage.cost.total, 0.000042);
    assert.deepEqual(normalizePiUsage(model, message.usage), { tokens: 14, spendMicroUsd: 42 });
  }
});
test('explicit token overrides account token on wire; missing or invalid cost receipt fails closed', async () => {
  const runtime = await createRuntime();
  registerBlend(
    runtime,
    { searchCredential: () => ({ origin: 'https://example.test', token: 'account' }) },
    'session',
    { OMS_BLEND_TOKEN: 'local-bench-token' },
  );
  await runtime.refresh({ allowNetwork: false });
  for (const cost of ['0.000001', null, '', 'NaN', '-1']) {
    const stream = runtime.getProvider('blend')!.streamSimple!(
      runtime.getModel('blend', 'blend-flash')!,
      normalizeContext({ messages: [] }),
      {
        fetch: async (_url, init) => {
          assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer local-bench-token');
          return response(cost);
        },
      },
    );
    const result = await stream.result();
    assert.equal(result.stopReason, cost === '0.000001' ? 'stop' : 'error');
  }
});
test('signed-out Blend refuses selection and inference with invited-account /login message and no HTTP', async () => {
  const runtime = await createRuntime();
  const blend = registerBlend(runtime, { searchCredential: () => undefined }, 'session', {});
  await runtime.refresh({ allowNetwork: false });
  const controls = createProviderControls({
    modelRuntime: runtime,
    session: { async setModel() {} },
    maxOutputTokens: 128,
    signal: new AbortController().signal,
    withUserOperation: (action) => action(),
    checkAuthFile() {},
    blend: { configured: () => false, ensureProfile: blend.ensureProfile },
  });
  await assert.rejects(controls.selectModel('blend', 'blend-auto'), { message: BLEND_SIGN_IN });
  assert.equal(controls.listModels().find((m) => m.provider === 'blend')?.detail, BLEND_SIGN_IN);
  const output = runtime.getProvider('blend')!.streamSimple!(
    runtime.getModel('blend', 'blend-auto')!,
    normalizeContext({ messages: [] }),
    {
      fetch: async () => {
        throw Error('must not fetch');
      },
    },
  );
  const result = await output.result();
  assert.equal(result.errorMessage, BLEND_SIGN_IN);
});
test('unknown profile is admitted only after authenticated server model discovery', async (t) => {
  const runtime = await createRuntime();
  const blend = registerBlend(runtime, { searchCredential: () => undefined }, 'oms-id', {
    OMS_BLEND_TOKEN: 'bench',
    OMS_BLEND_URL: 'http://localhost:8788/v1',
  });
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(url, 'http://localhost:8788/v1/models');
    assert.equal(new Headers(init?.headers).get('x-blend-session'), 'oms-id');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer bench');
    return Response.json({ data: [{ id: 'claude-haiku-5-5' }, { id: 'mimo-v2.6-flash' }, { id: 'bad name' }] });
  };
  await blend.ensureProfile('claude-haiku-5-5');
  assert.ok(runtime.getModel('blend', 'claude-haiku-5-5'));
  assert.ok(runtime.getModel('blend', 'mimo-v2.6-flash'));
  assert.equal(runtime.getModel('blend', 'bad name'), undefined);
  await blend.ensureProfile('claude-haiku-5-5');
  assert.equal(requests, 1);
  await assert.rejects(blend.ensureProfile('not-listed'), /Unknown Blend profile/);
  globalThis.fetch = async () => new Response('private error detail', { status: 403 });
  await assert.rejects(blend.ensureProfile('unavailable'), /Unable to list Blend profiles/);
});
test('authoritative receipt bypasses estimates only for Blend; invalid usage still rejected', () => {
  const model = blendModel('blend-pro', 'https://example.test/v1');
  const usage: AssistantMessage['usage'] = {
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 12,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0000011 },
  };
  assert.deepEqual(normalizePiUsage(model, usage), { tokens: 12, spendMicroUsd: 2 });
  assert.ok(normalizePiUsage({ ...model, provider: 'other' }, usage)!.spendMicroUsd > 2);
  assert.equal(normalizePiUsage(model, { ...usage, totalTokens: 13 }), null);
  assert.equal(normalizePiUsage(model, { ...usage, cost: { ...usage.cost, total: -1 } }), null);
});
test('signed-out or expired Blend auth is checked before any budget reservation or dispatch', async () => {
  let writes = 0;
  const ledger = createBudgetLedger({
    caps: { tokens: 1000000, spendMicroUsd: 10000000, wallClockMs: 60000 },
    clock: Date.now,
    persist() {
      writes++;
    },
  });
  const before = writes;
  const stream = createMeteredStream({
    ledger,
    maxOutputTokens: 128,
    allocate: createDispatchAllocator(),
    logicalTurnId: () => 'turn',
    providerAvailability: () => BLEND_SIGN_IN,
    streamFunction() {
      throw Error('must not dispatch');
    },
  });
  const source = await stream(blendModel('blend-auto', 'https://example.test/v1'), normalizeContext({ messages: [] }));
  const result = await source.result();
  assert.equal(result.errorMessage, BLEND_SIGN_IN);
  assert.equal(writes, before);
  for (const status of [401, 403]) assert.match(describeRejection('blend', status, 'private body'), /invited.*\/login/);
});
for (const sample of [
  { name: 'reported failure usage', cost: 0.0001234, input: 20, cached: 2, valid: true },
  { name: 'empty pre-dispatch usage', cost: 0, input: 0, cached: 0, valid: true },
  { name: 'invalid receipt counts', cost: 0.0001234, input: 20, cached: 21, valid: false },
])
  test(`Blend HTTP failure receipt: ${sample.name}`, async (t) => {
    const runtime = await createRuntime();
    registerBlend(runtime, { searchCredential: () => undefined }, 'settled-session', { OMS_BLEND_TOKEN: 'bench' });
    await runtime.refresh({ allowNetwork: false });
    const model = runtime.getModel('blend', 'blend-flash')!;
    const ledger = createBudgetLedger({
      caps: { tokens: 1000000, spendMicroUsd: 10000000, wallClockMs: 60000 },
      clock: Date.now,
      persist() {},
    });
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json(
        { error: { message: 'Upstream request failed.', type: 'upstream_error', code: 502 } },
        {
          status: 502,
          headers: {
            'x-blend-cost-usd': String(sample.cost),
            'x-blend-receipt': 'settled',
            'x-blend-usage': JSON.stringify({ input: sample.input, cached: sample.cached, output: 0 }),
          },
        },
      ),
    );
    const stream = createMeteredStream({
      ledger,
      maxOutputTokens: 128,
      allocate: createDispatchAllocator(),
      logicalTurnId: () => 'settled-turn',
      streamFunction: runtime.getProvider('blend')!.streamSimple!,
    });
    const source = await stream(
      model,
      normalizeContext({ messages: [{ role: 'user', content: 'test', timestamp: 1 }] }),
    );
    const result = await source.result();
    assert.equal(result.stopReason, 'error');
    if (sample.valid) {
      assert.equal(result.usage.cost.total, sample.cost);
      assert.equal(ledger.snapshot().accounting, 'known');
      assert.equal(ledger.snapshot().used.spendMicroUsd, Math.ceil(sample.cost * 1e6));
      assert.equal(ledger.snapshot().used.tokens, sample.input);
    } else assert.ok(ledger.snapshot().accounting !== 'known' || ledger.snapshot().used.spendMicroUsd > 124);
  });
