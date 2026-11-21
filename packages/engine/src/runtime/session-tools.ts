import { join } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { createOmsExtensions } from '../oms-extension.ts';
import { createChatExtensions } from './chat-extensions.ts';
import { checkToolchain } from '../toolchain/check.ts';
import { readProject } from '../toolchain/project.ts';
import { createEdgeCheck } from './edge-check.ts';
import {
  accountKnowledgeSource,
  createKnowledgeExtension,
  createKnowledgeVisibility,
  type KnowledgeConfig,
} from './knowledge-service.ts';
import type { OmsAccountControls } from './oms-account.ts';
import { installedProgramClients, programReferenceExtension } from './program-reference.ts';
import { backendFor, type ExecutionBackend } from './execution-backend.ts';
import { createSandboxTools } from './sandbox-tools.ts';
import type { SessionHooks } from './session-hooks.ts';
import type { SessionLifecycle } from './session-lifecycle.ts';
import type { RuntimeEnvironment } from './session-environment.ts';
import type { CommonSessionOptions } from './session-types.ts';
import { createDiagnosisExtension } from './solana-diagnosis.ts';
import { createWeb } from './web.ts';

/** The task's tools: sandbox commands, toolchain report, optional web, the knowledge source and the optional edge check. */
export interface SessionTools {
  /** The task root as the agent and the guards see it: the real checkout on host, /work in a container. */
  taskRoot: string;
  backend: ExecutionBackend;
  sandboxTools: ReturnType<typeof createSandboxTools>;
  toolchainReadiness(): ReturnType<typeof checkToolchain> | { status: string; error: string };
  toolchainSummary: string;
  web: ReturnType<typeof createWeb> | undefined;
  /** Read on every call, never cached: a /login or /logout takes effect on the next call. */
  knowledgeSource: () => KnowledgeConfig | undefined;
  edgeCheck: ReturnType<typeof createEdgeCheck> | undefined;
}

export function createSessionTools(
  options: CommonSessionOptions,
  life: SessionLifecycle,
  env: RuntimeEnvironment,
  account: OmsAccountControls,
  edge?: { changedPaths: () => string[] },
): SessionTools {
  const { environment } = options;
  const { root } = env;
  const backend = backendFor(environment);
  const taskRoot = backend.taskRoot(root.codeRoot);
  const sandboxTools = createSandboxTools({
    onSpawn: life.processes!.onSpawn,
    backend,
    approvalPolicy: options.hostApprovalPolicy,
    hostTrust: options.hostTrust,
    writeDetails: options.hostTrust !== undefined,
    sharedSource: options.hostTrust !== undefined,
    protectedPaths: env.protectedFiles.map((file) => join(taskRoot, file)),
    taskName: root.taskName,
    mounts: env.mounts,
    leaseDir: root.leaseDir,
    sourceControlDir: root.sourceControlDir,
    surfnetPort: env.surfnetPort,
    signal: life.controller.signal,
    surfpool: backend.surfpoolPath(environment),
    outputMode: options.outputMode,
    buildProfile: environment.buildProfile,
    remainingWallClockMs: () => env.budget.snapshot().remaining.wallClockMs,
  });
  life.taskTools = sandboxTools;
  const toolchainReadiness: SessionTools['toolchainReadiness'] = () => {
    try {
      return checkToolchain(readProject(root.codeRoot));
    } catch {
      return {
        status: 'proposed, not verified',
        error: 'Toolchain scan unavailable: invalid/oversized manifests or Python >=3.11 missing',
      };
    }
  };
  const initialToolchain = toolchainReadiness();
  const installedClients = installedProgramClients([
    root.codeRoot,
    ...(environment.dependencies ? [environment.dependencies] : []),
  ]);
  const toolchainSummary =
    ('findings' in initialToolchain
      ? `Compatibility rule findings: ${[...new Set(initialToolchain.findings.map((finding) => finding.rule))].join(', ') || 'none'}; use toolchain_check for details. Build not verified.`
      : 'Toolchain scan unavailable; use toolchain_check for details. Build not verified.') +
    (installedClients.length ? ` Installed official program clients: ${installedClients.join(', ')}.` : '');
  // Web tools ask for the credential only during a turn.
  const web = options.web
    ? createWeb({ account: () => account.searchCredential(), sourcesDir: env.sourcesDir, ...options.web })
    : undefined;
  // Precedence: host option, env pair, account.
  const knowledgeSource = accountKnowledgeSource({
    pinned: options.knowledge,
    account: () => account.searchCredential(),
  });
  const edgeCheck = edge ? createEdgeCheck(edge) : undefined;
  return { taskRoot, backend, sandboxTools, toolchainReadiness, toolchainSummary, web, knowledgeSource, edgeCheck };
}

/** What the main chat and every helper read with: the program reference, the transaction diagnosis and the knowledge tools. */
export function readingExtensions(env: RuntimeEnvironment, tools: SessionTools): ExtensionFactory[] {
  return [
    programReferenceExtension,
    createDiagnosisExtension({
      codeRoot: env.root.codeRoot,
      rpcUrl: `http://127.0.0.1:${env.surfnetPort}`,
      knowledge: tools.knowledgeSource,
    }),
    ...[createKnowledgeExtension(tools.knowledgeSource)].filter((extension) => extension !== undefined),
  ];
}

/** Composes the pi extensions: proposal and verification when the session has them, guards, trace, budget, the sandbox tools, prompt hooks and knowledge. */
export function createSessionExtensions(
  options: CommonSessionOptions,
  life: SessionLifecycle,
  env: RuntimeEnvironment,
  tools: SessionTools,
  hooks: SessionHooks,
  initiallyKnown: boolean,
  endRunOnProposal?: boolean,
  helpers?: ExtensionFactory,
  injected: readonly ExtensionFactory[] = [],
): ExtensionFactory[] {
  const { taskRoot, knowledgeSource } = tools;
  const extra: ExtensionFactory[] = [
    tools.sandboxTools.extension,
    hooks.policy,
    ...readingExtensions(env, tools),
    ...[
      createKnowledgeVisibility(knowledgeSource, hooks.promptFor, () => initiallyKnown),
      tools.web?.extension,
      tools.edgeCheck?.extension,
      helpers,
    ].filter((extension) => extension !== undefined),
    ...injected,
  ];
  const shared = {
    guards: { approveHostCommands: tools.backend.approvesCommands },
    cwd: taskRoot,
    trace: life.trace!,
    protectedPaths: env.protectedFiles.map((file) => join(taskRoot, file)),
    extra,
  };
  return env.contract
    ? createOmsExtensions({
        ...shared,
        budget: env.budget,
        proposer: env.contract.proposer,
        evaluator: env.contract.evaluator,
        endRunOnProposal,
      }).extensions
    : createChatExtensions(shared);
}
