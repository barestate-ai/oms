import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { acquireTaskLease } from '@oms/engine';
import { runHarnessCommand, parseLaunchOptions } from '../src/harness.ts';
import { MAX_NO_PROGRESS_TURNS } from '../src/headless.ts';
import { createHarnessFixture } from '../../engine/test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const binary = process.env.SURFPOOL_BINARY;
const image = process.env.OMS_SANDBOX_IMAGE;
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? image;

for (const scenario of ['closed', 'blocked', 'usd', 'wall', 'unknown', 'owned'] as const) {
  test(
    `production headless CLI records ${scenario} through the normal owner and offline verifier`,
    { timeout: 120_000 },
    async (t) => {
      if (
        (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
        !binary ||
        !image ||
        !forwarderImage
      )
        return;
      const f = await createHarnessFixture({ binary, image, forwarderImage });
      const jsonOut = join(f.base, 'record.json');
      let now = Date.now();
      const lease = scenario === 'owned' ? acquireTaskLease(f.workspace, f.task.id) : undefined;
      try {
        if (scenario === 'closed') {
          f.faux.setResponses([
            fauxAssistantMessage(
              fauxToolCall('write', { path: 'amount.mjs', content: 'export const amount = 10;\n' }),
              { stopReason: 'toolUse' },
            ),
            fauxAssistantMessage(fauxToolCall('propose_done', { itemId: 'fixture' }), { stopReason: 'toolUse' }),
          ]);
        } else if (scenario === 'wall') {
          f.faux.setResponses([
            () => {
              now += 40 * 60_000;
              return fauxAssistantMessage(fauxToolCall('task_status', {}), { stopReason: 'toolUse' });
            },
          ]);
        } else if (scenario === 'unknown') {
          // Emit at the provider stream seam: faux.streamSimple estimates and overwrites usage.
          // Pi's default all-zero usage represents an absent provider receipt to the meter.
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
              const stream = createAssistantMessageEventStream();
              const message = {
                ...fauxAssistantMessage('No trustworthy receipt.'),
                api: model.api,
                provider: model.provider,
                model: model.id,
              };
              stream.push({ type: 'done', reason: 'stop', message });
              stream.end(message);
              return stream;
            },
          });
        } else {
          f.faux.setResponses(
            Array.from({ length: MAX_NO_PROGRESS_TURNS }, () => fauxAssistantMessage('Unable to complete.')),
          );
        }
        const args = [
          '--headless',
          '--sandbox',
          'docker',
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
          scenario === 'usd' ? '0.000001' : '4',
          '--output-tokens',
          '128',
          '--surfpool-binary',
          binary,
          '--json-out',
          jsonOut,
        ];
        const exitCode = await runHarnessCommand('run', args, { modelRuntime: f.modelRuntime, clock: () => now });
        assert.equal(exitCode, ['usd', 'wall'].includes(scenario) ? 2 : scenario === 'closed' ? 0 : 1);
        const raw = JSON.parse(readFileSync(jsonOut, 'utf8'));
        const { parseRunRecord, RunRecordSchema } = await import('@oms/engine');
        const record = parseRunRecord(raw);
        assert.ok(RunRecordSchema);
        assert.equal(record.taskId, f.task.id);
        assert.equal(record.contender, `${f.model.provider}:${f.model.id}`);
        assert.equal(
          record.status,
          ['usd', 'wall'].includes(scenario)
            ? 'capped'
            : scenario === 'closed'
              ? 'closed'
              : scenario === 'unknown'
                ? 'infra'
                : 'blocked',
        );
        assert.equal(record.cap, ['usd', 'wall'].includes(scenario) ? scenario : null);
        assert.equal(record.privateVerdict, null, 'headless does not invent private grades');
        assert.ok(Number.isSafeInteger(record.wallMs) && record.wallMs >= 0);
        assert.match(record.identities.harness, /^[0-9a-f]{64}$/);
        assert.equal(record.identities.image, image);
        if (scenario === 'owned') {
          assert.equal(f.faux.state.callCount, 0);
          assert.equal(record.transcriptPath, null);
          assert.equal(existsSync(f.task.leaseFile), true, 'headless never stops or recovers another owner');
        } else {
          assert.ok(record.transcriptPath && existsSync(record.transcriptPath));
          assert.equal(existsSync(f.task.leaseFile), false, 'runtime cleans its owner');
        }
        if (scenario === 'closed') {
          assert.equal(record.visibleVerdict, 'pass');
          assert.equal(record.items[0]?.status, 'closed');
          for (const field of ['specificationDigest', 'codeDigest', 'verifierDigest', 'snapshotDigest'] as const) {
            assert.match(record.items[0]!.evidence![field], /^[0-9a-f]{64}$/);
          }
          assert.equal(
            record.dispatches.length,
            2,
            'the run ends when propose_done closes the last item: no closing model reply',
          );
          assert.equal(f.faux.state.callCount, 2);
          assert.ok(
            record.dispatches.every(
              (d) =>
                d.usage &&
                Number.isSafeInteger(d.usage.cacheReadTokens) &&
                Number.isSafeInteger(d.usage.cacheWriteTokens),
            ),
          );
          assert.equal(
            record.settledMicroUsd,
            record.dispatches.reduce((sum, d) => sum + (d.settledMicroUsd ?? 0), 0),
          );
          assert.ok(record.firstVisiblePass && record.firstVisiblePass.wallMs <= record.wallMs);
          assert.ok(record.firstVisiblePass.spendMicroUsd <= record.settledMicroUsd);
          assert.ok(readFileSync(record.transcriptPath!, 'utf8').includes('propose_done'));
        }
        if (scenario === 'usd') assert.equal(f.faux.state.callCount, 0);
        if (scenario === 'wall') {
          assert.equal(f.faux.state.callCount, 1, 'no continuation after 40 minutes');
          assert.ok(record.wallMs >= 40 * 60_000);
        }
        if (scenario === 'unknown') {
          assert.equal(record.accounting, 'unknown');
          assert.ok(record.heldMicroUsd > 0);
          assert.equal(record.dispatches[0]?.usage, null);
          assert.equal(record.dispatches[0]?.settledMicroUsd, null);
        }
        assert.throws(() => parseRunRecord({ ...raw, wallMs: -1 }));
        assert.throws(() => parseRunRecord({ ...raw, unexpected: true }));
      } finally {
        lease?.release();
        rmSync(f.base, { recursive: true, force: true });
      }
    },
  );
}

