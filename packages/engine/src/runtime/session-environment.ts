import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  createEvaluator,
  createProposer,
  createVerifierCache,
  parseEvaluatorConfig,
  verifyPin,
  type Evaluator,
  type EvaluatorConfig,
  type Proposer,
} from '@oms/contract';
import { createTraceWriter, type BudgetLedger, type ExecutionMode } from '@oms/core';
import { createDispatchAllocator } from '@oms/core/dispatch';
import { buildMounts, type MountPlan } from '@oms/sandbox';
import { createSurfnet } from '@oms/surfnet';
import { createVerifierRunner } from '../verifier.ts';
import { inspectMutationLease } from '../workspace/index.ts';
import { privateDirectory, writePrivateJson } from '../workspace/storage.ts';
import { trackRuntimeProcesses, type RuntimeProcessTracker } from './recovery.ts';
import type { SessionLifecycle } from './session-lifecycle.ts';
import type { CommonSessionOptions, HarnessEnvironment, HarnessSessionOptions } from './session-types.ts';
import { backendFor, type ExecutionBackend } from './execution-backend.ts';
import { taskRoot, type SessionRoot } from './session-root.ts';
import { verifierBackendOptions } from './task-definition.ts';
import { taskContext, type TaskContext } from './task-context.ts';
import { openBudgetJournal } from './usage.ts';
import { hideKnowledgeBlocks, KNOWLEDGE_TOOL_NAMES } from './knowledge-service.ts';
import { createVerifierBackend } from './verifier-backend.ts';

/** The pinned requirements and their independent checks; only a pinned task session has them. */
export interface ContractParts {
  evaluator: Evaluator;
  /** The evaluator without the sandbox gate, for callers that already hold the verification slot. */
  baseEvaluator: Evaluator;
  proposer: Proposer;
}

/** What the rest of startup needs from any session: its state, budget, local chain and sandbox mounts. */
export interface RuntimeEnvironment {
  root: SessionRoot;
  manager: SessionManager;
  sessionId: string;
  executionMode: ExecutionMode;
  budget: BudgetLedger;
  /** Runs one execution window: a plain pass-through when bounded, a budgeted and timed operation when interactive. */
  withExecution<T>(operationId: string, action: (signal: AbortSignal) => Promise<T>): Promise<T>;
  allocate: ReturnType<typeof createDispatchAllocator>;
  surfnetPort: number;
  /** source_fetch's folder, outside the root so neither the proof digest nor the verifier's staged copy sees it. */
  sourcesDir: string;
  mounts: MountPlan;
  /** Paths relative to the root that the agent may read but never write. */
  protectedFiles: string[];
  contract?: ContractParts;
}

/** A pinned task session also has its trusted requirements and verifier. */
export interface TaskEnvironment extends RuntimeEnvironment {
  contract: ContractParts;
  context: TaskContext;
  config: EvaluatorConfig;
  /** Paths of the pinned verifier files, relative to the task root. */
  verifierFiles: string[];
}

const MAX_TIMER_MS = 2_147_483_647;

/** Tells the user once per workspace what a backend does and does not isolate, when it has anything to say. */
export function warnAboutBackend(environment: HarnessEnvironment, noticeDir: string): void {
  const notice = backendFor(environment).notice();
  if (!notice) return;
  const warningFile = join(noticeDir, `host-warning-${notice.key}.json`);
  if (existsSync(warningFile)) return;
  process.stderr.write(notice.text);
  writePrivateJson(warningFile, { acknowledgedAt: new Date().toISOString() });
}

/** Opens or resumes the pi conversation file of this session. */
function openSessionManager(options: CommonSessionOptions, root: SessionRoot): SessionManager {
  if (options.sessionId === undefined) return SessionManager.create(root.codeRoot, root.sessionsDir);
  if (!/^[a-f0-9-]{36}$/.test(options.sessionId)) throw new Error('Session ID is invalid');
  const file = SessionManager.findById(root.codeRoot, options.sessionId, root.sessionsDir);
  if (!file) throw new Error('Session does not belong to this task');
  const manager = SessionManager.open(file, root.sessionsDir);
  if (manager.getCwd() !== root.codeRoot) throw new Error('Saved session targets a different task');
  return manager;
}

/** The first startup stage: this process must hold the lease; its runtime processes are then tracked against it. */
export function claimRuntime(
  options: CommonSessionOptions,
  root: SessionRoot,
  life: SessionLifecycle,
): { execution: ExecutionBackend; processes: RuntimeProcessTracker } {
  const ownership = inspectMutationLease(root.leaseFile);
  if (ownership.status !== 'live' || ownership.owner.token !== life.lease.token)
    throw new Error('Task ownership changed before runtime startup');
  const execution = backendFor(options.environment);
  const processes = (life.processes = trackRuntimeProcesses(
    root.leaseFile,
    ownership.owner,
    root.workDir,
    [...execution.runtimeRoots(root.codeRoot), root.sessionsDir],
    execution.capturesProofRoots,
  ));
  writePrivateJson(join(root.stateDir, 'runtime-backend.json'), { backend: execution.name });
  return { execution, processes };
}

