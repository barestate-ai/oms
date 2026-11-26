import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { executePolicy, looksFailed, sessionKey, validateProfiles } from '../src/core/policies.ts';
import { MemorySessions } from '../src/core/sessions.ts';
import { BlendError } from '../src/core/types.ts';
import type { ChatInput, Completion, Policy, SessionState } from '../src/core/types.ts';
import { call, completion, input, request } from './fixtures.ts';

const cheap = 'mimo-v2.6-flash',
  strong = 'claude-haiku-5-5';
const state = (): SessionState => ({ escalated: {}, labels: {}, executorTurns: {}, orchestrations: {} });
function recorder() {
  const models: string[] = [];
  return {
    models,
    invoke: async (model: string) => {
      models.push(model);
      return completion();
    },
  };
}
const toolResult = (content: string) => ({ role: 'tool' as const, tool_call_id: 't', content });

test('default JSON profiles validate; Contributor is explicit single-profile opt-in only', async () => {
  const profiles = validateProfiles(JSON.parse(await readFile(new URL('../profiles.json', import.meta.url), 'utf8')));
  assert.equal(Object.entries(profiles).filter(([id, p]) => p.type === 'single' && id === p.model).length, 16);
  assert.deepEqual(profiles['blend-ember-fable'], {
    type: 'escalate',
    cheap: 'muse-ember-1.0',
    strong: 'claude-fable-5-2',
    trigger: { tool_failures: 2, retry_on_error_or_empty: true },
  });
  assert.deepEqual(profiles['blend-auto'], profiles['checkpoint-fable-mimo']);
  assert.deepEqual(profiles['blend-pro'], { type: 'single', model: 'claude-fable-5-2' });
  assert.deepEqual(profiles['blend-flash'], profiles['checkpoint-fable-glm']);
  assert.deepEqual(profiles['muse-spark-1.3-contributor'], { type: 'single', model: 'muse-spark-1.3-contributor' });
  assert.equal(
    JSON.stringify(Object.values(profiles).filter((p) => p.type !== 'single')).includes('contributor'),
    false,
  );
});
test('single policy always selects exactly one model', async () => {
  const r = recorder();
  await executePolicy({ type: 'single', model: cheap }, state(), input(), r.invoke);
  assert.deepEqual(r.models, [cheap]);
});
test('tool failures escalate at threshold and remain sticky with truncated/new history', async () => {
  const p: Policy = { type: 'escalate', cheap, strong, trigger: { tool_failures: 2 } };
  const s = state(),
    r = recorder(),
    body = input();
  body.messages.push(toolResult('error: tests failed'));
  await executePolicy(p, s, body, r.invoke);
  body.messages.push({ role: 'assistant', content: 'retry' }, toolResult('{"exit_code":1}'));
  await executePolicy(p, s, body, r.invoke);
  await executePolicy(p, s, input(), r.invoke);
  assert.deepEqual(r.models, [cheap, strong, strong]);
});
test('successful intervening tools reset consecutive-failure count', async () => {
  const r = recorder(),
    body = input();
  body.messages.push(toolResult('error'), toolResult('0 errors; 0 failed'), toolResult('exit code 1'));
  await executePolicy({ type: 'escalate', cheap, strong, trigger: { tool_failures: 2 } }, state(), body, r.invoke);
  assert.deepEqual(r.models, [cheap]);
});
test('assistant-turn threshold uses transcript assistant count', async () => {
  const r = recorder(),
    s = state(),
    p: Policy = { type: 'escalate', cheap, strong, trigger: { assistant_turns: 2 } },
    body = input();
  body.messages.push({ role: 'assistant', content: 'one' });
  await executePolicy(p, s, body, r.invoke);
  body.messages.push({ role: 'assistant', content: 'two' });
  await executePolicy(p, s, body, r.invoke);
  assert.deepEqual(r.models, [cheap, strong]);
});
for (const mode of ['error', 'empty'])
  test(`optional ${mode} retry uses identical input on strong and stays strong`, async () => {
    const s = state(),
      body = input(),
      models: string[] = [];
    const invoke = async (model: string, sent: ChatInput) => {
      assert.equal(sent, body);
      models.push(model);
      if (model === cheap) {
        if (mode === 'error') throw new BlendError(502, 'Upstream request failed.');
        return completion('  ');
      }
      return completion();
    };
    const p: Policy = { type: 'escalate', cheap, strong, trigger: { retry_on_error_or_empty: true } };
    await executePolicy(p, s, body, invoke);
    await executePolicy(p, s, body, invoke);
    assert.deepEqual(models, [cheap, strong, strong]);
  });
