import type { OmsSession } from '@oms/engine';
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
import { clearConversation, goalCommand } from './conversation-commands.ts';
import { acceptsArt, acceptsLayout, acceptsWeb, uiCommands } from './ui-commands.ts';
import { refuseWith, type Prepared } from './prepared.ts';
import type { Goal } from './goal.ts';
import type { StartupArtMode } from './startup-art.ts';
import type { Conversation } from './transcript.ts';
import type { WorkbenchPane } from './workbench.ts';
import type { TerminalPane } from './terminal-pane.ts';
import { acceptsBlend, blendCommand } from './blend.ts';

export type FocusTarget = 'input' | 'requirements' | 'conversation' | 'editor' | 'terminal' | 'actions';
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
  /** Which arguments the command takes; anything else is "unknown or invalid". Default: none. */
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

const KEYBOARD_HELP =
  '\nKeyboard\n' +
  'Commands: type / in the agent composer, empty editor, file browser or stopped terminal. Ctrl+K opens commands anywhere (Alt+/ also works). Plain / in a document, text field or running shell stays text.\n' +
  'Back: Escape closes a menu to its previous pane. From conversation, Escape returns to the agent composer. From the workbench composer, Escape returns to the editor.\n' +
  'Panes: /harness returns to the agent; /workbench focuses the editor; /files opens the browser; /terminal opens the shell. Ctrl+L focuses the composer, Ctrl+P opens files. F6 optionally cycles panes.\n' +
  'Tab/Shift+Tab navigate conversation panes. Editor Tab inserts a tab; terminal Tab goes to the shell.\n' +
  'Toolbar: F10 focuses the toolbar; arrows choose, Enter activates, Esc returns to the pane.\n' +
  'Editor: Ctrl+S save, Ctrl+F find, Ctrl+H replace, Ctrl+W close tab, Ctrl+Tab next tab. Ctrl+\\ changes split side.\n' +
  'Terminal: Ctrl+C interrupts its process; /terminal stop releases it for independent verification.\n' +
  'Agent: Enter sends, Shift/Alt+Enter adds a newline. /cancel requests cancellation. Ctrl+Q quits after cleanup; dirty files need confirmation.\n' +
  'Transcript: Ctrl+O shows or collapses full tool output. Ctrl+T hides or shows thinking. Ctrl+D on an empty input leaves.\n' +
  'Setup: ↑↓ chooses an authentication method; PgUp/PgDn scrolls disclosures without moving that choice. Ctrl+U clears masked entry. Ctrl+X copies the setup link. Keys and sign-in codes belong only in /connect.';

