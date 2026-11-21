import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable } from '@earendil-works/pi-tui';
import { copyToClipboard } from '@earendil-works/pi-coding-agent';
import type { OmsAccountControls } from '@oms/engine';
import { colorText, type OmsTheme } from './theme.ts';
import { displayText } from './transcript.ts';
interface AccountOptions {
  mode: 'login' | 'logout' | 'account';
  theme(): OmsTheme;
  bodyRows?(): number;
  render(): void;
  close(): void;
  /** An optional line shown once after a successful sign-in. */
  tip?(): string | undefined;
}
export class AccountPane {
  readonly body: Component;
  readonly input: Component & Focusable;
  readonly label = 'OMS account';
  get hint(): string {
    return this.device && this.pending
      ? 'ctrl+x copy code · pgup/pgdn scroll · esc cancel'
      : 'pgup/pgdn scroll · esc close';
  }
  private readonly controls: Pick<OmsAccountControls, 'snapshot' | 'login' | 'logout' | 'refresh'>;
  private readonly options: AccountOptions;
  private readonly controller = new AbortController();
  private device?: { verificationUri: string; userCode: string; expiresAt: number };
  private message = '';
  private pending = true;
  private disposed = false;
  private scroll = 0;
  private tip = '';
  constructor(controls: AccountPane['controls'], options: AccountOptions) {
    this.controls = controls;
    this.options = options;
    this.body = { invalidate() {}, render: (width) => this.renderBody(width) };
    this.input = {
      focused: false,
      invalidate() {},
      render: (width) => [truncateToWidth(this.pending ? 'Waiting…' : '', width, '')],
      handleInput: (data) => this.handleInput(data),
    };
    queueMicrotask(() => {
      if (!this.disposed) void this.run();
    });
  }
  private async run(): Promise<void> {
    try {
      if (this.options.mode === 'login') {
        if (this.controls.snapshot().state !== 'signed-out') {
          await this.controls.refresh(this.controller.signal);
          if (this.disposed || this.controller.signal.aborted) return;
          if (this.controls.snapshot().state === 'signed-in') {
            this.message = 'Already signed in · /logout to switch';
            return;
          }
        }
        await this.controls.login(
          {
            signal: this.controller.signal,
            showDevice: (device) => {
              this.device = device;
              if (!this.disposed) this.options.render();
            },
            notice: (message) => {
              this.message = message;
              if (!this.disposed) this.options.render();
            },
          },
          this.controller.signal,
        );
        if (this.controls.snapshot().state === 'signed-in') this.tip = this.options.tip?.() ?? '';
      } else if (this.options.mode === 'logout') {
        const result = await this.controls.logout(this.controller.signal);
        this.message = result.serverRevoked
          ? 'Signed out'
          : "Signed out here · couldn't reach the server; revoke this device from your account page";
      } else await this.controls.refresh(this.controller.signal);
    } catch {
      if (!this.disposed) this.message = "Couldn't reach OMS · check your connection and /login again";
    } finally {
      this.pending = false;
      if (!this.disposed) this.options.render();
    }
  }
  private renderBody(width: number): string[] {
    const snapshot = this.controls.snapshot();
    const status =
      snapshot.state === 'signed-in'
        ? `Signed in${snapshot.email ? ` as ${displayText(snapshot.email, 320)}` : ''}`
        : snapshot.state === 'unavailable'
          ? 'Sign-in unavailable'
          : this.pending && this.options.mode === 'login'
            ? 'Signing in…'
            : 'Not signed in';
    const lines = [status, displayText(snapshot.origin, 2048)];
    if (this.device && this.pending)
      lines.push(
        `Open: ${this.device.verificationUri}`,
        `Device code: ${this.device.userCode}`,
        `Expires: ${new Date(this.device.expiresAt).toLocaleTimeString()}`,
        'Approve only a code you just requested',
      );
    if (this.message) lines.push(displayText(this.message, 2048));
    if (snapshot.message) lines.push(displayText(snapshot.message, 2048));
    if (this.tip) lines.push(this.tip);
    lines.push('OMS sign-in enables hosted web search only · model keys stay in /connect');
    const rendered = lines.flatMap((line) =>
      wrapTextWithAnsi(colorText(this.options.theme(), 'foreground', line), Math.max(1, width)),
    );
    const height = Math.max(1, this.options.bodyRows?.() ?? 24);
    this.scroll = Math.min(this.scroll, Math.max(0, rendered.length - height));
    return rendered.slice(this.scroll, this.scroll + height);
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, 'escape') || (!this.pending && matchesKey(data, 'enter'))) this.options.close();
    else if (matchesKey(data, 'ctrl+x') && this.device) {
      void copyToClipboard(this.device.userCode)
        .then(
          () => {
            this.message = 'Code copied';
          },
          () => {
            this.message = "Couldn't copy · type the code shown";
          },
        )
        .finally(() => {
          if (!this.disposed) this.options.render();
        });
    } else if (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) {
      this.scroll = Math.max(
        0,
        this.scroll + (matchesKey(data, 'pageUp') ? -1 : 1) * Math.max(1, this.options.bodyRows?.() ?? 24),
      );
      this.options.render();
    }
  }
  dispose(): void {
    this.disposed = true;
    this.controller.abort();
    this.device = undefined;
  }
}
