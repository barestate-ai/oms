import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { executePolicy, validateProfiles } from '../src/core/policies.ts';
import { handle } from '../src/core/handle.ts';
import type { ChatInput, Completion, Policy, SessionState } from '../src/core/types.ts';
import { completion, input, call, dependencies, request, chatData } from './fixtures.ts';

const planner = 'muse-wonder-1.0',
  worker = 'muse-ember-1.0',
  validator = 'grok-4.7',
  repair = 'claude-opus-5-5';
const policy: Extract<Policy, { type: 'orchestrate' }> = {
  type: 'orchestrate',
  planners: [planner],
  worker,
  validator,
  repair,
};
const state = (): SessionState => ({ escalated: {}, labels: {}, executorTurns: {}, orchestrations: {} });
function fixture(answers: Record<string, Array<Completion | Error>> = {}) {
  const calls: Array<{ model: string; body: ChatInput }> = [];
  return {
    calls,
    invoke: async (model: string, body: ChatInput) => {
      calls.push({ model, body: structuredClone(body) });
      const result = answers[model]?.shift() ?? completion(model);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}
test('planners run in parallel on fresh bounded tool-free context; judge merges; worker keeps original tools', async () => {
  const s = state(),
    body = input();
  body.messages[1]!.content = 'x'.repeat(21000);
  body.messages.push({ role: 'assistant', content: 'old' }, { role: 'user', content: 'new' });
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  const f = fixture();
  const invoke = async (m: string, b: ChatInput) => {
    if (m === planner || m === repair) {
      if (++arrived === 2) release();
      await barrier;
    }
    return f.invoke(m, b);
  };
  await executePolicy(
    { ...policy, planners: [planner, repair], judge: validator, validator: undefined },
    s,
    body,
    invoke,
  );
  assert.deepEqual(
    f.calls.map((c) => c.model),
    [planner, repair, validator, worker],
  );
  for (const c of f.calls.slice(0, 2)) {
    assert.equal(c.body.messages.length, 2);
    assert.equal(c.body.messages[0]!.content, 'lead planner: concise plan + acceptance checklist');
    assert.equal(c.body.messages[1]!.content!.length, 20000);
    assert.equal(c.body.tools, undefined);
  }
  assert.equal(f.calls[2]!.body.tools, undefined);
  assert.ok(f.calls[3]!.body.tools);
  assert.match(f.calls[3]!.body.messages.at(-1)!.content!, /grok-4.7/);
  assert.equal(body.messages.length, 4);
});
for (const response of ['{"verdict":"pass","issues":[]}', 'not JSON', '{"verdict":"fail","issues":"wrong shape"}'])
  test(`validator accepts pass/unparsable: ${response}`, async () => {
    const f = fixture({ [validator]: [completion(response)] }),
      s = state();
    const r = await executePolicy(policy, s, input(), f.invoke);
    assert.equal(r.message.content, worker);
    assert.equal(f.calls.length, 3);
    assert.equal(s.orchestrations.root!.rejections, 0);
    assert.equal(f.calls[2]!.body.tools, undefined);
  });
test('failed validation injects feedback and switches sticky repair at rejection limit', async () => {
  const f = fixture({
    [validator]: [
      completion('{"verdict":"fail","issues":["fix it"]}'),
      completion('{"verdict":"pass","issues":[]}'),
      completion('{"verdict":"fail","issues":["still wrong"]}'),
    ],
  });
  const s = state(),
    body = input();
  body.messages.push({ role: 'tool', content: 't'.repeat(18000) });
  await executePolicy(policy, s, body, f.invoke);
  assert.deepEqual(
    f.calls.map((c) => c.model),
    [worker, validator, worker, validator],
  );
  assert.match(f.calls[2]!.body.messages.at(-1)!.content!, /fix it/);
  assert.equal(f.calls[2]!.body.messages.at(-2)!.role, 'user');
  assert.equal(f.calls[2]!.body.messages.at(-3)!.role, 'assistant');
  assert.equal(JSON.parse(f.calls[1]!.body.messages[1]!.content!).tool_results.length, 15000);
  await executePolicy(policy, s, body, f.invoke);
  assert.equal(f.calls.at(-1)!.model, repair);
  assert.equal(s.orchestrations.root!.repair, true);
  const before = f.calls.length;
  await executePolicy(policy, s, input(), f.invoke);
  assert.deepEqual(
    f.calls.slice(before).map((c) => c.model),
    [planner, repair],
  );
});
for (const answer of [completion(''), new Error('worker failed')])
  test('worker error/empty retries repair once and remains sticky', async () => {
    const f = fixture({ [worker]: [answer] }),
      s = state();
    const p = { ...policy, validator: undefined };
    await executePolicy(p, s, input(), f.invoke);
    assert.deepEqual(
      f.calls.map((c) => c.model),
      [planner, worker, repair],
    );
    await executePolicy(p, s, { ...input(), messages: [{ role: 'tool', content: 'ok' }] }, f.invoke);
    assert.equal(f.calls.at(-1)!.model, repair);
  });
test('tool calls skip validation, zero rejection limit disables validation, repair failure does not loop', async () => {
  const tool = completion(null);
  tool.message.tool_calls = [call];
  const f = fixture({ [worker]: [tool] });
  await executePolicy(policy, state(), input(), f.invoke);
  assert.equal(f.calls.length, 2);
  const g = fixture();
  await executePolicy({ ...policy, max_rejections: 0 }, state(), input(), g.invoke);
  assert.equal(g.calls.length, 2);
  const h = fixture({ [worker]: [new Error('one')], [repair]: [new Error('two')] });
  await assert.rejects(executePolicy(policy, state(), input(), h.invoke), /two/);
  assert.equal(h.calls.length, 3);
});
test('orchestrate validates cardinality, known targets, optional models and rejection counts', () => {
  assert.doesNotThrow(() => validateProfiles({ x: policy }));
  for (const change of [
    { planners: [] },
    { planners: [planner, planner, planner, planner] },
    { planners: [planner, repair] },
    { worker: 'missing' },
    { judge: 3 },
    { validator: 'missing' },
    { repair: 'missing' },
    { max_rejections: -1 },
    { max_rejections: 1.5 },
  ])
    assert.throws(() => validateProfiles({ x: { ...policy, ...change } }));
});

test('failed parallel planning waits for all physical calls before returning an error', async () => {
  let settled = false;
  await assert.rejects(
    executePolicy({ ...policy, planners: [planner, repair], judge: validator }, state(), input(), async (m) => {
      if (m === planner) throw Error('failed planner');
      await new Promise((r) => setTimeout(r, 5));
      settled = true;
      return completion();
    }),
    /failed planner/,
  );
  assert.equal(settled, true);
});

test('HTTP completion credits the worker, not the validator, and logs safe policy events', async () => {
  const { deps, logs } = dependencies();
  deps.profiles = { shape: { ...policy, planners: [worker], repair: undefined } };
  let calls = 0;
  deps.fetch = async () => Response.json(chatData(++calls === 3 ? '{"verdict":"pass","issues":[]}' : 'answer'));
  const response = await handle(request({ model: 'shape' }), deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-blend-model'), worker);
  assert.deepEqual(
    logs[0]!.events?.map((e) => e.type),
    ['plan', 'validate_pass'],
  );
  assert.equal(JSON.stringify(logs).includes('answer'), false);
});

const proposal = (id = 'p1'): Completion => {
  const result = completion(null);
  result.message.tool_calls = [
    { id, type: 'function', function: { name: 'propose_done', arguments: '{"itemId":"goal","note":"done"}' } },
  ];
  return result;
};

test('proposal gate matches the real OMS completion tool name', async () => {
  const source = await readFile(new URL('../../../packages/engine/src/propose-tool.ts', import.meta.url), 'utf8');
  assert.match(source, /export const PROPOSE_DONE_TOOL_NAME = 'propose_done'/);
});

test('proposal pass validates arguments and forwards the original completion', async () => {
  const answer = proposal();
  const f = fixture({ [worker]: [answer], [validator]: [completion('{"verdict":"pass","issues":[]}')] });
  assert.equal(await executePolicy(policy, state(), input(), f.invoke), answer);
  const validation = f.calls.find((c) => c.model === validator)!;
  assert.deepEqual(JSON.parse(validation.body.messages[1]!.content!).propose_done_arguments, [
    '{"itemId":"goal","note":"done"}',
  ]);
});

test('rejected proposal is withheld; recall history pairs every unexecuted tool call with honest feedback', async () => {
  const first = proposal();
  first.message.tool_calls!.push(call);
  const next = completion(null);
  next.message.tool_calls = [call];
  const f = fixture({
    [worker]: [first, next],
    [validator]: [completion('{"verdict":"fail","issues":["fix transaction signatures"]}')],
  });
  const result = await executePolicy(policy, state(), input(), f.invoke);
  assert.equal(result, next);
  assert.ok(!result.message.tool_calls!.some((c) => c.function.name === 'propose_done'));
  const body = f.calls.filter((c) => c.model === worker)[1]!.body;
  const at = body.messages.findIndex((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === 'p1'));
  assert.deepEqual(
    body.messages.slice(at + 1, at + 3).map((m) => m.tool_call_id),
    ['p1', call.id],
  );
  assert.ok(
    body.messages.slice(at + 1, at + 3).every((m) => m.role === 'tool' && m.content!.startsWith('Not executed:')),
  );
  assert.equal(body.messages[at + 3]!.role, 'user');
});

test('repeated proposals revalidate until rejection limit, then pass repair through without another validator call', async () => {
  const final = proposal('p3');
  const f = fixture({
    [worker]: [proposal('p1'), proposal('p2')],
    [validator]: [completion('{"verdict":"fail","issues":["one"]}'), completion('{"verdict":"fail","issues":["two"]}')],
    [repair]: [final],
  });
  const s = state();
  assert.equal(await executePolicy(policy, s, input(), f.invoke), final);
  assert.deepEqual(
    f.calls.map((c) => c.model),
    [planner, worker, validator, worker, validator, repair],
  );
  assert.equal(s.orchestrations.root!.rejections, 2);
  assert.equal(s.orchestrations.root!.repair, true);
});

test('deferred planning starts after discovery and preserves the same task context for later validation', async () => {
  const tool = completion(null);
  tool.message.tool_calls = [call];
  const f = fixture({
    [worker]: [tool, tool, proposal()],
    [validator]: [completion('{"verdict":"pass","issues":[]}')],
  });
  const p = { ...policy, defer_plan_until_tools: true };
  const s = state();
  await executePolicy(p, s, input(), f.invoke);
  assert.deepEqual(
    f.calls.map((c) => c.model),
    [worker],
  );
  const discovered = input();
  discovered.messages.push({
    role: 'tool',
    content: 'Actual objective: repair the counter; acceptance: 17 tests pass.',
  });
  await executePolicy(p, s, discovered, f.invoke);
  const plan = f.calls.find((c) => c.model === planner)!;
  assert.equal(plan.body.messages.length, 2);
  assert.equal(plan.body.tools, undefined);
  assert.match(plan.body.messages[1]!.content!, /Actual objective: repair the counter/);
  await executePolicy(
    p,
    s,
    { ...input(), messages: [{ role: 'tool', content: 'late logs after context trimming' }] },
    f.invoke,
  );
  assert.equal(f.calls.filter((c) => c.model === planner).length, 1);
  const validation = f.calls.find((c) => c.model === validator)!;
  assert.equal(JSON.parse(validation.body.messages[1]!.content!).goal, plan.body.messages[1]!.content);
  assert.equal(s.orchestrations.root!.goal, plan.body.messages[1]!.content);
});

test('discovery context is general and independently bounds system, first user and earliest tool evidence', async () => {
  const body = input();
  body.messages[0]!.content = 's'.repeat(21000);
  body.messages[1]!.content = 'u'.repeat(21000);
  body.messages.push(
    { role: 'tool', content: 'earliest objective ' + 't'.repeat(21000) },
    { role: 'tool', content: 'latest irrelevant log' },
  );
  const f = fixture();
  await executePolicy({ ...policy, defer_plan_until_tools: true, validator: undefined }, state(), body, f.invoke);
  const goal = JSON.parse(f.calls[0]!.body.messages[1]!.content!);
  assert.equal(goal.system.length, 20000);
  assert.equal(goal.first_user.length, 20000);
  assert.equal(goal.early_tool_results.length, 20000);
  assert.ok(goal.early_tool_results.startsWith('earliest objective'));
  assert.ok(!goal.early_tool_results.includes('latest irrelevant'));
});

test('deferred tool-free requests can still plan immediately and configuration rejects non-booleans', async () => {
  const body = input();
  delete body.tools;
  const f = fixture();
  await executePolicy({ ...policy, defer_plan_until_tools: true, validator: undefined }, state(), body, f.invoke);
  assert.deepEqual(
    f.calls.map((c) => c.model),
    [planner, worker],
  );
  for (const value of ['true', 1, null])
    assert.throws(() => validateProfiles({ shape: { ...policy, defer_plan_until_tools: value } }));
});

test('empty discovery results do not trigger planning before objective evidence is available', async () => {
  const body = input();
  body.messages.push({ role: 'tool', content: '' });
  const f = fixture();
  const s = state();
  await executePolicy({ ...policy, defer_plan_until_tools: true, validator: undefined }, s, body, f.invoke);
  assert.deepEqual(
    f.calls.map((c) => c.model),
    [worker],
  );
  assert.equal(s.orchestrations.root!.goal, undefined);
});
