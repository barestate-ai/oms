import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const text = Type.String({ minLength: 1 });
const digest = Type.String({ pattern: '^[0-9a-f]{64}$' });
const nullable = <T extends ReturnType<typeof Type.String> | typeof count>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const object = { additionalProperties: false } as const;
const evidence = Type.Object(
  {
    specificationDigest: digest,
    codeDigest: digest,
    verifierDigest: digest,
    snapshotDigest: digest,
  },
  object,
);

/** Shared wire shape for headless, runner, grader and report. Unknown observations stay null. */
export const RunRecordSchema = Type.Object(
  {
    schema: Type.Literal('oms.run/1'),
    taskId: text,
    contender: text,
    runId: text,
    runIndex: count,
    status: Type.Union([
      Type.Literal('closed'),
      Type.Literal('blocked'),
      Type.Literal('capped'),
      Type.Literal('infra'),
      Type.Literal('invalid'),
    ]),
    reason: nullable(text),
    cap: Type.Union([Type.Literal('usd'), Type.Literal('wall'), Type.Literal('tokens'), Type.Null()]),
    items: Type.Array(
      Type.Object(
        {
          id: text,
          status: Type.Union([
            Type.Literal('open'),
            Type.Literal('active'),
            Type.Literal('proposed'),
            Type.Literal('closed'),
            Type.Literal('blocked'),
            Type.Literal('stale'),
          ]),
          evidence: Type.Union([evidence, Type.Null()]),
        },
        object,
      ),
    ),
    visibleVerdict: Type.Union([Type.Literal('pass'), Type.Literal('fail'), Type.Null()]),
    privateVerdict: Type.Union([Type.Literal('pass'), Type.Literal('fail'), Type.Null()]),
    dispatches: Type.Array(
      Type.Object(
        {
          dispatchId: text,
          provider: text,
          model: text,
          endpoint: text,
          outcome: Type.Union([
            Type.Literal('known'),
            Type.Literal('uncertain'),
            Type.Literal('not_dispatched'),
            Type.Literal('reserved'),
          ]),
          heldMicroUsd: count,
          settledMicroUsd: nullable(count),
          usage: Type.Union([
            Type.Object(
              {
                inputTokens: count,
                outputTokens: count,
                cacheReadTokens: count,
                cacheWriteTokens: count,
              },
              object,
            ),
            Type.Null(),
          ]),
        },
        object,
      ),
    ),
    accounting: Type.Union([Type.Literal('known'), Type.Literal('unknown'), Type.Literal('pending')]),
    settledMicroUsd: count,
    heldMicroUsd: count,
    funding: Type.Union([
      Type.Literal('api'),
      Type.Literal('subscription'),
      Type.Literal('token-plan'),
      Type.Literal('allowance'),
    ]),
    wallMs: count,
    transcriptPath: nullable(text),
    firstVisiblePass: Type.Union([Type.Object({ wallMs: count, spendMicroUsd: count }, object), Type.Null()]),
    identities: Type.Object(
      { task: digest, harness: digest, prompt: digest, image: text, forwarderImage: text },
      object,
    ),
    caps: Type.Object({ tokens: count, spendMicroUsd: count, wallClockMs: count }, object),
    /** Set only on the online head-to-head cells; every other cell ran without web. */
    online: Type.Optional(Type.Union([Type.Literal('web + Solana MCP'), Type.Literal('web: fetch only')])),
    /** Web tool calls in the run (all zero when web is off, as in every offline bench cell). Optional so earlier records still parse.
     * searchBy / fetchBy: answered calls per backend, e.g. {"oms:searxng+tinyfish": 3}; also optional. */
    web: Type.Optional(
      Type.Object(
        {
          webSearch: count,
          webFetch: count,
          solanaMcp: count,
          searchBy: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), count)),
          fetchBy: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), count)),
        },
        object,
      ),
    ),
    /** oms3 only: which first-turn knowledge block ran (topic cards, or the search-only fallback for a Worker without detect_topics). */
    injection: Type.Optional(Type.Union([Type.Literal('topics-v1'), Type.Literal('search-v0')])),
    /** Why oms3 did not get its full primer: a fallback to search-v0, or a topics-v1 run whose search_docs step failed (short, OMS's own wording). */
    injectionFallback: Type.Optional(Type.String({ maxLength: 80 })),
    /** Runs with the knowledge service: the model's calls per knowledge tool (search_docs, api_lookup, ...); tools never called are absent. */
    knowledgeCalls: Type.Optional(Type.Record(Type.String(), count)),
    /** oms3 only: the knowledge corpus version, list_sources' "Built ..." line, read with the first-turn block. */
    knowledgeBuilt: Type.Optional(Type.String({ maxLength: 200 })),
    /** Headless runs: turns started after a turn that changed no task item's state. Optional so earlier records still parse. */
    noProgressContinuations: Type.Optional(count),
    /** Runs with the pre-done edge-case check: whether it ran, its model turns and wall time, and its last command's exit. */
    edgeCheck: Type.Optional(
      Type.Object(
        {
          triggered: Type.Boolean(),
          turns: count,
          ms: count,
          result: Type.Union([Type.Literal('pass'), Type.Literal('fail'), Type.Literal('none')]),
        },
        object,
      ),
    ),
    /** Best-of-N cells only: the chosen attempt, elapsed wall time of the parallel attempts, and each attempt's selection facts.
     * The record's own wallMs, spend and dispatches are summed over every attempt. */
    bestOf: Type.Optional(
      Type.Object(
        {
          chosen: count,
          elapsedMs: count,
          attempts: Type.Array(
            Type.Object(
              {
                runId: text,
                status: Type.Union([
                  Type.Literal('closed'),
                  Type.Literal('blocked'),
                  Type.Literal('capped'),
                  Type.Literal('infra'),
                  Type.Literal('invalid'),
                ]),
                visibleVerdict: Type.Union([Type.Literal('pass'), Type.Literal('fail'), Type.Null()]),
                edge: Type.Union([Type.Literal('pass'), Type.Literal('fail'), Type.Literal('none')]),
                changedLines: count,
                wallMs: count,
              },
              object,
            ),
          ),
        },
        object,
      ),
    ),
  },
  object,
);

export type RunRecord = Static<typeof RunRecordSchema>;

export function parseRunRecord(input: unknown): RunRecord {
  if (!Value.Check(RunRecordSchema, input)) throw new Error('Invalid RunRecord');
  if (
    input.status === 'closed' &&
    (!input.items.length ||
      input.visibleVerdict !== 'pass' ||
      input.items.some((item) => item.status !== 'closed' || !item.evidence))
  )
    throw new Error('Invalid closed RunRecord');
  if ((input.status === 'capped') !== (input.cap !== null)) throw new Error('Invalid RunRecord cap');
  return input;
}
