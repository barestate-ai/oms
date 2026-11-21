import { omsCommand, type OmsSession } from '@oms/engine';
import type { runReviewCommand } from '../review.ts';
import {
  prepareAccount,
  prepareAirdrop,
  prepareChain,
  prepareError,
  prepareProgram,
  prepareRewind,
  prepareTransaction,
} from './solana-commands.ts';
import { prepareDiff, prepareSession, prepareStatus, prepareUsage } from './inspect-commands.ts';
import { prepareReview, prepareRun, prepareTest, prepareVerify } from './work-commands.ts';
import { agentsCommand, teamCommand } from './agent-commands.ts';
import { acceptsConnectors, connectorCommandNames, connectorsCommand, contextCommand } from './connector-commands.ts';
import type { Connectors } from '../connectors/runtime.ts';
import { clearConversation, goalCommand } from './conversation-commands.ts';
import { acceptsArt, acceptsLayout, acceptsPanel, acceptsWeb, uiCommands } from './ui-commands.ts';
import { refuseWith, type Prepared } from './prepared.ts';
import type { Goal } from './goal.ts';
import type { StartupArtMode } from './startup-art.ts';
import type { Conversation } from './transcript.ts';
import type { WorkbenchPane } from './workbench.ts';
import type { TerminalPane } from './terminal-pane.ts';
import type { WorkbenchIde } from './ide.ts';

export type FocusTarget =
  'input' | 'requirements' | 'conversation' | 'editor' | 'terminal' | 'actions' | 'explorer' | 'panel';
export type ViewName = 'harness' | 'workbench';
export interface Requirement {
  id: string;
  title: string;
  status: string;
}

/** What a command may do to the interface. interface.ts builds one over its live state; handlers touch nothing else. */
export interface CommandContext {
  readonly harness: OmsSession;
  readonly workbench: WorkbenchPane;
  readonly shell: TerminalPane;
  /** The workbench screen: explorer, panel, quick open, tasks. */
  readonly ide: WorkbenchIde;
  readonly conversation: Conversation;
  readonly review: typeof runReviewCommand;
  columns(): number;
  setNotice(text: string): void;
  /** Remove the composer text a command was typed as, if it is still there. */
  clearDraft(draft: string | undefined): void;
  /** Answer at once: a note in the conversation, the draft cleared, the agent composer focused. */
  show(title: string, text: string, draft: string | undefined): void;
  switchView(view: ViewName): void;
  setFocus(focus: FocusTarget): void;
  scrollToEnd(): void;
  /** Scroll so the newest note starts at the top of the conversation (a long list is read from its first line). */
  scrollToNote(): void;
  editorAction(action: () => void | Promise<void>): void;
  terminalAction(action: string): void;
  /** Show or hide the agent beside the workbench; undefined toggles. */
  setAgentPanel(visible: boolean | undefined): void;
  toggleRequirements(): void;
  /** Re-read the requirements and report what was last checked. */
  checkRequirements(): { proofAvailable: boolean; checkedAt: string; items: readonly Requirement[] };
  selectedRequirement(): string | undefined;
  modelDetail(): string | undefined;
  openSetup(mode: 'model' | 'connect' | 'theme' | 'settings', query: string, draft: string | undefined): void;
  openAccount(mode: 'login' | 'logout' | 'account', draft: string | undefined): void;
  /** A folder chat's connectors; absent in a pinned task and in tests that do not need them. */
  readonly connectors?: Connectors;
  openConnectors(draft: string | undefined): void;
  /** False, with a notice, for an unknown theme. */
  changeTheme(id: string): boolean;
  art: { setMode(mode: StartupArtMode): void; next(): void; title(): string; reload(): void };
  goal: { get(): Goal | undefined; set(goal: Goal | undefined): void };
  startGoal(text: string, check: string | undefined, draft: string | undefined): void;
  /** Send text to the agent as the user's next message. */
  ask(text: string, draft: string | undefined): void;
  /** Run another command as if chosen from the menu. */
  submit(text: string): void;
  cancel(): void;
  quit(): void;
  /** Ask a yes/no question on one key: y runs `onYes`; n, Esc or any other key drops it. */
  confirm(question: string, onYes: () => void): void;
}

