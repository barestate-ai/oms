# Changelog

## 0.1.3 (unreleased)

- Blend routes coding requests across models through your signed-in, invited OMS account. `/blend` selects Auto; `/blend pro|flash|auto` switches profiles, `/blend off` returns to your previous model, and `/model` lists the Blend profiles. Usage includes the router's settled cost, including retries. Profiles are benchmark-selected on Solana Bench: Auto/Pro route Ember to Fable on real tool failures (score 266, $3.84 per 50-submission run); Flash hands routine work to Ember after Fable's opening turns (230, $2.81). See [Blend](docs/blend.md).
- Selecting text in OMS with the mouse copies it to the clipboard, the same way as in other coding CLIs. Before, the mouse selection did nothing and Cmd+C had nothing to copy.

## 0.1.2

Helper agents: the chat's agent can hand work to helpers that run beside it.

### Helpers and teams

- The agent can start helpers. `explore` finds code and facts, `review` reads a diff or program, `build` makes one scoped change and runs its check. Several run at once, at most 4, and each report comes back to the chat for it to check.
- `/team <goal>` asks the agent to split a goal across helpers and combine the results. `/agents` lists the agents and what each helper in this conversation did, with status, model and tokens. A helper shows as one line in the conversation; Ctrl+O opens its own transcript.
- Your own agents are files in `~/.oms/agents/` or, for one project, `.oms-agents/` in the folder. `/agents new <name> [--project] [--edit] <what it does>` writes one. A project agent beats a personal custom agent of the same name, but cannot replace a built-in. Descriptions are limited to 120 printable characters, and only personal agent files may select a model. The agent cannot rewrite `.oms-agents`; `/agents new` still works.
- Helpers use the chat's model unless a personal agent file names another, and spend from the same session limits. A subscription sign-in such as SuperGrok stays plan usage. Esc and `/cancel` stop helpers too. Helpers need a direct model: with Claude Code selected the agent tool is off and `/team` says so.

### Safety

- Read-only helpers cannot write the folder when commands run under the macOS sandbox. Where there is no sandbox, or YOLO is on, the first report says so.
- A `build` helper takes its files before it starts and cannot change others with the file tools. File tools enforce these claims on every system. Commands may write outside the claim; changes are reported in the result, except observed file-tool writes by another helper. On macOS the sandbox also protects other live claims. Where there is no sandbox, or YOLO is on, the first editing report says command claims are not enforced.
- One helper's long command no longer holds up another helper. The chat's own commands still run one at a time, and the terminal is not shared with helpers.
- Approval questions are asked one at a time, so two helpers asking together do not deny each other. YOLO skips them as it does for the chat.
- Pinned tasks and `oms run` are unchanged.
- Sandboxed commands can no longer read Cargo or npm credentials inside toolchain folders, such as `~/.cargo/credentials.toml` or an `npmrc` under a Node install.

### Claude Code

- Pinned Solana tasks on Claude Code get a short work procedure for capped actions: plan several candidates first, simulate before sending, and stop a script when it stops paying off. They also get notes on how Solana programs are deployed, such as SPL Governance's many separate deployments. Other providers' prompts are unchanged.
- Claude Code runs at high effort by default. Set `OMS_CLAUDE_EFFORT` to change it.
- `program_reference` shows what an instruction is for, and for Orca, Meteora and Raydium, which pool and position operations a wallet can do on existing pools.
- A Solana failure diagnosis adds the failing program's deployment note once per conversation.
- The Claude Code model is resolved inside the OMS session, where its provider registers.
- An empty reply from Claude Code is retried up to twice instead of ending the run. A tool never runs twice: after a tool result, the retry sends a short note to continue. Sign-in, usage-limit, cancel and budget stops still end the run.

## 0.1.1

OMS now works like the pi and Claude Code CLIs: run `oms` in any folder and it edits that folder.

### Start anywhere

- `oms` opens a chat in the current folder and edits files in place, with or without git, uncommitted work included. OMS stores nothing in the folder; conversations live under `~/.oms/folders/` and running `oms` there again picks up where you left off.
- In your home folder, `/` or a folder that holds keys, OMS opens a scratch folder instead and says so.
- Surfpool installs itself on first launch. `oms start` works, `oms --help` fits on one screen and `oms help advanced` has the rest.
- The old demo starter project is gone. Pinned tasks (`oms task create`, `oms run`) are unchanged.

### Fewer prompts, YOLO mode

- On macOS, commands run inside the sandbox without asking. A command the sandbox blocks says so in one line.
- `oms --yolo` or `/yolo` runs commands without asking and without the sandbox, with full network. The footer shows YOLO while it is on.
- On Linux, where there is no sandbox, OMS asks once per command with an option to allow it for the session. `--yolo` and `/yolo` skip those prompts there too.
- The agent can read `.env` files, but their values are masked on screen, in tool output, after Ctrl+O and in restored history. Wallet keypairs and `~/.config/solana` stay blocked. `.git/hooks` and `.git/config` stay read-only.

