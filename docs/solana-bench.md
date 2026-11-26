# Solana Bench (solbench-harness)

`solbench-harness` runs the Solana Bench scoring rule against whole agent harnesses as shipped, each online. Everything needed to rerun it is in this repository: `bench/` (runner in `bench/src/run.ts`, tests in `bench/test/`). It runs from a source checkout.

## What it measures

One agent gets one goal (`bench/solbench-harness/workspace/GOAL.md`, identical for every harness): maximise the number of unique (program id, first instruction-data byte) pairs in successfully executed transactions on a fresh Surfpool 0.10.4 mainnet fork. The agent has at most 50 `submit-tx` calls and 30 minutes of wall clock per run. It never holds a key: the environment signs with a fresh fork-only wallet, and the agent's only Solana endpoint is the environment's RPC (`$SOLANA_RPC_URL`), which refuses everything except reads, `simulateTransaction` and the `solbench_submit` and `solbench_status` methods behind `./submit-tx`.

There are two variants. `basic` funds the wallet with SOL. `swap` also funds it with USDC and USDT for DeFi paths.

The cells compared:

| Cell | Harness | Model and login |
| --- | --- | --- |
| `oms3-web:gpt-sol` | OMS headless, web tools on the hosted search service, reference-service injection if a token is set | GPT-6.1 Sol through the Codex (ChatGPT) subscription |
| `codex-web:gpt-sol` | Codex CLI 0.167.0, live web search, Solana MCP | GPT-6.1 Sol, Codex subscription |
| `claude-code-web:opus-sub` | Claude Code 2.1.319, its own WebSearch and WebFetch, Solana MCP | Claude Opus 5.5 on the Claude Code subscription |
| `oms3-web:opus-sub` | OMS headless as in the first row, with `--provider claude-code --model opus`: OMS owns the tools and budgets, the installed `claude` CLI is only the model | Claude Opus 5.5 on the Claude Code subscription |

The OMS Claude Code cell runs OMS on the host, so `claude` must be on `PATH` (an absolute, non-`node_modules` directory) there, not in the container. The runner stages the Claude login into a private `home/` in the run directory (refresh token removed) and points the CLI at it with `OMS_CLAUDE_CODE_HOME`; the cell refuses to start if any `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH*`, `CLAUDE_CODE_USE_*` or `AWS_BEARER_TOKEN_BEDROCK` variable is set. OMS applies no input-token cap to Claude Code, and Claude Code usage is a subscription charge, so the API-dollar cap never applies. Its run directories are named `<prefix>-solbh-oms3-web-opus-sub-<variant>`.

The existing cells use subscription logins. Their staged login files have refresh tokens and API keys removed. The separate `oms3:blend/<profile>` cells use API dollars through a loopback Blend router, never a subscription login.

### Blend API cells

Every ID in `deploy/blend-worker/profiles.json`, including experimental profiles and all single-model profiles, is accepted as `oms3:blend/<id>`. These cells use the same OMS production headless harness and fork/workspace/goal, with isolated empty auth and agent directories, no web/search/knowledge credentials, 131,072 input tokens and at most 32,000 output tokens per request. They are **not** the online subscription treatment and must be labelled separately when compared.

Use `oms3-web:blend/<id>` for the same API cell with OMS search and fetch enabled (set `OMS_SEARCH_URL` and `OMS_SEARCH_TOKEN`). This does not enable hosted OMS knowledge. Use `--usd-scope anthropic-muse` to apply the series cap only to Anthropic and Muse; xAI and OpenCode Go spend remains in the router log. Keep the same scope and prefix when retrying.

Bind the four provider keys in the trusted host environment; they stay outside the agent container. A separate loopback router is created per attempt. Router JSONL is the dollar/token authority; `oms-record.json` also retains OMS accounting. `--max-usd` (default 4) caps the entire prefix's API series, including reruns, not each attempt. The append-only `<prefix>-blend-budget.jsonl` records holds before dispatch and settlements afterward; interrupted holds remain charged on resume. Successful calls refund unused holds; failed calls retain only outstanding billing exposure. Do not remove this ledger to resume a capped series.

The agent image must be compatible with the host glibc libraries OMS mounts into it. The supplied Ubuntu 22.04 base is compatible with this VM's glibc 2.35; its Dockerfile accepts `BASE_IMAGE` for an equivalent registry mirror. API launches probe the shell with those mounts before any model call, so an incompatible image fails without spending dollars.

```sh
SOLBENCH_HARNESS_SURFPOOL=/path/to/verified/surfpool-0.10.4 \
SOLBENCH_HARNESS_DEPS=/path/to/installed/workspace-deps \
node bench/src/run.ts --cell oms3:blend/claude-haiku-5-5 --variant basic \
  --runs 1 --prefix devblend --max-submissions 10 --max-usd 1 --out-root /path/to/results
```

Each result includes `usd`, `billingUpperUsd`, router tokens, wall time and `forkFailures`. At least three fork RPC health/transport failures, or a dead fork, set the attempt aside as `paused.json` with reason `fork-failure`. Terminal provider 429/usage limits and native `capped:usd` with zero dispatches are also set aside, never scored as zeros. The runner archives each excluded attempt and retries the same slot on a fresh fork at most twice; usage/USD retries back off 60 then 120 seconds and retain the same dollar ledger. A prefix-specific `attempts.jsonl` records dispositions and attempt numbers. Program/transaction failures do not count as fork failures. Set-aside and API-budget-truncated attempts are excluded from tables and paired tests but their costs remain counted.

