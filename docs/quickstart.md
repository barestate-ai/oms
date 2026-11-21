# Connect OMS

## Install

macOS, Linux and WSL2. Pick one:

**curl (recommended)** installs Node, Git, Solana CLI and Surfpool as needed:

```sh
curl -fsSL https://barestate.xyz/oms/install | sh
```

Open a new shell afterward. The installer uses `~/.oms` and adds its `bin` directory to your shell config. Solana CLI uses the official Anza installer and its default location under `~/.local/share/solana`; OMS can use it immediately, without a new shell. Rerun to upgrade OMS. On Linux it installs missing Git only with passwordless sudo; otherwise it prints the command to run. On macOS, finish the Command Line Tools prompt if Git is missing, then rerun.

Set `OMS_HOME` for a different OMS directory, `OMS_VERSION` for a specific release, `OMS_NO_MODIFY_PATH=1` to leave shell config alone, `OMS_SKIP_SOLANA=1` to skip Solana CLI installation, or `OMS_SKIP_DOCTOR=1` to defer Surfpool installation. Set these on `sh`, for example `curl -fsSL https://barestate.xyz/oms/install | OMS_VERSION=0.1.2 sh`.

**Homebrew** installs Node, Git and Solana CLI:

```sh
brew install barestate-ai/tap/oms
```

**npm / npx** needs Node >=22.19.0, Git and Solana CLI already installed:

```sh
npm install -g @barestate/oms --ignore-scripts --no-audit --no-fund
oms
# Or run without a global install:
npx @barestate/oms
```

Run `oms` in any folder: it opens a chat that edits that folder in place, keeps its own state under `~/.oms/folders/`, and resumes the last conversation when you run `oms` there again. The first launch installs Surfpool 1.7.0 and checks its SHA-256; `oms doctor --install` does the same on its own.

In a source checkout, run `npm ci --ignore-scripts`, then `node packages/cli/src/bin.ts doctor --install` and `npm start`.

Docker is not part of the install. `npm start` uses host mode: on macOS commands run under a Seatbelt profile without asking (writes only in the folder, no access to keys or other repos, network only to Surfnet); on Linux v0.1 there is no sandbox, OMS tells you once at startup, and each command asks first: allow it once, allow it for the session, or deny. `/yolo` (or `oms --yolo`) turns the asking and the sandbox off after you confirm with `y`, and the footer shows YOLO while it is on. Optional: `--sandbox docker` selects Docker for untrusted repositories with `oms task create` and `oms run`; plain `oms` does not run in Docker.

Enter the slash commands below inside OMS, not in your shell. Arrow keys select a row; Enter confirms; Esc returns. `/connect` configures access and `/model` selects a model. A row marked **Connected** means credentials are configured locally. Never paste credentials into chat, source files or bug reports.

## Codex / ChatGPT subscription

```text
/connect
/model
```

In `/connect`, choose **Codex (ChatGPT subscription)**. Open the displayed URL yourself and complete the browser flow. In `/model`, choose a direct `openai-codex` model, such as `gpt-6.1-sol` when listed. The row should say **Connected** and the selected provider/model should appear in the interface. A ChatGPT login does not configure OpenAI API billing or OMS routed profiles. Plan limits apply; catalog-equivalent spend is not your subscription invoice.

## Claude Code subscription

