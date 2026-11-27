import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { privateDirectory } from '../workspace/storage.ts';
import type { MutationLease } from '../workspace/index.ts';
import { createOmsAccountControls } from './oms-account.ts';
import type { SessionApiParts } from './session-api.ts';
import type { RuntimeEnvironment } from './session-environment.ts';
import { createSessionHooks } from './session-hooks.ts';
import { createSessionLifecycle, type SessionLifecycle } from './session-lifecycle.ts';
import { createSessionModel } from './session-model.ts';
import { createSessionExtensions, createSessionTools } from './session-tools.ts';
import type { CommonSessionOptions } from './session-types.ts';

/** Runs one startup under a lifecycle that releases exactly what exists if any stage fails. */
export async function startSession<T>(
  lease: MutationLease,
  start: (life: SessionLifecycle) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  const life = createSessionLifecycle(lease, controller);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const session = await start(life);
    signal?.throwIfAborted();
    return session;
  } catch (error) {
    life.liveSession?.dispose();
    try {
      await life.releaseResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Harness startup and cleanup failed');
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/** The stages after the environment: the agent account, tools, prompt hooks, extensions and model wiring. */
export async function assembleSession(
  options: CommonSessionOptions,
  life: SessionLifecycle,
  env: RuntimeEnvironment,
  extras: {
    edge?: { changedPaths: () => string[] };
    endRunOnProposal?: boolean;
    owner: string;
    /** A chat's helper tool; pinned tasks never get one. */
    helpers?: ExtensionFactory;
    /** A chat's host-injected extensions and the tool names they register; pinned tasks never get them. */
    extensions?: readonly ExtensionFactory[];
    extensionTools?: readonly string[];
  },
): Promise<SessionApiParts> {
  privateDirectory(env.root.agentRoot);
  const account = createOmsAccountControls({
    agentRoot: env.root.agentRoot,
    signal: life.controller.signal,
    withUserOperation: life.withUserOperation,
  });
  const tools = createSessionTools(options, life, env, account, extras.edge);
  const hooks = createSessionHooks(options, life, env, tools);
  // Whether a knowledge credential exists at start: it decides the prompt and which tools are declared to the model.
  const initiallyKnown = tools.knowledgeSource() !== undefined;
  const extensions = createSessionExtensions(
    options,
    life,
    env,
    tools,
    hooks,
    initiallyKnown,
    extras.endRunOnProposal,
    extras.helpers,
    extras.extensions,
  );
  const model = await createSessionModel(
    options,
    life,
    env,
    tools,
    hooks,
    extensions,
    initiallyKnown,
    extras.extensionTools,
    account.searchCredential,
  );
  return { options, life, env, tools, model, account, owner: extras.owner };
}
