# Offline Blend Solana benchmark

Requires **Node 22.19+** with native TypeScript stripping. Tasks use only Node
builtins: no install, RPC, network, or model calls are needed. Authoring and
validation used Node 22.23.5. Do not run the repository-wide test discovery here:
starter workspaces are deliberately incomplete.

## Agent and evaluator boundaries

Give the agent only a task's `PROMPT.md` and a copy of `workspace/`. Keep `hidden/`
outside its accessible filesystem. Every workspace has two small public tests:

```sh
cd <finished-workspace>
node --test
```

The evaluator runs:

```sh
node bench/blend/grade.ts <task-directory> <finished-workspace>
node --test bench/blend/tooling.test.ts
```

`grade` is also an async exported function. It creates a fresh temporary copy,
overwrites `grade.test.ts` there with the trusted hidden suite, and runs
`node --test --test-reporter=tap grade.test.ts`. **Only hidden tests contribute to
the score**: explicitly naming the file prevents agent-added tests from inflating
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
