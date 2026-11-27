# Offline Blend Solana benchmark

## Running a batch

```sh
node bench/blend/run.ts --configs mimo-v2.6-flash,claude-haiku-5-5,grok-4.3 \
  --batch pilot --max-usd 1.50 \
  --task-ids lamport-accounting,clock-sysvar,pda-ata-curve
node bench/blend/report.ts ~/blend-batches/pilot/runs.jsonl mimo-v2.6-flash claude-haiku-5-5
```

Bind the router's four provider keys to the **runner process only**. The runner
starts a loopback Node router per cell, using the production portable core and
the checked-in profiles. Each router has one private JSONL, attributable to that
cell's single OMS session (including helper/policy calls). Provider keys never
enter agent containers or worker environments. Nothing prints task titles,
prompts, responses, tool arguments or raw errors.

Defaults: `--tasks bench/blend/tasks`, `--reps 1`, `--concurrency 4`,
`--run-usd 0.60`, `--minutes 12`, `--tokens 250000`. `--batch`, `--configs` and
`--max-usd` are required. Additional flags: `--task-ids id,id`,
`--out /absolute/private/batch-directory`, `--backend auto|docker|host`.
Any task directory with the same layout works; no manifest ID allowlist is used.
`--profiles /private/profiles.json` loads and hashes a frozen alternative policy
catalog without changing the shipped profiles. Single-model admission rates are
unchanged; escalation admission sums the conservative rates of cheap and strong
to cover both calls in an error/empty fallback. Final receipts still settle cost,
and the router-side spend bound remains in force. Other policy shapes retain the
generic reservation envelope.
Never point this at the sealed set until the final run is authorized.

The runner probes Docker and an actual OMS task session before paid work;
`auto` falls back to host only if that fails. Explicit `docker` fails closed.
Pinned task setup uses disposable Git seed commits in **temporary task repos**;
it never stages or commits the OMS checkout. OMS's standard task harness is used,
with the original ticket as its prompt, 32K input / 4096 output per request,
bounded execution, no web or knowledge, and visible tests as the proposal check.
All settings are identical across configurations. Single-model reservation
prices come from the router's pricing table (including conservative tier/peak
bounds), avoiding the app's generic placeholder admission prices. Final costs
still come through the normal Blend receipt and OMS metered stream.

Only starter workspace files enter the task worktree; hidden graders and
references are not mounted into it. After OMS closes, `grade.ts` runs hidden
tests only in a separate network-disabled Docker container when Docker is the
chosen backend. Host fallback is not a security boundary, including grading.
The grading image is Node 22. Private OMS state includes its normal transcript;
**batch records and router logs contain no prompt/response text**. Artifacts
remain outside the checkout for audit, including finished workspaces and changed
file names. Agent-visible repository code is never used as runner configuration.

Each batch directory is create-once (no automatic resume). `batch.json`
and each `runs.jsonl` row record Git revision, a hash of tracked diffs plus
untracked nonignored files, the profiles hash, task hashes and settings. Router
cost sums reported usage at list rates. Each transport, 5xx or 429 failure is
retried once after a 250ms backoff, before buffered output reaches OMS. Every
attempt is logged separately with a status class and usage source. A failed
attempt settles reported usage when available, otherwise input is estimated
conservatively from serialized upstream bytes plus protocol allowance (one token
per byte); no missing output is invented. These are assessed costs, not invoices.
OMS settles failed requests from the same authoritative header, preserving the
error event rather than pretending the model succeeded. OMS cost is integer
micro-USD rounded up per dispatch. Tokens include cached input
**once**, and output includes reasoning.
`wall_ms` measures OMS setup/turn/cleanup, excluding the hidden grader.
Per-call spend is appended to `~/blend-research/spend.jsonl`.

Budget admission reserves the **entire run cap** for each in-flight cell, then
refunds unused funds on reconciliation. Consequently concurrency can be lower
than requested, and a small remaining budget may not admit another run even if
its eventual cost would have fitted. A second router-side byte/output/rate bound
prevents dispatch beyond the per-run cap. Finished reservations settle to router
cost (`budget_charge_usd`), including failed-call estimates, not the full run
cap. For actual-billing safety the scheduler separately retains only the failed
attempts' byte/output/rate upper bounds (`billing_upper_usd`), not $0.60 per run.
This bounds unreported output too, which an input-only estimate cannot promise.
Only an internal dispatch/log reconciliation mismatch retains a full reservation.
Scheduling takes an ordered prefix of task × rep ×
config, interleaving configs for each task. Budget failures therefore do not
prefer one configuration's whole task list.

Provider run/request concurrency defaults to `opencode-go=1,anthropic=3,xai=2,muse=2`;
override with `--provider-concurrency provider=N,...`. Mixed profiles also acquire
the actual upstream provider's permit until that buffered attempt settles.
Terminal provider 429/usage limits and pre-dispatch USD admission caps are infra
outcomes, not zero scores. Each slot defaults to at most two fresh-workspace retries
(`--infra-retries 0|1|2` can lower the limit),
queued after 60/120-second backoffs and admitted against the same batch budget.
`runs.jsonl` retains every attempt, its attempt number, eligibility, infra reason,
and retry delay; infra scores/passed/total are null. Reports exclude infra attempts
from quality/pairing while charging all their receipts. Exhausted or unaffordable
retries leave missing observations; they are never imputed as zero.