/** The saved conversation, its budget journal and its trace; interactive sessions get budgeted execution windows. */
export function openConversation(
  options: CommonSessionOptions,
  root: SessionRoot,
  life: SessionLifecycle,
): Pick<RuntimeEnvironment, 'manager' | 'sessionId' | 'executionMode' | 'budget' | 'withExecution' | 'allocate'> {
  const { controller } = life;
  const clock = options.clock ?? Date.now;
  const executionMode = options.executionMode ?? 'bounded';
  privateDirectory(dirname(root.sessionsDir));
  privateDirectory(root.sessionsDir);
  const manager = openSessionManager(options, root);
  const append = manager.appendMessage.bind(manager);
  manager.appendMessage = (message) => {
    if (message.role === 'toolResult' && KNOWLEDGE_TOOL_NAMES.includes(message.toolName)) {
      const { details: _details, ...safe } = message;
      return append({ ...safe, content: [{ type: 'text', text: message.isError
        ? 'Solana knowledge unavailable' : 'fetched Solana knowledge: Solana' }] });
    }
    if (message.role === 'assistant' || message.role === 'toolResult' || message.role === 'user') {
      if (typeof message.content === 'string') {
        return append(message.role === 'user' ? { ...message, content: hideKnowledgeBlocks(message.content) } : message);
      }
      const content = message.content.map((part) => part.type === 'text'
        ? { ...part, text: hideKnowledgeBlocks(part.text) } : part);
      return append({ ...message, content } as typeof message);
    }
    return append(message);
  };
  const sessionId = manager.getSessionId();
  const budgetJournal = (life.budgetJournal = openBudgetJournal({
    path: join(root.sessionsDir, `${sessionId}.budget.jsonl`),
    caps: options.caps,
    clock,
    executionMode,
  }));
  const budget = budgetJournal.ledger;
  if (executionMode === 'interactive') {
    // A request left open by a process that is gone is charged at its reservation, so the conversation can go on.
    const settled = new Set(budget.receipts().map((receipt) => receipt.dispatchId));
    for (const { dispatchId } of budget.reservations()) {
      if (settled.has(dispatchId)) continue;
      const result = budget.settle({
        dispatchId,
        receiptId: `interrupted-${dispatchId}`,
        outcome: 'uncertain',
        tokens: null,
        spendMicroUsd: null,
      });
      if (!result.ok) throw new Error(result.message);
    }
  }
  const restoredBudget = budget.snapshot();
  if (restoredBudget.accounting !== 'known' && executionMode !== 'interactive')
    throw new Error('Saved usage is pending or unknown; reconcile it before resuming this conversation');
  if (restoredBudget.activeOperationId) {
    const ended = budget.endOperation(restoredBudget.activeOperationId);
    if (!ended.ok) throw new Error(ended.message);
  }
  const modeChange = budget.setExecutionMode(executionMode);
  if (!modeChange.ok) throw new Error(modeChange.message);
  const withExecution = async <T>(operationId: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (executionMode === 'bounded') return action(controller.signal);
    if (life.executionController) throw new Error('Wait for the current execution to finish');
    const started = budget.beginOperation(operationId);
    if (!started.ok) throw new Error(started.message);
    const operation = new AbortController();
    life.executionController = operation;
    const signal = AbortSignal.any([controller.signal, operation.signal]);
    let timer: NodeJS.Timeout | undefined;
    const expire = () => {
      const remaining = budget.snapshot().remaining.wallClockMs;
      if (remaining > 0) {
        timer = setTimeout(expire, Math.min(remaining, MAX_TIMER_MS));
        return;
      }
      operation.abort(new Error('Execution wall-clock limit exhausted'));
      void life.liveSession?.abort().catch(() => {});
    };
    expire();
    try {
      signal.throwIfAborted();
      return await action(signal);
    } finally {
      clearTimeout(timer);
      life.executionController = undefined;
      const ended = budget.endOperation(operationId);
      if (!ended.ok) throw new Error(ended.message);
    }
  };
  const allocate = createDispatchAllocator(budget.reservations());
  const trace = (life.trace = createTraceWriter({
    path: join(root.sessionsDir, `${sessionId}.trace.jsonl`),
    clock: Date.now,
    fsync: true,
  }));
  const probe = trace.append({ type: 'budget', accounting: budget.snapshot().accounting, sessionId });
  if (!probe.ok) throw new Error('Session trace cannot be opened safely; operator recovery required');
  return { manager, sessionId, executionMode, budget, withExecution, allocate };
}

/** The session's own Surfpool, started from the pinned snapshot when there is one. */
export async function startSurfnet(
  options: CommonSessionOptions,
  root: SessionRoot,
  life: SessionLifecycle,
  processes: RuntimeProcessTracker,
  snapshot?: string,
): Promise<number> {
  const surf = (life.surf = createSurfnet({
    binary: options.environment.binary,
    ...(snapshot === undefined ? {} : { snapshot }),
    workDir: join(root.workDir, 'exploration'),
    signal: life.controller.signal,
    onSpawn: processes.onSpawn,
  }));
  await surf.start();
  const port = surf.ports()?.rpc;
  if (port === undefined) throw new Error('Task Surfpool did not acquire its RPC port');
  return port;
}

