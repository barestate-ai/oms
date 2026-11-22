import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { defaultHarnessEnvironment, parseRunRecord } from '@oms/engine';
import { runHarnessCommand } from '../src/harness.ts';
import { MAX_NO_PROGRESS_TURNS } from '../src/headless.ts';
import { createHarnessFixture } from '../../engine/test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const binary = process.env.SURFPOOL_BINARY ?? join(homedir(), '.local/bin/surfpool');

const narrate = () => fauxAssistantMessage('Summarizing what I found so far.');

function registerModel(
  f: Awaited<ReturnType<typeof createHarnessFixture>>,
  spec: { api?: string; contextWindow: number; maxTokens: number },
  streamSimple: (model: { api: string; provider: string; id: string }) => unknown,
) {
  f.modelRuntime.registerProvider(f.model.provider, {
    api: (spec.api ?? f.model.api) as typeof f.model.api,
    apiKey: 'synthetic-fixture-not-a-provider-key',
    baseUrl: f.model.baseUrl,
    models: [
      {
        type: 'chat',
        id: f.model.id,
        name: f.model.name,
        reasoning: f.model.reasoning,
        input: f.model.input,
        cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
        contextWindow: spec.contextWindow,
        maxTokens: spec.maxTokens,
      },
    ],
    streamSimple: streamSimple as never,
  });
}

async function headlessRun(t: import('node:test').TestContext) {
  if (await skipUnavailable(t, { surfpool: binary })) return null;
  const f = await createHarnessFixture({
    ...defaultHarnessEnvironment(binary, 'host'),
    ...(process.env.OMS_BENCH_DEPENDENCIES ? {} : { dependencies: undefined }),
  });
  const jsonOut = join(f.base, 'record.json');
  return { f, jsonOut };
}

test('a run near the token cap still dispatches when the measured transcript fits', { timeout: 180_000 }, async (t) => {
  const run = await headlessRun(t);
  if (!run) return;
  const { f, jsonOut } = run;
  let calls = 0;
  try {
    // A 1.2M-window model reserves ~1.2M tokens at the catalog bound — over the 600K cap —
    // while its real transcript is a few dozen KB. Measured admission must still dispatch.
    registerModel(f, { contextWindow: 1_200_000, maxTokens: 128 }, (model) => {
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
          cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, total: 1 },
        },
      };
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end(message);
      return stream;
    });
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
        '--tokens',
        '600000',
        '--spend-usd',
        '4',
        '--output-tokens',
        '128',
        '--surfpool-binary',
        binary,
        '--json-out',
        jsonOut,
      ],
      { modelRuntime: f.modelRuntime },
    );
    const record = parseRunRecord(JSON.parse(readFileSync(jsonOut, 'utf8')));
    assert.equal(record.status, 'blocked', `the stall cutoff, not the cap: ${record.reason}`);
    assert.equal(record.reason, 'no-verified-progress');
    assert.equal(calls, MAX_NO_PROGRESS_TURNS, 'every narration reached the provider');
    assert.equal(record.dispatches.length, MAX_NO_PROGRESS_TURNS);
    assert.equal(exitCode, 1);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('a Codex run short on tokens but rich in dollars reports capped:tokens', { timeout: 180_000 }, async (t) => {
  const run = await headlessRun(t);
  if (!run) return;
  const { f, jsonOut } = run;
  let calls = 0;
  try {
    // Codex reserves its whole catalog output capacity: 3M output tokens never fit the 2M
    // token cap, while the same bound's ~$3 spend fits the $400 allowance easily.
    registerModel(f, { api: 'openai-codex-responses', contextWindow: 4_000_000, maxTokens: 3_000_000 }, () => {
      calls++;
      throw new Error('must never dispatch');
    });
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
        '400',
        '--output-tokens',
        '128',
        '--surfpool-binary',
        binary,
        '--json-out',
        jsonOut,
      ],
      { modelRuntime: f.modelRuntime },
    );
    const record = parseRunRecord(JSON.parse(readFileSync(jsonOut, 'utf8')));
    assert.equal(record.status, 'capped');
    assert.equal(record.reason, 'capped:tokens');
    assert.equal(record.cap, 'tokens');
    assert.equal(exitCode, 2);
    assert.equal(calls, 0);
    assert.equal(record.dispatches.length, 0);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