/** A handler answers directly (nothing returned) or hands back work for the shared pipeline: a refusal, or something to run. */
export type CommandHandler = (ctx: CommandContext, argument: string, draft: string | undefined) => Prepared | void;

/**
 * Whether a command runs while work is busy. 'always': reads, any argument. 'accepted': interface-only commands, for the
 * arguments they accept. 'never': it needs the agent and the task idle. A function decides by argument.
 */
export type WhileBusy = 'always' | 'accepted' | 'never' | ((argument: string) => boolean);

export interface CommandSpec {
  name: string;
  group: 'Navigate' | 'Setup' | 'Edit' | 'Inspect' | 'Work' | 'Solana';
  description: string;
  /** Shown after the name in the menu and /help. */
  argument?: string;
  /** Completion leaves the cursor after the name instead of running it. */
  needsArgument?: true;
  /** Which arguments the command takes; for anything else the user is told its usage. Default: none. */
  accepts?: (argument: string) => boolean;
  whileBusy: WhileBusy;
  /** False for work that must finish within its backend timeout: the Cancel control stays off and /cancel refuses. */
  cancellable?: false;
  /** 'task' commands need a pinned task: a chat hides them from the menu and /help and refuses them when typed. 'chat' commands exist only in a chat. */
  availability?: 'task' | 'chat';
  /** What the header and a failure note call this work when it runs as an action. Default: command. */
  activity?: 'verification' | 'review';
  run: CommandHandler;
}

const any = (): boolean => true;
const present = (argument: string): boolean => argument !== '';
const singleWord = (argument: string): boolean => !/\s/.test(argument);
const nonBlank = (argument: string): boolean => argument.trim() !== '';

type KeyRow = readonly [keys: string, action: string];

/** Two aligned columns: the keys, then what they do. */
const keyTable = (rows: readonly KeyRow[]): string => {
  const width = Math.max(...rows.map(([keys]) => keys.length)) + 2;
  return rows.map(([keys, action]) => `  ${keys.padEnd(width)}${action}`).join('\n');
};

/** Every key of the current mode, from one table: /help keys. A chat has no requirements panel and no toolbar. */
export function keysHelp(kind: 'task' | 'chat' = 'task'): string {
  const chat = kind === 'chat';
  const keys: KeyRow[] = [
    ['enter', 'send'],
    ['shift+enter', 'new line (alt+enter too)'],
    ['esc', 'cancel work · close a menu'],
    ['ctrl+c', 'cancel work · twice to quit'],
    ['ctrl+q', 'quit (ctrl+d on an empty line)'],
    ['/ or ctrl+k', 'commands'],
    ['ctrl+o', 'expand tool output'],
    ['ctrl+t', 'show or hide thinking'],
    ['tab', 'move focus (shift+tab back)'],
    ['pgup pgdn', 'scroll the conversation'],
    ['f3', 'workbench or conversation'],
    ['f4', 'pick a model'],
    ['f8', 'next theme'],
    ['f6', 'move between areas'],
    ['f10', 'header tabs'],
    ...(chat ? [] : ([['f2', 'requirements panel']] as KeyRow[])),
  ];
  const workbench: KeyRow[] = [
    ['ctrl+p', 'open a file · name:line · :line · #text'],
    ['ctrl+b', 'file list'],
    ['alt+j', 'bottom panel'],
    ['alt+a', 'ask the agent about the selection'],
    ['f7', 'tasks and helper agents'],
    ['ctrl+n', 'new file'],
    ['ctrl+s', 'save'],
    ['ctrl+f', 'find'],
    ['ctrl+h', 'replace'],
    ['ctrl+/', 'comment'],
    ['ctrl+r', 'reload a file that changed'],
    ['ctrl+w', 'close tab'],
    ['ctrl+tab', 'next tab'],
    ['ctrl+\\', 'other split side'],
    ['ctrl+l', 'back to the agent'],
  ];
  return [
    'Keys',
    keyTable(keys),
    '',
    'Workbench',
    keyTable(workbench),
    '',
    'Terminal',
    keyTable([
      ['ctrl+c', 'interrupt'],
      ['f6', 'move out (the shell gets every other key)'],
      ['shift+pgup', 'scroll back'],
      ['/terminal stop', 'end the shell'],
    ]),
    '',
    'Sign-in',
    keyTable([
      ['ctrl+x', 'copy the link or code'],
      ['ctrl+u', 'clear the field'],
    ]),
  ].join('\n');
}