test('empty/tool-call distinction and disabled/error-validation retry', async () => {
  const p: Policy = { type: 'escalate', cheap, strong, trigger: { retry_on_error_or_empty: true } };
  const c = completion(null);
  c.message.tool_calls = [call];
  let n = 0;
  await executePolicy(p, state(), input(), async () => {
    n++;
    return c;
  });
  assert.equal(n, 1);
  await assert.rejects(
    executePolicy({ ...p, trigger: {} }, state(), input(), async () => {
      throw new BlendError(502, 'safe');
    }),
  );
  await assert.rejects(
    executePolicy(p, state(), input(), async () => {
      throw new BlendError(400, 'invalid', 'invalid_request_error');
    }),
  );
});
test('plan-exec routes new user calls to planner and periodically replans after N executor turns', async () => {
  const p: Policy = { type: 'plan-exec', planner: strong, executor: cheap, replan_every: 2 };
  const s = state(),
    r = recorder(),
    body = input();
  await executePolicy(p, s, body, r.invoke);
  body.messages.push(toolResult('result'));
  for (let i = 0; i < 4; i++) await executePolicy(p, s, body, r.invoke);
  body.messages.push({ role: 'user', content: 'new task' });
  await executePolicy(p, s, body, r.invoke);
  assert.deepEqual(r.models, [strong, cheap, cheap, strong, cheap, strong]);
});
for (const label of ['easy', 'medium', 'hard', 'invalid'])
  test(`classifier ${label} is sticky, sees only first user and falls back hard for invalid output`, async () => {
    const s = state(),
      seen: string[] = [];
    const p: Policy = {
      type: 'classify',
      classifier: cheap,
      routes: { easy: cheap, medium: strong, hard: 'grok-4.3' },
    };
    const body = input();
    body.messages.push({ role: 'user', content: 'later user' });
    const invoke = async (model: string, sent: ChatInput): Promise<Completion> => {
      seen.push(model);
      if (seen.length === 1) {
        assert.equal(sent.stream, false);
        assert.equal(sent.tools, undefined);
        assert.equal(sent.messages[1]?.content, 'Read src/lib.rs');
        return completion(label);
      }
      return completion();
    };
    await executePolicy(p, s, body, invoke);
    await executePolicy(p, s, body, invoke);
    const target = label === 'easy' ? cheap : label === 'medium' ? strong : 'grok-4.3';
    assert.deepEqual(seen, [cheap, target, target]);
  });
test('classifier failure does not silently route or stick a label', async () => {
  const s = state();
  await assert.rejects(
    executePolicy(
      { type: 'classify', classifier: cheap, routes: { easy: cheap, medium: cheap, hard: strong } },
      s,
      input(),
      async () => {
        throw new BlendError(502, 'safe');
      },
    ),
  );
  assert.deepEqual(s.labels, {});
});
test('nested policy combinations preserve separate state paths', async () => {
  const r = recorder();
  const p: Policy = {
    type: 'classify',
    classifier: cheap,
    routes: { easy: cheap, medium: cheap, hard: { type: 'escalate', cheap, strong, trigger: { assistant_turns: 1 } } },
  };
  const body = input();
  body.messages.push({ role: 'assistant', content: 'prior' });
  await executePolicy(p, state(), body, async (model) => {
    r.models.push(model);
    return completion(model === cheap ? 'hard' : 'ok');
  });
  assert.deepEqual(r.models, [cheap, strong]);
});
test('failure heuristic distinguishes zero exits, failing tests and structured errors', () => {
  for (const text of [
    'error: command failed',
    'exit_code: 2',
    'failing tests',
    '{"exitCode":1}',
    '{"exit_code":0,"stdout":"tests failed"}',
    '{"error":"boom"}',
  ])
    assert.equal(looksFailed(text), true, text);
  for (const text of [
    null,
    '',
    'all tests passed',
    '0 errors, 0 failures',
    '{"exit_code":0}',
    '{"error":null}',
    '{"exit_code":0,"stderr":""}',
  ])
    assert.equal(looksFailed(text), false, text ?? 'null');
});
test('session keys use explicit header or framed first system+user hash', async () => {
  const a = input(),
    b = input();
  b.messages.push(toolResult('later'));
  const key = await sessionKey(request(), a);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(await sessionKey(request(), b), key);
  assert.equal(await sessionKey(request({}, 'explicit'), b), 'explicit');
  b.messages[1]!.content = 'different';
  assert.notEqual(await sessionKey(request(), b), key);
});
test('memory sessions serialize concurrent operations, isolate sessions and recover after errors', async () => {
  const sessions = new MemorySessions(),
    order: string[] = [];
  const jobs = [1, 2].map((n) =>
    sessions.run('same', async (s) => {
      order.push(`start${n}`);
      await Promise.resolve();
      s.executorTurns.x = (s.executorTurns.x ?? 0) + 1;
      order.push(`end${n}`);
      return s.executorTurns.x;
    }),
  );
  assert.deepEqual(await Promise.all(jobs), [1, 2]);
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2']);
  await assert.rejects(
    sessions.run('same', async () => {
      throw Error('expected');
    }),
  );
  assert.equal(await sessions.run('same', async (s) => s.executorTurns.x), 2);
  assert.equal(await sessions.run('other', async (s) => s.executorTurns.x), undefined);
});
test('profile validation rejects invalid models, thresholds, routes, names and recursive cycles', () => {
  for (const p of [
    {},
    { a: { type: 'single', model: 'unknown' } },
    { a: { type: 'escalate', cheap, strong, trigger: { tool_failures: 0 } } },
    { a: { type: 'plan-exec', planner: cheap, executor: strong, replan_every: -1 } },
    { a: { type: 'classify', classifier: cheap, routes: { easy: cheap } } },
    { 'bad name': { type: 'single', model: cheap } },
  ])
    assert.throws(() => validateProfiles(p));
  const cyclic: Record<string, unknown> = { type: 'plan-exec', executor: cheap };
  cyclic.planner = cyclic;
  assert.throws(() => validateProfiles({ a: cyclic }));
});
