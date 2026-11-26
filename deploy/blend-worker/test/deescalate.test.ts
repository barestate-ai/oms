import assert from 'node:assert/strict';
import test from 'node:test';
import { executePolicy, readOnlyCall } from '../src/core/policies.ts';
import { BlendError } from '../src/core/types.ts';
import type { Message, Policy, PolicyEvent, SessionState } from '../src/core/types.ts';
import { completion, input } from './fixtures.ts';

const strong = 'claude-haiku-5-5',
  cheap = 'mimo-v2.6-flash';
const policy: Policy = {
  type: 'deescalate',
  strong,
  cheap,
  handoff_after_turns: 2,
  return_after_failures: 2,
  cooldown_turns: 2,
};
const state = (): SessionState => ({ escalated: {}, labels: {}, executorTurns: {}, orchestrations: {} });
const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const turn = (id: string, name: string, args: unknown, result: string): Message[] => [
  { role: 'assistant', content: null, tool_calls: [call(id, name, args)] },
  { role: 'tool', tool_call_id: id, content: result },
];
function recorder() {
  const models: string[] = [];
  return { models, invoke: async (model: string) => (models.push(model), completion()) };
}

test('strong runs first, hands off after N clean turns, returns on failures, then hands back after cooldown', async () => {
  const s = state(),
    r = recorder(),
    events: PolicyEvent[] = [],
    body = input();
  const step = () => executePolicy(policy, s, body, r.invoke, 'root', (e) => events.push(e));
  await step();
  body.messages.push(...turn('a', 'bash', { command: 'anchor build' }, 'ok'));
  await step();
  body.messages.push(...turn('b', 'bash', { command: 'node send.ts' }, 'sent'));
  await step();
  body.messages.push(...turn('c', 'bash', { command: 'node send.ts' }, 'Error: tx failed'));
  await step();
  body.messages.push(...turn('d', 'bash', { command: 'node send.ts' }, 'Error: tx failed'));
  await step();
  body.messages.push(...turn('e', 'bash', { command: 'node fix.ts' }, 'sent'));
  await step();
  body.messages.push(...turn('f', 'bash', { command: 'node fix.ts' }, 'sent'));
  await step();
  assert.deepEqual(r.models, [strong, strong, cheap, cheap, strong, strong, cheap]);
  assert.deepEqual(
    events.map((e) => e.type),
    ['handoff', 'return', 'handoff'],
  );
});

test('handoff waits for a clean latest tool result', async () => {
  const s = state(),
    r = recorder(),
    body = input();
  body.messages.push(...turn('a', 'bash', { command: 'x' }, 'Error: failed'));
  body.messages.push(...turn('b', 'bash', { command: 'x' }, 'Error: failed'));
  await executePolicy(policy, s, body, r.invoke);
  body.messages.push(...turn('c', 'bash', { command: 'x' }, 'done'));
  await executePolicy(policy, s, body, r.invoke);
  assert.deepEqual(r.models, [strong, cheap]);
});

test('cheap error or empty completion falls back to strong with cooldown; invalid requests rethrow', async () => {
  const s = state(),
    body = input();
  body.messages.push(...turn('a', 'bash', { command: 'x' }, 'ok'), ...turn('b', 'bash', { command: 'x' }, 'ok'));
  const models: string[] = [];
  await executePolicy(policy, s, body, async (model) => {
    models.push(model);
    if (model === cheap) throw new BlendError(502, 'upstream');
    return completion();
  });
  assert.deepEqual(models, [cheap, strong]);
  assert.equal(s.deescalations!.root!.cheap, false);
  assert.equal(s.deescalations!.root!.until, 4);
  const t = state();
  await assert.rejects(
    executePolicy(policy, t, body, async (model) => {
      if (model === cheap) throw new BlendError(400, 'bad', 'invalid_request_error');
      return completion();
    }),
  );
});

test('read-only inspection results never count as failures; mutating shell output still does', async () => {
  assert.equal(readOnlyCall(call('1', 'read', { path: 'GOAL.md' })), true);
  assert.equal(readOnlyCall(call('1', 'bash', { command: 'ls -la && head -n 5 a.md 2>/dev/null | cat' })), true);
  assert.equal(readOnlyCall(call('1', 'bash', { command: 'echo hi > out.txt' })), false);
  assert.equal(readOnlyCall(call('1', 'bash', { command: 'cat $(node x.js)' })), false);
  assert.equal(readOnlyCall(call('1', 'bash', { command: 'node send.ts' })), false);
  assert.equal(readOnlyCall(call('1', 'edit', { path: 'a' })), false);
  assert.equal(readOnlyCall(undefined), false);
  const escalate: Policy = { type: 'escalate', cheap, strong, trigger: { tool_failures: 2 } };
  const r = recorder(),
    body = input();
  body.messages.push(
    ...turn('a', 'read', { path: 'GOAL.md' }, 'Failed transactions do not count; error handling'),
    ...turn('b', 'bash', { command: 'ls; cat README.md' }, 'error failure notes'),
  );
  await executePolicy(escalate, state(), body, r.invoke);
  body.messages.push(...turn('c', 'bash', { command: 'node a.ts' }, 'Error: failed'));
  body.messages.push(...turn('d', 'bash', { command: 'node a.ts' }, 'Error: failed'));
  await executePolicy(escalate, state(), body, r.invoke);
  assert.deepEqual(r.models, [cheap, strong]);
});

test('validation rejects bad de-escalation thresholds', async () => {
  const { validateProfiles } = await import('../src/core/policies.ts');
  assert.throws(() => validateProfiles({ x: { ...policy, cooldown_turns: 0 } }));
  assert.throws(() => validateProfiles({ x: { ...policy, strong: 'nope' } }));
  assert.doesNotThrow(() => validateProfiles({ x: policy }));
});

test('deescalation events carry cause and failing tool names', async () => {
  const s = state(),
    r = recorder(),
    events: PolicyEvent[] = [],
    body = input();
  const step = () => executePolicy(policy, s, body, r.invoke, 'root', (e) => events.push(e));
  await step();
  body.messages.push(...turn('a', 'bash', { command: 'anchor build' }, 'ok'));
  await step();
  body.messages.push(...turn('b', 'bash', { command: 'node send.ts' }, 'sent'));
  await step();
  assert.equal(events[0]?.reason, 'turns');
  body.messages.push(...turn('c', 'apply_patch', {}, 'Command failed'));
  await step();
  body.messages.push(...turn('d', 'submit_transaction', {}, 'Transaction failed'));
  await step();
  const ret = events.at(-1);
  assert.equal(ret?.type, 'return');
  assert.equal(ret?.reason, 'tool_failures');
  assert.deepEqual(ret?.tools, ['apply_patch', 'submit_transaction']);
});