/** The commands a chat lists in /help, in this order; the rest are still typed or found with /. */
const CHAT_HELP = [
  'connect',
  'connectors',
  'model',
  'yolo',
  'web',
  'goal',
  'team',
  'agents',
  'run',
  'test',
  'diff',
  'status',
  'usage',
  'session',
  'clear',
  'cancel',
  'files',
  'terminal',
  'workbench',
  'review',
  'chain',
  'rewind',
  'airdrop',
  'tx',
  'account',
  'program',
  'error',
];
/** The few keys /help shows under the commands; /help keys has the rest. */
const SHORT_KEYS =
  'Keys\n' +
  keyTable([
    ['esc', 'cancel'],
    ['ctrl+c', 'cancel · twice to quit'],
    ['ctrl+k', 'commands'],
    ['/help keys', 'all keys'],
  ]);

/** `extra` names commands that only work with a connected service (/pr, /issue, /ci) and are listed only then. */
export function chatHelp(extra: readonly string[] = []): string {
  const rows = [...CHAT_HELP, ...extra]
    .map((name) => findCommand(name)!)
    .map((command) => [`/${command.name}`, command.description]);
  const width = Math.max(...rows.map(([name]) => name!.length)) + 2;
  const list = rows.map(([name, text]) => `${name!.padEnd(width)}${text}`).join('\n');
  return `${list}\n\nAlso: /theme /art /settings /login /logout · /exit to quit\n\n${SHORT_KEYS}`;
}

/** /help lists the commands and a few keys; /help keys lists every key. It lives here because it renders the table. */
const help: CommandHandler = (ctx, argument, draft) => {
  const chat = ctx.harness.kind === 'chat';
  ctx.conversation.note(
    'help',
    argument === 'keys'
      ? keysHelp(ctx.harness.kind)
      : chat
        ? chatHelp(connectorCommandNames(ctx.connectors))
        : `${commandHelp(ctx.harness.kind)}\n\n${SHORT_KEYS}`,
  );
  ctx.clearDraft(draft);
  ctx.switchView('harness');
  if (!chat) ctx.setFocus('conversation');
  // Help is long: it opens at its first line, not its last.
  ctx.scrollToNote();
};

