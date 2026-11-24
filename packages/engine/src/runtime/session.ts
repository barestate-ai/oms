import { acquireTaskLease } from '../workspace/index.ts';
import { gitChangedPaths } from './edge-check.ts';
import { createTaskApi } from './session-api.ts';
import { assembleSession, startSession } from './session-assembly.ts';
import { startTaskEnvironment } from './session-environment.ts';
import type { HarnessSession, HarnessSessionOptions } from './session-types.ts';

export { sessionToolNames } from './session-model.ts';
export type {
  ChatSession,
  ChatSessionOptions,
  HarnessEnvironment,
  HarnessSession,
  HarnessSessionOptions,
  HarnessTaskDefinition,
  HarnessVerification,
  OmsSession,
} from './session-types.ts';
export { parseHarnessTaskDefinition, prepareHarnessTask } from './task-definition.ts';
export { coAuthorTrailerHint, CO_AUTHOR_TRAILER, knowledgeHint, omsSystemPrompt } from './system-prompt.ts';

/**
 * One live task owner. UI views consume it; replacing a view never replaces this runtime.
 *
 * Startup is a fixed sequence of stages, each in its own module, and each registers what it creates on the lifecycle so a
 * failure at any point releases exactly what exists: the task environment (ownership, pin, verifier, budget, local chain),
 * the agent account, the tools, the prompt and context hooks, the extensions, the model and stream wiring, and the API.
 */
export async function createHarnessSession(options: HarnessSessionOptions): Promise<HarnessSession> {
  const { workspace, task } = options;
  return startSession(acquireTaskLease(workspace, task.id), async (life) => {
    const env = await startTaskEnvironment(options, life);
    const parts = await assembleSession(options, life, env, {
      ...(options.edgeCheck ? { edge: { changedPaths: () => gitChangedPaths(task.codeRoot, task.baseOid) } } : {}),
      endRunOnProposal: options.endRunOnProposal,
      owner: `task ${task.id}`,
    });
    return createTaskApi({ ...parts, options, env });
  });
}