/** The commands a chat lists in /help, in this order; the rest are still typed or found with /. */
const CHAT_HELP = [
  'connect',
  'model',
  'blend',
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
const CHAT_KEYS =
  'Enter sends · Shift+Enter adds a line · Esc cancels · Ctrl+O shows full tool output · Ctrl+T hides thinking · Ctrl+D leaves\n' +
  '/help keys lists every key.';

export function chatHelp(): string {
  const rows = CHAT_HELP.map((name) => findCommand(name)!).map((command) => [`/${command.name}`, command.description]);
  rows.push(['/theme /art /settings /login /logout', 'Look and account'], ['/exit (or /quit)', 'Leave']);
  const width = Math.max(...rows.map(([name]) => name!.length)) + 2;
  return rows.map(([name, text]) => `${name!.padEnd(width)}${text}`).join('\n') + '\n\n' + CHAT_KEYS;
}

/** /help lists the commands and a few keys; /help keys lists every key. It lives here because it renders the table. */
const help: CommandHandler = (ctx, argument, draft) => {
  const chat = ctx.harness.kind === 'chat';
  ctx.conversation.note(
    'commands',
    argument === 'keys' ? KEYBOARD_HELP.trimStart() : chat ? chatHelp() : commandHelp(ctx.harness.kind) + KEYBOARD_HELP,
  );
  ctx.clearDraft(draft);
  ctx.switchView('harness');
  if (!chat) ctx.setFocus('conversation');
  ctx.scrollToEnd();
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
    description: 'Back to the conversation',
    whileBusy: 'accepted',
    run: uiCommands.harness,
  },
  {
    name: 'files',
    group: 'Navigate',
    description: 'Browse files',
    whileBusy: 'accepted',
    run: uiCommands.files,
  },
  {
    name: 'terminal',
    group: 'Navigate',
    description: 'Sandbox shell',
    argument: '[start|stop|hide]',
    accepts: any,
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
    name: 'blend',
    group: 'Setup',
    description: 'Use Blend routing or return to the previous model',
    argument: '[auto|pro|flash|off]',
    accepts: acceptsBlend,
    whileBusy: 'never',
    run: blendCommand,
  },
  {
    name: 'connect',
    group: 'Setup',
    description: 'Sign in or add an API key',
    argument: '[provider|import <path>]',
    accepts: any,
    whileBusy: 'accepted',
    run: uiCommands.connect,
  },
  {
    name: 'theme',
    group: 'Setup',
    description: 'Colors',
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
    description: 'Web search on or off',
    argument: '[on|off]',
    accepts: acceptsWeb,
    whileBusy: 'accepted',
    run: uiCommands.web,
  },
  {
    name: 'yolo',
    group: 'Setup',
    description: 'Run commands without asking or the sandbox',
    availability: 'chat',
    whileBusy: 'accepted',
    run: uiCommands.yolo,
  },
  {
    name: 'settings',
    group: 'Setup',
    description: 'Preferences and limits',
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
    argument: '[address]',
    accepts: any,
    whileBusy: 'always',
    run: (ctx, argument, draft) =>
      argument ? prepareAccount(argument, ctx.harness) : ctx.openAccount('account', draft),
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
    description: 'What changed',
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
    description: 'Show requirements beside the conversation',
    availability: 'task',
    whileBusy: 'accepted',
    run: (ctx, argument, draft) =>
      ctx.harness.kind === 'chat'
        ? refuseWith('Requirements come with a task made by oms task create.')
        : uiCommands.requirements(ctx, argument, draft),
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
    description: 'New unsaved file · Ctrl+N',
    argument: '[path]',
    accepts: any,
    whileBusy: 'accepted',
    run: uiCommands.newfile,
  },
  {
    name: 'save',
    group: 'Edit',
    description: 'Save active file · Ctrl+S',
    whileBusy: 'accepted',
    run: uiCommands.save,
  },
  {
    name: 'close',
    group: 'Edit',
    description: 'Close tab; protects unsaved changes · Ctrl+W',
    whileBusy: 'accepted',
    run: uiCommands.close,
  },
  { name: 'find', group: 'Edit', description: 'Find text · Ctrl+F', whileBusy: 'accepted', run: uiCommands.find },
  {
    name: 'replace',
    group: 'Edit',
    description: 'Replace text · Ctrl+H',
    whileBusy: 'accepted',
    run: uiCommands.replace,
  },
  {
    name: 'next',
    group: 'Edit',
    description: 'Next editor tab · Ctrl+Tab',
    whileBusy: 'accepted',
    run: uiCommands.next,
  },
  {
    name: 'split',
    group: 'Edit',
    description: 'Toggle second file view · Ctrl+\\ changes side',
    whileBusy: 'accepted',
    run: uiCommands.split,
  },
  {
    name: 'layout',
    group: 'Navigate',
    description: 'Workbench conversation panel',
    argument: '[editor|balanced]',
    accepts: acceptsLayout,
    whileBusy: 'accepted',
    run: uiCommands.layout,
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
    description: 'Run a command in the sandbox',
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
    name: 'clear',
    group: 'Work',
    description: 'New conversation; files stay',
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
    description: 'Leave, after checking unsaved files',
    whileBusy: 'accepted',
    run: (ctx) => ctx.quit(),
  },
  {
    name: 'quit',
    group: 'Work',
    description: 'Same as /exit',
    whileBusy: 'accepted',
    run: (ctx) => ctx.quit(),
  },
  {
    name: 'chain',
    group: 'Solana',
    description: 'Local Solana network',
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
    description: 'Local-chain transaction',
    argument: '<signature>',
    needsArgument: true,
    accepts: any,
    whileBusy: 'always',
    run: (ctx, argument) => prepareTransaction(argument, ctx.harness),
  },
  {
    name: 'program',
    group: 'Solana',
    description: 'Program reference, offline',
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

/** Only an unfinished command name opens completion; arguments remain normal input. */
export function commandMatches(draft: string, kind: 'task' | 'chat' = 'task'): readonly CommandSpec[] | undefined {
  const match = /^\/([a-z]*)$/i.exec(draft.trimStart());
  if (!match) return undefined;
  const query = match[1]!.toLowerCase();
  return available(kind).filter((command) => command.name.startsWith(query));
}

const available = (kind: 'task' | 'chat'): readonly CommandSpec[] =>
  OMS_COMMANDS.filter((command) => command.availability !== (kind === 'chat' ? 'task' : 'chat'));

export function commandHelp(kind: 'task' | 'chat' = 'task'): string {
  return ['Navigate', 'Setup', 'Edit', 'Inspect', 'Work', 'Solana']
    .map(
      (group) =>
        `${group}\n` +
        available(kind)
          .filter((command) => command.group === group && command.name !== 'quit')
          .map((command) =>
            command.name === 'exit'
              ? `/exit (or /quit) — ${command.description}`
              : `/${command.name}${command.argument ? ' ' + command.argument : ''} — ${command.description}`,
          )
          // /account is one name for two jobs (OMS account, or with an address a chain account), listed once in the menu under Setup.
          .concat(
            group === 'Solana' ? ['/account <address> — Local-chain account: owner, lamports, data, token fields'] : [],
          )
          .join('\n'),
    )
    .join('\n\n');
}