Install the [official Claude Code CLI](https://code.claude.com/docs/en/setup), then sign in from your terminal:

```sh
claude auth login
claude auth status
```

Choose your Claude subscription when signing in. OMS requires a first-party Claude account login; an API-key, Bedrock, Vertex or other provider login does not configure the Claude Code provider. Return to OMS:

```text
/connect
/model
```

In `/connect`, choose **Claude Code (Claude subscription)**. This checks the installed CLI and its login without sending a model request. In `/model`, choose **Claude Code**, then **Sonnet**, **Opus** or **Haiku** (listed as `claude-code/sonnet`, `claude-code/opus` and `claude-code/haiku`). Selecting it sends no model request; the first message starts the native chat. If you sign in or out in another terminal, reopen `/connect` to refresh the check. Do not copy Claude tokens into OMS; authentication stays with Claude Code.

OMS runs the installed, unmodified CLI as a native Claude chat with a durable session ID bound to this OMS conversation. Claude keeps its own history across user messages and resumes that history when OMS restarts. OMS supplies trusted task instructions and tools; native MCP calls receive the actual results from OMS's guarded executors. Claude's built-in tools, project hooks and additional MCP servers are disabled for this chat, so its operations keep OMS's approvals and sandbox. Claude's own final response cannot close a task without the pinned verification checks passing.

Use the existing session and conversation actions:

- `/session` shows the OMS owner, observed native session ID and state: `new` before initialization, `ready` after the native process initializes, or `disconnected` after it stops. A successful login check alone does not mean the chat is ready.
- Running `oms` again in the folder and the standard OMS resume command restore the saved native identity. With Claude Code selected in `/model`, the next message resumes that history. If the history cannot be resumed, OMS reports the failure without silently creating a replacement chat.
- With Claude Code selected, `/clear` starts a fresh native chat with trusted current task context and clears the OMS conversation view. Previous chat messages are not replayed into the new thread. Task files, requirement status and verification remain intact. If the native reset fails, OMS retains the conversation. Wait for the current turn to finish or use `/cancel` first.

If a native tool batch was interrupted or the native protocol failed verification, review the OMS transcript and tool results before proceeding. Select **Claude Code** in `/model`, then use `/clear` to start a fresh native chat and clear the conversation view, retaining task files and verification. Interrupted tools are never replayed automatically; restarting OMS or reselecting the model does not bypass this guard.

Switching to another provider stops the native transport. Switching back resumes Claude's own thread; messages exchanged with other providers are not imported into it. The Claude Code provider accepts text conversations and OMS tools. Names such as `sonnet` select its cataloged Claude model. Subscription limits and Claude extra-usage settings still apply; OMS does not fall back to an Anthropic API key. Use the Anthropic API-key provider for direct API access.

For a repository task, launch a native chat explicitly:

```sh
oms run --workspace /path/to/repo --task first --provider claude-code --model sonnet
```

After quitting, use the printed resume command, or add `--session <OMS-session-id>` to that launch. `--session` takes the OMS identity from `/session`, which selects the bound native Claude history; it does not take an arbitrary Claude session ID. Plain `oms` reopens the folder's saved OMS conversation and native binding on the next launch.

Claude Code runs at high effort by default. Set `OMS_CLAUDE_EFFORT` to `low`, `medium`, `high`, `xhigh` or `max` before starting OMS to change it; any other value is refused.

OMS reserves the model's full catalog context and output capacity because Claude Code cannot enforce OMS's local per-request output cap. Total token and time limits remain active. Headless runs can select `--provider claude-code --model sonnet`; they omit the input cap that other headless providers use by default. An explicit `--input-tokens` is refused before opening the workspace because the native CLI adds its own request overhead.

Anthropic documents [hosting unmodified Claude Code](https://code.claude.com/docs/en/legal-and-compliance) and [using a signed-in Claude plan with programmatic CLI requests](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). The Claude Code provider uses your local CLI and account, without a separate OMS Claude login.

## MiMo Token Plan

```text
/connect
/model
```

Choose the **Xiaomi Token Plan** provider matching your plan region: `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`, or `xiaomi-token-plan-ams`. Enter the plan credential in the private setup prompt. Do not choose the `xiaomi` PAYG provider for a Token Plan. In `/model`, choose the corresponding direct MiMo model. Success locally is a **Connected** row for that regional provider.

## OpenCode Go

```text
/connect
/model
```

Choose **OpenCode Go** in `/connect` and enter its credential in the private prompt. Select an available `opencode-go` direct model in `/model`. A **Connected** row confirms local configuration. Subscription limits apply, and provider extra-usage settings may allow additional billing. OMS's catalog-equivalent spend does not describe your plan invoice.

## OpenAI-compatible key

```text
/connect
/model
```

Choose a built-in provider that matches your endpoint, enter its key in the private prompt, then choose a direct model in `/model`. The model should show **Connected**. For OpenAI itself, choose the API-key entry rather than Codex subscription login. Arbitrary OpenAI-compatible endpoints are not supported by the current direct runtime: OMS disables custom `models.json` loading. Do not invent `--base-url` or `--api-key` flags; neither is an OMS launch option.

## Web access

Web tools are on by default in `npm start` and `oms run`. They run in the OMS process, not in the sandbox.

- `web_fetch` and the `solana_*` docs tools (from the official Solana MCP) need no key.
- `web_search` needs a key of your own, exported before you start OMS. For example:

  ```sh
  export FIRECRAWL_API_KEY=...   # or EXA_API_KEY, TAVILY_API_KEY, PARALLEL_API_KEY, TINYFISH_API_KEY
  npm start
  ```

  Firecrawl's free tier is 1,000 credits a month (a search costs 2 credits per 10 results) and 10 requests a minute. With several keys, OMS fails over between them on rate limits.

Hosted search: `/login` signs in to your OMS account through browser device authorization and enables the hosted oms-search backend; `/logout` removes it. Signing in does not select a model or send inference.

Turn web access off:
- with `/web off` in a session (`/web` alone shows the state and the call counts);
- with `npm start -- --no-web` for one launch;
- with `{"web": "off"}` in `~/.oms/config.json`.

Headless runs have no web access unless you pass `--web`.

## Diagnose a failed setup

```sh
node packages/cli/src/bin.ts doctor
node packages/cli/src/bin.ts doctor --json
node packages/cli/src/bin.ts doctor --surfpool-binary /absolute/path/to/surfpool
```

OMS uses `~/.oms/tools/surfpool-1.7.0/surfpool` (or `.tmp/tools/surfpool` in a source checkout that has one), not the executable on PATH. `doctor --surfpool-binary` checks a different binary for that doctor invocation only; it does not configure subsequent launches.

Doctor checks local tools without starting an agent. It does not validate provider login or make a model request. Open `/connect` and `/model` to inspect saved access. Install the pinned Surfpool release using the matching archive and checksum in [runtime-manifest.json](../packages/engine/runtime-manifest.json). `--programs` also requires the host Anchor toolchain.

Inside OMS, `/status` shows task state, `/verify` requests independent checking, `/help` lists implemented commands, and `/quit` exits after cleanup. Ctrl+Q does the same, as does Ctrl+D on an empty prompt or Ctrl+C twice at an idle prompt; one Ctrl+C cancels running work.

More commands, none of which call a model unless noted:

- Work: `/goal <text> [--check "<command>"]` keeps the agent working until an independent check passes (the command, run in the sandbox, or the task's pinned verifier when there is no `--check`), up to five checks and within the budget; `/goal` shows it and `/goal clear` drops it. `/test` runs the project's tests in the sandbox. `/clear` starts a fresh conversation in the same task. `/cancel` stops any of them.
- Helpers: in a folder chat the agent can hand a task to helper agents and read their reports. `explore` and `review` only read, and their commands run with the folder unwritable on macOS (on Linux, or with YOLO on, the first report says the limit is not enforced). `build` file tools refuse changes outside the files it is given. Commands may write outside those files, and changes are reported except observed file-tool writes by other helpers; the macOS sandbox also protects other live claims. On Linux, or with YOLO on, the first editing report says command claims are not enforced. Read-only commands may still write temporary files and toolchain caches or use the shared Surfnet; checks that write build output belong in a `build` helper. At most 4 helpers run at once, and they are charged to the same session limits as the chat. `/team <goal>` asks the agent to split a goal across helpers. `/agents` lists them and what each helper did; `/agents new <name> [--project] [--edit] <what it does>` writes your own agent file to `~/.oms/agents/` or, with `--project`, to `.oms-agents/` in the folder (commit it to share it). A project agent beats a personal agent of the same name, but project agent files cannot replace built-ins or select a model, and descriptions must fit in 120 printable characters. The agent cannot rewrite `.oms-agents`; `/agents new` writes it from OMS. Helpers need a direct model, not a Claude Code chat.
- Inspect: `/diff [path]` shows task changes against the base (long diffs open read-only in the workbench) and `/usage` shows tokens, spend, time and the caps.
- Solana, on the task's local Surfpool only: `/chain` (RPC, slot, health), `/rewind confirm` (restart the chain from its starting state), `/airdrop <address> [sol]` (up to 100), `/account <address>`, `/tx <signature>`, `/program <name|id> [instruction]` and `/error <code> [program]`.

Commands that read (`/status`, `/session`, `/usage`, `/diff`, `/chain`, `/account <address>`, `/tx`, `/program`, `/error`) work while the agent runs; the rest wait for it or `/cancel`. For a provider error, retain the error category and provider/model name, but omit credentials and sign-in URLs from reports.