### A quieter screen

- The conversation, the input and one footer line (folder, model, context). Thinking is shown; reads are one line; edits show only the changed lines; commands show their last lines. Ctrl+O expands, Ctrl+T hides thinking.
- `/connect` lists Codex (ChatGPT), Claude Code and Grok (SuperGrok or X Premium, or an xAI API key) first. `/help` lists every command on one screen. `/exit` and Ctrl+D leave.

### Fixes

- Every Grok (xAI) request failed: OMS sent a `background` field that xAI rejects. It is now sent to OpenAI only.
- A Grok subscription (SuperGrok or X Premium) counts as plan usage, like Codex and Claude Code. It was charged as API dollars against the $5 limit, which blocked larger models.
- One failed request no longer locks the chat. A request the provider rejects is not charged and its reason is shown; a request that breaks off midway is counted at its maximum cost and the chat goes on.
- `/files` works on macOS, `git init` works in a new folder, and opening OMS without sending anything leaves no files behind.

## 0.1.0

First public release, `npx @barestate/oms`.

### Install

- One command: `npx @barestate/oms`. `oms --version` prints the version.
- `oms doctor --install` downloads Surfpool 1.7.0 from the URL in the runtime manifest, checks its SHA-256 against the manifest, and puts it where the starter expects it. A mismatch or failed download installs nothing and says why.
- Docker is not an install prerequisite. Host mode is the product path; `--sandbox docker` selects container execution.
- macOS: host commands run under a per-run Seatbelt (`sandbox-exec`) profile. Writes stay in the worktree, private HOME, temp and Cargo's download caches; pinned verifier files and `.git` are read-only; `~/.ssh`, `~/.config/solana`, `~/.aws`, `~/Library` and similar credential locations are unreadable. `scripts/seatbelt-verify.sh` checks each Seatbelt block on a Mac.
- Linux: no sandbox in v0.1; OMS warns at startup.
- The scrubbed environment (an allowlist) covers agent shell, terminal and verifier processes; tests prove API keys and `AWS_*` never reach them.
- `oms doctor` lists Docker as optional in host mode and reports whether Seatbelt confines commands.

### Commands

- `/goal` runs the agent until an independent check passes, `/clear` starts a fresh conversation, `/test`, `/diff` and `/usage` cover tests, changes and spend.
- Solana commands on the task's local Surfpool: `/chain`, `/rewind`, `/airdrop`, `/account`, `/tx`, `/program` and `/error`. They never call a model and refuse any RPC that is not the task's loopback chain.

### Program reference

- Every session starts with a built-in index of Solana programs in its system prompt: program id, instruction-tag style and instruction names for the native and SPL programs and the most used applications.
- The offline `program_reference` tool returns an instruction's discriminator bytes, accounts in order with signer and writable flags, and argument types, from partial or any-case names. `node scripts/gen-program-reference.ts` regenerates the data from pinned sources.

### Task execution and verification

- Persistent OMS agent sessions, with repository initialization, managed tasks, explicit requirement pinning and task-bound resume.
- Sandbox-backed read/edit/write/POSIX shell tools, fixed OMS resources, and independent offline-Surfpool verification with `/status` and `/verify`.
- Durable before-dispatch token and spend reservations, conservative supported-provider normalization and restart preservation of unknown outcomes.
- Run tasks headlessly and save structured results, transcripts and accounting.
- Keep offline RPC settings consistent across tools, allow explicit long command timeouts, and retain bounded command logs.
- Verifier evidence binds immutable requirements, complete code membership, snapshot bytes and runtime identity; later code changes expose stale evidence.

### Interface

- Harness and Workbench views of one session: file browser, tabs, literal find/replace, split view, sandbox terminal, command palette and dirty-buffer protection.
- Themes (Gruvbox default, Catppuccin Mocha, Tokyo Night, Nord, Dracula, Rose Pine), `/model` and `/connect` setup, `/settings`, and one of four startup pictures with `/art off` to disable them.
- Provider setup for OpenAI API keys, Codex subscription sign-in, Anthropic API keys, OpenCode Zen/Go and Xiaomi MiMo Token Plan, with confirmed `/connect import <path>` from a private file. Claude subscription login is explicitly unavailable under the provider's third-party policy.

### Web access

- `web_fetch` reads public HTTPS pages; it blocks private and loopback addresses and caps time and size. The official Solana MCP docs tools need no key. `web_search` uses your own Exa, Firecrawl, Tavily, Parallel or TinyFish key, or the hosted OMS search after `/login`.
- Turn web access off with `/web off`, `--no-web` or `{"web": "off"}` in the state root's `config.json`. Headless runs stay offline unless `--web` is passed. Run records count web calls.
- `/login` and `/logout` sign in to the OMS account through browser device authorization. The account is used only for hosted web search.

### Solana workflow

- Bounded knowledge-service tools, Anchor and Kit toolchain repair and report-only security review.
