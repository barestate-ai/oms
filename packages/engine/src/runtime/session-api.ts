import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AgentSessionRuntime } from '@earendil-works/pi-coding-agent';
import type { SandboxResult } from '@oms/sandbox';
import { createChainControls } from './chain.ts';
import { backendFor } from './execution-backend.ts';
import { remoteDecodeError } from './knowledge-service.ts';
import type { OmsAccountControls } from './oms-account.ts';
import { createProviderControls } from './provider-controls.ts';
import type { RuntimeEnvironment, TaskEnvironment } from './session-environment.ts';
import type { SessionLifecycle } from './session-lifecycle.ts';
import type { SessionModel } from './session-model.ts';
import type { SessionTools } from './session-tools.ts';
import type {
  CommonSessionOptions,
  HarnessSession,
  HarnessSessionOptions,
  HarnessVerification,
  SessionCore,
} from './session-types.ts';
import { createHarnessSettingsControls, flushHarnessSettings } from './settings-controls.ts';
import { modelReadiness } from './usage.ts';
import { blendToken } from './blend.ts';

const MAX_TIMER_MS = 2_147_483_647;

/** Everything the returned session API is assembled from; each part is produced by an earlier startup stage. */
export interface SessionApiParts {
  options: CommonSessionOptions;
  life: SessionLifecycle;
  env: RuntimeEnvironment;
  tools: SessionTools;
  model: SessionModel;
  account: OmsAccountControls;
  /** Names the session in the warning printed when cleanup is uncertain. */
  owner: string;
}

/** Arms the task wall-clock deadline of a bounded session; the timer is cleared by `life.releaseResources`. */
function enforceTaskDeadline(life: SessionLifecycle, env: RuntimeEnvironment, session: SessionModel['session']): void {
  const enforce = () => {
    const remaining = env.budget.snapshot().remaining.wallClockMs;
    if (remaining > 0) {
      life.deadline = setTimeout(enforce, Math.min(remaining, MAX_TIMER_MS));
      return;
    }
    life.controller.abort(new Error('Task wall-clock budget exhausted'));
    void session.abort().catch(() => {});
  };
  if (env.executionMode === 'bounded') enforce();
}

/** The pi runtime whose disposal releases everything the task session owns. */
function createTaskRuntime(parts: SessionApiParts): AgentSessionRuntime {
  const { life, model, env } = parts;
  const services = {
    cwd: env.root.codeRoot,
    agentDir: env.root.agentRoot,
    modelRuntime: model.modelRuntime,
    settingsManager: model.settingsManager,
    resourceLoader: model.resourceLoader,
    diagnostics: [],
  };
  class TaskSessionRuntime extends AgentSessionRuntime {
    #disposal: Promise<void> | undefined;
    override dispose(): Promise<void> {
      return (this.#disposal ??= (async () => {
        try {
          await life.releaseResources();
        } catch (error) {
          process.stderr.write(
            `OMS cleanup uncertain for ${parts.owner}; ownership retained. Stop and inspect task processes before lease recovery.\n`,
          );
          throw error;
        } finally {
          await super.dispose();
        }
      })());
    }
  }
  return new TaskSessionRuntime(
    model.session,
    services,
    async () => {
      throw new Error(
        'Live session replacement is unavailable in this preview; use the OMS launcher to select a task session',
      );
    },
    [],
    model.created.modelFallbackMessage,
  );
}

