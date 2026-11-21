import { homedir } from 'node:os';
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
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  getKeybindings,
  setKeybindings,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  type Component,
  type Terminal,
  type KeybindingsConfig,
} from '@earendil-works/pi-tui';
import { LAYOUT_NODE } from '@earendil-works/pi-tui/dist/layout-node.js';
import type { OmsSession } from '@oms/engine';
import { createFileEditorPane } from './file-editor.ts';
import {
  acceptsArgument,
  canRunWhileBusy,
  commandMatches,
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
import { WorkbenchPane } from './workbench.ts';
import { TerminalPane } from './terminal-pane.ts';
import { displayDefinition, type HelperDisplay } from './display-tools.ts';
import { Conversation, describeValue, displayText, singleLine } from './transcript.ts';
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

/** Clipboard writer for copy-on-select: true on success, otherwise the reason shown to the user. */
async function copySelectionText(text: string): Promise<boolean | string> {
  try {
    await copyToClipboard(text);
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

const MODEL_CONFIGURATION = 'Run /connect to sign in or /model to choose a model. Your draft is kept.';

function hasModelConfiguration(model: { provider: string; id: string } | undefined): boolean {
  const provider = model?.provider.trim();
  const id = model?.id.trim();
  return !!provider && !!id && provider !== 'unknown' && id !== 'unknown';
}

function alignEnds(left: string, right: string, width: number): string {
  if (visibleWidth(right) + 4 >= width) return truncateToWidth(left, width, '');
  const start = truncateToWidth(left, width - visibleWidth(right) - 2, '');
  return start + ' '.repeat(Math.max(1, width - visibleWidth(start) - visibleWidth(right))) + right;
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
    super(terminal, true, undefined, { mouse: true, copyOnSelect: true, copySelection: copySelectionText });
    this.fail = fail;
    this.palette = palette;
    this.prepareFrame = prepareFrame;
    this.mouseFocus = mouseFocus;
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
    /** 'theme' paints the palette background on every row; the default 'terminal' keeps the terminal's own. */
    background?: Backdrop;
    startupArt?: StartupArtMode;
    onStartupArtChange?: (mode: StartupArtMode) => void;
    view?: 'harness' | 'workbench';
    onViewChange?: (view: 'harness' | 'workbench') => void;
    /** A note shown in the conversation when the interface opens. */
    startNote?: string;
  } = {},
): Promise<void> {
  const terminal = options.terminal ?? new ProcessTerminal();
  const display = { depth: detectColorDepth(), backdrop: options.background ?? 'terminal' } as const;
  let theme = getTheme(options.theme ?? DEFAULT_THEME_ID, display);
  if (!theme) throw new Error(`Choose a theme from: ${THEME_IDS.join(', ')}`);
  /** A folder chat is pi-minimal: the conversation, the input and one footer line. A pinned task keeps its panes. */
  const minimal = harness.kind === 'chat';
  let requirementsVisible = false;
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
  let notice = '';
  let hostApproval: { text: string; answer(allowed: boolean | 'session'): void } | undefined;
  let checkedItems: Requirement[] = [];
  let setup: SetupPane | HarnessSettingsPane | AccountPane | undefined;
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
      composerLayoutEntry.basis = terminal.rows >= 24 ? 7 : terminal.rows >= 20 ? 6 : 3;
      chatComposerEntry.basis = 2 + Math.max(1, Math.min(6, input.document.text.split('\n').length));
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
  /** The model catalog is rebuilt on every read; a frame reads it once. */
  let frameModels: ReturnType<typeof harness.listModels> | undefined;
  let framing = false;
  const models = () => (framing ? (frameModels ??= harness.listModels()) : harness.listModels());
  /** The one busy rule: a model turn, a command, or a cancellation still settling. */
  const busy = () => !!active || externalBusy || !!externalCancellation;
  /** Cancel does something only for cancellable work: the running action, or a turn this presentation did not start. */
  const canCancel = () => (active ? active.cancellable : externalBusy);
  const input = createFileEditorPane('', () => {
    if (input.document.text !== dismissedCommands) dismissedCommands = undefined;
    requestRender();
  });
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
              toolDefinition: (name) => displayDefinition(name, harness.session.getToolDefinition?.(name)),
              cwd: harness.root,
              requestRender: () => requestRender(),
            });
            helperViews.set(id, { count: messages.length, view });
            return view;
          },
        }
      : undefined;
  const conversation = new Conversation(
    nativeChatDisplayHistory(harness),
    (message, provider) => actionError('agent', message, provider),
    {
      toolDefinition: (name) => displayDefinition(name, harness.session.getToolDefinition?.(name), helperDisplay),
      cwd: harness.root,
      requestRender: () => requestRender(),
    },
  );
  conversation.applyTheme(theme);
  if (options.startNote) conversation.note('scratch folder', options.startNote);
  const art = new StartupArt();
  let artMode = options.startupArt ?? (minimal ? 'off' : 'auto');
  // Chosen from the environment (after the one Kitty graphics query over SSH) and again when /art changes the setting.
  let artShown = artShow(artMode, process.env);
  /** The image tier draws the mosaic until the picture is converted for Kitty graphics. */
  const loadArtImage = () => (artShown === 'image' ? art.loadImage().catch(() => {}) : Promise.resolve());
  let artViewport = 0,
    artHidden = 0;
  function placeholder(width: number): string[] {
    const configured = hasModelConfiguration(harness.session.model);
    if (minimal)
      return wrapTextWithAnsi(
        colorText(
          theme!,
          'muted',
          !models().some((candidate) => candidate.configured)
            ? 'Run /connect to sign in, then /model to pick a model. Run /help for help.'
            : configured && selectedModelChoice()?.configured
              ? 'Run /help for help.'
              : 'Run /model to pick a model. Run /help for help.',
        ),
        Math.max(1, width - 1),
      ).map((line) => ' ' + line);
    const content = configured
      ? [
          colorText(theme!, 'accent', 'What are we building?'),
          '',
          'Describe a change below. Your agent works in this task.',
          '',
          '/workbench  Files and terminal',
          '/help       Commands and keyboard controls',
        ]
      : [
          colorText(theme!, 'accent', 'Start with your workspace'),
          '',
          '/connect    Connect a provider privately',
          '/model      Choose a model',
          '',
          '/workbench  Edit files without a model',
          'Never paste keys or sign-in codes into chat.',
        ];
    if (terminal.rows < 18)
      return wrapTextWithAnsi(
        configured ? '/workbench files · /help controls' : '/connect to begin · /workbench to edit',
        width,
      );
    return ['', ...content.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 2)))].map((line) => ' ' + line);
  }
  /** The art is the first block of the transcript, sized so it fits above the placeholder; it scrolls away with the conversation. */
  function artBlock(width: number, below: number, content: number): string[] {
    artViewport = transcript.viewportHeight;
    const rows = Math.min(artViewport - 6, artViewport - 3 - below, Math.floor(terminal.rows / 2));
    const muted = (text: string) => colorText(theme!, 'muted', text);
    const block = art.block(width, rows, artShown, muted);
    // The layout scrolls after drawing: crop the picture for the rows it is about to scroll away, so no second frame.
    const end = Math.max(0, block.length + content - artViewport);
    artHidden = transcript.isFollowingEnd ? end : Math.min(transcript.scrollTop, end);
    return artHidden ? art.block(width, rows, artShown, muted, artHidden) : block;
  }
  const transcript = new (class extends ScrollView {
    // The viewport and scroll position are known only after the content renders: render again when they differ from
    // the ones the art was drawn for (the size, and for the real picture which rows are scrolled away).
    override updateLayout(contentHeight: number, viewportHeight: number, render: () => void): void {
      super.updateLayout(contentHeight, viewportHeight, render);
      if (
        artMode !== 'off' &&
        (Math.floor(viewportHeight) !== artViewport || (artShown === 'image' && this.scrollTop !== artHidden))
      )
        render();
    }
  })(
    {
      invalidate() {
        conversation.invalidate();
      },
      render(width) {
        const lines = conversation.render(width);
        // The placeholder only shows, or sizes the art, when there is no conversation yet or art is on.
        const hint = lines.length && artShown === 'off' ? [] : placeholder(width);
        const body = lines.length ? lines : hint;
        const block = artBlock(width, hint.length, body.length);
        return block.length ? [...block, ...body] : body;
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

  function setNotice(text: string): void {
    notice = singleLine(text, 800);
    requestRender();
  }

  function changeTheme(id: string): boolean {
    const next = getTheme(id, display);
    if (!next) {
      setNotice(`Unknown theme. Choose: ${THEME_IDS.join(', ')}; draft retained.`);
      return false;
    }
    theme = next;
    conversation.applyTheme(next);
    options.onThemeChange?.(next.id);
    setNotice(`Theme: ${next.name}`);
    return true;
  }
  function closeSetup(): void {
    setup?.dispose();
    setup = undefined;
    setFocus(focus);
    requestRender();
  }
  function openSetup(mode: 'model' | 'connect' | 'theme' | 'settings', query = '', draft?: string): void {
    if (closing) return;
    if ((mode === 'model' || mode === 'connect') && busy()) {
      setNotice('Wait for current work to finish before changing model credentials; draft retained.');
      return;
    }
    setup?.dispose();
    const shared = {
      theme: () => theme!,
      rows: () => terminal.rows,
      bodyRows: () => Math.max(1, terminal.rows - (terminal.rows >= 20 ? 7 : 6) - (notice ? 1 : 0)),
      render: requestRender,
      close: closeSetup,
      notice: setNotice,
    };
    setup =
      mode === 'settings'
        ? new HarnessSettingsPane(harness, shared)
        : new SetupPane(harness, { ...shared, mode, query, selectTheme: changeTheme });
    if (draft !== undefined) clearDraft(draft);
    notice = '';
    renderer.setFocus(setup.input);
    requestRender();
  }
  function openAccount(mode: 'login' | 'logout' | 'account', draft?: string): void {
    if (closing) return;
    if (mode === 'login' && busy()) {
      setNotice('Wait for current work before signing in; draft retained.');
      return;
    }
    setup?.dispose();
    setup = new AccountPane(harness.account, {
      mode,
      theme: () => theme!,
      render: requestRender,
      close: closeSetup,
      bodyRows: () => Math.max(1, terminal.rows - (terminal.rows >= 20 ? 7 : 6) - (notice ? 1 : 0)),
    });
    clearDraft(draft);
    renderer.setFocus(setup.input);
    requestRender();
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
    const choices = commandMatches(draft, harness.kind);
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
      .catch((error) => setNotice(error instanceof Error ? error.message : 'Editor action failed.'));
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
        .catch((error) =>
          setNotice(error instanceof Error ? error.message : 'Terminal cleanup failed; use /terminal stop to retry.'),
        );
    } else if (!action || action === 'start') {
      terminalVisible = true;
      setFocus('terminal');
      void shell.start();
    } else setNotice('Use /terminal, /terminal stop or /terminal hide.');
    requestRender();
  }
  function requirementsShown(width = terminal.columns): boolean {
    return view === 'harness' && requirementsVisible && width >= 78;
  }
  function repairHiddenFocus(): void {
    if (setup) return;
    if (focus === 'requirements' && !requirementsShown()) setFocus('input');
    if (view === 'harness' && (focus === 'editor' || focus === 'terminal')) setFocus('input');
    if (view === 'workbench' && focus === 'terminal' && !terminalVisible) setFocus('editor');
    if (view === 'workbench' && focus === 'conversation' && (!agentPanelVisible || terminal.columns < 118))
      setFocus('input');
  }
  function toggleRequirements(): void {
    requirementsVisible = !requirementsVisible;
    repairHiddenFocus();
    requestRender();
  }
  function selectedModelChoice() {
    const model = harness.session.model;
    return model && models().find((choice) => choice.provider === model.provider && choice.id === model.id);
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
      setNotice(`Cancellation failed: ${describeValue(error instanceof Error ? error.message : error)}`);
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
    if (missingAuth || expiredAuth)
      return `${MODEL_CONFIGURATION} Authentication is unavailable${provider ? ` for ${singleLine(provider, 80)}` : ''}.`;
    if (
      message.startsWith(`No model selected.\n\n${loginHelp}`) ||
      message.startsWith(`No models available. ${loginHelp}`)
    ) {
      return `${MODEL_CONFIGURATION} No model is available.`;
    }
    return message;
  }

  function cancel(): void {
    if (active) {
      if (!active.cancellable) {
        setNotice('This operation must finish within its backend timeout; cancellation is unavailable.');
        return;
      }
      if (active.cancellation) return;
      active.controller.abort();
      const action = active;
      setNotice('Cancellation requested; awaiting the actual operation outcome.');
      if (action.kind === 'agent' && action.accepted) abortAgent(action);
      else action.cancellation = Promise.resolve();
    } else if (externalBusy && !externalCancellation) {
      setNotice('Cancellation requested; awaiting the live session outcome.');
      externalCancellation = Promise.resolve()
        .then(() => harness.session.abort())
        .catch((error) => {
          failure = error;
          setNotice(`Cancellation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        })
        .finally(() => {
          externalCancellation = undefined;
          maybeFinish();
          requestRender();
        });
    }
  }

  function quit(force = false): void {
    if (closing) return;
    if (!force && workbench.dirty && !discardConfirmed) {
      discardConfirmed = true;
      setNotice('Ctrl+Q again: discard unsaved files. Any other key keeps them; Ctrl+S saves the active file.');
      return;
    }
    closing = true;
    setNotice('Closing...');
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

  function begin(
    kind: ActionKind,
    draft: string | undefined,
    operation: (signal: AbortSignal) => Promise<void>,
    cancellable = true,
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
        if (action.controller.signal.aborted) throw new Error('Request cancelled before dispatch; draft retained.');
        await operation(action.controller.signal);
        if (action.error) throw new Error(action.error);
        if (kind !== 'agent' || !action.accepted) clearDraft(draft);
      } catch (error) {
        const message = actionError(
          kind,
          error,
          kind === 'agent' && !action.accepted ? harness.session.model?.provider : undefined,
        );
        // A refusal before agent_start leaves the text untouched. Once the message is in the conversation the failure is
        // too, so the input stays empty and the next message starts clean.
        // An SDK assistant error is already represented by its contextual message.
        if (!action.errorDisplayed) conversation.note(`${kind} failed`, message);
        setNotice(
          message.startsWith(MODEL_CONFIGURATION)
            ? message
            : `${kind} failed; details in conversation.${action.accepted ? '' : ' Draft retained.'}`,
        );
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
          if (output?.failure) throw new Error(output.failure);
        },
        command.cancellable !== false,
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
      setNotice(`${MODEL_CONFIGURATION} No model is available.`);
      return;
    }
    const choice = selectedModelChoice();
    if (choice?.selectable === false) {
      setNotice(choice.detail ?? 'Selected model needs setup · /model to choose a connected provider');
      return;
    }
    if (check === undefined && !taskVerifierItem(harness)) {
      setNotice(
        harness.kind === 'chat'
          ? 'No verifier here. Use /goal <text> --check "<command>".'
          : 'This task has no open requirement for its verifier to decide. Add a check: /goal <text> --check "<command>"',
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
  };

  /** Slash commands go through the table: busy rule, argument check, then the handler and the shared pipeline. */
  function submit(draft = input.document.text, fromPalette = false): void {
    const composerDraft = fromPalette ? undefined : draft;
    if (!draft.trim()) return;
    const trimmed = draft.trim();
    if (trimmed === '/quit' || trimmed === '/exit') {
      quit();
      return;
    }
    if (closing) {
      setNotice('Closing; draft retained.');
      return;
    }
    if (trimmed === '/quit discard' || trimmed === '/exit discard') {
      quit(true);
      return;
    }
    const slash = trimmed.startsWith('/');
    const parsed = slash ? parseCommand(trimmed) : undefined;
    const command = findCommand(parsed?.name);
    const argument = parsed?.argument ?? '';
    if (busy() && !(command && canRunWhileBusy(command, argument))) {
      setNotice('Work is running. Use /cancel to stop it, or keep editing your next request.');
      return;
    }
    if (slash) {
      if (!command || !acceptsArgument(command, argument)) {
        setNotice('Unknown or invalid OMS command. Use /help; draft retained.');
        return;
      }
      setNotice('');
      const prepared = command.run(commandContext, argument, composerDraft);
      if (!prepared) return;
      if (!prepared.ok) {
        setNotice(prepared.complete ? prepared.message : `${prepared.message} Draft retained.`);
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
      setNotice(`${MODEL_CONFIGURATION} No model is available.`);
      return;
    }
    const choice = selectedModelChoice();
    if (choice?.selectable === false) {
      const detail = choice.detail ?? 'Selected model needs setup · /model to choose a connected provider';
      conversation.note('model unavailable', detail);
      transcript.scrollToEnd();
      setNotice(detail);
      return;
    }
    begin('agent', composerDraft, async () => {
      await harness.session.prompt(text, { expandPromptTemplates: false });
    });
  }

  const rail: Component = {
    invalidate() {},
    render(width) {
      const lines = [colorText(theme!, 'muted', 'Requirements'), ''];
      for (const item of checkedItems) {
        const selected = item.id === selectedId;
        lines.push(
          colorText(
            theme!,
            selected ? 'accent' : 'foreground',
            truncateToWidth(
              `${selected ? '> ' : '  '}${singleLine(item.id, 80)}  ${singleLine(item.status, 80)}`,
              width,
            ),
          ),
        );
        lines.push(truncateToWidth(`  ${singleLine(item.title, 400)}`, width), '');
      }
      if (lines.length === 2) lines.push('Task state unavailable');
      return lines;
    },
  };
  const railView = new ScrollView(rail, { scrollbar: 'auto', overscroll: 'contain' });
  const appActions = new ActionBar(
    () => [
      { id: 'harness', label: 'Harness', active: view === 'harness', onPress: () => submit('/harness', true) },
      { id: 'workbench', label: 'Workbench', active: view === 'workbench', onPress: () => submit('/workbench', true) },
      { id: 'commands', label: 'Commands', icon: '≡', onPress: () => openPalette() },
      { id: 'files', label: 'Files', icon: '▸', onPress: () => submit('/files', true) },
      { id: 'model', label: 'Model', disabled: busy(), onPress: () => openSetup('model') },
      { id: 'settings', label: 'Settings', onPress: () => openSetup('settings') },
      { id: 'help', label: 'Help', icon: '?', onPress: () => submit('/help', true) },
    ],
    { theme: () => theme!, render: requestRender, onEscape: () => setFocus(view === 'harness' ? 'input' : 'editor') },
  );
  const composerActions = new ActionBar(
    () => [
      {
        id: 'send',
        label: 'Send',
        icon: '↑',
        disabled: !input.document.text.trim() || busy(),
        onPress: () => submit(),
      },
      { id: 'cancel', label: 'Cancel', icon: '×', disabled: !canCancel(), onPress: cancel },
      { id: 'commands', label: 'Commands', icon: '/', onPress: () => openPalette() },
    ],
    { theme: () => theme!, render: requestRender },
  );
  const setupActions = new ActionBar(
    () => [
      { id: 'back', label: 'Back', icon: '‹', onPress: () => setup?.handleInput('\x1b') },
      { id: 'confirm', label: 'Confirm', icon: '↵', onPress: () => setup?.handleInput('\r') },
    ],
    { theme: () => theme!, render: requestRender },
  );
  const component = (render: (width: number) => string[]): Component => ({ render, invalidate() {} });
  const header = component((width) => {
    const state = closing
      ? 'closing'
      : active
        ? active.cancellation
          ? 'cancelling'
          : active.kind
        : externalBusy
          ? 'agent running'
          : 'idle';
    const workspace = `${colorText(theme!, 'warning', 'oms')} · ${view === 'harness' ? 'Harness' : 'Workbench'} · ${singleLine(sessionLabel(harness), 160)}`;
    const activity = `${state}${shell.cleanupUncertain ? ' · shell cleanup unknown' : shell.running ? ' · shell running' : ''}`;
    return [paintThemeRow(theme!, alignEnds(workspace, activity, width), width)];
  });
  const status = component((width) => {
    const model = harness.session.model;
    const choice = selectedModelChoice();
    // Before anything is connected the session still holds a default model; do not present it as a pick the user made.
    const nothingConnected = !models().some((candidate) => candidate.configured);
    const modelLabel =
      model && hasModelConfiguration(model) && !(nothingConnected && choice?.selectable === false)
        ? `${model.provider === 'claude-code' ? 'Native chat · ' : ''}${singleLine(model.provider, 80)}/${singleLine(model.id, 120)}${choice?.selectable === false ? ' · unavailable · /model' : ''}`
        : model && hasModelConfiguration(model)
          ? 'No model selected · /connect then /model'
          : 'No model · /connect or /model';
    const budget = harness.budget.snapshot();
    const scope =
      budget.executionMode === 'interactive'
        ? (['tokens', 'wallClockMs'] as const)
        : (['tokens', 'spendMicroUsd', 'wallClockMs'] as const);
    const low = scope.some((key) => budget.remaining[key] <= 0 || budget.remaining[key] <= budget.caps[key] * 0.1);
    const exhausted = budget.exhausted;
    const risk = exhausted
      ? `Budget EXHAUSTED${budget.accounting === 'unknown' ? ' · unknown' : ''}`
      : budget.accounting === 'unknown'
        ? 'Budget unknown'
        : low
          ? 'Budget low'
          : '';
    const summary = risk ? `${risk} · /status${width >= 65 ? '  |  ' + modelLabel : ''}` : modelLabel;
    return [truncateToWidth(colorText(theme!, risk ? 'warning' : 'muted', summary), width)];
  });
  const inputLabel = component((width) => {
    if (minimal && !setup && !paletteInput) {
      const scroll =
        view !== 'harness'
          ? ''
          : focus === 'input'
            ? ' Press Tab, then PgUp/PgDn to scroll.'
            : ' Use PgUp/PgDn to scroll.';
      return wrapTextWithAnsi(
        colorText(
          theme!,
          'muted',
          `Press Enter to send. Use Shift+Enter for a newline. Type / for commands. Run /help keys for help. Press Ctrl+Q to quit.${scroll}`,
        ),
        width,
      );
    }
    const label = truncateToWidth(
      setup
        ? setup.label
        : paletteInput
          ? '─ Commands · Esc back'
          : `─ ${focus === 'input' ? '> ' : ''}Agent · / commands${width >= 55 ? ' · Enter send · Shift+Enter newline' : ' · Enter send'}`,
      width,
      '',
    );
    return [
      colorText(theme!, 'accent', label) +
        colorText(theme!, 'muted', '─'.repeat(Math.max(0, width - visibleWidth(label)))),
    ];
  });
  const noticeRow = component((width) => wrapTextWithAnsi(colorText(theme!, 'warning', notice), width));
  const workingRow = component((width) => [
    truncateToWidth(colorText(theme!, 'muted', ` ${active?.cancellation ? 'Cancelling...' : 'Working...'}`), width),
  ]);
  /** The folder, then the model, how full its context is, and YOLO when it is on. One line. */
  const chatFooter = component((width) => {
    const model = harness.session.model;
    const connected = models().some((candidate) => candidate.configured);
    const parts: string[] = [];
    if (model && hasModelConfiguration(model) && connected)
      parts.push(colorText(theme!, 'muted', `${singleLine(model.provider, 60)}/${singleLine(model.id, 100)}`));
    const usage = harness.session.getContextUsage?.();
    if (usage?.percent != null) parts.push(colorText(theme!, 'muted', `${usage.percent.toFixed(1)}%`));
    const budget = harness.budget.snapshot();
    if (budget.accounting === 'unknown') parts.push(colorText(theme!, 'warning', 'usage unknown · /status'));
    else if (budget.exhausted) parts.push(colorText(theme!, 'warning', 'budget used up · /status'));
    if (harness.kind === 'chat' && harness.yolo.enabled()) parts.unshift(colorText(theme!, 'warning', 'YOLO'));
    const right = parts.join(colorText(theme!, 'muted', ' · '));
    const folderPath = harness.kind === 'chat' ? harness.folder.path : harness.root;
    const home = homedir();
    const folder = singleLine(
      folderPath === home || folderPath.startsWith(home + '/') ? '~' + folderPath.slice(home.length) : folderPath,
      400,
    );
    const room = Math.max(8, width - visibleWidth(right) - 4);
    // The end of a long path says more than its start.
    const shown = folder.length > room ? '…' + folder.slice(folder.length - room + 1) : folder;
    return [paintThemeRow(theme!, alignEnds(colorText(theme!, 'muted', shown), right, width), width)];
  });
  const rule = component((width) => [colorText(theme!, 'border', '─'.repeat(Math.max(0, width)))]);
  const chatComposer = new VStack([
    { component: rule, basis: 1, shrink: 0 },
    { component: input.view, basis: 0, grow: 1, minSize: 1 },
    { component: rule, basis: 1, shrink: 0 },
  ]);
  const footer = component((width) => [
    truncateToWidth(
      colorText(
        theme!,
        'muted',
        setup
          ? setup.hint
          : paletteInput
            ? '↑↓ choose · Enter run · Esc back'
            : focus === 'editor' || focus === 'terminal'
              ? `${focus} · Ctrl+K commands · Ctrl+L agent${width >= 65 ? ' · /help keys' : ''}`
              : `${focus} · Ctrl+K commands · /help${width >= 65 ? ' keys · Ctrl+L agent' : ''}`,
      ),
      width,
      '',
    ),
  ]);
  const commandMenu = component((width) => {
    const choices = currentCommands();
    if (!choices) return [];
    if (!choices.length) return [colorText(theme!, 'warning', 'No matching commands. Use /help.')];
    const count = Math.max(1, Math.min(10, terminal.rows - 10));
    const start = Math.max(0, commandIndex - count + 1);
    return [
      colorText(theme!, 'muted', `Commands · ${commandIndex + 1}/${choices.length}`),
      ...choices
        .slice(start, start + count)
        .map((command, offset) =>
          colorText(
            theme!,
            start + offset === commandIndex ? 'accent' : 'foreground',
            truncateToWidth(
              `${start + offset === commandIndex ? '> ' : '  '}/${command.name.padEnd(12)} ${command.group}${width >= 65 ? ' · ' + command.description : ''}`,
              width,
              '',
            ),
          ),
        ),
    ];
  });
  const setupBody = component((width) => setup?.body.render(width) ?? []);
  const setupInput = component((width) => setup?.input.render(width) ?? []);
  const conversationFrame = new PaneFrame(transcript, {
    theme: () => theme!,
    title: () => 'Conversation',
    focused: () => focus === 'conversation',
    rows: () => terminal.rows,
    compact: () => terminal.rows < 20,
    onFocus: () => setFocus('conversation'),
  });
  const composerBody = new VStack([
    { component: input.view, basis: 0, grow: 1, minSize: 1 },
    { component: composerActions, basis: 1, shrink: 0, visible: () => terminal.rows >= 20 },
  ]);
  const composerFrame = new PaneFrame(composerBody, {
    theme: () => theme!,
    title: () => 'Agent · Enter send · / commands',
    focused: () => focus === 'input',
    rows: () => terminal.rows,
    compact: () => terminal.rows < 20,
    onFocus: () => setFocus('input'),
  });
  const setupFrame = new PaneFrame(setupBody, {
    theme: () => theme!,
    title: () => setup?.label ?? 'Setup',
    focused: () => !!setup,
    rows: () => terminal.rows,
    compact: () => terminal.rows < 20,
  });
  const paletteField = component((width) => paletteInput?.render(width) ?? []);
  const body = new HStack(
    [
      { component: railView, basis: 27, shrink: 0, visible: (viewport) => requirementsShown(viewport.width) },
      { component: conversationFrame, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    ],
    { gap: 2 },
  );
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
  const approvalRow = component((width) =>
    hostApproval ? wrapTextWithAnsi(displayText(hostApproval.text, 4096), width) : [],
  );
  const layoutRoot = new VStack([
    { component: approvalRow, basis: 'auto', shrink: 0, visible: () => !!hostApproval },
    { component: header, basis: 'auto', shrink: 1, minSize: 1, visible: () => !minimal },
    { component: appActions, basis: 1, shrink: 0, visible: () => !minimal && !setup && !paletteInput },
    {
      component: transcript,
      basis: 0,
      grow: 1,
      shrink: 1,
      minSize: 1,
      visible: () => minimal && !setup && view === 'harness',
    },
    {
      component: body,
      basis: 0,
      grow: 1,
      shrink: 1,
      minSize: 1,
      visible: () => !minimal && !setup && view === 'harness',
    },
    {
      component: workbenchLayout,
      basis: 0,
      grow: 1,
      shrink: 1,
      minSize: 1,
      visible: () => !setup && view === 'workbench',
    },
    { component: setupFrame, basis: 0, grow: 1, shrink: 1, minSize: 1, visible: () => !!setup },
    { component: commandMenu, basis: 'auto', shrink: 0, visible: () => currentCommands() !== undefined },
    {
      component: inputLabel,
      basis: 'auto',
      shrink: 0,
      visible: () =>
        !!paletteInput ||
        (!!setup && terminal.rows < 20) ||
        ((minimal || terminal.rows < 20) && (view === 'harness' || focus === 'input')),
    },
    {
      component: composerFrame,
      basis: terminal.rows >= 24 ? 7 : terminal.rows >= 20 ? 6 : 3,
      shrink: 1,
      minSize: 1,
      visible: () => !minimal && !setup && !paletteInput && (view === 'harness' || focus === 'input'),
    },
    { component: workingRow, basis: 1, shrink: 0, visible: () => minimal && (!!active || externalBusy) },
    {
      component: chatComposer,
      basis: 3,
      shrink: 1,
      minSize: 3,
      visible: () => minimal && !setup && !paletteInput && (view === 'harness' || focus === 'input'),
    },
    { component: paletteField, basis: 1, shrink: 0, visible: () => !!paletteInput },
    { component: setupInput, basis: 1, shrink: 0, visible: () => !!setup },
    { component: setupActions, basis: 1, shrink: 0, visible: () => !!setup },
    { component: noticeRow, basis: 'auto', shrink: 0, visible: () => !!notice },
    { component: status, basis: 1, shrink: 0, visible: () => !minimal },
    { component: footer, basis: 1, shrink: 0, visible: () => !minimal || !!setup || !!paletteInput },
    { component: chatFooter, basis: 1, shrink: 0, visible: () => minimal && !setup && !paletteInput },
  ]);
  const composerLayoutEntry = layoutRoot[LAYOUT_NODE]().entries.find((entry) => entry.component === composerFrame)!;
  const chatComposerEntry = layoutRoot[LAYOUT_NODE]().entries.find((entry) => entry.component === chatComposer)!;
  renderer.setLayoutRoot(layoutRoot);
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
          requestRender();
          resolve(allowed);
        };
        const choices =
          harness.kind === 'chat' ? 'y = once · s = this session · n / Escape = deny' : 'Y = allow · N / Escape = deny';
        hostApproval = {
          text: `Allow host command${request.requester ? ` from ${singleLine(request.requester, 40)}` : ''}? ${request.reasons.join(', ')}\n${request.command}\n${choices}`,
          answer: finish,
        };
        signal?.addEventListener('abort', abort, { once: true });
        conversation.note('Host approval required', hostApproval.text);
        requestRender();
      }),
  );
  const removeInput = renderer.addInputListener((data) => {
    try {
      repairHiddenFocus();
      if (isKeyRelease(data)) return { consume: true };
      if (hostApproval) {
        if (data.toLowerCase() === 'y') hostApproval.answer(true);
        else if (data.toLowerCase() === 's' && harness.kind === 'chat') hostApproval.answer('session');
        else if (data.toLowerCase() === 'n' || matchesKey(data, 'escape')) hostApproval.answer(false);
        else if (matchesKey(data, 'ctrl+q') || matchesKey(data, 'ctrl+c')) {
          hostApproval.answer(false);
          quit();
        }
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+q') || (matchesKey(data, 'ctrl+c') && focus !== 'terminal' && focus !== 'editor')) {
        quit();
        return { consume: true };
      }
      if (discardConfirmed) notice = '';
      discardConfirmed = false;
      if (closing) return { consume: true };
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
      if (matchesKey(data, 'f10')) {
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
      if (focus === 'editor') {
        workbench.handleInput(data);
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+o')) {
        setNotice(conversation.toggleToolOutput() ? 'Tool output expanded. Ctrl+O to collapse.' : '');
        requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+t')) {
        setNotice(conversation.toggleThinking() ? 'Thinking hidden. Ctrl+T to show.' : '');
        requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'escape')) {
        if (currentCommands() !== undefined) {
          dismissedCommands = input.document.text;
          requestRender();
        } else if (focus !== 'input') setFocus('input');
        else if (view === 'workbench') setFocus('editor');
        else cancel();
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
      if (focus === 'input') {
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
    terminal.setTitle(
      harness.kind === 'chat'
        ? `oms · ${singleLine(sessionLabel(harness), 120)}`
        : `oms · ${singleLine(sessionLabel(harness), 120)} / ${singleLine(harness.task.id, 80)}`,
    );
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
            if (titleSaved) terminal.write('\x1b[23;0t');
          } finally {
            setKeybindings(previousKeybindings);
          }
        }
      }
    }
  }
}
