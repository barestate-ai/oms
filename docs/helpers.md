# How to use helper agents and teams

Hand parts of a job to helpers that run beside your chat, then get their reports back. You end up with several pieces of work done at once and one answer to check.

Helpers work in a folder chat (plain `oms` in a folder). Pinned tasks and `oms run` do not use them. See the [helper reference](helpers-reference.md) for every limit and rule.

## Prerequisites

- OMS 0.1.2 or newer, running in a folder chat.
- A direct model selected with `/model`, such as a Codex or MiMo model. Helpers do not work with Claude Code selected; see [How to use Claude Code in OMS](claude-code.md).

## Let the agent use helpers

1. Ask for the work in plain words. The chat's agent decides when a helper is worth it.

   ```text
   Use explore to find every place this program checks the signer, then use review on the result.
   ```

   There are three built-in helpers:

   | Helper | Does |
   | --- | --- |
   | `explore` | Finds code and facts, and reports file paths. Read-only. |
   | `review` | Reads a diff or program and reports problems, most serious first. Read-only. |
   | `build` | Makes one scoped change in files it is given, runs its check, and reports. |

2. Watch the conversation. Each helper shows as a row with its agent, task and time, and a line under it with its status and tokens. Press Ctrl+O to open a helper's own transcript.

3. Read the reports. Each one goes back to the chat's agent, which should check the result before it tells you it is done. Review changes with `/diff` as usual.

## Split a goal across a team

Enter a goal after `/team`:

```text
/team add unit tests for each instruction in programs/vault
```

OMS asks the agent to split the goal into independent pieces, start a helper for each in one turn, do the small or tightly coupled parts itself, check every report and combine them. At most 4 helpers run at once; the rest wait for a free slot.

## See what ran

```text
/agents
```

The first block lists the agents you can start, with whether each is read-only or edits, and where it comes from. The second block, "This session", lists each helper of this conversation with its status, model and tokens. Helpers that were running when OMS stopped show as `interrupted`.

## Stop helpers

Press Esc or enter `/cancel`. Helpers started by that turn stop too.

## Add your own agent

1. Write the file from inside OMS:

   ```text
   /agents new signer-check Check signer and owner validation in Anchor programs
   ```

   This writes `~/.oms/agents/signer-check.md` and prints its path. Add `--edit` for an agent that may change files, and `--project` to write `.oms-agents/signer-check.md` in the current folder instead. OMS never overwrites an existing file.

2. Edit the instructions below the header. `/files` can open the file. A new file looks like this:

   ```markdown
   ---
   name: signer-check
   description: Check signer and owner validation in Anchor programs
   tools: read
   ---
   You are signer-check: Check signer and owner validation in Anchor programs.
   You cannot change files. End with a report under 150 words: what you found or did, with file paths and line numbers.
   ```

3. Ask for it by name:

   ```text
   Use signer-check on programs/vault.
   ```

To make a personal agent use a different model than the chat, add a line such as `model: openai-codex/gpt-6.1-sol` to its header. Use a model you have connected, written as `provider/id`. Project agents cannot choose a model.

## Verification

Run `/agents`. Your agent appears in the list with its source: `~/.oms/agents` or `.oms-agents (this folder)`.

## Troubleshooting

- **`/agents` says "Skipped: ..."**: that file was not loaded. The reason is next to the file name, for example an unknown header field, a name that does not match the file name, or a description over 120 characters. Fix the file; changes are read the next time you list agents or the agent starts a helper.
- **"Helpers need a direct model."**: Claude Code is selected. Pick another model with `/model`.
- **A helper says it needs a file outside its files**: the `build` helper may change only the files the agent listed. Ask again with those files included, or make the change yourself.
- **A helper is stuck on "waiting for ..."**: it is waiting for a free slot, or for another helper that holds files it needs. It starts when they are free.
- **A helper failed with "stopped after ..."**: it hit a time, turn or token limit. Its report so far is returned. Split the task into smaller ones.
- **`/agents new` says the file already exists**: choose another name, or edit the existing file.

## Related

- [Helper reference](helpers-reference.md)
- [How to use Claude Code in OMS](claude-code.md)
- [Quickstart](quickstart.md)