## Prerequisites

- Linux or macOS with Node 22.19 or newer, and `npm ci --ignore-scripts` done in this repository.
- Docker, with a running daemon (every cell runs in a container on an internal network).
- The Surfpool 0.10.4 binary, whose SHA-256 the runner checks (`3c4a22f4376d007141cc6ac709f60c766a678af24c5224c26ddb78df3566ffd9`). Point `SOLBENCH_HARNESS_SURFPOOL` at it; the default is `.tmp/solbench-harness/surfpool-0.10.4`.
- A login for each cell you run: `codex login` (ChatGPT sign-in) for the Codex and OMS cells, `claude` login for both Claude Code cells. Credentials are read from `~/.codex/auth.json` and `~/.claude/.credentials.json`.
- For the OMS cell: `OMS_SEARCH_URL` (https, or loopback) and `OMS_SEARCH_TOKEN` for an oms-search service. To use the hosted service for web searches and page fetching, unset `EXA_API_KEY`, `TINYFISH_API_KEY`, and `FIRECRAWL_API_KEY`. Leave `OMS_SEARCH_PROVIDER` unset or set it to `auto` or `oms`. To inject hosted Solana guidance, set `OMS_KNOWLEDGE_TOKEN` to a device token from a GitHub-linked OMS account. `OMS_KNOWLEDGE_URL` defaults to the quota-enforced endpoint at `https://barestate.xyz/oms/api/knowledge/mcp`.
- A workspace SDK set, installed once and mounted read-only into every cell:

```sh
mkdir -p .tmp/solbench-harness && cp -R bench/solbench-harness/deps .tmp/solbench-harness/deps
(cd .tmp/solbench-harness/deps && npm ci --ignore-scripts)
export SOLBENCH_HARNESS_DEPS="$PWD/.tmp/solbench-harness/deps"
```

## Build the images

```sh
docker build -t oms-bench-agents:1 bench/agents
docker build -t oms-solbench-harness:1 bench/solbench-harness
```

## Run one cell

Start the open-HTTPS tunnel the online cells need, in its own terminal (it admits only public HTTPS addresses; the host, private networks and cloud metadata stay unreachable):

```sh
node bench/src/run.ts egress --log .tmp/solbench-harness/egress.log
```

Then run, for example, five basic runs of the Codex cell:

```sh
export SOLBENCH_HARNESS_SURFPOOL=/path/to/surfpool-0.10.4
node bench/src/run.ts --cell codex-web:gpt-sol --variant basic --runs 5 --out-root ./runs
```

Pass several `--cell` flags to run cells interleaved, run by run (cell A run 0, cell B run 0, cell A run 1, ...). A run directory that already has a `result.json` is skipped, so the command resumes. A usage limit exhausts at most two backed-off retries, then stops the series with the slot set aside as `paused.json`; rerun the same command after the limit resets. Scored series use 50 submissions; series whose prefix starts with `dev` are for tuning and may use at most 10 (`--prefix dev1 --max-submissions 10`). Create a file named `STOP` in the out-root to stop between runs.

Each run directory holds `result.json`, `submissions.jsonl` (every signed transaction), the Surfpool log, the agent's logs and a workspace trace.

Print the tables:

```sh
node bench/src/run.ts report --out-root ./runs
```

## How scoring works

A pair is the program id of a top-level instruction plus the first byte of its data; each pair counts once per run, and only transactions that executed successfully count. Instructions with empty data have no first byte and count nothing.

The headline score is the count of the remaining pairs after three exclusions: Memo and Memo v1, which accept any data; SPL Noop and Metaplex Noop, whose entrypoints accept any data; and any program the run deployed or upgraded itself (detected from the loader instructions in its own transactions), since a deployed program can be written to accept any data. These are reported in separate columns (`raw`, `arbitrary-data`, `memo`) and never in the headline. A second column drops the signature-verifying precompiles (Keccak, Ed25519, Secp256r1), which treat `data[0]` as a count. The rules are stated in `GOAL.md`, which every harness receives, and its SHA-256 is recorded in each result.

## Comparing cells

- **Same batch.** Cells are compared only on runs from one interleaved series: run i of each cell, in the same variant, run back to back against forks taken minutes apart. The fork is not slot-pinned and fetches accounts lazily, so DeFi state moves between batches; scores from different batches or prefixes are not pooled or compared. The paired comparison matches run i of one cell to run i of the other in the same variant, and the report records the fork slots and the code commit of every run.
- **Forks whose node is unhealthy.** If the mainnet fork fails during a run (submissions fail with "Node is unhealthy" or the Surfpool process dies), that is an infrastructure failure of the fork, not a result. Such a run is excluded from every table and test and the slot is rerun on a fresh fork, in the same batch. A run is not excluded for any reason that depends on its score. Excluded runs are listed with their reason, not silently dropped. The runner sets aside usage-limit stops and OMS infrastructure endings before any submission the same way (`paused.json`); a run that an OMS provider error cut short after submissions is listed as truncated, outside the tables and the tests.
