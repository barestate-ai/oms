import { randomUUID } from 'node:crypto';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { KnowledgeConfig } from './knowledge-service.ts';
import { BYTES_PER_TOKEN, CONTEXT_FIXED_OVERHEAD, createContextTrimmer } from './context-trim.ts';
import type { SessionLifecycle } from './session-lifecycle.ts';
import type { RuntimeEnvironment } from './session-environment.ts';
import type { SessionTools } from './session-tools.ts';
import type { CommonSessionOptions } from './session-types.ts';
import {
  CLAUDE_CAPPED_WORK,
  CLAUDE_DEPLOYMENT_KNOWLEDGE,
  knowledgeHint,
  omsChatPrompt,
  omsSystemPrompt,
  WEB_PROMPT,
  WEB_PROMPT_NO_KNOWLEDGE,
} from './system-prompt.ts';
import { elideOldFetches } from './web.ts';
import { omsCommand } from './cli-command.ts';

/** The prompt text and the per-turn context hooks of one session. */
export interface SessionHooks {
  /** The id shared by every model call of one user request; budget accounting groups calls by it. */
  turn: { id: string };
  /** Keeps what is sent to the model inside the context window; the session transcript keeps everything. */
  trim: ReturnType<typeof createContextTrimmer>;
  /** The system prompt for each state of the knowledge credential; the turn start picks the one that matches. */
  promptFor(config: KnowledgeConfig | undefined): string;
  /** The extension that applies the prompt and context hooks, blocks session surgery and registers the status tools. */
  policy: ExtensionFactory;
}

export function createSessionHooks(
  options: CommonSessionOptions,
  life: SessionLifecycle,
  env: RuntimeEnvironment,
  tools: SessionTools,
): SessionHooks {
  const { taskRoot, web } = tools;
  const turn = { id: randomUUID() };
  // The context hook sees no system messages, so the rendered prompt bytes are measured at turn
  // start; the trimmer reserves them plus the tool-schema and envelope allowance under the cap.
  let promptBytes = 0;
  // A local input cap is enforced on serialized bytes (one byte can be one token), so it is
  // converted back to the trimmer's tokens-bytes estimate; the model window stays an estimate.
  const trim = createContextTrimmer(
    () =>
      options.maxInputTokens === undefined
        ? life.liveSession?.model?.contextWindow
        : Math.ceil(options.maxInputTokens / BYTES_PER_TOKEN),
    () =>
      // The absolute overhead budget guards the byte-provable local cap; the window path keeps the
      // proportional margin (the measured-bound payload hook is the hard gate there).
      options.maxInputTokens === undefined ? 0 : promptBytes + CONTEXT_FIXED_OVERHEAD,
  );
  const promptFor = (config: KnowledgeConfig | undefined) =>
    (env.contract ? omsSystemPrompt : omsChatPrompt)(
      taskRoot,
      tools.toolchainSummary,
      `${knowledgeHint(options, config)}${web ? (config ? WEB_PROMPT : WEB_PROMPT_NO_KNOWLEDGE) : ''}`,
    );
  const policy: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', (event, ctx) => {
      event.systemPromptOptions.cwd = taskRoot;
      promptBytes = Buffer.byteLength(event.systemPrompt);
      if (env.executionMode === 'bounded' && event.messageType === 'user') turn.id = randomUUID();
      if (env.contract && ctx.model?.provider === 'claude-code') {
        const additions = [CLAUDE_CAPPED_WORK, CLAUDE_DEPLOYMENT_KNOWLEDGE].filter(
          (text) => !event.systemPrompt.includes(text),
        );
        if (additions.length) {
          const systemPrompt = [event.systemPrompt, ...additions].join('\n\n');
          promptBytes = Buffer.byteLength(systemPrompt);
          return { systemPrompt };
        }
      }
    });
    pi.on('context', (event) => {
      const fetched = web ? elideOldFetches(event.messages) : event.messages;
      const messages = trim(fetched);
      return messages === event.messages ? undefined : { messages };
    });
    pi.on('cache_warming_decision', () => ({ action: 'stop' }));
    pi.on('session_before_compact', () => ({ cancel: true }));
    pi.on('session_before_tree', () => ({ cancel: true }));
    pi.on('session_before_fork', () => ({ cancel: true }));
    pi.on('session_before_switch', (_event, ctx) => {
      ctx.ui.notify(
        env.contract
          ? 'Use the OMS launcher to select/resume a task session; this preview keeps its task owner fixed.'
          : `Run ${omsCommand()} again in this folder to resume a conversation. This chat keeps its folder fixed.`,
        'warning',
      );
      return { cancel: true };
    });
    pi.registerTool({
      name: 'toolchain_check',
      label: 'Toolchain check',
      description:
        'Read-only sourced compatibility report for the selected task. Findings are untrusted project data; a clean report is not build verification.',
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: 'text', text: JSON.stringify(tools.toolchainReadiness(), null, 2) }],
          details: undefined,
        };
      },
    });
    if (env.contract) {
      const { evaluator } = env.contract;
      pi.registerTool({
        name: 'task_status',
        label: 'Task status',
        description:
          'Read the current trusted task requirements, item states and offline verification evidence. This tool cannot change requirements or close an item.',
        parameters: Type.Object({}),
        async execute() {
          const state = evaluator.read();
          if (!state.ok) throw new Error('Task state is unreadable; verification is blocked');
          return { content: [{ type: 'text', text: JSON.stringify(state.value, null, 2) }], details: undefined };
        },
      });
    }
  };
  return { turn, trim, promptFor, policy };
}