/** The one table of slash commands: what the menu and /help show, when each may run, and what it does. Order is display order. */
export const OMS_COMMANDS: readonly CommandSpec[] = [
  {
    name: 'workbench',
    group: 'Navigate',
    description: 'Editor, files and terminal',
    whileBusy: 'accepted',
    run: uiCommands.workbench,
  },
  {
    name: 'harness',
    group: 'Navigate',
    description: 'Back to chat',
    whileBusy: 'accepted',
    run: uiCommands.harness,
  },
  {
    name: 'files',
    group: 'Navigate',
    description: 'Find and open a file · ctrl+p',
    whileBusy: 'accepted',
    run: uiCommands.files,
  },
  {
    name: 'terminal',
    group: 'Navigate',
    description: 'Open a shell',
    argument: '[start|stop|hide]',
    accepts: (argument) => ['', 'start', 'stop', 'hide'].includes(argument),
    whileBusy: 'accepted',
    run: uiCommands.terminal,
  },
  {
    name: 'help',
    group: 'Navigate',
    description: 'Commands and keys',
    argument: '[keys]',
    accepts: (argument) => argument === '' || argument === 'keys',
    whileBusy: 'accepted',
    run: help,
  },
  {
    name: 'model',
    group: 'Setup',
    description: 'Pick a model',
    argument: '[search]',
    accepts: any,
    whileBusy: 'accepted',
    run: uiCommands.model,
  },
  {
    name: 'connect',
    group: 'Setup',
    description: 'Model provider sign-in or API key',
    argument: '[provider|import <path>]',
    accepts: any,
    whileBusy: 'accepted',
    run: uiCommands.connect,
  },
  {
    name: 'connectors',
    group: 'Setup',
    description: 'Give the agent GitHub, Docker, AWS',
    argument: '[dismiss]',
    accepts: acceptsConnectors,
    availability: 'chat',
    whileBusy: 'accepted',
    run: connectorsCommand,
  },
  {
    name: 'theme',
    group: 'Setup',
    description: 'Color theme',
    argument: '[name]',
    accepts: any,
    whileBusy: 'accepted',
    run: uiCommands.theme,
  },
  {
    name: 'art',
    group: 'Setup',
    description: 'Startup picture',
    argument: '[next|auto|image|truecolor|256|off]',
    accepts: acceptsArt,
    whileBusy: 'accepted',
    run: uiCommands.art,
  },
  {
    name: 'web',
    group: 'Setup',
    description: 'Show or switch web search',
    argument: '[on|off]',
    accepts: acceptsWeb,
    whileBusy: 'accepted',
    run: uiCommands.web,
  },
  {
    name: 'yolo',
    group: 'Setup',
    description: 'YOLO mode: no approvals, no sandbox',
    availability: 'chat',
    whileBusy: 'accepted',
    run: uiCommands.yolo,
  },
  {
    name: 'settings',
    group: 'Setup',
    description: 'Thinking level and preferences',
    accepts: any,
    whileBusy: 'accepted',
    run: uiCommands.settings,
  },
  {
    name: 'login',
    group: 'Setup',
    description: 'Sign in to OMS for hosted search',
    whileBusy: 'accepted',
    run: uiCommands.login,
  },
  {
    name: 'logout',
    group: 'Setup',
    description: 'Sign out of OMS',
    whileBusy: 'accepted',
    run: uiCommands.logout,
  },
  {
    name: 'account',
    group: 'Setup',
    description: 'OMS account, or a chain account with an address',
    argument: '[address] [--cluster devnet|mainnet]',
    accepts: any,
    whileBusy: 'always',
    run: (ctx, argument, draft) =>
      argument ? prepareAccount(argument, ctx.harness, ctx.connectors) : ctx.openAccount('account', draft),
  },
  {
    name: 'review',
    group: 'Inspect',
    description: 'Security report for a Solana program',
    whileBusy: 'never',
    cancellable: false,
    activity: 'review',
    run: (ctx) => prepareReview(ctx),
  },
  {
    name: 'status',
    group: 'Inspect',
    description: 'Model and budget',
    whileBusy: 'always',
    run: (ctx) => prepareStatus(ctx),
  },
  {
    name: 'session',
    group: 'Inspect',
    description: 'Session details',
    whileBusy: 'always',
    run: (ctx) => prepareSession(ctx.harness),
  },
  {
    name: 'diff',
    group: 'Inspect',
    description: 'Show changes',
    argument: '[path]',
    accepts: any,
    whileBusy: 'always',
    run: (ctx, argument) => prepareDiff(argument, ctx.harness),
  },
  {
    name: 'usage',
    group: 'Inspect',
    description: 'Tokens, spend and time',
    accepts: any,
    whileBusy: 'always',
    run: (ctx, argument) => prepareUsage(argument, ctx.harness),
  },
  {
    name: 'requirements',
    group: 'Inspect',
    description: 'Toggle requirements panel',
    availability: 'task',
    whileBusy: 'accepted',
    run: (ctx, argument, draft) =>
      ctx.harness.kind === 'chat'
        ? refuseWith(`Requirements come with a task made by ${omsCommand()} task create.`)
        : uiCommands.requirements(ctx, argument, draft),
  },
  {
    name: 'changes',
    group: 'Inspect',
    description: 'Changed files, diffs and reverting',
    whileBusy: 'accepted',
    run: uiCommands.changes,
  },
  {
    name: 'open',
    group: 'Edit',
    description: 'Open a file',
    argument: '<path>',
    needsArgument: true,
    accepts: present,
    whileBusy: 'accepted',
    run: uiCommands.open,
  },
  {
    name: 'newfile',
    group: 'Edit',
    description: 'New file · ctrl+n',
    argument: '[path]',
    accepts: any,
    whileBusy: 'accepted',
    run: uiCommands.newfile,
  },
  {
    name: 'save',
    group: 'Edit',
    description: 'Save file · ctrl+s',
    argument: '[all]',
    accepts: (argument) => argument === '' || argument === 'all',
    whileBusy: 'accepted',
    run: uiCommands.save,
  },
  {
    name: 'close',
    group: 'Edit',
    description: 'Close tab · ctrl+w',
    whileBusy: 'accepted',
    run: uiCommands.close,
  },
  { name: 'find', group: 'Edit', description: 'Find · ctrl+f', whileBusy: 'accepted', run: uiCommands.find },
  {
    name: 'replace',
    group: 'Edit',
    description: 'Replace · ctrl+h',
    whileBusy: 'accepted',
    run: uiCommands.replace,
  },
  {
    name: 'next',
    group: 'Edit',
    description: 'Next tab · ctrl+tab',
    whileBusy: 'accepted',
    run: uiCommands.next,
  },
  {
    name: 'split',
    group: 'Edit',
    description: 'Split editor · ctrl+\\ switch side',
    whileBusy: 'accepted',
    run: uiCommands.split,
  },
  {
    name: 'search',
    group: 'Edit',
    description: 'Search the project',
    argument: '[text]',
    accepts: any,
    whileBusy: 'accepted',
    run: uiCommands.search,
  },
  {
    name: 'goto',
    group: 'Edit',
    description: 'Go to a line · ctrl+g',
    argument: '<line>',
    needsArgument: true,
    accepts: present,
    whileBusy: 'accepted',
    run: uiCommands.goto,
  },
  {
    name: 'layout',
    group: 'Navigate',
    description: 'Show the agent beside the editor',
    argument: '[editor|balanced]',
    accepts: acceptsLayout,
    whileBusy: 'accepted',
    run: uiCommands.layout,
  },
  {
    name: 'tasks',
    group: 'Navigate',
    description: 'Tasks and helper agents · f7',
    whileBusy: 'accepted',
    run: uiCommands.tasks,
  },
  {
    name: 'panel',
    group: 'Navigate',
    description: 'Terminal, problems, output and changes · alt+j',
    argument: '[terminal|problems|output|changes|hide]',
    accepts: acceptsPanel,
    whileBusy: 'accepted',
    run: uiCommands.panel,
  },
  {
    name: 'sidebar',
    group: 'Navigate',
    description: 'Show or hide the file list · ctrl+b',
    whileBusy: 'accepted',
    run: uiCommands.sidebar,
  },
  {
    name: 'verify',
    group: 'Work',
    description: 'Check a requirement',
    availability: 'task',
    argument: '[item-id]',
    accepts: singleWord,
    whileBusy: 'never',
    cancellable: false,
    activity: 'verification',
    run: (ctx, argument) => prepareVerify(ctx, argument),
  },
  {
    name: 'run',
    group: 'Work',
    description: 'Run a shell command',
    argument: '<command>',
    needsArgument: true,
    accepts: nonBlank,
    whileBusy: 'never',
    run: (ctx, argument) => prepareRun(argument, ctx.harness),
  },
  {
    name: 'test',
    group: 'Work',
    description: 'Run the project tests',
    accepts: any,
    whileBusy: 'never',
    run: (ctx, argument) => prepareTest(argument, ctx.harness),
  },
  {
    name: 'goal',
    group: 'Work',
    description: 'Keep going until a check passes',
    argument: '[<text> [--check "<command>"] | clear]',
    accepts: any,
    whileBusy: (argument) => !argument.trim(),
    run: goalCommand,
  },
  {
    name: 'team',
    group: 'Work',
    description: 'Split a goal across helper agents',
    argument: '<goal>',
    needsArgument: true,
    accepts: nonBlank,
    availability: 'chat',
    whileBusy: 'never',
    run: teamCommand,
  },
  {
    name: 'agents',
    group: 'Work',
    description: 'List helper agents, or add one',
    argument: '[new <name> <what it does>]',
    accepts: any,
    availability: 'chat',
    whileBusy: 'always',
    run: agentsCommand,
  },
  {
    name: 'pr',
    group: 'Work',
    description: 'Have the agent review a pull request',
    argument: '[number] [request]',
    accepts: any,
    availability: 'chat',
    whileBusy: 'never',
    run: contextCommand('pr'),
  },
  {
    name: 'issue',
    group: 'Work',
    description: 'Have the agent work on an issue',
    argument: '<number|LIN-123> [request]',
    needsArgument: true,
    accepts: any,
    availability: 'chat',
    whileBusy: 'never',
    run: contextCommand('issue'),
  },
  {
    name: 'ci',
    group: 'Work',
    description: 'Have the agent fix failing checks',
    argument: '[request]',
    accepts: any,
    availability: 'chat',
    whileBusy: 'never',
    run: contextCommand('ci'),
  },
  {
    name: 'clear',
    group: 'Work',
    description: 'Start a new conversation',
    accepts: any,
    whileBusy: 'never',
    run: clearConversation,
  },
  {
    name: 'cancel',
    group: 'Work',
    description: 'Stop the current work',
    whileBusy: 'accepted',
    run: uiCommands.cancel,
  },
  {
    name: 'exit',
    group: 'Work',
    description: 'Quit',
    whileBusy: 'accepted',
    run: (ctx) => ctx.quit(),
  },
  {
    name: 'quit',
    group: 'Work',
    description: 'Quit',
    whileBusy: 'accepted',
    run: (ctx) => ctx.quit(),
  },
  {
    name: 'chain',
    group: 'Solana',
    description: 'Local chain status',
    accepts: any,
    whileBusy: 'always',
    run: (ctx, argument) => prepareChain(argument, ctx.harness),
  },
  {
    name: 'rewind',
    group: 'Solana',
    description: 'Reset the local chain',
    argument: '[confirm]',
    accepts: any,
    whileBusy: 'never',
    run: (ctx, argument) => prepareRewind(argument, ctx.harness),
  },
  {
    name: 'airdrop',
    group: 'Solana',
    description: 'Airdrop SOL on the local chain',
    argument: '<address> [sol]',
    needsArgument: true,
    accepts: any,
    whileBusy: 'never',
    run: (ctx, argument) => prepareAirdrop(argument, ctx.harness),
  },
  {
    name: 'tx',
    group: 'Solana',
    description: 'Inspect a transaction',
    argument: '<signature> [--cluster devnet|mainnet]',
    needsArgument: true,
    accepts: any,
    whileBusy: 'always',
    run: (ctx, argument) => prepareTransaction(argument, ctx.harness, ctx.connectors),
  },
  {
    name: 'program',
    group: 'Solana',
    description: 'Look up a program (offline)',
    argument: '<name|id> [instruction]',
    needsArgument: true,
    accepts: any,
    whileBusy: 'always',
    run: (_ctx, argument) => prepareProgram(argument),
  },
  {
    name: 'error',
    group: 'Solana',
    description: 'Decode a program error code',
    argument: '<code> [program]',
    needsArgument: true,
    accepts: any,
    whileBusy: 'always',
    run: (ctx, argument) => prepareError(argument, ctx.harness),
  },
];

