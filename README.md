<div align="center">

<img src="https://raw.githubusercontent.com/barestate-ai/oms/main/.github/assets/banner.jpg" alt="Oh My Sol" width="100%">

# Oh My Sol

**The Solana harness, batteries included.**

[![npm](https://img.shields.io/npm/v/@barestate/oms?color=744123&label=npm)](https://www.npmjs.com/package/@barestate/oms)
[![downloads](https://img.shields.io/npm/dm/@barestate/oms?color=744123)](https://www.npmjs.com/package/@barestate/oms)
[![CI](https://img.shields.io/github/actions/workflow/status/barestate-ai/oms/ci.yml?branch=main&label=CI)](https://github.com/barestate-ai/oms/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-744123)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-744123?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20WSL%202-744123)](#install)
<br>
[![Solana Bench](https://img.shields.io/badge/Solana%20Bench-377%20vs%20273%20Codex%20CLI-392b1f?logo=solana&logoColor=white)](#benchmarks)
[![Claude Code](https://img.shields.io/badge/vs%20Claude%20Code-2%C3%97%20on%20Sonnet%205.5-392b1f?logo=anthropic&logoColor=white)](#benchmarks)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/barestate-ai/oms)

[Website](https://barestate.xyz/oh-my-sol) · [Docs](https://barestate.xyz/docs) · [Benchmarks](https://barestate.xyz/docs/benchmarks/overview) · [DeepWiki](https://deepwiki.com/barestate-ai/oms)

</div>

---

Oh My Sol (OMS) runs in your terminal with the model you already use, Codex and Claude Code included, and it beats both Codex CLI and Claude Code on Solana work.

## Install

macOS, Linux and WSL2. Pick one:

**curl (recommended)** — installs Node, Git, Solana CLI and Surfpool as needed:

```sh
curl -fsSL https://barestate.xyz/oms/install | sh
```

Open a new shell, then run `oms` in your project folder. OMS installs privately under `~/.oms`; Solana CLI uses the official Anza installer and its default location under `~/.local/share/solana`. No sudo is needed except when installing Git on Linux. On macOS, finish the Command Line Tools prompt if Git is missing, then rerun. Rerun to upgrade OMS. Set `OMS_HOME` to change the OMS install directory, `OMS_VERSION` to pin a release, `OMS_NO_MODIFY_PATH=1` to leave shell config alone, `OMS_SKIP_SOLANA=1` to skip Solana CLI installation, or `OMS_SKIP_DOCTOR=1` to defer Surfpool installation.

**Homebrew** — installs Node, Git and Solana CLI:

```sh
brew install barestate-ai/tap/oms
```

**npm / npx** — bring Node >=22.19.0, Git and Solana CLI:

```sh
npm install -g @barestate/oms --ignore-scripts --no-audit --no-fund
oms
# Or run without a global install:
npx @barestate/oms
```

The first launch installs Surfpool 1.7.0 and checks its SHA-256. `oms doctor --install` does the same on its own.

## The batteries

- **Solana references.** Programs, instructions and accounts, built in and offline.
- **Error decoding.** `/error 0xbc4` names a program error from Anchor, System and SPL tables and from your own IDL.
- **A local chain.** Surfpool runs beside every session. `/chain`, `/airdrop`, `/tx` and `/rewind` drive it.
- **Toolchain repair.** OMS resolves Anchor and Kit version and build mismatches.
- **Helper agents.** `/team <goal>` splits work across `explore`, `review` and `build` helpers, or your own.
- **A checker the model cannot game.** A task closes only when its pinned checks pass on a fresh local chain.
- **A sandbox.** On macOS every command runs in Seatbelt, with your keys and home folder out of reach.

## Benchmarks

Each model ran in OMS and in its own lab's harness. OMS scored higher on every model.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/barestate-ai/oms/main/.github/assets/solana-bench-dark.svg">
  <img src="https://raw.githubusercontent.com/barestate-ai/oms/main/.github/assets/solana-bench-light.svg" alt="Solana Bench, basic environment: Oh My Sol 377 vs Codex CLI 273 on GPT-6.1 Sol, 303 vs 252 Claude Code on Claude Opus 5.5, 208 vs 100 Claude Code on Claude Sonnet 5.5" width="100%">
</picture>

**Solana Bench**, mean score:

| Model | Environment | Oh My Sol | Own harness | OMS lead |
|---|---|---|---|---|
| GPT-6.1 Sol | basic | **377** | 273 (Codex CLI) | +38% |
| GPT-6.1 Sol | swap | **366** | 283 (Codex CLI) | +30% |
| Claude Opus 5.5 | basic | **303** | 252 (Claude Code) | +20% |
| Claude Opus 5.5 | swap | **258** | 230 (Claude Code) | +12% |
| Claude Sonnet 5.5 | basic | **208** | 100 (Claude Code) | +107% |
| Claude Sonnet 5.5 | swap | **176** | 93 (Claude Code) | +90% |

**Fresh Solana tasks**, runs passed:

| Model | Oh My Sol | Own harness | Input tokens per solved task |
|---|---|---|---|
| GPT-6.1 Sol | **96%** | 76% (Codex CLI) | 42% fewer |
| GPT-6 Astra | **92%** | 71% (Codex CLI) | 51% fewer |
| Claude Opus 5.5 | **92%** | 79% (Claude Code) | 62% fewer |
| Claude Sonnet 5.5 | **71%** | 46% (Claude Code) | 59% fewer |

Charts are in the [benchmark docs](https://barestate.xyz/docs/benchmarks/overview). To run Solana Bench yourself, see [docs/solana-bench.md](docs/solana-bench.md).

## How you use it

Run `oms` in a project folder and chat. The agent reads and edits that folder in place, and `/diff` shows what changed. OMS keeps its own state under `~/.oms/folders/`, so the folder stays clean, and running `oms` there again resumes the conversation.

Switch to the editor with `/workbench` when you want the files and a shell in front of you, and back with `/harness`.

## Bring your own model

| Access you have | Connect in OMS |
|---|---|
| ChatGPT or Codex subscription | `/connect`, then pick a Codex model in `/model` |
| Claude subscription | `claude auth login` once, then `/connect` and **Claude Code** in `/model` |
| MiMo Token Plan | `/connect` with your Token Plan region |
| OpenCode Go | `/connect`, then any OpenCode model |
| OpenAI or Anthropic API key | `/connect` with the key |

With a Claude subscription, OMS runs a native Claude Code chat tied to your OMS conversation and picks it up again when you come back. Every command Claude runs still goes through OMS approvals and the sandbox. [docs/claude-code.md](docs/claude-code.md) covers effort and resume.

## When a task is done

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/barestate-ai/oms/main/.github/assets/task-loop-dark.svg">
  <img src="https://raw.githubusercontent.com/barestate-ai/oms/main/.github/assets/task-loop-light.svg" alt="How a task runs: the model edits the worktree and proposes done, an independent checker runs on a fresh offline Surfpool chain, a pass settles the task" width="100%">
</picture>

A task pins its requirements and verifier files before work starts. The model proposes a requirement as done, and an independent checker decides. It captures the proposed source, starts a fresh offline Surfpool chain and runs the pinned checks. The model cannot edit the pinned files and never closes a requirement itself.

```text
/goal make the escrow tests pass --check "anchor test"
```

`/goal` keeps the agent working until the check passes, feeding each failure back to the model. `/verify` runs the checker on its own, with no model turn.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/barestate-ai/oms/main/.github/assets/checker-dark.svg">
  <img src="https://raw.githubusercontent.com/barestate-ai/oms/main/.github/assets/checker-light.svg" alt="The model can only propose a requirement as done. The independent checker closes it when its checks pass" width="100%">
</picture>

## Your keys stay out of reach

OMS never holds mainnet keys. Mainnet work comes back to you as a transaction to review and sign.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/barestate-ai/oms/main/.github/assets/security-layers-dark.svg">
  <img src="https://raw.githubusercontent.com/barestate-ai/oms/main/.github/assets/security-layers-light.svg" alt="Protections around your keys: prompt rule, file-read guards, shell guard and the operating system sandbox" width="100%">
</picture>

- **macOS:** every command runs under a per-run Seatbelt profile. Writes go only to the worktree, a private home and temp. `~/.ssh`, `~/.config/solana`, `~/.aws`, keypair files and the keychain are unreadable, and the only network destination is the local chain.
- **Linux:** OMS asks you to approve every shell command, with extra warnings for wallet paths, recursive removal and downloads piped to a shell.
- **Docker:** `--sandbox docker` runs commands in a pinned, offline container for repositories you don't trust.

Agent commands start from an empty environment with a private home, so API keys such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` never reach them. Provider credentials stay in private configuration and never enter chat or task files.

## Web access

The agent looks things up through the official Solana MCP, `web_fetch` and `web_search`. Signing in with `/login` turns on hosted search, or you can bring an Exa, Firecrawl, Tavily, Parallel or TinyFish key. Results come back as reference text, and `/web off` turns all of it off.

## Commands

| Command | What it does |
|---|---|
| `/connect`, `/model` | Add a provider, pick a model |
| `/goal <text> --check "<cmd>"` | Work until the check passes |
| `/verify`, `/status` | Run the checker, see requirements and spend |
| `/team <goal>`, `/agents` | Split work across helper agents |
| `/test`, `/run <cmd>` | Run tests or a command in the sandbox |
| `/diff`, `/usage`, `/session` | Changes, tokens and session |
| `/chain`, `/airdrop`, `/rewind`, `/tx` | Drive the local chain |
| `/error <code>`, `/program <name>` | Decode errors and programs |
| `/review` | Offline security report for your program |
| `/workbench`, `/harness` | Editor or chat |
| `/web on\|off`, `/login` | Web access and hosted search |
| `/help`, `/exit` | Every command and key, and quit |

Keys: Enter sends, Shift+Enter adds a line, Esc cancels, PgUp and PgDn scroll, Ctrl+K opens the command menu. Ctrl+C cancels running work, and pressing it twice at an idle prompt quits, as do Ctrl+D on an empty prompt and Ctrl+Q. `/help keys` lists the rest.

## Develop

```sh
npm ci --ignore-scripts
node packages/cli/src/bin.ts doctor --install
npm start
```

`npm test` runs every workspace's tests and `npm run typecheck` checks the types. OMS runs native TypeScript on Node with no build step. [docs/quickstart.md](docs/quickstart.md) covers the source setup and [docs/release.md](docs/release.md) the release archive.

| Package | What it holds |
|---|---|
| `packages/cli` | The `oms` command and the terminal app |
| `packages/engine` | Task controller, sandboxed tools and verification |
| `packages/contract` | Task contract, digest pinning and the evaluator |
| `packages/core` | Tracing, budgets, model catalog and usage |
| `packages/sandbox` | Seatbelt and Docker command sandboxes |
| `packages/surfnet` | Surfpool lifecycle and rewind |
| `packages/review` | The offline security review |
| `packages/signer` | The signing boundary |
| `bench` | Solana Bench harness |

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
