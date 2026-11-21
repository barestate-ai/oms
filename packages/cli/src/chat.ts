import {
  createChatSession,
  latestChatSession,
  omsCommand,
  resolveChatFolder,
  savedBudgetUsable,
  scratchNotice,
  type ChatFolder,
  type HarnessEnvironment,
} from '@oms/engine';
import { webSetting } from './interactive.ts';
import type { LaunchOptions } from './harness.ts';
import { chooseLocalAction } from './ownership.ts';
import { runOmsInterface } from './tui/interface.ts';
import { interfacePreferences } from './tui/preferences.ts';
import { YOLO_NOTICE } from './tui/ui-commands.ts';

export interface ChatLaunch {
  folder: string;
  /** Where OMS keeps its state; `~/.oms` for the installed command. */
  stateRoot: string;
  environment: HarnessEnvironment;
  launch: LaunchOptions;
  /** false for --no-web. Web tools are still registered so /web on can turn them on later. */
  web?: boolean;
  /** --yolo: start with commands unsandboxed and unasked. */
  yolo?: boolean;
  start?: typeof createChatSession;
  run?: typeof runOmsInterface;
  choose?: typeof chooseLocalAction;
}

/**
 * Which conversation a launch opens: the most recent one of this folder, or a new one. A saved conversation whose budget can
 * admit no work is never reopened silently: the user starts a separate one on purpose, or cancels (undefined).
 */
export async function chooseChatSession(
  folder: ChatFolder,
  stateRoot: string,
  launch: Pick<LaunchOptions, 'caps' | 'executionMode'>,
  choose = chooseLocalAction,
): Promise<{ sessionId?: string } | undefined> {
  const saved = latestChatSession(folder, stateRoot);
  if (!saved) return {};
  if (savedBudgetUsable(saved.journal, launch.caps, launch.executionMode)) return { sessionId: saved.sessionId };
  const selected = await choose(
    `The saved session cannot admit work: its limits are exhausted or its accounting needs reconciliation. Conversation and accounting are retained, including unknown charges. Cancel to inspect/reconcile the saved journal, or explicitly start a separate ${launch.executionMode} session with the selected caps. This does not resolve previous unknown usage.`,
    [{ value: 'new', label: 'Start a new session; retain all previous history and accounting' }],
  );
  return selected === 'new' ? {} : undefined;
}

/** Opens the chat for a folder and returns when the user quits. All state stays under the state root. */
export async function runInteractiveChat(o: ChatLaunch): Promise<void> {
  // Internal SDK policy: no automatic catalog refresh, update checks or telemetry.
  process.env.PI_OFFLINE = '1';
  const folder = resolveChatFolder(o.folder, { stateRoot: o.stateRoot });
  const selected = await chooseChatSession(folder, o.stateRoot, o.launch, o.choose);
  if (!selected) return;
  const chat = await (o.start ?? createChatSession)({
    folder,
    stateRoot: o.stateRoot,
    environment: o.environment,
    caps: o.launch.caps,
    maxOutputTokens: o.launch.maxOutputTokens,
    executionMode: o.launch.executionMode,
    web: { enabled: o.web !== false && webSetting(o.stateRoot) === 'on' },
    ...(o.yolo ? { yolo: true } : {}),
    ...selected,
  });
  try {
    await (o.run ?? runOmsInterface)(chat, {
      ...interfacePreferences(o.stateRoot),
      view: 'harness',
      ...(folder.scratch || o.yolo
        ? {
            startNote: [folder.scratch ? scratchNotice(folder.path) : '', o.yolo ? YOLO_NOTICE : '']
              .filter(Boolean)
              .join('\n'),
          }
        : {}),
    });
  } finally {
    await chat.close();
  }
  process.stdout.write(`Run ${omsCommand()} in this folder to continue.\n`);
}