const BY_NAME: ReadonlyMap<string, CommandSpec> = new Map(OMS_COMMANDS.map((command) => [command.name, command]));

export type OmsCommand = CommandSpec;
export const findCommand = (name: string | undefined): CommandSpec | undefined =>
  name === undefined ? undefined : BY_NAME.get(name);

/** `/name rest` gives the lowercase name and the argument text; undefined for text that is not a command. */
export function parseCommand(text: string): { name: string; argument: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  return match ? { name: match[1]!.toLowerCase(), argument: match[2] ?? '' } : undefined;
}

export function acceptsArgument(command: CommandSpec, argument: string): boolean {
  return (command.accepts ?? ((value: string) => value === ''))(argument);
}

export function canRunWhileBusy(command: CommandSpec, argument: string): boolean {
  const rule = command.whileBusy;
  return typeof rule === 'function'
    ? rule(argument)
    : rule === 'always' || (rule === 'accepted' && acceptsArgument(command, argument));
}

/**
 * Only an unfinished command name opens completion; arguments remain normal input. A chat lists the commands its /help shows
 * first, then the rest; /quit is typed, never listed beside /exit.
 */
export function commandMatches(draft: string, kind: 'task' | 'chat' = 'task'): readonly CommandSpec[] | undefined {
  const match = /^\/([a-z]*)$/i.exec(draft.trimStart());
  if (!match) return undefined;
  const query = match[1]!.toLowerCase();
  // /quit stays typeable but is not listed beside /exit.
  const matches = available(kind).filter(
    (command) => command.name.startsWith(query) && (query !== '' || command.name !== 'quit'),
  );
  if (kind !== 'chat') return matches;
  const rank = (command: CommandSpec) => {
    const index = CHAT_HELP.indexOf(command.name);
    return index < 0 ? CHAT_HELP.length : index;
  };
  return matches
    .map((command, order) => ({ command, order }))
    .sort((a, b) => rank(a.command) - rank(b.command) || a.order - b.order)
    .map(({ command }) => command);
}

