import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInput } from '../src/core/input.ts';
import { executePolicy, validateProfiles } from '../src/core/policies.ts';
import { BlendError, type ChatInput, type Completion, type PolicyEvent, type SessionState } from '../src/core/types.ts';
import { call, completion, input } from './fixtures.ts';

const strong = 'claude-fable-5-2';
const worker = 'glm-5.3-flash';
const policy = validateProfiles({
  checkpoint: { type: 'checkpoint', strong, worker, opening_turns: 1, failure_streak: 2, worker_turns: 2 },
}).checkpoint!;
const tool = (name = 'bash') => ({ ...call, function: { name, arguments: '{"command":"node run.ts"}' } });
const continuing = (name?: string): Completion => ({
  ...completion(null),
  message: { role: 'assistant', content: null, tool_calls: [tool(name)] },
  finishReason: 'tool_calls',
});
function session(selected = policy, onWorkerInput?: (body: ChatInput) => void) {
  const body = input();
  const state: SessionState = { escalated: {}, labels: {}, executorTurns: {}, orchestrations: {} };
  const events: PolicyEvent[] = [];
  const models: string[] = [];
  let i = 0;
  const recordTool = (content: string) => {
    const id = 'call_' + ++i;
    body.messages.push(
      { role: 'assistant', content: null, tool_calls: [{ ...tool(), id }] },
      { role: 'tool', content, tool_call_id: id },
    );
    return id;
  };
  const step = (result: () => Completion = continuing) =>
    executePolicy(
      selected,
      state,
      body,
      async (model, received) => {
        if (model === worker && onWorkerInput) onWorkerInput(received);
        else assert.equal(received, body);
        models.push(model);
        return model === worker ? result() : continuing();
      },
      'root',
      (event) => events.push(event),
    );
  return { body, events, models, recordTool, step };
}

test('checkpoint opens strong, works for K turns, reviews for one turn, then hands back', async () => {
  const { models, events, recordTool, step } = session();
  await step();
  for (let i = 0; i < 4; i++) {
    recordTool('ok');
    await step();
  }
  assert.deepEqual(models, [strong, worker, worker, strong, worker]);
  assert.deepEqual(
    events.map((e) => e.reason),
    ['turns', 'checkpoint_interval', 'turns'],
  );
});

test('only real consecutive failures trigger one review; output with failure words is not an error', async () => {
  const { body, models, events, recordTool, step } = session();
  const old = recordTool('failed');
  recordTool('Error: sample output');
  body.failedToolCalls = [old];
  await step();
  const a = recordTool('first');
  const b = recordTool('second');
  body.failedToolCalls = [old, a, b];
  await step();
  await step();
  assert.deepEqual(models, [worker, strong, worker]);
  assert.deepEqual(events[1], { type: 'return', path: 'root', reason: 'tool_failures', tools: ['bash', 'bash'] });
});

test('a numeric tool exit status is authoritative for clients without OMS failure IDs', async () => {
  const { models, recordTool, step } = session();
  recordTool('{"exit_code":0,"output":"Error: example"}');
  recordTool('{"exit_code":2,"output":"no errors"}');
  await step();
  recordTool('{"exit_code":1}');
  await step();
  assert.deepEqual(models, [worker, strong]);
});

test('strong replaces a worker proposal or final answer before it reaches the client', async () => {
  for (const candidate of [() => continuing('propose_done'), () => completion('final answer')]) {
    const { models, events, recordTool, step } = session();
    recordTool('ok');
    const result = await step(candidate);
    assert.equal(result.message.tool_calls?.[0]?.function.name, 'bash');
    assert.deepEqual(models, [worker, strong]);
    assert.equal(events.at(-1)?.reason, 'final');
  }
});

test('a budget rejection is not retried with the strong model', async () => {
  const { models, recordTool, step } = session();
  recordTool('ok');
  await assert.rejects(
    step(() => {
      throw new BlendError(402, 'budget');
    }),
  );
  assert.deepEqual(models, [worker]);
});

test('a gated tool replaces the entire worker response, even alongside routine edits', async () => {
  const selected = validateProfiles({
    checkpoint: { ...policy, review_tools: ['bash', 'shell'] },
  }).checkpoint!;
  const { events, recordTool, step, models } = session(selected);
  recordTool('ok');
  const routine = continuing('edit');
  assert.equal(await step(() => routine), routine);
  const workerBatch = continuing('edit');
  workerBatch.message.tool_calls!.push(tool('shell'));
  const reviewed = await step(() => workerBatch);
  assert.deepEqual(
    reviewed.message.tool_calls?.map((call) => call.function.name),
    ['bash'],
  );
  assert.deepEqual(models, [worker, worker, strong]);
  assert.deepEqual(events.at(-1), { type: 'return', path: 'root', reason: 'guarded_tool', tools: ['shell'] });
});

test('failure metadata is optional and validated separately from tool output', () => {
  const raw = { model: 'checkpoint', messages: input().messages };
  assert.deepEqual(parseInput({ ...raw, oms_failed_tool_calls: ['abc'] }).failedToolCalls, ['abc']);
  assert.throws(() => parseInput({ ...raw, oms_failed_tool_calls: [1] }));
  assert.throws(() => validateProfiles({ x: { type: 'checkpoint', strong, worker, opening_turns: 0 } }));
  assert.throws(() => validateProfiles({ x: { type: 'checkpoint', strong, worker, review_tools: ['bash', 1] } }));
  assert.throws(() => validateProfiles({ x: { type: 'checkpoint', strong, worker, hide_review_tools: 'true' } }));
});

test('workers can see only routine tools while strong still receives the complete tool list', async () => {
  const selected = validateProfiles({
    checkpoint: { ...policy, review_tools: ['bash'], hide_review_tools: true },
  }).checkpoint!;
  const { body, models, events, recordTool, step } = session(selected, (received) => {
    assert.deepEqual(
      received.tools?.map((t) => t.function.name),
      ['edit'],
    );
  });
  body.tools = ['edit', 'bash', 'propose_done'].map((name) => ({
    type: 'function',
    function: { name, parameters: {} },
  }));
  recordTool('ok');
  const routine = continuing('edit');
  assert.equal(await step(() => routine), routine);
  await step(() => continuing('bash'));
  assert.deepEqual(models, [worker, worker, strong]);
  assert.equal(events.at(-1)?.reason, 'guarded_tool');
  assert.equal(body.tools.length, 3);
});
