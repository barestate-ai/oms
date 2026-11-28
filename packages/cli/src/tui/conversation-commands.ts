import { goalSummary, parseGoalArguments } from './goal.ts';
import { budgetLine } from './inspect-commands.ts';
import { refuse, refuseWith, type Prepared } from './prepared.ts';
import { singleLine } from './transcript.ts';
import type { CommandContext } from './commands.ts';

const HANDOVER_PROMPT = `Write a handover note for a new session that will continue this work and has seen none of this conversation.
Use these headings: Goal, Done, In progress, Next steps, Key files and commands, Decisions and constraints, Open questions.
Be specific: name the files, commands, branches and errors, and say what was tried. Leave out finished detail the next session does not need.
Do not use tools. Reply with the note only.`;
const HANDOVER_SEED = `This is a handover from the previous session, which has ended. Read it, then reply in one or two lines with what you will pick up first, and wait.`;

/** The text of the reply the agent just finished, or nothing when the turn failed, was stopped or said nothing. */
function finishedReply(messages: readonly unknown[]): string {
  const last = messages.at(-1) as { role?: string; stopReason?: string; content?: unknown } | undefined;
  if (last?.role !== 'assistant' || last.stopReason !== 'stop' || !Array.isArray(last.content)) return '';
  return last.content
    .flatMap((block: { type?: string; text?: unknown }) =>
      block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
    )
    .join('\n')
    .trim();
}

/**
 * /handover [what to stress]: the agent writes a handover note, then a new conversation starts with that note as its
 * first message. Nothing is cleared unless the note was written.
 */
export function handoverCommand(ctx: CommandContext, argument: string): Prepared {
  const { harness } = ctx;
  if (!harness.session.messages.length) return refuseWith('Nothing to hand over yet');
  return {
    ok: true,
    async run(signal) {
      const stop = () => void harness.session.abort().catch(() => {});
      signal.addEventListener('abort', stop, { once: true });
      try {
        await harness.session.prompt(
          argument.trim() ? `${HANDOVER_PROMPT}\n\nMake sure it covers: ${argument.trim()}` : HANDOVER_PROMPT,
          { expandPromptTemplates: false },
        );
      } finally {
        signal.removeEventListener('abort', stop);
      }
      const note = signal.aborted ? '' : finishedReply(harness.session.messages);
      if (!note)
        return {
          title: 'handover',
          text: 'No handover note was written, so this conversation continues.',
          failure: 'No handover note was written',
          failureShown: true,
        };
      if (harness.session.model?.provider === 'claude-code') await harness.nativeChat?.reset();
      harness.session.agent.reset();
      harness.session.sessionManager.resetLeaf();
      ctx.goal.set(undefined);
      ctx.conversation.clear();
      return {
        title: 'handover',
        text: 'New conversation · it starts from the handover note · files unchanged',
        ask: `${HANDOVER_SEED}\n\n${note}`,
      };
    },
  };
}

/** /clear: a fresh conversation in the same task. A native Claude chat resets through its own controls, so it runs as work. */
export function clearConversation(ctx: CommandContext, argument: string, draft: string | undefined): Prepared | void {
  if (argument) return refuseWith('/clear takes no arguments');
  const { harness } = ctx;
  if (harness.session.model?.provider === 'claude-code') {
    const chat = harness.nativeChat;
    if (!chat) return refuseWith("Couldn't reset the Claude chat");
    return {
      ok: true,
      async run() {
        await chat.reset();
        harness.session.agent.reset();
        harness.session.sessionManager.resetLeaf();
        ctx.goal.set(undefined);
        ctx.conversation.clear();
        return {
          title: 'clear',
          inPlace: true,
          text: `New Claude chat · earlier messages are not sent · ${
            ctx.harness.kind === 'chat' ? 'files unchanged' : 'files and task unchanged'
          }`,
        };
      },
    };
  }
  try {
    harness.session.agent.reset();
    // The session file keeps its history; the next entry starts a new branch, so a resume sees only what follows.
    harness.session.sessionManager.resetLeaf();
  } catch (error) {
    return refuseWith(
      `Couldn't clear the conversation · ${singleLine(error instanceof Error ? error.message : 'unknown error', 200)}`,
    );
  }
  ctx.goal.set(undefined);
  ctx.conversation.clear();
  ctx.show(
    'clear',
    ctx.harness.kind === 'chat' ? 'New conversation · files unchanged' : 'New conversation · files and task unchanged',
    draft,
  );
}

/** /goal [<text> [--check "<command>"] | clear]: show, clear, or start the loop that works until the check passes. */
export function goalCommand(ctx: CommandContext, argument: string, draft: string | undefined): Prepared | void {
  const request = parseGoalArguments(argument);
  if (request.kind === 'error') return refuse(request.message);
  if (request.kind === 'set') {
    ctx.startGoal(request.text, request.check, draft);
    return;
  }
  if (request.kind === 'clear') {
    ctx.goal.set(undefined);
    ctx.show('goal', 'Goal cleared.', draft);
  } else ctx.show('goal', goalSummary(ctx.goal.get(), budgetLine(ctx.harness), ctx.harness.kind === 'chat'), draft);
}