const available = (kind: 'task' | 'chat'): readonly CommandSpec[] =>
  OMS_COMMANDS.filter((command) => command.availability !== (kind === 'chat' ? 'task' : 'chat'));

/** Edit distance between two short words. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** The command a mistyped name most likely meant: one it starts, or one within a couple of typos. */
export function closestCommand(name: string, kind: 'task' | 'chat' = 'task'): CommandSpec | undefined {
  const typed = name.toLowerCase();
  const choices = available(kind).filter((command) => command.name !== 'quit');
  const started = typed.length >= 2 ? choices.find((command) => command.name.startsWith(typed)) : undefined;
  if (started) return started;
  const tolerance = typed.length <= 4 ? 1 : 2;
  let best: { command: CommandSpec; away: number } | undefined;
  for (const command of choices) {
    const away = distance(typed, command.name);
    if (away <= tolerance && (!best || away < best.away)) best = { command, away };
  }
  return best?.command;
}

/** What to tell someone whose command text did not parse: the unknown name and the nearest command, or what the command takes. */
export function commandProblem(parsed: { name: string; argument: string } | undefined, kind: 'task' | 'chat'): string {
  const name = parsed ? parsed.name.slice(0, 40) : '';
  const command = findCommand(parsed?.name);
  if (!command) {
    const near = closestCommand(name, kind);
    return `/${name} not found · ${near ? `did you mean /${near.name}?` : '/help'}`;
  }
  return command.argument ? `Usage: /${command.name} ${command.argument}` : `/${command.name} takes no arguments`;
}

export function commandHelp(kind: 'task' | 'chat' = 'task'): string {
  return ['Navigate', 'Setup', 'Edit', 'Inspect', 'Work', 'Solana']
    .map((group) => {
      const rows = available(kind)
        .filter((command) => command.group === group && command.name !== 'quit')
        .map((command) => [
          command.name === 'exit'
            ? '/exit (or /quit)'
            : `/${command.name}${command.argument ? ' ' + command.argument : ''}`,
          command.description,
        ])
        // /account is one name for two jobs (OMS account, or with an address a chain account), listed once in the menu under Setup.
        .concat(group === 'Solana' ? [['/account <address>', 'Chain account: owner, lamports, data, tokens']] : []);
      // One long argument list must not push every description to the right.
      const width = Math.min(26, Math.max(...rows.map(([name]) => name!.length))) + 2;
      // A name longer than the column puts its description on the next line, under the others.
      const row = ([name, text]: string[]) =>
        name!.length <= width - 2 ? `${name!.padEnd(width)}${text}` : `${name}\n${' '.repeat(width)}${text}`;
      return `${group}\n${rows.map(row).join('\n')}`;
    })
    .join('\n\n');
}