/** What every session returns: commands, controls for settings, providers, web and chain, and `close`. */
export function createCoreApi(parts: SessionApiParts): SessionCore {
  const { options, life, env, tools, model, account } = parts;
  const { session } = model;
  const { sandboxTools } = tools;
  const { web } = tools;
  const webControls = web && {
    enabled: web.enabled,
    usage: web.usage,
    set(on: boolean) {
      web.setEnabled(on);
      const others = session.getActiveToolNames().filter((name) => !web.toolNames.includes(name));
      session.setActiveToolsByName(on ? [...others, ...web.toolNames] : others);
    },
  };
  if (webControls && !web.enabled()) webControls.set(false);
  const settings = createHarnessSettingsControls({
    session,
    backend: backendFor(options.environment).name,
    withUserOperation: life.withUserOperation,
  });
  const providerControls = createProviderControls({
    blend: { configured: () => !!blendToken(account), ensureProfile: model.ensureBlendProfile },
    modelRuntime: model.modelRuntime,
    session,
    maxOutputTokens: options.maxOutputTokens,
    signal: life.controller.signal,
    withUserOperation: life.withUserOperation,
    checkAuthFile: model.checkAuthFile,
    loginOptions: { agentName: 'OMS', getDeviceId: () => model.settingsManager.getOrCreateDeviceId() },
    flushSettings: () => flushHarnessSettings(model.settingsManager),
    inferencePreferencesPath: join(env.root.agentRoot, 'inference.json'),
    modelReadiness: (m) =>
      modelReadiness(
        m,
        env.budget,
        options.maxOutputTokens,
        env.executionMode,
        options.maxInputTokens,
        options.subscriptionSpendExempt,
        model.modelRuntime.isUsingSubscription(m.provider),
      ),
  });
  const runCommand = (command: string, signal?: AbortSignal): Promise<SandboxResult> =>
    life.withUserOperation(() =>
      env.withExecution(randomUUID(), async (operationSignal) => {
        if (!command.trim()) throw new Error('A command is required');
        const result = await sandboxTools.execute(
          ['/bin/sh', '-c', command],
          signal ? AbortSignal.any([operationSignal, signal]) : operationSignal,
          env.budget.snapshot().remaining.wallClockMs,
        );
        session.recordBashResult(command, {
          output: result.stdout + result.stderr,
          exitCode: result.cancelled ? undefined : result.exitCode,
          cancelled: result.cancelled,
          truncated: result.truncated,
        });
        return result;
      }),
    );
  const runtime = createTaskRuntime(parts);
  enforceTaskDeadline(life, env, session);
  return {
    root: env.root.codeRoot,
    runtime,
    session,
    budget: env.budget,
    settings,
    runCommand,
    nativeChat: model.nativeChat,
    account,
    ...providerControls,
    setHostApproval: (approve) => sandboxTools.setHostApproval(approve),
    chain: createChainControls({ surfnet: life.surf!, withUserOperation: life.withUserOperation }),
    knowledge: {
      config: tools.knowledgeSource,
      decodeError: (code: string, program?: string, signal?: AbortSignal) =>
        remoteDecodeError(tools.knowledgeSource, code, program, signal),
    },
    ...(webControls ? { web: webControls } : {}),
    files: sandboxTools.files,
    startTerminal: (columns, rows) => life.withUserOperation(() => sandboxTools.startTerminal(columns, rows)),
    async close() {
      await runtime.dispose();
    },
  };
}

/** The core API plus verification against the pinned requirements. */
export function createTaskApi(
  parts: SessionApiParts & { options: HarnessSessionOptions; env: TaskEnvironment },
): HarnessSession {
  const { options, life, env, tools } = parts;
  const { contract } = env;
  const { sandboxTools } = tools;
  const core = createCoreApi(parts);
  const verify = (itemId?: string): Promise<HarnessVerification> =>
    life.withUserOperation(() =>
      env.withExecution(randomUUID(), () =>
        sandboxTools.withVerification(async () => {
          const state = contract.evaluator.read();
          if (!state.ok) throw new Error('Task state is unreadable');
          const item = itemId
            ? state.value.items.find((item) => item.id === itemId)
            : state.value.items.find((item) => ['active', 'proposed', 'stale'].includes(item.status));
          if (!item) throw new Error('Select an active, proposed or stale task item');
          if (item.status === 'stale') {
            const reopened = contract.evaluator.reopen(item.id);
            if (!reopened.ok) throw new Error(reopened.message);
          }
          if (item.status !== 'proposed') {
            const proposal = contract.proposer.propose(item.id);
            if (!proposal.ok) throw new Error(proposal.message);
          }
          await life.backend!.assertIntegrity();
          return { itemId: item.id, result: await contract.baseEvaluator.evaluate(item.id) };
        }),
      ),
    );
  return {
    ...core,
    kind: 'task',
    workspace: options.workspace,
    task: options.task,
    evaluator: contract.evaluator,
    verify,
    ...(tools.edgeCheck ? { edgeCheck: { summary: tools.edgeCheck.summary } } : {}),
  };
}