/** The sandbox mounts, and source_fetch's folder they share. */
export function planMounts(
  options: CommonSessionOptions,
  root: SessionRoot,
  execution: ExecutionBackend,
  protectedFiles: readonly string[],
): Pick<RuntimeEnvironment, 'sourcesDir' | 'mounts'> {
  const { environment } = options;
  const sourcesDir = join(tmpdir(), 'oms-sources', root.taskName);
  mkdirSync(sourcesDir, { recursive: true, mode: 0o700 });
  const mounts = buildMounts({
    projectRoot: root.codeRoot,
    taskName: root.taskName,
    // The task's own tests start Surfpool, so the agent sees the same trusted binary the verifier does.
    // source_fetch's folder: outside the task root, so the proof's code digest and the verifier's staged copy never see it.
    // Host commands read it through the temp directory; a container needs it mounted at the same path.
    ...execution.taskMounts({ binary: environment.binary, dependencies: environment.dependencies, sourcesDir }),
    forbidden: root.forbidden,
    readOnlyPaths: protectedFiles.map((file) => join(root.codeRoot, file)),
    // The verifier sees the locked dependencies; the agent's own test runs must see the same ones.
    // Build-profile sessions install the project's own JS deps (deps_fetch), so no read-only overlay there.
    ...(environment.dependencies && !environment.buildProfile
      ? {
          readOnlyOverlays: [
            { hostPath: join(environment.dependencies, 'node_modules'), containerPath: '/work/node_modules' },
          ],
        }
      : {}),
    heavyDirs: environment.buildProfile ? ['target', '.oms-cargo'] : [],
  });
  return { sourcesDir, mounts };
}

/**
 * Environment and task setup, in startup order: ownership checks, the pinned requirements, the verifier backend, the saved
 * conversation and its budget journal, the trace, the evaluator, the task's own Surfpool and the sandbox mounts. Every
 * resource is registered on `life` the moment it exists.
 */
export async function startTaskEnvironment(
  options: HarnessSessionOptions,
  life: SessionLifecycle,
): Promise<TaskEnvironment> {
  const { workspace, task, environment } = options;
  const { controller } = life;
  warnAboutBackend(environment, workspace.stateDir);
  const context = taskContext(workspace, task);
  const root = taskRoot(workspace, task, context);
  const { execution, processes } = claimRuntime(options, root, life);
  const pinned = verifyPin(task.pinFile, context.roots);
  if (!pinned.ok) throw new Error('Task requirements or verifier inputs do not match their pin');
  const parsedConfig = parseEvaluatorConfig(pinned.pin.evaluatorConfig);
  if (!parsedConfig.ok) throw new Error('Pinned evaluator configuration is invalid');
  const config = parsedConfig.value;
  const backend = (life.backend = await createVerifierBackend({
    ...verifierBackendOptions(environment, task, context),
    signal: controller.signal,
    operationSignal: () => life.executionController?.signal,
    onSpawn: processes.onSpawn,
  }));
  if (backend.executionIdentity !== config.executionIdentity) {
    throw new Error("The approved runtime identity differs from this task's pinned runtime");
  }
  const conversation = openConversation(options, root, life);
  const runner = createVerifierRunner(backend);
  const baseEvaluator = createEvaluator({
    ...context.roots,
    pinFile: task.pinFile,
    runner,
    cache: createVerifierCache({ path: join(context.stateDir, 'verifier-cache.json'), projectRoot: workspace.root }),
  });
  const evaluator: Evaluator = {
    ...baseEvaluator,
    evaluate: (itemId) => {
      if (!life.taskTools) return Promise.reject(new Error('Task sandbox is not ready'));
      return life.taskTools.withVerification(async () => {
        await backend.assertIntegrity();
        return baseEvaluator.evaluate(itemId);
      });
    },
  };
  const baseProposer = createProposer({ ...context.roots, pinFile: task.pinFile });
  const proposer = {
    ...baseProposer,
    propose(itemId: string) {
      if (!life.taskTools) throw new Error('Task sandbox is not ready');
      life.taskTools.assertVerificationAllowed();
      return baseProposer.propose(itemId);
    },
  };
  const surfnetPort = await startSurfnet(
    options,
    root,
    life,
    processes,
    config.snapshotPath === undefined ? undefined : join(task.codeRoot, config.snapshotPath),
  );
  const verifierFiles = pinned.pin.verifier.files.map((file) => file.path);
  const protectedFiles = [...verifierFiles, '.git'];
  return {
    root,
    ...conversation,
    contract: { evaluator, baseEvaluator, proposer },
    surfnetPort,
    ...planMounts(options, root, execution, protectedFiles),
    protectedFiles,
    context,
    config,
    verifierFiles,
  };
}
