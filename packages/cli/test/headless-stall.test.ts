import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { defaultHarnessEnvironment, parseRunRecord } from '@oms/engine';
import { runHarnessCommand } from '../src/harness.ts';
import { HEADLESS_INSTRUCTION, MAX_NO_PROGRESS_TURNS } from '../src/headless.ts';
import { createHarnessFixture } from '../../engine/test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const binary = process.env.SURFPOOL_BINARY ?? join(homedir(), '.local/bin/surfpool');

const narrate = () => fauxAssistantMessage('Summarizing what I found so far.');

const expected = {
  'recovers after 2 stalls': { status: 'closed', reason: null, cap: null, calls: 4, continuations: 2, exit: 0 },
  'stalls 3 turns in a row': {
    status: 'blocked',
    reason: 'no-verified-progress',
    cap: null,
    calls: MAX_NO_PROGRESS_TURNS,
    continuations: MAX_NO_PROGRESS_TURNS - 1,
    exit: 1,
  },
  'runs out of budget mid-stall': {
    status: 'capped',
    reason: 'capped:usd',
    cap: 'usd',
    calls: 2,
    continuations: 1,
    exit: 2,
  },
  'runs out of budget at the stall cutoff': {
    status: 'capped',
    reason: 'capped:usd',
    cap: 'usd',
    calls: MAX_NO_PROGRESS_TURNS,
    continuations: MAX_NO_PROGRESS_TURNS - 1,
    exit: 2,
  },
  'reaches the deadline mid-stall': {
    status: 'capped',
    reason: 'capped:wall',
    cap: 'wall',
    calls: 1,
    continuations: 0,
    exit: 2,
  },
} as const;

for (const [scenario, want] of Object.entries(expected)) {
  test(`headless run that ${scenario} ends as ${want.reason ?? want.status}`, { timeout: 180_000 }, async (t) => {
    if (await skipUnavailable(t, { surfpool: binary })) return;
    // Pin the task with the same environment the headless run derives for --sandbox host, so the pinned
    // runtime identity matches. The fixture's docker default would otherwise add the repo root as
    // `dependencies` on linux-x64 (and OMS_BENCH_DEPENDENCIES adds it to both when set).
    const f = await createHarnessFixture({
      ...defaultHarnessEnvironment(binary, 'host'),
      ...(process.env.OMS_BENCH_DEPENDENCIES ? {} : { dependencies: undefined }),
    });
    const jsonOut = join(f.base, 'record.json');
    let now = Date.now();
    let calls = 0;
    try {
      if (scenario === 'recovers after 2 stalls') {
        f.faux.setResponses([
          narrate(),
          narrate(),
          fauxAssistantMessage(fauxToolCall('write', { path: 'amount.mjs', content: 'export const amount = 10;\n' }), {
            stopReason: 'toolUse',
          }),
          fauxAssistantMessage(fauxToolCall('propose_done', { itemId: 'fixture' }), { stopReason: 'toolUse' }),
        ]);
      } else if (scenario === 'stalls 3 turns in a row') {
        f.faux.setResponses([narrate(), narrate(), narrate(), narrate()]);
      } else if (scenario === 'reaches the deadline mid-stall') {
        f.faux.setResponses([
          () => {
            now += 40 * 60_000;
            return narrate();
          },
          narrate(),
        ]);
      } else {
        // Mid-stall settles at $4 and the cutoff at $2, both against a $6 allowance: the cap must end the
        // run whether it trips before or exactly at the streak cutoff, ahead of no-verified-progress.
        const settledUsd = scenario === 'runs out of budget mid-stall' ? 4 : 2;
        f.modelRuntime.registerProvider(f.model.provider, {
          api: f.model.api,
          apiKey: 'synthetic-fixture-not-a-provider-key',
          baseUrl: f.model.baseUrl,
          models: [
            {
              type: 'chat',
              id: f.model.id,
              name: f.model.name,
              reasoning: f.model.reasoning,
              input: f.model.input,
              cost: f.model.cost,
              contextWindow: f.model.contextWindow,
              maxTokens: f.model.maxTokens,
            },
          ],
          streamSimple: (model) => {
            calls++;
            const stream = createAssistantMessageEventStream();
            const message = {
              ...narrate(),
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: settledUsd, cacheRead: 0, cacheWrite: 0, total: settledUsd },
              },
            };
            stream.push({ type: 'done', reason: 'stop', message });
            stream.end(message);
            return stream;
          },
        });
      }
      const exitCode = await runHarnessCommand(
        'run',
        [
          '--headless',
          '--sandbox',
          'host',
          '--host-approval',
          'allow',
          '--workspace',
          f.repo,
          '--state-root',
          join(f.base, 'state'),
          '--task',
          f.task.id,
          '--provider',
          f.model.provider,
          '--model',
          f.model.id,
          '--minutes',
          '40',
          '--spend-usd',
          scenario.startsWith('runs out of budget') ? '6' : '4',
          '--output-tokens',
          '128',
          '--surfpool-binary',
          binary,
          '--json-out',
          jsonOut,
        ],
        { modelRuntime: f.modelRuntime, clock: () => now },
      );
      const record = parseRunRecord(JSON.parse(readFileSync(jsonOut, 'utf8')));
      assert.equal(record.status, want.status);
      assert.equal(record.reason, want.reason);
      assert.equal(record.cap, want.cap);
      assert.equal(exitCode, want.exit);
      assert.equal(scenario.startsWith('runs out of budget') ? calls : f.faux.state.callCount, want.calls);
      assert.equal(record.dispatches.length, want.calls);
      assert.equal(record.noProgressContinuations, want.continuations);
      const transcript = readFileSync(record.transcriptPath!, 'utf8');
      // The first turn carries the task context; every continuation is the unchanged headless instruction.
      const continuations = transcript
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === 'message' && entry.message.role === 'user')
        .slice(1);
      assert.equal(continuations.length, want.continuations);
      for (const entry of continuations)
        assert.equal(JSON.stringify(entry.message.content).includes(HEADLESS_INSTRUCTION), true);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });
}
