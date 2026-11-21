import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createBudgetLedger, type BudgetCaps, type BudgetLedgerEvent, type ExecutionMode } from '@oms/core';
import { acquireMutationLease, inspectMutationLease, type MutationLease } from '../workspace/index.ts';
import { assertPrivate, WorkspaceError } from '../workspace/storage.ts';
import type { ChatFolder } from './chat-folder.ts';
import { backendFor } from './execution-backend.ts';
import { serialized, type HostTrust } from './host-approval.ts';
import { createHelpers } from './helpers/index.ts';
import { recoverSession } from './recovery.ts';
import { createCoreApi } from './session-api.ts';
import { assembleSession, startSession } from './session-assembly.ts';
import {
  claimRuntime,
  openConversation,
  planMounts,
  startSurfnet,
  warnAboutBackend,
  type RuntimeEnvironment,
} from './session-environment.ts';
import { chatRoot, chatStateDir, type SessionRoot } from './session-root.ts';
import type { ChatSession, ChatSessionOptions } from './session-types.ts';
import { omsCommand } from './cli-command.ts';

export const DOCKER_CHAT_REFUSAL = `Run \`${omsCommand()} help advanced\` for workspace and task setup instructions. Docker mode requires a pinned task and does not support folder chat.`;

/** Another window already has this folder open. */
export class ChatBusyError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(
      `OMS is already open in this folder (process ${pid}). Close that window, or run ${omsCommand()} in another folder.`,
    );
    this.name = 'ChatBusyError';
    this.pid = pid;
  }
}

/** The agent may commit, but a hook or a changed config would run later outside the sandbox. */
const PROTECTED_GIT_FILES = ['.git/hooks', '.git/config'];

/** A stale owner's recorded processes are stopped first, so a crashed window never blocks its folder. */
async function acquireChatLease(root: SessionRoot): Promise<MutationLease> {
  try {
    return acquireMutationLease(root.leaseFile);
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    const found = inspectMutationLease(root.leaseFile);
    if (found.status === 'live') throw new ChatBusyError(found.owner.pid);
    if (found.status !== 'stale') throw error;
    await recoverSession(root, found.owner, 'host');
    return acquireMutationLease(root.leaseFile);
  }
}

export async function createChatSession(options: ChatSessionOptions): Promise<ChatSession> {
  const { folder, stateRoot } = options;
  if (backendFor(options.environment).requiresDocker) throw new Error(DOCKER_CHAT_REFUSAL);
  const root = chatRoot(folder, stateRoot);
  // Seatbelt is the protection and needs no warning; the missing sandbox elsewhere is told once.
  if (backendFor(options.environment).notice()?.key !== 'seatbelt') warnAboutBackend(options.environment, stateRoot);
  const trust: HostTrust = { yolo: options.yolo === true, allowed: new Set() };
  options = { ...options, hostTrust: trust };
  return startSession(await acquireChatLease(root), async (life) => {
    const { execution, processes } = claimRuntime(options, root, life);
    // Only a repository that already exists has hooks and config worth guarding; a new one the user asked for must work.
    const protectedFiles = PROTECTED_GIT_FILES.filter((file) => existsSync(join(root.codeRoot, file)));
    const conversation = openConversation(options, root, life);
    life.discardUnused = () => {
      const saved = conversation.manager.getSessionFile();
      if (conversation.budget.reservations().length || (saved && existsSync(saved))) return;
      for (const suffix of ['budget', 'trace'])
        rmSync(join(root.sessionsDir, `${conversation.sessionId}.${suffix}.jsonl`), { force: true });
    };
    const surfnetPort = await startSurfnet(options, root, life, processes);
    const env: RuntimeEnvironment = {
      root,
      ...conversation,
      surfnetPort,
      ...planMounts(options, root, execution, protectedFiles),
      protectedFiles: [...protectedFiles, '.oms-agents'],
    };
    const helpers = createHelpers({
      dirs: { personal: join(stateRoot, 'agents'), project: join(folder.path, '.oms-agents') },
      trust,
    });
    life.helpers = helpers;
    const parts = await assembleSession(options, life, env, {
      owner: 'this folder',
      helpers: helpers.extension,
      extensions: options.extensions,
      extensionTools: options.extensionTools,
    });
    helpers.bind(parts);
    const core = createCoreApi(parts);
    return {
      ...core,
      // Helpers can ask together; the terminal shows one question at a time.
      setHostApproval: (approve) => core.setHostApproval?.(approve && serialized(approve)),
      helpers: helpers.api,
      kind: 'chat',
      folder,
      yolo: {
        enabled: () => trust.yolo,
        set: (on) => {
          trust.yolo = on;
        },
      },
    };
  });
}

/** The newest saved conversation of a folder, with the budget journal that goes with it. */
export function latestChatSession(
  folder: ChatFolder,
  stateRoot: string,
): { sessionId: string; journal: string } | undefined {
  const sessions = join(chatStateDir(stateRoot, folder.key), 'sessions');
  if (!existsSync(sessions)) return undefined;
  const recent = SessionManager.continueRecent(folder.path, sessions);
  const file = recent.getSessionFile();
  if (!file || !existsSync(file)) return undefined;
  const sessionId = recent.getSessionId();
  return { sessionId, journal: join(sessions, `${sessionId}.budget.jsonl`) };
}

/** Whether a saved conversation's budget can still admit work, without changing it. */
export function savedBudgetUsable(
  journal: string,
  caps: BudgetCaps,
  executionMode: ExecutionMode | undefined,
  now = Date.now(),
): boolean {
  if (!existsSync(journal)) return false;
  try {
    assertPrivate(journal, false);
    const contents = readFileSync(journal, 'utf8');
    if (!contents.endsWith('\n') || contents.length === 0) return false;
    const events = contents
      .slice(0, -1)
      .split('\n')
      .map((line) => JSON.parse(line)) as BudgetLedgerEvent[];
    const ledger = createBudgetLedger({
      caps,
      clock: () => now,
      events,
      persist() {
        throw new Error('Read-only budget inspection');
      },
    });
    const snapshot = ledger.snapshot();
    // Resuming charges an uncertain or interrupted request at its reservation, so an interactive chat goes on.
    if (executionMode === 'interactive') return true;
    if (snapshot.accounting !== 'known' || snapshot.pendingDispatchIds.length !== 0) return false;
    return !snapshot.admissionBlocked;
  } catch {
    return false;
  }
}
