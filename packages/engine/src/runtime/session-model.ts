import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  type AgentSession,
  type ExtensionFactory,
  type SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { normalizeContext } from '@earendil-works/pi-ai';
import { assertPrivate, isMissing } from '../workspace/storage.ts';
import { registerOmsCatalog } from './catalog.ts';
import {
  CLAUDE_CODE_PROVIDER,
  claudeCodeEffort,
  createClaudeCodeProvider,
  type NativeChatControls,
} from './claude-code.ts';
import { AGENT_TOOL } from './helpers/agents.ts';
import { attachKnowledgeContext, KNOWLEDGE_TOOL_NAMES } from './knowledge-service.ts';
import { PROGRAM_REFERENCE_TOOL } from './program-reference.ts';
import type { RuntimeEnvironment } from './session-environment.ts';
import type { SessionHooks } from './session-hooks.ts';
import type { SessionLifecycle } from './session-lifecycle.ts';
import type { SessionTools } from './session-tools.ts';
import type { CommonSessionOptions } from './session-types.ts';
import { createHarnessSettings } from './settings-controls.ts';
import { RAW_OUTPUT_TOOL } from './solana-diagnosis.ts';
import { withToolExecutionModes } from './tool-execution.ts';
import { createMeteredStream, type ModelUsageObserver } from './usage.ts';

/** Registered tools pi would otherwise drop: deps_fetch is part of the build profile. */
export function sessionToolNames(
  buildProfile: boolean | undefined,
  outputMode: string | undefined,
  kind: 'task' | 'chat' = 'task',
): string[] {
  return [
    'read',
    'edit',
    'write',
    'bash',
    ...(kind === 'task' ? ['propose_done', 'task_status'] : []),
    'toolchain_check',
    RAW_OUTPUT_TOOL,
    PROGRAM_REFERENCE_TOOL,
    ...(buildProfile ? ['deps_fetch'] : []),
    ...(outputMode === 'head-tail' ? ['read_log'] : []),
  ];
}

/** The live pi session with its model runtime, and the pieces the returned session API is built from. */
export interface SessionModel {
  session: AgentSession;
  created: Awaited<ReturnType<typeof createAgentSession>>;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  resourceLoader: DefaultResourceLoader;
  nativeChat: NativeChatControls;
  /** Throws when the agent's auth file is readable by others; a no-op when the host injected its own model runtime. */
  checkAuthFile(): void;
}

type ModelUsageCredential = () => { origin: string; token: string } | undefined;

