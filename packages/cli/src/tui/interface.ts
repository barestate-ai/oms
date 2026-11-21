import { readFileSync } from 'node:fs';
import { runReviewCommand } from '../review.ts';
import {
  HStack,
  VStack,
  ScrollView,
  ProcessTerminal,
  TuiAltScreen,
  Input,
  matchesKey,
  isKeyRelease,
  stripTerminalSequences,
  truncateToWidth,
  getKeybindings,
  setKeybindings,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  type Component,
  type OverlayHandle,
  type Terminal,
  type KeybindingsConfig,
} from '@earendil-works/pi-tui';
import { LAYOUT_NODE } from '@earendil-works/pi-tui/dist/layout-node.js';
import type { OmsSession } from '@oms/engine';
import { createFileEditorPane } from './file-editor.ts';
import {
  acceptsArgument,
  canRunWhileBusy,
  commandProblem,
  findCommand,
  parseCommand,
  type CommandContext,
  type CommandSpec,
  type FocusTarget,
  type OmsCommand,
  type Requirement,
} from './commands.ts';
import { SetupPane } from './setup.ts';
import { copyToClipboard } from '@earendil-works/pi-coding-agent';
import { HarnessSettingsPane } from './harness-settings.ts';
import { AccountPane } from './account.ts';
import { ActionBar, PaneFrame } from './chrome.ts';
import {
  emptyStateRows,
  headerLeft,
  placeholderRow,
  promptRow,
  requirementsRows,
  ruleRow,
  warningRows,
  type RuleLabel,
} from './chrome-rows.ts';
import { glyphsFor, inGlyphs } from './glyphs.ts';
import { approvalCard, approvalCommandRows, approvalFullyShown, confirmationCard, Panel } from './panel.ts';
import { argumentUsage, popupStart, POPUP_ROWS, slashChoices, slashPopup } from './slash-popup.ts';
import { SpinnerRow, toolVerb } from './spinner.ts';
import {
  budgetFact,
  cachedBranch,
  contextFact,
  costFact,
  shortModelName,
  statusHints,
  statusRow,
  type StatusChip,
  type StatusFact,
} from './status-row.ts';
import { WorkbenchPane } from './workbench.ts';
import { TerminalPane } from './terminal-pane.ts';
import type { HelperDisplay } from './display-tools.ts';
import { Conversation, copyableText, describeValue, displayText, singleLine } from './transcript.ts';
import { nativeChatDisplayHistory } from './claude-chat.ts';
import type { CommandOutput, Prepared } from './prepared.ts';
import { sessionLabel } from './inspect-commands.ts';
import { newGoal, runGoalCheck, runGoalLoop, taskVerifierItem, type Goal } from './goal.ts';
import { StartupArt, artShow, settleKittyGraphics, type StartupArtMode } from './startup-art.ts';
import {
  colorText,
  DEFAULT_THEME_ID,
  detectColorDepth,
  getTheme,
  paintThemeRow,
  THEME_IDS,
  type Backdrop,
  type OmsTheme,
  type OmsThemeId,
} from './theme.ts';

/** Only a selection that began in the conversation loses its glyph gutters; editor and terminal text is copied as it is. */
export function selectionClipboardText(text: string, inTranscript: boolean): string {
  return inTranscript ? copyableText(text) : text;
}

