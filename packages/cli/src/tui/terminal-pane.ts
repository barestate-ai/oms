import { VStack, matchesKey, truncateToWidth, type Component, type Focusable } from '@earendil-works/pi-tui';
import { TerminalStoppedError, type HarnessSession, type TaskTerminal } from '@oms/engine';
import { TerminalView } from './terminal-view.ts';
import { colorText, type OmsTheme } from './theme.ts';

import { displayText } from './transcript.ts';
interface TerminalPaneOptions {
  theme: () => OmsTheme;
  columns: () => number;
  rows: () => number;
  requestFocus?: () => void;
  render: () => void;
  notice: (message: string) => void;
}

/** Presentation retains parsed output while the session owns the shell and cleanup. */
export class TerminalPane {
  readonly body = new VStack();
  readonly focus: Component & Focusable;
  private readonly harness: Pick<HarnessSession, 'startTerminal'>;
  private readonly options: TerminalPaneOptions;
  private pane: TerminalView | undefined;
  private terminal: TaskTerminal | undefined;
  private unsubscribe: (() => void) | undefined;
  private pending: Promise<void> | undefined;
  private disposed = false;
  private state = 'not started';
  private focused = false;
  private message = '';

  constructor(harness: Pick<HarnessSession, 'startTerminal'>, options: TerminalPaneOptions) {
    this.harness = harness;
    this.options = options;
    const owner = this;
    this.focus = {
      get focused() {
        return owner.focused;
      },
      set focused(value: boolean) {
        owner.focused = value;
        if (owner.pane) owner.pane.focused = value;
      },
      invalidate() {
        owner.pane?.invalidate();
      },
      render: (width) => this.pane?.render(width) ?? [],
      handleInput: (data) => {
        if (this.terminal) this.pane?.handleInput(data);
        else if (matchesKey(data, 'enter')) void this.start();
      },
    };
    this.layout();
  }

  get running(): boolean {
    return !!this.terminal || !!this.pending;
  }
  /** A shell is up (not just starting): what quitting would stop. */
  get live(): boolean {
    return !!this.terminal;
  }
  get cleanupUncertain(): boolean {
    return this.state === 'cleanup uncertain';
  }
  get hint(): string {
    if (this.cleanupUncertain) return 'Recovery required · /session details';
    if (!this.terminal) return 'Enter starts a shell · Ctrl+P open a file · Ctrl+K commands';
    return this.pane?.scrolledBack
      ? 'Scrolled back · Shift+PgDn returns · F6 leaves the terminal'
      : 'F6 leaves the terminal · Shift+PgUp scrolls back · Ctrl+C interrupts · Ctrl+Q quits';
  }
  /** One word for the panel header: what the shell is doing. */
  get status(): string {
    return this.state;
  }
  resolveMouseFocus(component: Component): Component | undefined {
    return component === this.pane || component === this.pane?.view ? this.focus : undefined;
  }

  /** What shows where the shell will be, until it is running. */
  private emptyState(): Component {
    return {
      invalidate() {},
      render: (width) => {
        const theme = this.options.theme();
        const lines =
          this.state === 'starting' || this.state === 'stopping' || this.state === 'cleaning up'
            ? [`${this.state[0]!.toUpperCase()}${this.state.slice(1)}…`]
            : this.cleanupUncertain
              ? ['The shell is still cleaning up.', '/session shows what is left to recover.']
              : this.state.startsWith('exited') || this.state === 'session deadline reached'
                ? [`The shell ended (${this.state}).`, 'Press Enter to start a new one.']
                : ['No shell is running.', 'Press Enter to open one in the project sandbox.'];
        return ['', ...lines.map((line) => truncateToWidth(`  ${colorText(theme, 'muted', line)}`, width, ''))];
      },
    };
  }

  private layout(): void {
    this.body.clear();
    this.body.addChild(this.pane?.view ?? this.emptyState(), { basis: 0, grow: 1, minSize: 1 });
    this.body.addChild(
      {
        invalidate() {},
        render: (width) => [truncateToWidth(colorText(this.options.theme(), 'warning', this.message), width, '')],
      },
      { basis: 1, shrink: 0, visible: () => !!this.message },
    );
    this.options.render();
  }

  start(): Promise<void> {
    if (this.disposed || this.terminal || this.cleanupUncertain) return Promise.resolve();
    if (this.pending) return this.pending;
    this.message = '';
    this.state = 'starting';
    this.layout();
    const operation = (async () => {
      try {
        const columns = Math.min(500, Math.max(1, this.options.columns()));
        const rows = Math.min(500, Math.max(1, this.options.rows()));
        const terminal = await this.harness.startTerminal(columns, rows);
        if (this.disposed) {
          await terminal.close();
          return;
        }
        this.unsubscribe?.();
        if (this.pane) {
          await this.pane.flush();
          this.pane.dispose();
        }
        this.terminal = terminal;
        const pane = new TerminalView({
          columns,
          rows,
          requestRender: this.options.render,
          requestFocus: this.options.requestFocus,
          input: (data) => {
            try {
              terminal.write(Buffer.from(data, 'utf8'));
            } catch (error) {
              pane.stopInput();
              this.message = `Input stopped: ${displayText(error instanceof Error ? error.message : 'transport failure', 200).replace(/\s+/g, ' ')}`;
              this.layout();
            }
          },
          resize: (width, height) => {
            try {
              terminal.resize(width, height);
            } catch (error) {
              if (!(error instanceof TerminalStoppedError)) throw error;
              pane.stopInput();
              this.state = 'cleaning up';
              this.layout();
            }
          },
        });
        this.pane = pane;
        pane.focused = this.focused;
        this.unsubscribe = terminal.subscribe((data) => pane.write(data));
        this.state = 'running';
        this.layout();
        void terminal.exited
          .then(
            (result) => {
              this.state = result.timedOut ? 'session deadline reached' : `exited ${result.exitCode}`;
              this.message = '/terminal starts a new shell.';
            },
            (error) => {
              this.cleanupFailure(error);
            },
          )
          .finally(() => {
            pane.stopInput();
            if (this.terminal === terminal) this.terminal = undefined;
            if (!this.disposed) this.layout();
          });
      } catch (error) {
        this.state = 'not started';
        this.message = displayText(error instanceof Error ? error.message : 'Unable to start terminal', 300).replace(
          /\s+/g,
          ' ',
        );
        if (!this.disposed) this.layout();
      } finally {
        this.pending = undefined;
      }
    })();
    this.pending = operation;
    return operation;
  }

  async stop(): Promise<void> {
    this.pane?.stopInput();
    await this.pending;
    this.pane?.stopInput();
    if (!this.terminal || this.cleanupUncertain) return;
    this.state = 'stopping';
    this.message = '';
    this.layout();
    try {
      await this.terminal.close();
    } catch (error) {
      this.cleanupFailure(error);
    }
  }

  /** Stop a running shell before its session closes; one still starting is left to the session's own shutdown. */
  async release(): Promise<void> {
    if (!this.pending) await this.stop();
  }

  private cleanupFailure(error: unknown): void {
    this.pane?.stopInput();
    this.state = 'cleanup uncertain';
    this.message = displayText(error instanceof Error ? error.message : 'Terminal cleanup failed', 300).replace(
      /\s+/g,
      ' ',
    );
    if (!this.disposed) this.layout();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.pending;
    this.unsubscribe?.();
    if (this.pane) {
      this.pane.stopInput();
      await this.pane.flush();
      this.pane.dispose();
    }
  }
}