export function modelUsageObserver(readCredential?: ModelUsageCredential): ModelUsageObserver | undefined {
  if (process.env.OMS_SHARE_MODEL_USAGE !== '1' || !readCredential) return undefined;
  return (model) => {
    const credential = readCredential();
    if (credential?.origin !== 'https://barestate.xyz/oms') return undefined;
    return (outcome) => {
      void Promise.resolve()
        .then(() => {
          return fetch(credential.origin + '/api/telemetry/model', {
            method: 'POST',
            redirect: 'error',
            credentials: 'omit',
            signal: AbortSignal.timeout(2_000),
            headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.token}` },
            body: JSON.stringify({
              provider: model.provider,
              model: model.id,
              outcome,
            }),
          }).then((response) => response.body?.cancel());
        })
        .catch(() => {});
    };
  };
}

/**
 * Model and stream wiring: the model runtime and catalog, the Claude Code native provider, the pi session with the OMS
 * extensions, and the metered stream that enforces the budget on every model call.
 */
export async function createSessionModel(
  options: CommonSessionOptions,
  life: SessionLifecycle,
  env: RuntimeEnvironment,
  tools: SessionTools,
  hooks: SessionHooks,
  extensions: ExtensionFactory[],
  initiallyKnown: boolean,
  injectedTools: readonly string[] = [],
  telemetryCredential?: ModelUsageCredential,
): Promise<SessionModel> {
  const { environment } = options;
  const { controller } = life;
  const { agentRoot, codeRoot, sessionsDir } = env.root;
  const authPath = join(agentRoot, 'auth.json');
  const authFileCheck = () => {
    try {
      assertPrivate(authPath, false);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };
  const checkAuthFile = () => {
    if (!options.modelRuntime) authFileCheck();
  };
  checkAuthFile();
  const modelRuntime =
    options.modelRuntime ??
    (await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: true }));
  registerOmsCatalog(modelRuntime);
  const native = (life.nativeSession = await createClaudeCodeProvider(modelRuntime, {
    effort: claudeCodeEffort(),
    statePath: join(sessionsDir, `${env.sessionId}.claude.json`),
    signal: controller.signal,
    onSpawn: life.processes!.onSpawn,
  }));
  // Registration queues auth snapshot updates; finish canonical offline restoration before selection.
  await modelRuntime.refresh({ allowNetwork: false, signal: controller.signal });
  const selectedModel =
    options.model ??
    (options.modelSelection
      ? modelRuntime.getModel(options.modelSelection.provider, options.modelSelection.id)
      : undefined);
  if (options.modelSelection && !selectedModel) throw new Error('The selected model is not in the installed catalog');
  const settingsManager = createHarnessSettings(agentRoot);
  const resourceLoader = new DefaultResourceLoader({
    cwd: codeRoot,
    agentDir: agentRoot,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: [],
    extensionFactories: extensions.map(withToolExecutionModes),
    systemPrompt: hooks.promptFor(tools.knowledgeSource()),
  });
  await resourceLoader.reload();
  const created = await createAgentSession({
    cwd: codeRoot,
    agentDir: agentRoot,
    modelRuntime,
    ...(selectedModel ? { model: selectedModel } : {}),
    settingsManager,
    sessionManager: env.manager,
    resourceLoader,
    noTools: 'builtin',
    tools: [
      ...sessionToolNames(environment.buildProfile, options.outputMode, env.contract ? 'task' : 'chat'),
      ...KNOWLEDGE_TOOL_NAMES,
      ...(tools.web?.toolNames ?? []),
      ...(env.contract ? [] : [AGENT_TOOL]),
      ...injectedTools,
    ],
  });
  const { session } = created;
  attachKnowledgeContext(session);
  life.liveSession = session;
  const originalAbort = session.abort.bind(session);
  session.abort = async () => {
    await Promise.all([originalAbort(), native.disconnect()]);
  };
  // `claude auth status` is lazy: the first real use of a native selection verifies the ambient login
  // on demand, so an unchecked status can never read as an unconfigured provider. Each session verifies
  // once for itself, so a billing change between sessions can never ride on a stale subscription check.
  // The probe shares the session's authCheck with native startup, so a fresh session spawns the CLI once.
  let nativeVerified = false;
  const verifyNativeAccess = async (signal: AbortSignal = controller.signal) => {
    if (!nativeVerified) {
      const auth = await native.verifyAccess(signal);
      signal.throwIfAborted();
      if (!auth.configured) throw new Error(auth.detail);
      nativeVerified = true;
    }
    signal.throwIfAborted();
  };
  const originalSetModel = session.setModel.bind(session);
  session.setModel = async (...args: Parameters<AgentSession['setModel']>) => {
    if (args[0].provider === CLAUDE_CODE_PROVIDER) await verifyNativeAccess();
    if (session.model?.provider === 'claude-code') await native.disconnect();
    return originalSetModel(...args);
  };
  const nativeChat: NativeChatControls = {
    status: () => native.status(),
    reconnect: () =>
      life.withUserOperation(async () => {
        if (session.model?.provider !== 'claude-code')
          throw new Error('Select Claude Code before reconnecting its native chat');
        native.configure(
          session.model,
          normalizeContext({
            systemPrompt: session.agent.state.systemPrompt,
            tools: session.agent.state.tools,
            messages: await session.agent.convertToLlm(session.agent.state.messages),
          }),
          session.model.maxTokens,
        );
        await native.reconnect();
      }),
    reset: () =>
      life.withUserOperation(async () => {
        if (session.model?.provider !== 'claude-code')
          throw new Error('Select Claude Code before resetting its native chat');
        await native.reset();
        env.manager.appendCustomEntry('oms.claude.native-boundary', {
          sessionId: native.status().sessionId,
          reason: 'reset',
          at: Date.now(),
        });
      }),
  };
  session.agent.toolExecution = 'parallel';
  const originalSdkStream: StreamFn = session.agent.streamFunction;
  const directStream = createMeteredStream({
    streamFunction: originalSdkStream,
    observeModelUsage: modelUsageObserver(telemetryCredential),
    ledger: env.budget,
    allocate: env.allocate,
    executionMode: env.executionMode,
    maxOutputTokens: options.maxOutputTokens,
    maxInputTokens: options.maxInputTokens,
    subscriptionExempt: options.subscriptionSpendExempt,
    subscribed: (provider) => modelRuntime.isUsingSubscription(provider),
    logicalTurnId: () => hooks.turn.id,
    onBareBadRequest: () => hooks.trim.forgetReasoning(),
  });
  session.agent.streamFunction = (model, context, streamOptions) => {
    const signal = life.executionController
      ? AbortSignal.any([life.executionController.signal, ...(streamOptions?.signal ? [streamOptions.signal] : [])])
      : streamOptions?.signal;
    return directStream(model, context, { ...streamOptions, signal });
  };
  const originalPrompt = session.prompt.bind(session);
  const gatedPrompt = (...args: Parameters<AgentSession['prompt']>) => {
    const use = async (signal: AbortSignal) => {
      // The turn signal, not the session lifetime, bounds verification and the SDK call it unlocks.
      if (session.model?.provider === CLAUDE_CODE_PROVIDER) await verifyNativeAccess(signal);
      else signal.throwIfAborted();
      return originalPrompt(...args);
    };
    if (env.executionMode === 'interactive') {
      return life.withUserOperation(() => {
        hooks.turn.id = randomUUID();
        return env.withExecution(hooks.turn.id, use);
      });
    }
    return use(controller.signal);
  };
  session.prompt = gatedPrompt;
  await session.bindExtensions({});
  // Registered for a later sign-in, but not declared to the model while no credential exists.
  if (!initiallyKnown)
    session.setActiveToolsByName(session.getActiveToolNames().filter((name) => !KNOWLEDGE_TOOL_NAMES.includes(name)));
  return { session, created, modelRuntime, settingsManager, resourceLoader, nativeChat, checkAuthFile };
}