test('normal launch defaults remain unchanged and headless requires explicit identity and record destination', async () => {
  assert.equal(parseLaunchOptions([]).executionMode, 'interactive');
  for (const args of [['--headless'], ['--headless', '--task', 'x', '--json-out', '/tmp/not-created.json']]) {
    await assert.rejects(runHarnessCommand('run', args), /headless requires/i);
  }
});

test(
  'an oms3 run record carries its injected first turn in the prompt identity and its injection path; oms does not',
  { timeout: 240_000 },
  async (t) => {
    if (
      (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
      !binary ||
      !image ||
      !forwarderImage
    )
      return;
    // workerV2 toggles the mock between a v0.2.0 Worker (topic tools) and an old one (detect_topics is an unknown tool).
    let workerV2 = false;
    const scopedTo: unknown[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        const rpc = JSON.parse(raw) as { id: number; params?: { name?: string; arguments?: { topic?: string } } };
        const name = rpc.params?.name;
        if (name === 'search_docs') scopedTo.push(rpc.params?.arguments?.topic);
        const result =
          name === 'detect_topics'
            ? workerV2
              ? {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({ topics: [{ id: 'kit-client', card: 'topic-card-marker' }] }),
                    },
                  ],
                }
              : { content: [{ type: 'text', text: 'Unknown tool: detect_topics' }], isError: true }
            : {
                content: [
                  {
                    type: 'text',
                    text:
                      name === 'list_sources'
                        ? 'Built 2026-11-07T00:00:00Z.'
                        : '- read_doc(id="kit/a.md", offset=0) | kit@6.0.0 | Fee\n  primer-marker snippet',
                  },
                ],
              };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const saved = {
      OMS_KNOWLEDGE_URL: process.env.OMS_KNOWLEDGE_URL,
      OMS_KNOWLEDGE_TOKEN: process.env.OMS_KNOWLEDGE_TOKEN,
    };
    process.env.OMS_KNOWLEDGE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    process.env.OMS_KNOWLEDGE_TOKEN = 'synthetic-fixture-not-a-knowledge-token';
    // One fixture for both runs, so the system prompt is the same and only the first turn can differ.
    const f = await createHarnessFixture({ binary, image, forwarderImage });
    let runs = 0;
    const run = async (inject: boolean, toolCalls: Array<[string, Record<string, string>]> = []) => {
      f.faux.setResponses([
        ...toolCalls.map(([name, args]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })),
        fauxAssistantMessage('Unable to complete.'),
      ]);
      const jsonOut = join(f.base, `record-${runs++}.json`);
      await runHarnessCommand(
        'run',
        [
          '--headless',
          '--sandbox',
          'docker',
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
          '4',
          '--output-tokens',
          '128',
          '--surfpool-binary',
          binary,
          '--json-out',
          jsonOut,
          '--knowledge',
          ...(inject ? ['--knowledge-inject'] : []),
        ],
        { modelRuntime: f.modelRuntime },
      );
      const record = JSON.parse(readFileSync(jsonOut, 'utf8'));
      return {
        prompt: record.identities.prompt as string,
        transcript: readFileSync(record.transcriptPath, 'utf8'),
        injection: record.injection as unknown,
        knowledgeBuilt: record.knowledgeBuilt as unknown,
        knowledgeCalls: record.knowledgeCalls as unknown,
      };
    };
    try {
      const oms = await run(false);
      const omsAgain = await run(false);
      const oms3 = await run(true);
      assert.equal(omsAgain.prompt, oms.prompt, 'control: same harness, same identity');
      assert.ok(oms3.transcript.includes('primer-marker'), 'the primer reached the first user turn');
      assert.equal(oms.transcript.includes('primer-marker'), false);
      assert.ok(
        oms.transcript.includes('task_status (trusted, already read'),
        'the first turn carries the task status, so the model needs no tool call for it',
      );
      assert.notEqual(oms3.prompt, oms.prompt);
      assert.equal(oms.injection, undefined);
      assert.equal(oms3.injection, 'search-v0', 'an old Worker gets the search-only primer');
      assert.equal(oms3.transcript.includes('topic-card-marker'), false);
      workerV2 = true;
      scopedTo.length = 0;
      const topics = await run(true, [
        ['task_status', {}],
        ['api_lookup', { name: 'getTransferInstruction' }],
        ['search_docs', { query: 'transfer' }],
        ['api_lookup', { name: 'createSolanaRpc' }],
      ]);
      assert.equal(topics.injection, 'topics-v1');
      assert.equal(topics.knowledgeBuilt, 'Built 2026-11-07T00:00:00Z.', 'the record names the corpus version');
      assert.equal(oms.knowledgeBuilt, undefined);
      assert.ok(topics.transcript.includes('topic-card-marker'), 'the topic card reached the first user turn');
      assert.ok(topics.transcript.includes('primer-marker'), 'and so did the topic-scoped hits');
      assert.deepEqual(
        scopedTo,
        ['kit-client', undefined],
        'the primer search is topic-scoped; the model chose its own',
      );
      assert.deepEqual(
        topics.knowledgeCalls,
        { api_lookup: 2, search_docs: 1 },
        "the record counts the model's knowledge calls, not the primer's",
      );
      assert.deepEqual(oms.knowledgeCalls, {});
      assert.notEqual(topics.prompt, oms3.prompt);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      server.closeAllConnections();
      server.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  },
);
