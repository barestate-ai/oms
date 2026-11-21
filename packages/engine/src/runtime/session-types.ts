import type {
  AgentSession,
  AgentSessionRuntime,
  ExtensionFactory,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { EvaluateResult, Evaluator, TaskContract } from '@oms/contract';
import type { BudgetCaps, BudgetLedger, ExecutionMode } from '@oms/core';
import type { SandboxResult } from '@oms/sandbox';
import type { Task, Workspace } from '../workspace/index.ts';
import type { ChainControls } from './chain.ts';
import type { ChatFolder } from './chat-folder.ts';
import type { NativeChatControls } from './claude-code.ts';
import type { EdgeCheckSummary } from './edge-check.ts';
import type { Helpers } from './helpers/index.ts';
import type { HostApproval, HostApprovalPolicy, HostTrust } from './host-approval.ts';
import type { KnowledgeConfig } from './knowledge-service.ts';
import type { OmsAccountControls } from './oms-account.ts';
import type { ProviderControls } from './provider-controls.ts';
import type { HarnessSettingsControls } from './settings-controls.ts';
import type { TaskFileAccess } from './task-files.ts';
import type { TaskTerminal } from './task-terminal.ts';
import type { WebConfig, WebUsage } from './web.ts';

export interface HarnessEnvironment {
  backend?: 'host' | 'docker';
  binary: string;
  image: string;
  forwarderImage: string;
  buildProfile?: boolean;
  /** Trusted lockfile checkout; never discovered from contender workspaces. */
  dependencies?: string;
}
export interface HarnessTaskDefinition {
  contract: TaskContract;
  verifierPaths: string[];
  codePaths: string[];
  snapshotPath?: string;
  testTimeoutMs?: number;
}
/** What a pinned task session and a folder chat are opened with alike. */
export interface CommonSessionOptions {
  environment: HarnessEnvironment;
  hostApprovalPolicy?: HostApprovalPolicy;
  /** A folder chat's trust; pinned tasks and headless runs never set it and keep asking. */
  hostTrust?: HostTrust;
  caps: BudgetCaps;
  maxOutputTokens: number;
  /** Trusted text-only local transport bound; omitted in normal sessions. */
  maxInputTokens?: number;
  /** Benchmark runner only: bounded ChatGPT-subscription calls are not held to the API-dollar cap (they cost no API credit). */
  subscriptionSpendExempt?: boolean;
  executionMode?: ExecutionMode;
  /** Opt-in model/user command previews and session-scoped read_log; never verifier output. */
  outputMode?: 'head-tail';
  /** Trusted clock injection for deterministic execution-window tests. */
  clock?: () => number;
  sessionId?: string;
  /** Trusted host/test injection, never repository-discovered executable code. */
  modelRuntime?: ModelRuntime;
  model?: Model<Api>;
  modelSelection?: { provider: string; id: string };
  /** Trusted host configuration for the Solana knowledge service, for the benchmark harness. Absent: the session uses
   * OMS_KNOWLEDGE_URL plus OMS_KNOWLEDGE_TOKEN when both are set, else the signed-in OMS account, else the tools are hidden. */
  knowledge?: KnowledgeConfig;
  /** The look-it-up nudge in the system prompt. Defaults on whenever a knowledge credential exists; false turns it off. */
  knowledgeHint?: boolean;
  /** The search_docs rule and the top task-matched doc snippets in the first user turn (headless). Defaults on whenever a knowledge credential exists. */
  knowledgeInject?: boolean;
  /** Web access (web_search, web_fetch, Solana MCP), host-side. Absent means the tools do not exist: the bench never sets it. */
  web?: WebConfig;
}
export interface HarnessSessionOptions extends CommonSessionOptions {
  workspace: Workspace;
  task: Task;
  /** Stop the run at a successful propose_done: the verifier answers next, with no closing model reply (headless). */
  endRunOnProposal?: boolean;
  /** Hold the first propose_done on a program change for a bounded edge-case pass (A3). Off by default. */
  edgeCheck?: boolean;
}
export interface HarnessVerification {
  itemId: string;
  result: EvaluateResult;
}
/** What every live session offers, whether it is a pinned task or a folder chat. */
export interface SessionCore extends ProviderControls {
  nativeChat?: NativeChatControls;
  /** The folder the agent edits. */
  root: string;
  runtime: AgentSessionRuntime;
  session: AgentSession;
  budget: BudgetLedger;
  settings: HarnessSettingsControls;
  account: OmsAccountControls;
  runCommand(command: string, signal?: AbortSignal): Promise<SandboxResult>;
  files: TaskFileAccess;
  startTerminal(columns: number, rows: number): Promise<TaskTerminal>;
  setHostApproval?(approve: HostApproval | undefined): void;
  /** Present only when the session was opened with `web`; `set` is the `/web on|off` switch. */
  web?: { enabled(): boolean; set(on: boolean): void; usage(): WebUsage };
  /** The task's local Surfpool, for chain commands (never another network). */
  chain?: ChainControls;
  /** decode_error text for a program error code; throws when no knowledge credential exists. */
  knowledge: {
    decodeError(code: string, program?: string, signal?: AbortSignal): Promise<string>;
    /** The credential the knowledge tools use right now, read on each call. */
    config(): KnowledgeConfig | undefined;
  };
  close(): Promise<void>;
}
/** A conversation that works in place in the user's folder, with no pinned task, verifier or proposal tool. */
export interface ChatSession extends SessionCore {
  kind: 'chat';
  folder: ChatFolder;
  /** Helper agents: the ones that can be started, and the ones that ran in this conversation. */
  helpers: Helpers;
  /** YOLO: commands run without asking and without the sandbox. */
  yolo: { enabled(): boolean; set(on: boolean): void };
}
export interface ChatSessionOptions extends CommonSessionOptions {
  folder: ChatFolder;
  /** Where OMS keeps this folder's state: `<stateRoot>/folders/<key>`. */
  stateRoot: string;
  /** Start with YOLO on. */
  yolo?: boolean;
  /** Trusted host injection from the launching CLI; never repository-discovered. They load after the built-in extensions. */
  extensions?: readonly ExtensionFactory[];
  /** The tools those extensions register. The session's tool list drops any tool it does not name (`*` patterns allowed). */
  extensionTools?: readonly string[];
}
export type OmsSession = HarnessSession | ChatSession;
export interface HarnessSession extends SessionCore {
  kind: 'task';
  workspace: Workspace;
  task: Task;
  evaluator: Evaluator;
  verify(itemId?: string): Promise<HarnessVerification>;
  /** Present only when the session was opened with `edgeCheck`. */
  edgeCheck?: { summary(): EdgeCheckSummary };
}