/** Clipboard writer for copy-on-select: true on success, otherwise the reason shown to the user. */
async function copySelectionText(text: string, inTranscript: boolean): Promise<boolean | string> {
  try {
    await copyToClipboard(selectionClipboardText(text, inTranscript));
    return true;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

type ActionKind = 'agent' | 'command' | 'verification' | 'review';
interface Action {
  kind: ActionKind;
  /** Verification and review run to their backend timeout; nothing stops them early. */
  cancellable: boolean;
  draft: string | undefined;
  accepted: boolean;
  controller: AbortController;
  completion: Promise<void>;
  cancellation?: Promise<void>;
  error?: string;
  errorDisplayed?: boolean;
}

const NO_MODEL = 'No model selected · /connect to sign in, /model to pick one';
const MODEL_UNAVAILABLE = 'Model unavailable · /model';
const notSignedIn = (provider?: string): string =>
  `Not signed in${provider ? ` to ${singleLine(provider, 80)}` : ''} · /connect`;
/** A notice that already says what to do next; it replaces the generic "failed" line. */
const isSetupNotice = (message: string): boolean => /^(No model selected|Not signed in)/.test(message);
const FAILED_WHAT: Record<ActionKind, string> = {
  agent: 'Request',
  command: 'Command',
  verification: 'Verification',
  review: 'Review',
};
const CANCELLING = 'Cancelling…';
/** One press of Ctrl+C on an idle prompt arms quitting for this long. */
const QUIT_ARMED_MS = 2000;

/** Starter ideas for the empty state and the composer's placeholder; one of each per session. */
const SUGGESTIONS = [
  'add a withdraw instruction with a signer check',
  'write an Anchor test for the withdraw path',
  'find why this account fails to deserialize',
  'explain a program error and fix it',
] as const;
const PLACEHOLDERS = [
  'Ask OMS to build, test or explain a program…',
  'Try: write an Anchor test for the withdraw path',
  'Try: add a transfer instruction with a signer check',
  'Try: explain this program error and fix it',
] as const;
const hashOf = (text: string): number =>
  [...text].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 7);

/** The release version for the empty state; empty when package.json is not where a source checkout keeps it. */
function releaseVersion(): string {
  try {
    const version = (
      JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    ).version;
    return typeof version === 'string' ? version.replace(/[^\w.+-]/g, '').slice(0, 32) : '';
  } catch {
    return '';
  }
}

function hasModelConfiguration(model: { provider: string; id: string } | undefined): boolean {
  const provider = model?.provider.trim();
  const id = model?.id.trim();
  return !!provider && !!id && provider !== 'unknown' && id !== 'unknown';
}

/** Convert render-loop failures into rejection of this presentation's lifecycle. */
class InterfaceRenderer extends TuiAltScreen {
  private readonly fail: (error: unknown) => void;
  private readonly palette: () => OmsTheme;
  private readonly prepareFrame: () => void;
  private readonly mouseFocus: (component: Component) => Component;
  constructor(
    terminal: Terminal,
    fail: (error: unknown) => void,
    palette: () => OmsTheme,
    prepareFrame: () => void,
    mouseFocus: (component: Component) => Component,
  ) {
    // Selecting text copies it, like most coding CLIs; the terminal's own selection is captured by mouse mode.
    const self: { renderer?: InterfaceRenderer } = {};
    super(terminal, true, undefined, {
      mouse: true,
      copyOnSelect: true,
      copySelection: (text) => copySelectionText(text, self.renderer?.selectionStartsInTranscript() ?? false),
    });
    self.renderer = this;
    this.fail = fail;
    this.palette = palette;
    this.prepareFrame = prepareFrame;
    this.mouseFocus = mouseFocus;
  }
  /** The conversation's scroll view, set once it exists. */
  transcriptView: unknown;
  /** Whether the current selection began inside the conversation. The renderer keeps its bounds in a private method. */
  selectionStartsInTranscript(): boolean {
    const bounds = (
      this as unknown as { getSelectionBounds(): { start: { scrollView?: unknown } } | undefined }
    ).getSelectionBounds?.();
    return !!bounds && this.transcriptView !== undefined && bounds.start.scrollView === this.transcriptView;
  }
  /** Rows painted last frame, by their unpainted text; most rows do not change between frames. */
  private painted = new Map<string, string>();
  private paintedFor = '';
  protected override resolveFakeCursors(lines: string[]): string[] {
    const theme = this.palette();
    const columns = this.terminal.columns;
    const previous = this.paintedFor === `${theme.id} ${columns}` ? this.painted : new Map<string, string>();
    const painted = new Map<string, string>();
    const rows = super.resolveFakeCursors(lines).map((line) => {
      const row = painted.get(line) ?? previous.get(line) ?? paintThemeRow(theme, line, columns);
      painted.set(line, row);
      return row;
    });
    this.painted = painted;
    this.paintedFor = `${theme.id} ${columns}`;
    return rows;
  }
  override setFocus(component: Component | null): void {
    // Native dispatch resolves candidates even for focus:false; only commit at actual focus.
    super.setFocus(component === null ? null : this.mouseFocus(component));
  }
  protected override doRender(): void {
    try {
      this.prepareFrame();
      super.doRender();
    } catch (error) {
      this.fail(error);
    }
  }
}

/** One OMS presentation over the live session. Whole-app quit/failure closes its owner; layout never does. */
/** The interface's key registry. pi's tool renderers print the two app keys in their hints; OMS handles them itself. */
export function omsKeybindings(owned: KeybindingsConfig): KeybindingsManager {
  return new KeybindingsManager(
    {
      ...TUI_KEYBINDINGS,
      'app.tools.expand': { defaultKeys: 'ctrl+o', description: 'Toggle tool output' },
      'app.thinking.toggle': { defaultKeys: 'ctrl+t', description: 'Toggle thinking blocks' },
    },
    owned,
  );
}

export async function runOmsInterface(
  harness: OmsSession,
  options: {
    review?: typeof runReviewCommand;
    terminal?: Terminal;
    theme?: OmsThemeId;
    onThemeChange?: (theme: OmsThemeId) => void;
    /** 'theme' (the default) paints the palette background on every row; 'terminal' keeps the terminal's own. */
    background?: Backdrop;
    startupArt?: StartupArtMode;
    onStartupArtChange?: (mode: StartupArtMode) => void;
    view?: 'harness' | 'workbench';
    onViewChange?: (view: 'harness' | 'workbench') => void;
    /** A note shown in the conversation when the interface opens. */
    startNote?: string;
    /**
     * Chips for the right side of the status row, read on every frame (cheap, no I/O): the local chain, connectors.
     * Each draws as an optional colored dot and a short text, between the branch and the model. The local chain's own
     * `surfpool` chip is added by the interface when the session's chain runs.
     */
    statusChips?: () => readonly StatusChip[];
    /** The first launch: the startup art shows once. The launcher calls `onFirstRunShown` so it is not shown again. */
    firstRun?: boolean;
    onFirstRunShown?: () => void;
    /** The version in the empty state; read from the release's package.json when omitted. */
    version?: string;
  } = {},
): Promise<void> {
  const terminal = options.terminal ?? new ProcessTerminal();
  const display = { depth: detectColorDepth(), backdrop: options.background ?? 'theme' } as const;
  // A 16-color terminal cannot draw the tinted themes: it gets the Terminal theme, which uses the terminal's own colors.
  let theme = getTheme(display.depth === '16' ? 'terminal' : (options.theme ?? DEFAULT_THEME_ID), display);
  if (!theme) throw new Error(`Choose a theme from: ${THEME_IDS.join(', ')}`);
  /** The theme the user chose; a picker preview changes `theme` and goes back to this on Esc. */
  let committedTheme = theme;
  const glyphs = glyphsFor(process.env);
  const chat = harness.kind === 'chat';
  /** The user's F2 choice for the requirements sidebar; undefined follows the width (shown from 120 columns). */
  let requirementsChoice: boolean | undefined;
  let view = options.view ?? 'harness';
  let terminalVisible = false;
  let agentPanelVisible = false;
  let discardConfirmed = false;
  const previousKeybindings = getKeybindings();
  const ownedBindings: KeybindingsConfig = { ...previousKeybindings.getResolvedBindings() };
  for (const id of Object.keys(TUI_KEYBINDINGS)) {
    if (id.startsWith('tui.altScreen.')) ownedBindings[id] = [];
  }
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const finished = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let closing = false;
  let disposed = false;
  let failure: unknown;
  let active: Action | undefined;
  let externalBusy = harness.session.isStreaming;
  let externalCancellation: Promise<void> | undefined;
  let sessionSettled: (() => void) | undefined;
  let shutdown: Promise<void> | undefined;
  let shutdownComplete = false;
  let titleSaved = false;
  type Focus = FocusTarget;
  let focus: Focus = view === 'workbench' ? 'editor' : 'input';
  let harnessFocus: Focus = 'input';
  let workbenchFocus: Focus = 'editor';
  let selectedId: string | undefined;
  /** A warning (or error) that stays until it is dismissed or replaced; confirmations are toasts instead. */
  let notice = '';
  /** A confirmation shown in the status row for a few seconds. */
  let toastText: string | undefined;
  let toastTimer: NodeJS.Timeout | undefined;
  let hostApproval:
    | {
        request: { requester?: string; reasons: readonly string[]; command: string; session: boolean };
        /** The first command row the card shows; a command taller than the card scrolls. */
        offset: number;
        /** The last row of the command has been on screen, so Allow is open. */
        read: boolean;
        answer(allowed: boolean | 'session'): void;
      }
    | undefined;
  /** A card that appears right after an answer ignores Allow until this time, so a repeated key cannot approve it unseen. */
  let approvalGuardUntil = 0;
  /** The running turn, for the spinner row, the terminal title and the progress bar. */
  let busyStartedAt: number | undefined;
  let currentTool: { id: string; name: string; args: unknown } | undefined;
  let completedTokens = 0;
  let streamingTokens = 0;
  let shownTitle = '';
  let progressShown = false;
  /** A yes/no question a command asked (/yolo): drawn as a card above the composer, answered on one key. */
  let confirmation: { question: string; yes: () => void } | undefined;
  /** Ctrl+C was pressed once on an idle prompt: a second press within QUIT_ARMED_MS quits. */
  let quitArmed: { timer: NodeJS.Timeout; notice: string } | undefined;
  let checkedItems: Requirement[] = [];
  let setup: SetupPane | HarnessSettingsPane | AccountPane | undefined;
  let overlayHandle: OverlayHandle | undefined;
  let commandIndex = 0;
  let commandDraft = '';
  let dismissedCommands: string | undefined;
  let paletteInput: Input | undefined;
  let proofAvailable = false;
  let goal: Goal | undefined;
  let checkedAt = 'not checked';
  const fail = (error: unknown) => {
    failure ??= error;
    if (!closing) quit(true);
    reject(error);
  };
  const renderer = new InterfaceRenderer(
    terminal,
    fail,
    () => theme!,
    () => {
      // A frame is synchronous: its model-list reads share one snapshot that ends with it.
      frameModels = undefined;
      framing = true;
      queueMicrotask(() => {
        framing = false;
        frameModels = undefined;
      });
      repairHiddenFocus();
      composerEntry.basis = 2 + composerLines();
      syncActivity();
    },
    (component) => {
      if (setup) return setup.input;
      if (paletteInput) return paletteInput;
      if (component === input.focus) {
        focus = 'input';
        return input.focus;
      }
      const editorFocus = workbench.resolveMouseFocus(component);
      if (editorFocus) {
        focus = 'editor';
        return editorFocus;
      }
      if (shell.resolveMouseFocus(component)) {
        focus = 'terminal';
        return shell.focus;
      }
      return component;
    },
  );
  const requestRender = () => {
    if (!disposed) renderer.requestRender();
  };
  /** The row above the composer while work runs; its Loader animates only while the turn does. */
  const spinner = new SpinnerRow(
    renderer,
    () => theme!,
    glyphs,
    () => ({
      verb: busyVerb(),
      elapsedMs: busyStartedAt === undefined ? 0 : Date.now() - busyStartedAt,
      tokens: completedTokens + streamingTokens,
      canStop: canInterrupt(),
    }),
  );
  /** The model catalog is rebuilt on every read; a frame reads it once. */
  let frameModels: ReturnType<typeof harness.listModels> | undefined;
  let framing = false;
  const models = () => (framing ? (frameModels ??= harness.listModels()) : harness.listModels());
  /** The one busy rule: a model turn, a command, or a cancellation still settling. */
  const busy = () => !!active || externalBusy || !!externalCancellation;
  /** Esc can stop what is running: not a verification or review, nor a cancellation already under way, nor the shell's own keys. */
  const canInterrupt = () =>
    busy() &&
    !closing &&
    focus !== 'terminal' &&
    !externalCancellation &&
    (active ? active.cancellable && !active.cancellation : true);
  const input = createFileEditorPane(
    '',
    () => {
      if (input.document.text !== dismissedCommands) dismissedCommands = undefined;
      requestRender();
    },
    { wrap: true },
  );
  const workbench = new WorkbenchPane(harness, {
    theme: () => theme!,
    render: requestRender,
    rows: () => terminal.rows,
    notice: (message) => {
      if (view === 'harness') setNotice(message);
    },
    requestFocus: () => {
      if (!setup && !paletteInput) setFocus('editor');
    },
    focusChanged: () => {
      if (view === 'workbench' && focus === 'editor') setFocus('editor');
    },
  });
  const shell = new TerminalPane(harness, {
    theme: () => theme!,
    render: requestRender,
    notice: setNotice,
    requestFocus: () => {
      if (!setup && !paletteInput) setFocus('terminal');
    },
    hostRows: () => terminal.rows,
    columns: () => terminal.columns,
    rows: () => Math.max(3, Math.floor(terminal.rows / 3)),
  });
  /** A helper's conversation drawn like this one, rebuilt only when it has grown. */
  const helperViews = new Map<string, { count: number; view: Conversation }>();
  const helperDisplay: HelperDisplay | undefined =
    harness.kind === 'chat'
      ? {
          transcript(id) {
            const messages = harness.helpers.messages(id);
            const known = helperViews.get(id);
            if (known && known.count === messages.length) return known.view;
            const view = new Conversation(messages, (message, provider) => actionError('agent', message, provider), {
              cwd: harness.root,
              requestRender: () => requestRender(),
            });
            if (theme) view.applyTheme(theme);
            helperViews.set(id, { count: messages.length, view });
            return view;
          },
        }
      : undefined;
  const conversation = new Conversation(
    nativeChatDisplayHistory(harness),
    (message, provider) => actionError('agent', message, provider),
    {
      helpers: helperDisplay,
      rows: () => terminal.rows,
      cwd: harness.root,
      requestRender: () => requestRender(),
    },
  );
  conversation.applyTheme(theme);
  if (options.startNote) conversation.note('scratch folder', options.startNote);
  // A third of the screen holds a picture of 44 or more columns from about 40 rows.
  const art = new StartupArt(Math.random, 44);
  // The picture shows on the first launch, or when /art turns it on.
  let artMode = options.startupArt ?? (options.firstRun ? 'auto' : 'off');
  // Chosen from the environment (after the one Kitty graphics query over SSH) and again when /art changes the setting.
  let artShown = artShow(artMode, process.env);
  /** The image tier draws the mosaic until the picture is converted for Kitty graphics. */
  const loadArtImage = () => (artShown === 'image' ? art.loadImage().catch(() => {}) : Promise.resolve());
  let artViewport = 0,
    artHidden = 0;
  const version = options.version ?? releaseVersion();
  const sessionHash = hashOf(String(harness.session.sessionManager?.getSessionId?.() ?? ''));
  const suggestion = SUGGESTIONS[sessionHash % SUGGESTIONS.length]!;
  const composerPlaceholder = PLACEHOLDERS[sessionHash % PLACEHOLDERS.length]!;
  /** The empty state: three lines at the top of a new conversation. */
  function placeholder(width: number): string[] {
    const model = harness.session.model;
    const connected = models().some((candidate) => candidate.configured);
    const ready = !!model && hasModelConfiguration(model) && connected && selectedModelChoice()?.configured !== false;
    return emptyStateRows(
      theme!,
      glyphs,
      {
        version,
        model: ready ? shortModelName(model.id) : undefined,
        folder: sessionLabel(harness),
        rows: terminal.rows,
      },
      ready
        ? `Try: ${suggestion}`
        : !connected
          ? 'Run /connect to sign in, then /model to pick a model'
          : 'Run /model to pick a model',
    ).map((line) => truncateToWidth(line, width, glyphs.ellipsis));
  }
  /** The art is the first block of the transcript, sized so it fits above the placeholder; it scrolls away with the conversation. */
  function artBlock(width: number, below: number, content: number): string[] {
    artViewport = transcript.viewportHeight;
    // A third of the screen at most, and none on a short terminal.
    const rows =
      terminal.rows < 20 ? 0 : Math.min(artViewport - 6, artViewport - 3 - below, Math.floor(terminal.rows / 3));
    const muted = (text: string) => colorText(theme!, 'muted', text);
    const block = art.block(width, rows, artShown, muted);
    // The layout scrolls after drawing: crop the picture for the rows it is about to scroll away, so no second frame.
    const end = Math.max(0, block.length + content - artViewport);
    artHidden = transcript.isFollowingEnd ? end : Math.min(transcript.scrollTop, end);
    return artHidden ? art.block(width, rows, artShown, muted, artHidden) : block;
  }
  let artRows = 0;
  const transcript = new (class extends ScrollView {
    // The viewport and scroll position are known only after the content renders: render again when they differ from
    // the ones the art was drawn for (the size, and for the real picture which rows are scrolled away).
    override updateLayout(contentHeight: number, viewportHeight: number, render: () => void): void {
      super.updateLayout(contentHeight, viewportHeight, render);
      if (
        (artMode !== 'off' &&
          (Math.floor(viewportHeight) !== artViewport || (artShown === 'image' && this.scrollTop !== artHidden))) ||
        conversation.newOutputStale(this, contentHeight)
      )
        render();
    }
  })(
    {
      invalidate() {
        conversation.invalidate();
      },
      render(width): string[] {
        const lines = conversation.render(width);
        // The placeholder only shows, or sizes the art, when there is no conversation yet or art is on.
        const hint = lines.length && artShown === 'off' ? [] : placeholder(width);
        const body = lines.length ? lines : hint;
        const block = artBlock(width, hint.length, body.length);
        artRows = block.length;
        return conversation.withNewOutput(block.length ? [...block, ...body] : body, transcript, width);
      },
      // A click opens or folds the entry under it, or takes the view to the end from the '▼ new output' chip.
      handleMouse(event) {
        if (event.type !== 'click' || event.button !== 'left') return undefined;
        const hit = conversation.click(event.y, artRows);
        if (hit === 'end') transcript.scrollToEnd();
        return hit ? { handled: true } : undefined;
      },
    },
    { primary: true, follow: 'end', scrollbar: 'auto' },
  );

  function refreshRequirements(): void {
    if (harness.kind === 'chat') return;
    try {
      const state = harness.evaluator.read();
      proofAvailable = state.ok;
      if (!state.ok) return;
      checkedAt = new Date().toISOString().slice(11, 19) + ' UTC';
      checkedItems = state.value.items.map((item) => ({ id: item.id, title: item.title, status: item.status }));
      if (!checkedItems.some((item) => item.id === selectedId)) {
        selectedId =
          checkedItems.find((item) => ['active', 'proposed', 'stale'].includes(item.status))?.id ?? checkedItems[0]?.id;
      }
    } catch {
      proofAvailable = false;
    }
  }

  /** A warning that stays until it is replaced or dismissed with Escape. */
  function setNotice(text: string): void {
    notice = singleLine(text, 800);
    requestRender();
  }
  /** A confirmation for three seconds, in place of the status row's hints. */
  function toast(text: string): void {
    toastText = singleLine(text, 200);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastText = undefined;
      toastTimer = undefined;
      requestRender();
    }, 3000);
    toastTimer.unref();
    requestRender();
  }

  /** Take a toast away early, when the thing it announced is over. */
  function dismissToast(text: string): void {
    if (toastText !== text) return;
    toastText = undefined;
    clearTimeout(toastTimer);
    toastTimer = undefined;
    requestRender();
  }

  /** What the spinner row and the terminal title say the agent is doing. */
  function busyVerb(): string {
    if (hostApproval) return 'Waiting for approval';
    if (closing) return 'Closing';
    if (active?.cancellation || externalCancellation) return 'Cancelling';
    if (currentTool) return toolVerb(currentTool.name, currentTool.args);
    if (active && active.kind !== 'agent')
      return active.kind === 'verification'
        ? 'Verifying the requirements'
        : active.kind === 'review'
          ? 'Reviewing the code'
          : 'Running a command';
    return 'Thinking';
  }
  /**
   * Once per frame: start and stop the spinner with the turn, keep the terminal's progress bar and its title
   * (`⠹ oms · escrow — Reading lib.rs`) in step. Each is written only when it changes.
   */
  function syncActivity(): void {
    const working = busy();
    if (working && busyStartedAt === undefined) {
      busyStartedAt = Date.now();
      spinner.start();
    } else if (!working && busyStartedAt !== undefined) {
      busyStartedAt = undefined;
      currentTool = undefined;
      streamingTokens = 0;
      spinner.stop();
    }
    if (working !== progressShown) {
      progressShown = working;
      terminal.setProgress(working);
    }
    if (!titleSaved) return;
    const base =
      harness.kind === 'chat'
        ? `oms · ${singleLine(sessionLabel(harness), 120)}`
        : `oms · ${singleLine(sessionLabel(harness), 120)} / ${singleLine(harness.task.id, 80)}`;
    const frame =
      glyphs.spinner[Math.floor((Date.now() - (busyStartedAt ?? 0)) / 1000) % glyphs.spinner.length] ?? glyphs.dot;
    const title = working ? `${frame} ${base} — ${busyVerb()}` : base;
    if (title !== shownTitle) {
      shownTitle = title;
      terminal.setTitle(title);
    }
  }

  /** The text cursor takes the theme's accent (truecolor, painted themes); OSC 112 gives it back on exit. */
  let cursorColored = false;
  function colorCursor(): void {
    if (disposed || display.depth !== 'truecolor' || theme!.ansi) return;
    cursorColored = true;
    terminal.write(`\x1b]12;${theme!.colors.accentFill}\x07`);
  }
  function applyTheme(next: OmsTheme): void {
    theme = next;
    conversation.applyTheme(next);
    // Each helper transcript draws with its own style: recolor the ones already built.
    for (const { view } of helperViews.values()) view.applyTheme(next);
    if (cursorColored) colorCursor();
    requestRender();
  }
  function changeTheme(id: string): boolean {
    const next = getTheme(id, display);
    if (!next) {
      setNotice(`Unknown theme · ${THEME_IDS.join(', ')}`);
      return false;
    }
    committedTheme = next;
    applyTheme(next);
    options.onThemeChange?.(next.id);
    toast(`Theme set to ${next.name}`);
    return true;
  }
  /** The theme picker shows each theme as the cursor reaches it; closing without choosing restores the chosen one. */
  function previewTheme(id: string): void {
    const next = getTheme(id, display);
    if (next && next !== theme) applyTheme(next);
  }
  function closeSetup(): void {
    if (theme !== committedTheme) applyTheme(committedTheme);
    setup?.dispose();
    setup = undefined;
    overlayHandle?.hide();
    overlayHandle = undefined;
    setFocus(focus);
    requestRender();
  }
  /** The panel floats over the conversation; the setup pane owns the keys while it is open. */
  function showPanel(pane: SetupPane | HarnessSettingsPane | AccountPane): void {
    setup = pane;
    overlayHandle ??= renderer.showOverlay(setupPanel, {
      width: 72,
      margin: 1,
      anchor: 'center',
      maxHeight: '100%',
      nonCapturing: true,
    });
    // The approval card is never drawn under a panel: the panel waits behind it until the answer.
    overlayHandle.setHidden(!!hostApproval);
    renderer.setFocus(pane.input);
    requestRender();
  }
  function openSetup(mode: 'model' | 'connect' | 'theme' | 'settings', query = '', draft?: string): void {
    if (closing) return;
    if ((mode === 'model' || mode === 'connect') && busy()) {
      setNotice('Wait for the current turn to finish');
      clearDraft(draft);
      return;
    }
    setup?.dispose();
    const shared = {
      theme: () => theme!,
      rows: () => terminal.rows,
      bodyRows: () => setupPanel.bodyRows(),
      render: requestRender,
      close: closeSetup,
      notice: toast,
      warn: setNotice,
    };
    const pane =
      mode === 'settings'
        ? new HarnessSettingsPane(harness, shared)
        : new SetupPane(harness, { ...shared, mode, query, selectTheme: changeTheme, previewTheme });
    if (draft !== undefined) clearDraft(draft);
    notice = '';
    showPanel(pane);
  }
  function openAccount(mode: 'login' | 'logout' | 'account', draft?: string): void {
    if (closing) return;
    if (mode === 'login' && busy()) {
      setNotice('Wait for the current turn to finish');
      clearDraft(draft);
      return;
    }
    setup?.dispose();
    const pane = new AccountPane(harness.account, {
      mode,
      theme: () => theme!,
      render: requestRender,
      close: closeSetup,
      bodyRows: () => setupPanel.bodyRows(),
    });
    clearDraft(draft);
    showPanel(pane);
  }
  function openPalette(): void {
    if (setup) closeSetup();
    paletteInput = paletteInput ? undefined : new Input();
    paletteInput?.handleInput('/');
    notice = '';
    setFocus(focus);
  }
  function currentCommands(): readonly OmsCommand[] | undefined {
    const draft = paletteInput?.getValue() ?? input.document.text;
    if (setup || closing || (!paletteInput && (focus !== 'input' || draft === dismissedCommands))) return undefined;
    const choices = slashChoices(draft, harness.kind);
    if (draft !== commandDraft) {
      commandDraft = draft;
      commandIndex = 0;
    }
    if (choices) commandIndex = Math.max(0, Math.min(commandIndex, choices.length - 1));
    return choices;
  }
  function completeCommand(command: OmsCommand, execute: boolean): void {
    if (paletteInput) {
      const value = `/${command.name}${!execute || command.needsArgument ? ' ' : ''}`;
      paletteInput.setValue(value);
      paletteInput.handleInput('\x05');
      if (execute && !command.needsArgument) {
        paletteInput = undefined;
        setFocus(focus);
        submit(value, true);
      }
      requestRender();
      return;
    }
    input.document.select(0, input.document.text.length);
    input.document.insert(`/${command.name}${!execute || command.needsArgument ? ' ' : ''}`);
    input.focus.invalidate();
    if (execute && !command.needsArgument) submit();
    requestRender();
  }
  function setFocus(next: Focus): void {
    focus = next;
    renderer.setFocus(
      setup
        ? setup.input
        : (paletteInput ??
            (next === 'input'
              ? input.focus
              : next === 'editor'
                ? workbench.focus
                : next === 'terminal'
                  ? shell.focus
                  : next === 'actions'
                    ? appActions
                    : null)),
    );
    requestRender();
  }
  function switchView(next: 'harness' | 'workbench'): void {
    if (closing || setup || next === view) return;
    if (view === 'harness') harnessFocus = focus;
    else workbenchFocus = focus;
    view = next;
    options.onViewChange?.(next);
    setFocus(next === 'harness' ? harnessFocus : workbenchFocus);
    repairHiddenFocus();
    notice = '';
  }
  function editorAction(action: () => void | Promise<void>): void {
    switchView('workbench');
    setFocus('editor');
    Promise.resolve()
      .then(action)
      .catch((error) => setNotice(error instanceof Error ? error.message : 'Editor action failed'));
  }
  function terminalAction(action: string): void {
    switchView('workbench');
    if (action === 'hide') {
      terminalVisible = false;
      if (focus === 'terminal') setFocus('editor');
    } else if (action === 'stop') {
      terminalVisible = true;
      setFocus('terminal');
      void shell
        .stop()
        .catch((error) => setNotice(error instanceof Error ? error.message : "Shell didn't stop · restart oms"));
    } else if (!action || action === 'start') {
      terminalVisible = true;
      setFocus('terminal');
      void shell.start();
    } else setNotice('Usage: /terminal [start|stop|hide]');
    requestRender();
  }
  /** The requirements sidebar: a task, the conversation view, and room for it (shown from 120 columns, or when asked for from 100). */
  function requirementsShown(width = terminal.columns): boolean {
    return harness.kind === 'task' && view === 'harness' && width >= 100 && (requirementsChoice ?? width >= 120);
  }
  function repairHiddenFocus(): void {
    if (setup) return;
    if (focus === 'requirements' && !requirementsShown()) setFocus('input');
    // The header, and the actions bar in it, hide on a short terminal: its keys must not stay trapped there.
    if (focus === 'actions' && !headerShown()) setFocus(view === 'harness' ? 'input' : 'editor');
    if (view === 'harness' && (focus === 'editor' || focus === 'terminal')) setFocus('input');
    if (view === 'workbench' && focus === 'terminal' && !terminalVisible) setFocus('editor');
    if (view === 'workbench' && focus === 'conversation' && (!agentPanelVisible || terminal.columns < 118))
      setFocus('input');
  }
  function toggleRequirements(): void {
    requirementsChoice = !(requirementsChoice ?? terminal.columns >= 120);
    repairHiddenFocus();
    requestRender();
  }
  function selectedModelChoice() {
    const model = harness.session.model;
    return model && models().find((choice) => choice.provider === model.provider && choice.id === model.id);
  }
  // Earlier prompts and commands, for Up and Down in the composer; kept in memory for this session only.
  const sent: string[] = [];
  let sentIndex = 0;
  let unsent = '';
  function remember(text: string): void {
    if (sent.at(-1) !== text) sent.push(text);
    if (sent.length > 100) sent.shift();
    sentIndex = sent.length;
  }
  /** Up on the first row recalls the previous message; Down on the last row goes forward again. True when it did. */
  function recall(direction: -1 | 1): boolean {
    const rows = input.rows(Math.max(1, terminal.columns - 2));
    if (
      direction < 0
        ? input.position.line !== 1 || sentIndex === 0
        : input.position.line < rows || sentIndex >= sent.length
    )
      return false;
    if (sentIndex === sent.length) unsent = input.document.text;
    sentIndex += direction;
    const text = sentIndex === sent.length ? unsent : sent[sentIndex]!;
    input.document.select(0, input.document.text.length);
    input.document.insert(text);
    input.focus.invalidate();
    requestRender();
    return true;
  }
  function clearDraft(snapshot: string | undefined): void {
    if (snapshot === undefined || input.document.text !== snapshot) return;
    input.document.select(0, snapshot.length);
    input.document.insert('');
    input.focus.invalidate();
  }
  function maybeFinish(): void {
    if (closing && shutdownComplete && !busy()) {
      if (failure) reject(failure);
      else resolve();
    }
  }

  function abortAgent(action: Action): void {
    // Invoke immediately: agent_start is the last boundary before the SDK's first request.
    // An earlier abort during async preflight cannot cancel a run that does not exist yet.
    const attempt = (async () => {
      await harness.session.abort();
    })();
    const previous = action.cancellation;
    action.cancellation = (async () => {
      const results = await Promise.allSettled(previous ? [previous, attempt] : [attempt]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    })();
    // Observe immediately, while retaining rejection for the operation's finalizer.
    void action.cancellation.catch((error) => {
      setNotice(`Cancel failed · ${describeValue(error instanceof Error ? error.message : error)}`);
    });
  }

  function actionError(kind: ActionKind, error: unknown, provider?: string): string {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : describeValue(error);
    if (kind !== 'agent') return message;
    // Match only known SDK diagnostics; history uses its recorded provider, preflight the current one.
    const loginHelp = 'Use /login to log into a provider via OAuth or API key. See:';
    const missingAuth =
      message.startsWith(`No API key found for the selected model.\n\n${loginHelp}`) ||
      (!!provider && message.startsWith(`No API key found for ${provider}.\n\n${loginHelp}`));
    const expiredAuth =
      !!provider &&
      message ===
        `Authentication failed for "${provider}". Credentials may have expired or network is unavailable. Run '/login ${provider}' to re-authenticate.`;
    if (missingAuth || expiredAuth) return notSignedIn(provider);
    if (
      message.startsWith(`No model selected.\n\n${loginHelp}`) ||
      message.startsWith(`No models available. ${loginHelp}`)
    ) {
      return NO_MODEL;
    }
    return message;
  }

  function cancel(): void {
    if (active) {
      if (!active.cancellable) {
        setNotice("Can't cancel this · it stops on its own");
        return;
      }
      if (active.cancellation) return;
      active.controller.abort();
      const action = active;
      toast(CANCELLING);
      if (action.kind === 'agent' && action.accepted) abortAgent(action);
      else action.cancellation = Promise.resolve();
    } else if (externalBusy && !externalCancellation) {
      toast(CANCELLING);
      externalCancellation = Promise.resolve()
        .then(() => harness.session.abort())
        .catch((error) => {
          failure = error;
          setNotice(`Cancel failed · ${error instanceof Error ? error.message : 'unknown error'}`);
        })
        .finally(() => {
          externalCancellation = undefined;
          dismissToast(CANCELLING);
          maybeFinish();
          requestRender();
        });
    }
  }

  function quit(force = false): void {
    if (closing) return;
    if (!force && workbench.dirty && !discardConfirmed) {
      discardConfirmed = true;
      setNotice('Unsaved files · ctrl+q again to discard · ctrl+s to save');
      return;
    }
    closing = true;
    setNotice('Closing…');
    if (!active || active.cancellable) cancel();
    shutdown = Promise.resolve()
      // A shell closed by the session underneath its pane can end with uncertain cleanup; stop it here first.
      .then(() => shell.release())
      .then(() => harness.close())
      .then(
        () => {
          shutdownComplete = true;
          maybeFinish();
        },
        (error) => {
          shutdownComplete = true;
          fail(error);
        },
      );
  }

  function disarmQuit(): void {
    if (!quitArmed) return;
    clearTimeout(quitArmed.timer);
    const { notice: armed } = quitArmed;
    quitArmed = undefined;
    if (notice === armed) setNotice('');
  }
  /** Ctrl+C: cancel what is running. On an idle prompt the first press says so, and a second one within a moment quits. */
  function interrupt(): void {
    if (busy()) {
      disarmQuit();
      cancel();
      return;
    }
    if (quitArmed) {
      disarmQuit();
      quit();
      return;
    }
    const armed = input.document.text ? 'ctrl+c again to quit · unsent text is lost' : 'ctrl+c again to quit';
    setNotice(armed);
    quitArmed = { timer: setTimeout(disarmQuit, QUIT_ARMED_MS), notice: notice };
    quitArmed.timer.unref();
  }

  function begin(
    kind: ActionKind,
    draft: string | undefined,
    operation: (signal: AbortSignal) => Promise<void>,
    cancellable = true,
    label = FAILED_WHAT[kind],
  ): void {
    const action: Action = {
      kind,
      cancellable,
      draft,
      accepted: false,
      controller: new AbortController(),
      completion: Promise.resolve(),
    };
    active = action;
    notice = '';
    action.completion = Promise.resolve().then(async () => {
      try {
        if (action.controller.signal.aborted) throw new Error('Cancelled before it started');
        await operation(action.controller.signal);
        if (action.error) throw new Error(action.error);
        if (kind !== 'agent' || !action.accepted) clearDraft(draft);
      } catch (error) {
        const message = actionError(
          kind,
          error,
          kind === 'agent' && !action.accepted ? harness.session.model?.provider : undefined,
        );
        // A message the agent never received stays in the input, since it is the user's own text. A command was typed to run
        // once, so it never stays to be run again or to join the next thing typed. Once the message is in the conversation the
        // failure is too, so the input stays empty and the next message starts clean.
        if (kind !== 'agent') clearDraft(draft);
        // An SDK assistant error is already represented by its contextual message; a setup notice says what to do next.
        if (!action.errorDisplayed && !isSetupNotice(message)) conversation.note(`${kind} failed`, message);
        setNotice(isSetupNotice(message) ? message : `${label} failed · see above`);
      } finally {
        if (action.cancellation) {
          try {
            await action.cancellation;
          } catch (error) {
            failure ??= closing ? error : undefined;
          }
        }
        if (!closing) refreshRequirements();
        if (active === action) active = undefined;
        dismissToast(CANCELLING);
        requestRender();
        maybeFinish();
      }
    });
    requestRender();
  }

  /** Show a deterministic command's result: a conversation note, and a long result as a read-only workbench report. */
  function showOutput(command: string, output: CommandOutput): void {
    if (closing) return;
    conversation.note(output.title, output.text);
    if (output.report) {
      workbench.openReport(output.report.id, output.report.text, command);
      switchView('workbench');
      setFocus('editor');
    } else if (!output.inPlace) {
      switchView('harness');
      setFocus('input');
      transcript.scrollToEnd();
    }
    if (output.clearNotice) setNotice('');
    requestRender();
  }
  /** The one pipeline for a command that produced work. Reads run beside the agent; the rest take the action slot. */
  function runPrepared(
    command: CommandSpec,
    argument: string,
    prepared: Extract<Prepared, { ok: true }>,
    draft: string | undefined,
  ): void {
    const show = (output: CommandOutput | undefined) => {
      if (output) showOutput(command.name, output);
    };
    if (!canRunWhileBusy(command, argument)) {
      begin(
        command.activity ?? 'command',
        draft,
        async (signal) => {
          const output = await prepared.run(signal);
          show(output);
          if (output?.failure) {
            // The note above already says what went wrong; do not add the same line again.
            if (output.failureShown && active) active.errorDisplayed = true;
            throw new Error(output.failure);
          }
        },
        command.cancellable !== false,
        `/${command.name}`,
      );
      return;
    }
    // Reads take no action slot and cannot be cancelled, but they are short and bounded.
    clearDraft(draft);
    void prepared
      .run(new AbortController().signal)
      .then(show, (error) => {
        if (!closing)
          conversation.note(
            `${command.name} failed`,
            singleLine(error instanceof Error ? error.message : describeValue(error), 800),
          );
      })
      .finally(requestRender);
  }
  /** /goal <text>: the agent works until the check passes; settle-gate rules (retry cap, budget, repeated failure) end the loop. */
  function startGoal(text: string, check: string | undefined, draft: string | undefined): void {
    if (!hasModelConfiguration(harness.session.model)) {
      setNotice(NO_MODEL);
      return;
    }
    const choice = selectedModelChoice();
    if (choice?.selectable === false) {
      setNotice(choice.detail ?? MODEL_UNAVAILABLE);
      return;
    }
    if (check === undefined && !taskVerifierItem(harness)) {
      setNotice(
        harness.kind === 'chat'
          ? 'Add a check: /goal <text> --check "<command>"'
          : 'No open requirement · add a check: /goal <text> --check "<command>"',
      );
      return;
    }
    const current = (goal = newGoal(text, check));
    begin('agent', draft, async (signal) => {
      await runGoalLoop({
        goal: current,
        signal,
        budget: () => harness.budget.snapshot(),
        say: (line) => {
          conversation.note('goal', line);
          transcript.scrollToEnd();
          requestRender();
        },
        check: (checkSignal) => runGoalCheck(harness, current, checkSignal),
        async turn(prompt) {
          await harness.session.prompt(prompt, { expandPromptTemplates: false });
          if (active?.error) throw new Error(active.error);
        },
      });
    });
  }

  const commandContext: CommandContext = {
    harness,
    workbench,
    shell,
    conversation,
    review: options.review ?? runReviewCommand,
    columns: () => terminal.columns,
    setNotice,
    clearDraft,
    show(title, text, draft) {
      conversation.note(title, text);
      clearDraft(draft);
      switchView('harness');
      setFocus('input');
      transcript.scrollToEnd();
      setNotice('');
    },
    switchView,
    setFocus,
    scrollToEnd() {
      transcript.scrollToEnd();
      requestRender();
    },
    editorAction,
    terminalAction,
    setAgentPanel(visible) {
      agentPanelVisible = visible ?? !agentPanelVisible;
      switchView('workbench');
      repairHiddenFocus();
      requestRender();
    },
    toggleRequirements,
    checkRequirements() {
      refreshRequirements();
      return { proofAvailable, checkedAt, items: checkedItems };
    },
    selectedRequirement: () => selectedId,
    modelDetail: () => selectedModelChoice()?.detail,
    openSetup,
    openAccount,
    changeTheme,
    art: {
      setMode(mode) {
        artMode = mode;
        artShown = artShow(artMode, process.env);
        options.onStartupArtChange?.(artMode);
      },
      next: () => art.next(),
      title: () => art.title,
      reload() {
        void loadArtImage().then(requestRender);
        requestRender();
      },
    },
    goal: {
      get: () => goal,
      set(next) {
        goal = next;
      },
    },
    startGoal,
    ask,
    submit: (text) => submit(text, true),
    cancel,
    quit: () => quit(),
    confirm(question, onYes) {
      confirmation = { question, yes: onYes };
      requestRender();
    },
  };

  /** Slash commands go through the table: busy rule, argument check, then the handler and the shared pipeline. */
  function submit(draft = input.document.text, fromPalette = false): void {
    const composerDraft = fromPalette ? undefined : draft;
    if (!draft.trim()) return;
    const trimmed = draft.trim();
    if (!fromPalette) remember(draft);
    if (trimmed === '/quit' || trimmed === '/exit') {
      quit();
      return;
    }
    if (closing) {
      setNotice('Closing…');
      return;
    }
    if (trimmed === '/quit discard' || trimmed === '/exit discard') {
      quit(true);
      return;
    }
    // A message that opens with a file path ("/Users/me/app/lib.rs fails to compile") is a message, not a command.
    const slash = trimmed.startsWith('/') && !/^\/[^\s/]*\//.test(trimmed);
    const parsed = slash ? parseCommand(trimmed) : undefined;
    const command = findCommand(parsed?.name);
    const argument = parsed?.argument ?? '';
    if (busy() && !(command && canRunWhileBusy(command, argument))) {
      // The typed text stays: it is the user's own next request.
      setNotice(view === 'harness' ? 'Still working · esc to cancel' : 'Still working · /cancel to stop');
      return;
    }
    if (slash) {
      if (!command || !acceptsArgument(command, argument)) {
        setNotice(commandProblem(parsed, harness.kind));
        // A short mistyped command would only sit there to be joined to the next one. Longer or multi-line text may be
        // a message that merely starts with a slash: keep it.
        const typo = !/\n/.test(trimmed) && trimmed.length <= 80;
        if (typo) clearDraft(composerDraft);
        return;
      }
      setNotice('');
      const prepared = command.run(commandContext, argument, composerDraft);
      if (!prepared) return;
      if (!prepared.ok) {
        setNotice(prepared.message);
        clearDraft(composerDraft);
        return;
      }
      runPrepared(command, argument, prepared, composerDraft);
      return;
    }
    ask(draft, draft);
  }
  /** The user's next message to the agent, from the composer or a command such as /team. */
  function ask(text: string, composerDraft: string | undefined): void {
    if (!hasModelConfiguration(harness.session.model)) {
      setNotice(NO_MODEL);
      return;
    }
    const choice = selectedModelChoice();
    if (choice?.selectable === false) {
      const detail = choice.detail ?? MODEL_UNAVAILABLE;
      conversation.note('model unavailable', detail);
      transcript.scrollToEnd();
      setNotice(detail);
      return;
    }
    // The user sent something: show where it goes, even after scrolling up from the composer.
    transcript.scrollToEnd();
    begin('agent', composerDraft, async () => {
      await harness.session.prompt(text, { expandPromptTemplates: false });
    });
  }

  const component = (render: (width: number) => string[]): Component => ({ render, invalidate() {} });
  const headerShown = () => terminal.rows >= 30;

  // The requirements sidebar of a task: a divider, then the list.
  const rail: Component = {
    invalidate() {},
    render: (width) =>
      requirementsRows(theme!, glyphs, checkedItems, selectedId, focus === 'requirements', Math.max(1, width - 2)).map(
        (line) => ' ' + line,
      ),
  };
  const railView = new ScrollView(rail, { scrollbar: 'auto', overscroll: 'contain' });
  let dividerLines: string[] = [];
  let dividerKey = '';
  const divider: Component = {
    invalidate() {},
    render() {
      const line = colorText(theme!, 'border', glyphs.vertical);
      const key = `${line}${terminal.rows}`;
      if (key !== dividerKey) {
        dividerKey = key;
        dividerLines = Array<string>(terminal.rows).fill(line);
      }
      return dividerLines;
    },
  };

  // Header: the mark, the folder or task and its branch on the left; the two views, as plain words, on the right.
  const appActions = new ActionBar(
    () => [
      { id: 'chat', label: 'chat', active: view === 'harness', onPress: () => submit('/harness', true) },
      { id: 'workbench', label: 'workbench', active: view === 'workbench', onPress: () => submit('/workbench', true) },
    ],
    {
      theme: () => theme!,
      render: requestRender,
      onEscape: () => setFocus(view === 'harness' ? 'input' : 'editor'),
      padding: 1,
      gap: 0,
      inactive: 'faint',
    },
  );
  const branchName = () => (harness.kind === 'task' ? harness.task.branch : cachedBranch(harness.folder.path));
  const header = new HStack([
    {
      component: component((width) => [headerLeft(theme!, glyphs, sessionLabel(harness), branchName(), width)]),
      basis: 0,
      grow: 1,
      shrink: 1,
      minSize: 0,
    },
    { component: appActions, basis: 17, shrink: 0 },
    { component: component(() => [' ']), basis: 1, shrink: 0 },
  ]);

  // Composer: two rules, the prompt and the input, growing up to eight lines.
  const composerMax = () => Math.max(1, Math.min(8, Math.floor(terminal.rows * 0.4)));
  /** Rows of the draft, wrapped, at least one; one while the conversation has the focus. */
  function composerLines(): number {
    if (focus === 'conversation') return 1;
    // The prompt takes two columns; long lines wrap onto more rows, up to the same cap.
    return Math.max(1, Math.min(input.rows(Math.max(1, terminal.columns - 2)), composerMax()));
  }
  const composerLabel = (): RuleLabel[] => {
    const model = harness.session.model;
    const ready = !!model && hasModelConfiguration(model) && models().some((candidate) => candidate.configured);
    const yolo = chat && harness.yolo.enabled();
    return [
      ready ? { text: shortModelName(model.id), role: 'muted' } : { text: 'no model', role: 'warning' },
      yolo ? { text: 'yolo', role: 'error' } : { text: 'ask', role: 'muted' },
    ];
  };
  const spinnerInRule = () => busy() && terminal.rows < 20 && !hostApproval && !confirmation;
  // A draft taller than the composer scrolls: the top rule counts the rows above the view, so nothing is lost silently.
  const clipped = (): RuleLabel[] =>
    input.view.scrollTop > 0 && input.document.text
      ? [{ text: inGlyphs(glyphs, `↑ ${Math.round(input.view.scrollTop)} more`), role: 'muted' }]
      : [];
  const topRule = component((width) => [
    ruleRow(theme!, glyphs, width, focus === 'input', clipped(), spinnerInRule() ? spinnerLine() : undefined),
  ]);
  const bottomRule = component((width) => [ruleRow(theme!, glyphs, width, focus === 'input', composerLabel())]);
  const promptColumn = component(() => [promptRow(theme!, glyphs, focus === 'input' && !setup)]);
  const composerHint = (): string =>
    inGlyphs(
      glyphs,
      !models().some((candidate) => candidate.configured)
        ? 'Type /connect to sign in and pick a model'
        : // The empty state above already suggests something to try.
          (harness.session.messages?.length ?? 0) === 0
          ? PLACEHOLDERS[0]
          : composerPlaceholder,
    );
  const emptyComposer: Component = {
    invalidate() {},
    handleMouse(event) {
      if (event.button !== 'left') return undefined;
      if (event.type === 'click') setFocus('input');
      return event.type === 'click' || event.type === 'press' ? { handled: true, focus: false } : undefined;
    },
    render: (width) => [placeholderRow(theme!, glyphs, composerHint(), !!input.focus.focused, width)],
  };
  const composerBody = new HStack([
    { component: promptColumn, basis: 2, shrink: 0 },
    { component: input.view, basis: 0, grow: 1, minSize: 1, visible: () => input.document.text !== '' },
    { component: emptyComposer, basis: 0, grow: 1, minSize: 1, visible: () => input.document.text === '' },
  ]);
  const composer = new VStack([
    { component: topRule, basis: 1, shrink: 0 },
    { component: composerBody, basis: 0, grow: 1, minSize: 1 },
    { component: bottomRule, basis: 1, shrink: 0 },
  ]);
  const paletteField = component((width) => paletteInput?.render(width) ?? []);
  const paletteComposer = new VStack([
    { component: component((width) => [ruleRow(theme!, glyphs, width, true)]), basis: 1, shrink: 0 },
    { component: paletteField, basis: 1, shrink: 0 },
    {
      component: component((width) => [
        ruleRow(theme!, glyphs, width, true, [{ text: 'commands · esc to close', role: 'muted' }]),
      ]),
      basis: 1,
      shrink: 0,
    },
  ]);

  // The row above the composer while work runs. On a short terminal it moves into the composer's top rule.
  const spinnerLine = (): string => spinner.compact(Math.max(1, terminal.columns - 8));

  // Slash popup: directly above the composer. A click runs the command under it; the wheel moves the selection.
  const popupRows = () => Math.max(1, Math.min(POPUP_ROWS, terminal.rows - 10));
  const commandMenu: Component = {
    invalidate() {},
    render(width) {
      const choices = currentCommands();
      if (!choices) return [];
      return slashPopup(theme!, glyphs, choices, commandIndex, width, popupRows());
    },
    handleMouse(event) {
      const choices = currentCommands();
      if (!choices?.length) return undefined;
      if (event.type === 'wheel' && event.wheelDelta) {
        commandIndex = Math.max(0, Math.min(choices.length - 1, commandIndex + (event.wheelDelta < 0 ? -1 : 1)));
        return { handled: true, focus: false };
      }
      if (event.button !== 'left') return undefined;
      if (event.type === 'press') return { handled: true, focus: false };
      if (event.type !== 'click') return undefined;
      const choice = choices[popupStart(commandIndex, choices.length, popupRows()) + event.y];
      if (choice) completeCommand(choice, true);
      return { handled: true, focus: false };
    },
  };

  // The warning that stays until dismissed, and the card for a host command that needs a yes or no.
  const noticeRow = component((width) => warningRows(theme!, notice, width));
  /** How many command rows the card shows at this terminal height; a longer command scrolls inside it. */
  const approvalWindow = () => Math.max(2, Math.min(12, terminal.rows - 17));
  /** The farthest the card's command can scroll. */
  const approvalMaxOffset = () =>
    hostApproval
      ? Math.max(0, approvalCommandRows(hostApproval.request.command, terminal.columns).length - approvalWindow())
      : 0;
  /** Allow is open once the whole command has been on screen. */
  const approvalRead = () => {
    if (!hostApproval) return true;
    const total = approvalCommandRows(hostApproval.request.command, terminal.columns).length;
    hostApproval.read ||= approvalFullyShown(total, { rows: approvalWindow(), offset: hostApproval.offset });
    return hostApproval.read;
  };
  let approvalLines: string[] = [];
  const approvalRow: Component = {
    invalidate() {},
    render(width) {
      approvalLines = hostApproval
        ? approvalCard(theme!, glyphs, hostApproval.request, width, {
            rows: approvalWindow(),
            offset: hostApproval.read ? Math.min(hostApproval.offset, approvalMaxOffset()) : hostApproval.offset,
          })
        : confirmation
          ? confirmationCard(theme!, glyphs, confirmation.question, width)
          : [];
      return approvalLines;
    },
    // A click on an option answers like its key: Allow stays shut until the command has been read.
    handleMouse(event) {
      if ((!hostApproval && !confirmation) || event.button !== 'left') return undefined;
      if (event.type === 'press') return { handled: true, focus: false };
      if (event.type !== 'click') return undefined;
      const letter = /^│ {2}([ysn]) {2}/.exec(stripTerminalSequences(approvalLines[event.y] ?? ''))?.[1];
      if (hostApproval) {
        if (letter) answerApproval(letter as 'y' | 's' | 'n');
      } else if (confirmation && (letter === 'y' || letter === 'n')) {
        const pending = confirmation;
        confirmation = undefined;
        requestRender();
        if (letter === 'y') pending.yes();
      }
      return { handled: true, focus: false };
    },
  };
  /** Answer the approval card as its key does: n always denies; y and s wait for a fully shown command and the guard. */
  function answerApproval(letter: 'y' | 's' | 'n'): void {
    const asked = hostApproval;
    if (!asked) return;
    if (letter === 'n') asked.answer(false);
    else if (!approvalRead() || Date.now() < approvalGuardUntil) return;
    else if (letter === 'y') asked.answer(true);
    else if (harness.kind === 'chat') asked.answer('session');
  }

  // Status row: key hints (or a toast) on the left, session facts on the right.
  const status = component((width) => {
    const model = harness.session.model;
    const choice = selectedModelChoice();
    const connected = models().some((candidate) => candidate.configured);
    const facts: StatusFact[] = [];
    if (!headerShown()) {
      facts.push({ key: 'folder', text: sessionLabel(harness), role: 'muted' });
      const branch = branchName();
      if (branch) facts.push({ key: 'branch', text: branch, role: 'muted' });
    }
    if (harness.chain?.rpcUrl()) facts.push({ key: 'chip', text: 'surfpool', role: 'muted', dot: 'success' });
    for (const chip of options.statusChips?.() ?? [])
      facts.push({
        key: 'chip',
        text: singleLine(chip.text, 24),
        role: chip.role ?? 'muted',
        ...(chip.dot ? { dot: chip.dot } : {}),
      });
    if (shell.cleanupUncertain) facts.push({ key: 'chip', text: 'shell cleanup unknown', role: 'warning' });
    if (harness.kind === 'task' && !requirementsShown(width) && checkedItems.length) {
      const item = checkedItems.find((candidate) => candidate.id === selectedId) ?? checkedItems[0]!;
      const closed = checkedItems.filter((candidate) => /^(?:closed|done|verified|passed)$/.test(candidate.status));
      facts.push({
        key: 'chip',
        text: `${singleLine(item.id, 20)} ${singleLine(item.status, 20)} · ${closed.length}/${checkedItems.length}`,
        role: 'muted',
      });
    }
    // The composer's bottom rule already names the model; the status row does when that rule is not on screen, or the
    // model needs attention.
    const composerOnScreen = !paletteInput && (view === 'harness' || focus === 'input');
    if (model && hasModelConfiguration(model) && connected) {
      const name = shortModelName(model.id);
      if (choice?.selectable === false) facts.push({ key: 'model', text: `${name} · unavailable`, role: 'warning' });
      else if (!composerOnScreen) facts.push({ key: 'model', text: name, role: 'muted' });
    } else if (!composerOnScreen) facts.push({ key: 'model', text: 'no model', role: 'warning' });
    const usage = harness.session.getContextUsage?.();
    if (usage?.percent != null) facts.push(contextFact(usage.percent));
    const budget = harness.budget.snapshot();
    const cost = budget.accounting === 'unknown' ? undefined : costFact(budget.used.spendMicroUsd);
    if (cost) facts.push(cost);
    // An unknown allowance is reported by /status; only a nearly spent or used-up one interrupts the steady state.
    const low = budget.accounting === 'unknown' && !budget.exhausted ? undefined : budgetFact(budget);
    if (low) facts.push(low);
    if (chat && harness.yolo.enabled()) facts.push({ key: 'yolo', text: 'YOLO', role: 'error', bold: true });
    const draft = paletteInput?.getValue() ?? input.document.text;
    const popup = currentCommands() !== undefined;
    const usageHint = popup || paletteInput ? undefined : argumentUsage(draft, harness.kind);
    return [
      statusRow(theme!, glyphs, {
        width,
        facts,
        ...(toastText !== undefined && !hostApproval && !confirmation ? { toast: toastText } : {}),
        hints: statusHints({
          ...(hostApproval
            ? {
                approval: !approvalRead()
                  ? ('read' as const)
                  : hostApproval.request.session
                    ? ('once-or-session' as const)
                    : ('once' as const),
              }
            : {}),
          ...(confirmation ? { confirm: true } : {}),
          overlay: !!setup,
          busy: busy(),
          canInterrupt: canInterrupt(),
          popup: popup || !!paletteInput,
          ...(usageHint ? { usage: usageHint } : {}),
          view,
          focus,
        }),
      }),
    ];
  });

  const setupBody: Component = {
    invalidate() {},
    render: (width) => setup?.body.render(width) ?? [],
    handleMouse: (event) => setup?.body.handleMouse?.(event),
  };
  const setupInput = component((width) => setup?.input.render(width) ?? []);
  /** The floating panel for the model, connect, theme, settings and account screens: 60% of the rows, 72 columns. */
  const overlayRows = () =>
    terminal.rows < 24
      ? // From 20 rows the centered panel stays clear of the composer's rules and the status row; below that every row counts.
        Math.max(5, terminal.rows - (terminal.rows >= 20 ? 8 : 2))
      : Math.min(terminal.rows - 2, Math.max(14, Math.floor(terminal.rows * 0.6)));
  const setupPanel = new Panel({
    theme: () => theme!,
    glyphs,
    title: () => setup?.label ?? '',
    hint: () => setup?.hint ?? '',
    body: setupBody,
    input: setupInput,
    maxRows: overlayRows,
    compact: () => terminal.rows < 24,
  });
  // The conversation, with no frame; a task's requirements sit in a sidebar to its right.
  const conversationFrame = new PaneFrame(transcript, {
    theme: () => theme!,
    title: () => 'Conversation',
    focused: () => focus === 'conversation',
    rows: () => terminal.rows,
    compact: () => terminal.rows < 20,
    onFocus: () => setFocus('conversation'),
  });
  const body = new HStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: divider, basis: 1, shrink: 0, visible: (viewport) => requirementsShown(viewport.width) },
    { component: railView, basis: 33, shrink: 0, visible: (viewport) => requirementsShown(viewport.width) },
  ]);
  const workbenchBody = new HStack(
    [
      { component: workbench.body, basis: 0, grow: 1, minSize: 1 },
      {
        component: conversationFrame,
        basis: 36,
        shrink: 0,
        visible: (viewport) => agentPanelVisible && viewport.width >= 118,
      },
    ],
    { gap: 2 },
  );
  const workbenchLayout = new VStack([
    {
      component: workbenchBody,
      basis: 0,
      grow: 1,
      minSize: 1,
      visible: () => terminal.rows >= 20 || focus !== 'terminal' || !terminalVisible,
    },
    {
      component: shell.body,
      basis: 10,
      shrink: 1,
      minSize: 3,
      visible: () => terminalVisible && (terminal.rows >= 20 || focus === 'terminal'),
    },
  ]);
  const layoutRoot = new VStack([
    { component: header, basis: 1, shrink: 0, visible: headerShown },
    { component: component(() => ['']), basis: 1, shrink: 0, visible: headerShown },
    { component: body, basis: 0, grow: 1, shrink: 1, minSize: 1, visible: () => view === 'harness' },
    { component: workbenchLayout, basis: 0, grow: 1, shrink: 1, minSize: 1, visible: () => view === 'workbench' },
    { component: approvalRow, basis: 'auto', shrink: 0, visible: () => !!hostApproval || !!confirmation },
    { component: spinner, basis: 1, shrink: 0, visible: () => busy() && !spinnerInRule() },
    { component: commandMenu, basis: 'auto', shrink: 0, visible: () => currentCommands() !== undefined },
    {
      component: composer,
      basis: 3,
      shrink: 1,
      minSize: 3,
      visible: () => !paletteInput && (view === 'harness' || focus === 'input'),
    },
    { component: paletteComposer, basis: 3, shrink: 0, visible: () => !!paletteInput },
    { component: noticeRow, basis: 'auto', shrink: 0, visible: () => !!notice },
    { component: status, basis: 1, shrink: 0 },
  ]);
  const composerEntry = layoutRoot[LAYOUT_NODE]().entries.find((entry) => entry.component === composer)!;
  renderer.setLayoutRoot(layoutRoot);
  renderer.transcriptView = transcript;
  setFocus(focus);
  function changeFocus(backward = false): void {
    const order: Focus[] =
      view === 'harness'
        ? requirementsShown()
          ? ['input', 'requirements', 'conversation']
          : ['input', 'conversation']
        : [
            'editor',
            ...(terminalVisible ? ['terminal' as const] : []),
            'input',
            ...(agentPanelVisible && terminal.columns >= 118 ? ['conversation' as const] : []),
          ];
    setFocus(order[(order.indexOf(focus) + (backward ? order.length - 1 : 1)) % order.length]!);
  }
  harness.setHostApproval?.(
    (request, signal) =>
      new Promise<boolean | 'session'>((resolve) => {
        if (closing || signal?.aborted || hostApproval) {
          resolve(false);
          return;
        }
        const abort = () => finish(false);
        const finish = (allowed: boolean | 'session') => {
          signal?.removeEventListener('abort', abort);
          hostApproval = undefined;
          const outcome = allowed === 'session' ? 'Allowed for this session' : allowed ? 'Allowed once' : 'Denied';
          // The record keeps the whole command that was decided on, not the first 300 characters of it.
          conversation.note('', `${outcome}: ${displayText(request.command, 4096)}`);
          approvalGuardUntil = Date.now() + 700;
          overlayHandle?.setHidden(false);
          requestRender();
          resolve(allowed);
        };
        confirmation = undefined;
        hostApproval = {
          request: {
            ...(request.requester ? { requester: request.requester } : {}),
            reasons: request.reasons,
            command: request.command,
            session: harness.kind === 'chat',
          },
          offset: 0,
          read: false,
          answer: finish,
        };
        signal?.addEventListener('abort', abort, { once: true });
        overlayHandle?.setHidden(true);
        requestRender();
      }),
  );
  const removeInput = renderer.addInputListener((data) => {
    try {
      repairHiddenFocus();
      if (isKeyRelease(data)) return { consume: true };
      if (hostApproval) {
        const scroll = matchesKey(data, 'up')
          ? -1
          : matchesKey(data, 'down')
            ? 1
            : matchesKey(data, 'pageUp')
              ? -approvalWindow()
              : matchesKey(data, 'pageDown')
                ? approvalWindow()
                : matchesKey(data, 'home')
                  ? -Infinity
                  : matchesKey(data, 'end')
                    ? Infinity
                    : 0;
        if (scroll) {
          hostApproval.offset = Math.max(0, Math.min(approvalMaxOffset(), hostApproval.offset + scroll));
          approvalRead();
          requestRender();
        } else if (data.toLowerCase() === 'y' || (data.toLowerCase() === 's' && harness.kind === 'chat'))
          answerApproval(data.toLowerCase() as 'y' | 's');
        else if (data.toLowerCase() === 'n' || matchesKey(data, 'escape')) answerApproval('n');
        else if (matchesKey(data, 'ctrl+q')) {
          hostApproval.answer(false);
          quit();
        } else if (matchesKey(data, 'ctrl+c')) {
          // Ctrl+C cancels the work that is waiting on the answer.
          hostApproval.answer(false);
          cancel();
        }
        return { consume: true };
      }
      if (confirmation) {
        // One key answers: y does it; n or Esc drops it; any other key drops it and is handled as usual.
        const pending = confirmation;
        confirmation = undefined;
        requestRender();
        if (data.toLowerCase() === 'y') {
          pending.yes();
          return { consume: true };
        }
        if (data.toLowerCase() === 'n' || matchesKey(data, 'escape')) return { consume: true };
      }
      if (matchesKey(data, 'ctrl+q')) {
        disarmQuit();
        quit();
        return { consume: true };
      }
      // Ctrl+C belongs to the shell and the editor when they have focus; anywhere else it cancels work, and twice quits.
      const interruptKey = matchesKey(data, 'ctrl+c') && focus !== 'terminal' && focus !== 'editor';
      if (!interruptKey) disarmQuit();
      if (discardConfirmed) notice = '';
      discardConfirmed = false;
      if (closing) return { consume: true };
      if (interruptKey) {
        interrupt();
        return { consume: true };
      }
      const slashNavigation =
        data === '/' &&
        !setup &&
        !paletteInput &&
        ((focus === 'editor' && !workbench.acceptsText) || (focus === 'terminal' && !shell.running));
      if (matchesKey(data, 'ctrl+d') && focus === 'input' && !setup && !paletteInput && !input.document.text) {
        quit();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+k') || matchesKey(data, 'alt+/') || slashNavigation) {
        openPalette();
        return { consume: true };
      }
      if (setup && !matchesKey(data, 'f8')) {
        setup.handleInput(data);
        return { consume: true };
      }
      if (paletteInput) {
        if (matchesKey(data, 'escape')) {
          paletteInput = undefined;
          setFocus(focus);
          return { consume: true };
        }
        const choices = currentCommands() ?? [];
        if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
          commandIndex = Math.max(0, Math.min(choices.length - 1, commandIndex + (matchesKey(data, 'up') ? -1 : 1)));
        } else if ((matchesKey(data, 'tab') || matchesKey(data, 'enter')) && choices[commandIndex]) {
          completeCommand(choices[commandIndex]!, matchesKey(data, 'enter'));
        } else if (matchesKey(data, 'enter')) {
          const draft = paletteInput.getValue();
          paletteInput = undefined;
          setFocus(focus);
          if (draft.startsWith('/')) submit(draft, true);
        } else {
          paletteInput.handleInput(data);
          paletteInput.setValue(
            paletteInput
              .getValue()
              .replace(/[\r\n]/g, ' ')
              .slice(0, 1024),
          );
        }
        requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'f3')) {
        switchView(view === 'harness' ? 'workbench' : 'harness');
        return { consume: true };
      }
      if (matchesKey(data, 'f10') && headerShown()) {
        setFocus('actions');
        return { consume: true };
      }
      if (focus === 'actions') {
        appActions.handleInput(data);
        return { consume: true };
      }
      if (matchesKey(data, 'f6')) {
        changeFocus();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+l')) {
        setFocus('input');
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+p')) {
        editorAction(() => workbench.open());
        return { consume: true };
      }
      if (matchesKey(data, 'f4')) {
        openSetup('model');
        return { consume: true };
      }
      if (matchesKey(data, 'f8')) {
        changeTheme(THEME_IDS[(THEME_IDS.indexOf(theme!.id) + 1) % THEME_IDS.length]!);
        return { consume: true };
      }
      if (focus === 'terminal') {
        shell.focus.handleInput?.(data);
        return { consume: true };
      }
      // Esc stops running work from the editor too, once it has nothing of its own to close.
      if (focus === 'editor' && matchesKey(data, 'escape') && canInterrupt() && workbench.atRest) {
        cancel();
        return { consume: true };
      }
      if (focus === 'editor') {
        workbench.handleInput(data);
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+o')) {
        toast(conversation.toggleToolOutput() ? 'Tool output expanded · ctrl+o to collapse' : 'Tool output collapsed');
        requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+t')) {
        toast(conversation.toggleThinking() ? 'Thinking hidden · ctrl+t to show' : 'Thinking shown');
        requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'escape')) {
        if (currentCommands() !== undefined) {
          dismissedCommands = input.document.text;
          requestRender();
        } else if (focus !== 'input') setFocus('input');
        else if (canInterrupt()) cancel();
        else if (view === 'workbench') setFocus('editor');
        else if (notice && !busy()) {
          notice = '';
          requestRender();
        } else cancel();
        return { consume: true };
      }
      if (matchesKey(data, 'f2')) {
        toggleRequirements();
        return { consume: true };
      }
      // Paste is handled only by the shared lossless editor, never parsed as an action.
      if (data.startsWith('\x1b[200~')) {
        if (focus === 'input') input.focus.handleInput?.(data);
        return { consume: true };
      }
      const commands = currentCommands();
      if (commands && focus === 'input') {
        if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
          commandIndex = Math.max(0, Math.min(commands.length - 1, commandIndex + (matchesKey(data, 'up') ? -1 : 1)));
          requestRender();
          return { consume: true };
        }
        const selected = commands[commandIndex];
        if ((matchesKey(data, 'tab') || matchesKey(data, 'enter')) && selected) {
          completeCommand(selected, matchesKey(data, 'enter'));
          return { consume: true };
        }
      }
      if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
        changeFocus(matchesKey(data, 'shift+tab'));
        return { consume: true };
      }
      if (
        focus === 'input' &&
        (matchesKey(data, 'up') || matchesKey(data, 'down')) &&
        recall(matchesKey(data, 'up') ? -1 : 1)
      )
        return { consume: true };
      if (focus === 'input') {
        // The conversation scrolls from the composer too; the mouse wheel and arrows work in its own focus.
        if (view === 'harness' && (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown'))) {
          transcript.scrollBy((matchesKey(data, 'pageUp') ? -1 : 1) * Math.max(1, transcript.viewportHeight - 1));
          requestRender();
          return { consume: true };
        }
        if (data === '?' && !input.document.text) {
          submit('/help keys', true);
          return { consume: true };
        }
        if (matchesKey(data, 'shift+enter') || matchesKey(data, 'alt+enter') || data === '\x1b\r') {
          input.focus.handleInput?.('\r');
          return { consume: true };
        }
        if (matchesKey(data, 'enter')) {
          submit();
          return { consume: true };
        }
        return undefined;
      }
      if (focus === 'requirements') {
        const items = checkedItems;
        let selected = items.findIndex((item) => item.id === selectedId);
        const up = matchesKey(data, 'up');
        const down = matchesKey(data, 'down');
        const pageUp = matchesKey(data, 'pageUp');
        const pageDown = matchesKey(data, 'pageDown');
        const first = matchesKey(data, 'home') || matchesKey(data, 'ctrl+home');
        const last = matchesKey(data, 'end') || matchesKey(data, 'ctrl+end');
        if (up || down || pageUp || pageDown || first || last) {
          const distance = pageUp || pageDown ? Math.max(1, Math.floor(railView.viewportHeight / 3)) : 1;
          selected = first
            ? 0
            : last
              ? items.length - 1
              : Math.max(0, Math.min(items.length - 1, selected + (up || pageUp ? -distance : distance)));
          selectedId = items[selected]?.id;
          railView.scrollTo(Math.max(0, selected * 3 - 1));
        }
        if (matchesKey(data, 'enter')) {
          focus = 'input';
          renderer.setFocus(input.focus);
        }
      } else {
        if (matchesKey(data, 'up')) transcript.scrollBy(-1);
        if (matchesKey(data, 'down')) transcript.scrollBy(1);
        if (matchesKey(data, 'pageUp')) transcript.scrollBy(-Math.max(1, transcript.viewportHeight - 1));
        if (matchesKey(data, 'pageDown')) transcript.scrollBy(Math.max(1, transcript.viewportHeight - 1));
        if (matchesKey(data, 'home') || matchesKey(data, 'ctrl+home')) transcript.scrollToStart();
        if (matchesKey(data, 'end') || matchesKey(data, 'ctrl+end')) transcript.scrollToEnd();
      }
      requestRender();
      return { consume: true };
    } catch (error) {
      fail(error);
      return { consume: true };
    }
  });
  let unsubscribe: (() => void) | undefined;
  let clock: NodeJS.Timeout | undefined;
  const onSignal = () => quit(true);
  try {
    // The fullscreen renderer consults the public registry before dispatching input.
    // Disable its navigation/search defaults so only the currently focused OMS pane owns keys.
    setKeybindings(omsKeybindings(ownedBindings));
    refreshRequirements();
    unsubscribe = harness.session.subscribe((event) => {
      try {
        conversation.accept(event);
        if (
          event.type === 'message_end' &&
          active?.kind === 'agent' &&
          event.message.role === 'assistant' &&
          event.message.stopReason === 'error'
        ) {
          active.error = actionError(
            'agent',
            event.message.errorMessage || 'The provider request failed.',
            event.message.provider,
          );
          active.errorDisplayed = !!event.message.errorMessage;
        }
        if (event.type === 'agent_start') {
          completedTokens = 0;
          streamingTokens = 0;
          currentTool = undefined;
          externalBusy = true;
          if (active?.kind === 'agent') {
            active.accepted = true;
            clearDraft(active.draft);
            if (active.controller.signal.aborted) abortAgent(active);
          }
        }
        if (event.type === 'agent_settled') {
          externalBusy = false;
          if (!closing) refreshRequirements();
          sessionSettled?.();
          maybeFinish();
        }
        if (event.type === 'tool_execution_start')
          currentTool = { id: event.toolCallId, name: event.toolName, args: event.args };
        if (event.type === 'tool_execution_end' && currentTool?.id === event.toolCallId) currentTool = undefined;
        if (event.type === 'message_update' && event.message.role === 'assistant')
          streamingTokens = event.message.usage?.output ?? streamingTokens;
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          completedTokens += event.message.usage?.output ?? 0;
          streamingTokens = 0;
        }
        if (
          event.type === 'tool_execution_end' &&
          ['write', 'edit', 'bash', 'propose_done'].includes(event.toolName) &&
          !closing
        )
          refreshRequirements();
        requestRender();
      } catch (error) {
        fail(error);
      }
    });
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    if (!options.terminal) {
      await settleKittyGraphics(artMode, process.env);
      artShown = artShow(artMode, process.env);
    }
    await loadArtImage();
    renderer.start();
    terminal.write('\x1b[22;0t');
    titleSaved = true;
    colorCursor();
    syncActivity();
    if (options.firstRun) options.onFirstRunShown?.();
    // Running work and a bounded budget's wall clock change with time; nothing else on screen does.
    clock = setInterval(() => {
      if (busy() || harness.budget.snapshot().executionMode === 'bounded') requestRender();
    }, 1000);
    await finished;
  } finally {
    closing = true;
    hostApproval?.answer(false);
    harness.setHostApproval?.(undefined);
    clearInterval(clock);
    clearTimeout(toastTimer);
    spinner.stop();
    if (quitArmed) clearTimeout(quitArmed.timer);
    process.off('SIGINT', onSignal);
    setup?.dispose();
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    removeInput();
    // Even an exceptional render/input failure cannot leave a dispatched operation unobserved.
    try {
      if (active) {
        cancel();
        await active.completion;
      }
      if (externalBusy) {
        const settled = new Promise<void>((yes) => {
          sessionSettled = yes;
        });
        cancel();
        await settled;
      }
      if (externalCancellation) await externalCancellation;
      if (shutdown) await shutdown;
    } finally {
      workbench.dispose();
      await shell.dispose();
      unsubscribe?.();
      disposed = true;
      try {
        await terminal.drainInput(200, 25);
      } finally {
        try {
          renderer.stop({ preserveScreen: true });
        } catch (error) {
          // A renderer reset failure must not skip the terminal's own mode restoration.
          terminal.stop();
          terminal.showCursor();
          throw error;
        } finally {
          try {
            if (progressShown) terminal.setProgress(false);
            if (cursorColored) terminal.write('\x1b]112\x07');
            if (titleSaved) terminal.write('\x1b[23;0t');
          } finally {
            setKeybindings(previousKeybindings);
          }
        }
      }
    }
  }
}
