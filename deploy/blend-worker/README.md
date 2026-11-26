# Blend router core + local host

This package contains the Cloudflare wrapper and a loopback-only development host.
Its dependency versions, TypeScript configuration and node:test setup mirror `../search-worker`.
The portable seam is `handle(request, deps)` in `src/core/handle.ts`; inject fetch,
provider keys, validated profiles, a session store, a clock and a structured logger.

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run format:check
BLEND_LOG=/path/to/costs.jsonl BLEND_PORT=8788 npm start
```

Use Node 22.19+. The host binds **127.0.0.1 only** and reads
`ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENCODE_API_KEY`, `MUSE_API_KEY`.
`BLEND_LOG` is required; cost lines are appended atomically through a serialized
writer. `BLEND_PROFILES` optionally overrides the default `profiles.json`, loaded
and validated at startup. Restart to pick up tuning changes. Never put keys in profiles.

For local OMS development or benchmarks, override the client endpoint with
`OMS_BLEND_URL=http://127.0.0.1:8788/v1` and `OMS_BLEND_TOKEN=local-bench`.
The local host ignores auth and must never be exposed publicly. The hosted
default is `https://barestate.xyz/oms/blend/v1`; without a token override the
client uses the signed-in OMS account. Only HTTPS or loopback HTTP is accepted.
OMS sends its session ID as `x-blend-session` on discovery and inference.
The headless harness accepts `--provider blend --model <profile-id>`; the engine
API accepts `modelSelection: {provider: 'blend', id: '<profile-id>'}`. Unknown
profiles are checked against the authenticated catalog rather than fabricated.

`blend-ember-fable` is an experimental SolBench profile, not a shipped `/blend`
choice. It uses Ember → Fable with two consecutive tool failures or error/empty
response escalation, without a turn threshold or effort override.

`GET /v1/models` lists profiles. `POST /v1/chat/completions` accepts text-only OpenAI
chat transcripts, function tools/tool calls, system/developer messages,
`max_tokens` or `max_completion_tokens` (the latter takes precedence), `temperature`,
`top_p`, `stop`, and `tool_choice`. Multiple choices and multimodal inputs are
rejected rather than silently altered. Reasoning fields/blocks and assistant
`<think>`/`<thinking>` spans are removed across providers; billable reasoning tokens
are still counted. Anthropic receives three or fewer 5-minute ephemeral cache
breakpoints: the last system block and each of the two last non-system messages.
Muse always receives `store:false`. The explicitly requested
`muse-spark-1.3-contributor` single profile costs $0.10 input / $0.20 output /
$0.002 cached per million tokens. **Contributor allows training on submitted
content; `store:false` does not establish a training opt-out.** It is never
selected by the bundled automatic policies; select it only for suitable data.
Go uses its verified Go endpoint, a coding-agent User-Agent and stable conversation ID.

## Cloudflare wrapper

`src/worker.ts` serves only `barestate.xyz/oms/blend/*` as **oms-blend**.
The `GATEWAY` service binding only checks OMS account tokens at `/oms/api/me`;
it does not deploy or modify `oms` or `oms-search-api`. The bearer grammar,
identity checks and cache lifetimes match search-worker: allowed identities
cache for five minutes, refusals for thirty seconds using an absolute expiry
(KV TTL has a sixty-second floor). Gateway transport/5xx failures are not cached.
KV keys contain the token's SHA-256, never the token. Account tokens are removed
before forwarding to the per-user DO and are never sent to providers.

`CACHE` uses the dedicated `oms-blend-cache` namespace
`bc18205747e04418bf41e93e9ce51f98`, separate from the search Worker.

Each hashed user has a SQLite `BlendUser` DO for a sliding minute rate limit,
concurrent-request leases, daily spend and serialized durable policy state.
`BlendGlobal` owns the aggregate UTC-day spend ledger. Defaults, configurable
through vars, are `RATE_PER_MIN=30`, `MAX_CONCURRENT=2`, `USER_DAILY_USD=5` and
`GLOBAL_DAILY_USD=50`. Limits are checked durably before **each** upstream
attempt, including retries and classifier/fallback calls. Reservations include
serialized input, max output, peak/tier pricing and Anthropic cache writes.
Success settles actual list-rate usage and refunds unused funds. Failed calls
settle their assessed usage but retain only their remaining per-call billing
exposure until the UTC day ends. Uncertain admission/settlement RPCs never
refund an unconfirmed hold. Settlements are idempotent and use the original
reservation's day, including across midnight. Records older than seven days
are pruned. Dollar accounting uses integer micro-USD, rounded up per attempt.

Requests have a ten-minute deadline and a 2 MiB body limit. Concurrent-request
leases expire thirty seconds beyond that deadline to recover from isolate
loss; spend reservations are **not** released by a concurrency-lease expiry.
Session storage contains only routing flags/counters/labels under hashed keys,
not transcripts. Durable ledgers survive eviction/restart.

Every admission checks KV `blend:disabled`; any set value gives 503 before auth.
After configuring the real namespace, the remote kill/unkill one-liners are:

```sh
npm --prefix deploy/blend-worker run kill
npm --prefix deploy/blend-worker run unkill
```

Each script runs one `wrangler kv key put/delete --remote` command. KV is
eventually consistent; changes can take roughly sixty seconds to propagate.
There is no additional in-process kill-switch cache.