Other errored runs are still graded when a
finished workspace exists; missing workspaces or failed graders score zero. Solved
counts count perfect **run observations** (not unique tasks across repetitions).
The paired test averages repetitions within each task, pairs only tasks present
for both configs, and enumerates all sign flips of nonzero task differences.
Its two-sided statistic is the absolute sum of paired differences; ties cancel
algebraically. No Monte Carlo approximation or unpaired observations are used.
The exact implementation permits up to 24 nonzero pairs (the suite has 16).

Tests: `npm test -w @oms/bench`; runner/report tests live in
`bench/test/blend-runner.test.ts`, so workspace typechecking includes them.

Requires **Node 22.19+** with native TypeScript stripping. Tasks use only Node
builtins: no install, RPC, network, or model calls are needed. Authoring and
validation used Node 22.23.5. Do not run the repository-wide test discovery here:
starter workspaces are deliberately incomplete.

The expert extension has sixteen d5 tasks, four per hard-suite theme. Manifest
`v3` uses seed `blend-solana-expert-v1-2026-11-20`, two dev and two sealed tasks
per theme. Only the eight dev tasks live in `tasks-expert/`. Aggregate authoring
checks are in `expert-validation.json`; held-out tasks and all references remain
private under `~/blend-sealed/expert/`. Never reopen them after sealing. Select
the dev extension with `--tasks bench/blend/tasks-expert`. The expert gate uses
one infrastructure retry at most; the remaining-single batch disables slot
retries to retain usage-limit exclusions without spending its cap on retries.

## Agent and evaluator boundaries

Give the agent only a task's `PROMPT.md` and a copy of `workspace/`. Keep `hidden/`
outside its accessible filesystem. Every workspace has two small public tests:

```sh
cd <finished-workspace>
node --experimental-transform-types --test
```

The evaluator runs:

```sh
node bench/blend/grade.ts <task-directory> <finished-workspace>
node --test bench/blend/tooling.test.ts
```

`grade` is also an async exported function. It creates a fresh temporary copy,
overwrites `grade.test.ts` there with the trusted hidden suite, and runs
`node --experimental-transform-types --test --test-reporter=tap grade.test.ts`.
The trusted visible gate uses the same transform mode for every suite, supporting
Node 22 enums and parameter properties. **Only hidden tests contribute to the score**:
explicitly naming the file prevents agent-added tests from inflating
the denominator. Visible tests are validated separately during suite authoring.
The result is `{passed,total,score:passed/total}`. Crashes, malformed TAP, excessive
output (>8 MiB), and timeouts receive zero with the original hidden-test
denominator. Deadline is 60 seconds; the API permits a shorter deadline for tests.
Missing evaluator inputs, invalid deadlines, and symlink/nonregular-file
workspaces are infrastructure/input errors and throw. Inputs are never modified;
the temporary copy is removed even after failure.

This is **not a security sandbox**. Run untrusted agents and their tests with
separate filesystem, process, credential, and network isolation. Never mount the
sealed directory into an agent sandbox. Workspaces and hidden tests are flat,
independent `node:test` cases; the grader expects 8–20 literal `test(...)` calls.

## Reproducible split and hashes

The original suite has 32 tasks: difficulty counts **10 / 12 / 10**. The fixed
seed is `blend-solana-v1-2026-11-20`. `split.ts` lexically sorts task IDs within
each difficulty, applies a SHA-256-counter-seeded Fisher–Yates shuffle with
unbiased rejection sampling, then halves each stratum. Each split contains
**5 / 6 / 5**, for 16 tasks. No task content or observed score influences the split.

Before sealing, the reproducer is:

```sh
node bench/blend/split.ts [seed] [tasks-directory] [manifest-path]
```

It intentionally requires all 32 tasks and will refuse an incomplete/sealed
tree. `manifest.json` records every original task's ID and SHA-256. A task tree
hash covers **all regular files**, including prompt, metadata, starter and hidden
tests. Recursively collect POSIX relative file paths and lexically sort them;
for each path hash UTF-8 `path`, NUL, ASCII decimal byte length, NUL, then the exact
file bytes. File modes, timestamps, and empty directories are not hashed.
Symlinks and nonregular files are rejected.

After sealing, only dev tasks remain here. Held-out tasks and **all** reference
solutions, independent vector-generation code, and full validation logs are
outside the repository under `/home/ubuntu/blend-sealed/`. The held-out tar and
its SHA-256 file are there too. Do not reopen held-out task contents until the
user explicitly authorizes the final run. Task hashes were recorded after final
formatting and validation, before moving directories.

## Evaluation scope

The contracts distinguish wire-level parsing from runtime policy, and state
intentional bounded/strict validation choices explicitly. Examples include
canonical short-vecs, rational rent rounding, ALT lifecycle checks, UTF-8 BOM
preservation, fee caps and inverse amounts, and wire codecs that permit duplicate
keys while transaction verification rejects duplicate static keys.

Every reference was checked against all visible and hidden cases; every starter
fails a strict majority of hidden cases. Independent Python `struct`, `Decimal`,
`Fraction`, and `hashlib` vectors cover 31 tasks; the signature oracle is anchored
to RFC 8032 §7.1 test 1. Cross-checks additionally use the installed
`@solana/kit` 8.6.0 for base58, exhaustive compact-u16, PDA/ATA, curve membership,
and legacy/v0 message fixtures. SDK imports appear only in sealed authoring code,
never in a task or its tests. These checks establish correctness and starter
separation, not an empirical claim about any particular model's success rate.
