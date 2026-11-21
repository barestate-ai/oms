# Helper agents reference

Helper agents are separate model sessions the chat's agent can start for a scoped task. This page lists the commands, agent files, limits and safety rules. For steps, see [How to use helper agents and teams](helpers.md).

Helpers exist only in a folder chat. They are not available in pinned tasks or `oms run`, and with Claude Code selected.

## Commands

| Command | What it does |
| --- | --- |
| `/team <goal>` | Asks the agent to split the goal into independent pieces, start a helper for each in one turn with the `agent` tool, do small or coupled parts itself, check every report and combine them. Refused while Claude Code is selected. |
| `/agents` | Lists the agents (name, read-only or edits, description, source), then the helpers of this conversation (id, task, status, model, tokens). Shows why helpers are off when they are. Lists any agent files it skipped. |
| `/agents new <name> [--project] [--edit] <what it does>` | Writes an agent file from a template and prints its path. |

`/agents new` flags:

- `--project` writes to `.oms-agents/` in the folder. Without it the file goes to `~/.oms/agents/`.
- `--edit` sets `tools: edit`. Without it the agent is read-only.
- Everything else after the name is the description. It may not contain ` #`.

Esc, Ctrl+C and `/cancel` stop running helpers. Ctrl+O on a helper's line opens its own transcript.

## Built-in agents

| Name | Tools | Description |
| --- | --- | --- |
| `explore` | read-only | Find code and facts, report file paths |
| `build` | edits | Make one scoped change and run its check |
| `review` | read-only | Read a diff or program, report problems |

Each helper ends with a report of under 150 words. The report returned to the chat is capped at 4,000 characters.

## Agent files

Agents are Markdown files named `<name>.md` in:

1. `~/.oms/agents/` (personal)
2. `.oms-agents/` in the folder (project)

Precedence, from lowest to highest: built-in, personal, project. A personal agent with a built-in's name replaces that built-in. A project agent with the same name as a personal agent replaces it, but a project agent cannot replace a built-in; that file is skipped.

A file is a header between two `---` lines, then the instructions:

```markdown
---
name: reviewer
description: Review diffs for missing signer checks
tools: read
model: openai-codex/gpt-6.1-sol
---
Instructions for the helper go here.
```

| Field | Required | Rule |
| --- | --- | --- |
| `name` | yes | Lowercase letters, digits and dashes; starts with a letter; at most 32 characters; must equal the file name without `.md`. |
| `description` | yes | At most 120 printable characters. |
| `tools` | no | `read` (default) or `edit`. |
| `model` | no | `provider/id`. Personal files only; a project file's `model` is ignored. |

Other rules:

- Header lines are `key: value`. A trailing ` # note` after a value is dropped. Unknown fields skip the file.
- The instructions may not be empty.
- A file must be a regular file of at most 16 KB. At most 64 `.md` files are read per folder, in name order.
- A skipped file is listed under "Skipped" in `/agents`; the others still load.
- The agent cannot rewrite `.oms-agents`. `/agents new` can still write there.

## Models, limits and cost

- A helper uses the chat's model and thinking level, unless a personal agent file names another model. If that model is not available, or is Claude Code, the helper does not start.
- Helpers spend from the same session limits and ledger as the chat. A subscription sign-in stays plan usage.
- A helper's context is capped at 200,000 input tokens (less for a model with a smaller window).
- When several helpers' requests would together exceed the allowance, a request waits for one in flight to finish instead of failing.

| Limit | Value |
| --- | --- |
| Helpers running at once | 4; more wait for a slot |
| Helpers started per user message | 12 |
| Turns per helper | 40 |
| Tokens per helper | 300,000 |
| Time per helper | 10 minutes |

A helper that reaches a turn, token or time limit stops and is reported as failed, with its report so far.

## Safety

**Read-only helpers.** On macOS, commands run under the sandbox, which makes the folder read-only for them. Without the sandbox (Linux, or YOLO on), read-only is not enforced for commands. The first report from a read-only helper says so. Any file such a helper changed is listed in its result as `changed files (read-only agent)`.

**Edit helpers and claims.**

- Before it starts, an `edit` helper claims the files the agent listed in `files`. With none listed it claims the whole folder.
- A claim is folder-relative paths or globs (`*`, `**`, `?`). A trailing `/` means everything below. `..` and absolute paths outside the folder are rejected.
- Claims are taken all at once, in arrival order. A helper whose files overlap a held claim waits and shows `waiting for <helper>`. Read-only helpers take no claim.
- The file tools (`edit`, `write`) refuse paths outside the claim, on every system.
- Commands can write outside the claim. Those files are listed in the result as `touched outside claim`, except files another helper wrote with its file tools. On macOS the sandbox also protects files claimed by other live helpers. Without the sandbox, or with YOLO on, the first editing report says claims are not enforced for commands.

**Commands and approvals.**

- Each helper's commands run in their own lane: one helper's long command does not hold up another. The chat's own commands still run one at a time. The terminal is not shared with helpers.
- Approval questions are asked one at a time, so helpers asking together do not deny each other.
- `/yolo` skips approvals for helpers as it does for the chat, and turns the sandbox off. See [Host mode and sandboxing](../README.md#host-mode-and-sandboxing).

## Claude Code

Helpers need a direct model. With Claude Code selected the `agent` tool is off, `/team` is refused, and `/agents` shows: "Helpers need a direct model. Claude Code runs as one chat, so pick another model with /model." The tool comes back when you select another model.

## Environment

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `OMS_CLAUDE_EFFORT` | `low`, `medium`, `high`, `xhigh`, `max` | `high` | Effort level OMS passes to the Claude Code CLI. Any other value is an error. See [How to use Claude Code in OMS](claude-code.md). |

## Related

- [How to use helper agents and teams](helpers.md)
- [How to use Claude Code in OMS](claude-code.md)