Bind provider keys as Worker secrets, never vars. With all four keys present
in your shell environment, `npm --prefix deploy/blend-worker run put-secrets`
pipes them through `wrangler secret put` without printing their values. This
script performs remote mutations on `oms-blend`.

Analytics Engine dataset `oms_blend_usage` and console output use only
`user_hash,profile,model,input_tokens,cached_tokens,output_tokens,usd,status,ms`.
Each row is one attempted upstream call (or a zero-cost admission/catalog event),
with the enclosing request's HTTP status. AE indexes the user hash, blobs are
profile/model, and doubles follow the numeric-field order above. Console output
remains available if Analytics Engine rejects a write; durable dollar ledgers
are independent of telemetry. Neither log contains identity, bearer, session
IDs, prompt/response text, tool arguments, provider bodies or keys.

Local validation only:

```sh
cd deploy/blend-worker
npm test
npm run typecheck
npm run format:check
npx wrangler deploy --dry-run
```

## Streaming and accounting

Both JSON and SSE are translated from the corresponding upstream protocol. SSE
tool argument fragments retain indexes and concatenate into normal function calls.
**Streams are currently buffered until usage arrives** so that the required
`x-blend-cost-usd` HTTP header can contain the settled final cost (HTTP headers cannot
be updated after streaming starts). This is SSE-compatible, not low-latency token
delivery. A future live-forwarding mode would need to relax that header contract.

The final SSE chunk has `choices:[]`, aggregate `usage`, and
`blend:{model,cost_usd,calls}`, followed by `[DONE]`. JSON has the same metadata.
Headers name the final upstream model and total request cost, including classifier
and retry calls. Usage aggregates all calls, not only the final answer.
Transport, timeout, HTTP 5xx and 429 failures retry once after a 250ms backoff;
truncated or errored upstream streams also qualify because no output has been
forwarded. Other 4xx, malformed responses, cancellation and limits do not retry.
Failed attempts use returned usage when available, otherwise a conservative
input estimate (serialized upstream UTF-8 bytes plus 1,024, one token per byte)
and zero unknown output. This is an assessed cost, **not a billing upper bound**.
Pre-dispatch refusals cost zero. Every attempt is included in the final receipt.
`x-blend-receipt:settled` and `x-blend-usage` (JSON with aggregate `input`, `cached`,
`output` token counts) accompany error responses too, so OMS can settle a failed
dispatch without treating it as a successful model response.

Logs have `{ts,profile,calls,total_usd,status}`. Calls include
`model,in,cached,out,ms,usd,attempt,status_class,usage_source,dispatched`, upstream
HTTP status when available, and successful completion finish/text/tool/reasoning
counts. No message text, tool args, session IDs, provider bodies or keys are
logged. Errors never echo raw upstream bodies, exception text, or provider headers.
Logging failure fails closed.

Pricing is the 2026-11-20 research snapshot: Haiku >100K, xAI >=200K, Ember >200K
whole-request tiers; Go DeepSeek weekday 01:00–04:00 and 06:00–10:00 UTC doubles
all rates. Anthropic cache writes use the explicit 5-minute 1.25x input price.
Go `usage.cost=0` does not override list-rate token accounting. Rates are in
`src/core/pricing.ts`, not the PAYG catalog. Go subscription/shared-service ToS
eligibility must be reviewed before exposing it through a shared Worker.

## Profile policies

`blend-auto` (default) uses Fable with MiMo Flash checkpoints. `blend-pro`
uses Fable alone, the highest-scoring control. `blend-flash` uses Fable with
GLM Flash checkpoints, the lowest-cost tested checkpoint. See
[Blend](../../docs/blend.md#profiles) for the scores and costs.

Targets can be catalog model IDs or nested policy objects (up to depth 12):

- `{"type":"single","model":"..."}`
- `{"type":"escalate","cheap":"...","strong":"...","trigger":{"tool_failures":2,"assistant_turns":8,"retry_on_error_or_empty":true}}`
- `{"type":"checkpoint","strong":"...","worker":"...","opening_turns":6,"failure_streak":2,"worker_turns":8}`
- `{"type":"plan-exec","planner":"...","executor":"...","replan_every":4}`
- `{"type":"classify","classifier":"...","routes":{"easy":"...","medium":"...","hard":"..."}}`

Escalation is sticky. Failure counts inspect consecutive tool results in the
submitted full transcript, ignoring intervening assistant messages; success resets
the count. Assistant-turn thresholds count assistant messages. An optional
errored/empty cheap call repeats the identical request on strong; tool calls with
empty text are not empty answers. In plan-exec, a last user message resets the
executor cycle and selects the planner. After N executor turns, the next
continuation replans. Classification sees only the first user message once per
session; malformed labels conservatively select hard, while classifier transport
errors fail the request and do not cache a label. Classifier costs count.

Session key is `x-blend-session`, otherwise SHA-256 of a JSON-framed pair of first
system and first user text. State is also namespaced by profile and nested policy
path. `SessionStore.run` must serialize same-session operations; `MemorySessions`
uses a Map and promise queue, including error recovery. State is process-local and
currently unbounded; persistence, eviction, auth, rate/dollar limits, kill switch,
and a Durable Object implementation belong to the next Cloudflare-host brief.
Do not expose this local host publicly.
