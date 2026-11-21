import {
  hyperlink,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import { copyToClipboard } from '@earendil-works/pi-coding-agent';
import type { OmsSession } from '@oms/engine';
import { CATALOG, GROUP_LABEL, type ConnectorGroup, type ConnectorSpec } from '../connectors/catalog.ts';
import type { ConnectorId } from '../connectors/config.ts';
import { builtinRows, type BuiltinRow } from '../connectors/detect.ts';
import { accessLabel, statusChips, type ConnectorRow, type Connectors } from '../connectors/runtime.ts';
import type { DeviceInfo } from '../connectors/signin.ts';
import type { SidebarSection } from './explorer.ts';
import type { StatusChip } from './status-row.ts';
import { colorText, type OmsTheme, type ThemeRole } from './theme.ts';
import { displayText } from './transcript.ts';

interface ConnectorsOptions {
  theme(): OmsTheme;
  bodyRows?(): number;
  render(): void;
  close(): void;
}

/** What the row's mark says: ● ready, ◐ needs a sign-in or a step, ○ off or not here, ✕ not working. */
function mark(row: ConnectorRow): { glyph: string; role: ThemeRole } {
  const state = row.detection?.state;
  if (!row.enabled) return { glyph: '○', role: 'muted' };
  if (state === 'ready' || state === undefined) return { glyph: '●', role: state ? 'success' : 'muted' };
  if (state === 'signin' || state === 'missing') return { glyph: '◐', role: 'warning' };
  return { glyph: '✕', role: 'error' };
}

/** The right-hand half of a row: who, and how much the agent may do; or why it is off. */
export function rowSummary(row: ConnectorRow): string {
  const detection = row.detection;
  const account = detection?.account;
  if (row.enabled) {
    if (!detection) return `${accessLabel(row.spec, row.access)} · checking…`;
    if (detection.state === 'ready') return [account, accessLabel(row.spec, row.access)].filter(Boolean).join(' · ');
    return `${detection.detail ?? 'Needs attention.'} Press Enter.`;
  }
  if (!detection) return 'off · checking…';
  if (detection.state === 'ready') return `off · ${account ? account + ', ' : ''}ready to turn on`;
  if (detection.state === 'signin') return 'off · needs a sign-in';
  if (detection.state === 'missing') return 'off · not installed';
  return `off · ${detection.detail ?? 'could not check'}`;
}

/** Who or what the connector runs as, in a sentence: an account, a Docker version, an AWS profile, an RPC. */
function statusSentence(spec: ConnectorSpec, account: string | undefined): string {
  if (spec.id === 'docker') return account ? `Docker ${account} is running.` : 'Docker is running.';
  if (spec.id === 'aws') return account ? `Using ${account}.` : 'Ready.';
  if (spec.id === 'solana-rpc') return account ? `Using ${account}.` : 'Ready.';
  return account ? `Signed in as ${account}.` : 'Signed in.';
}

/** What the selected connector gives the agent, where it stands, and what to do next. Plain sentences. */
export function connectorDetail(row: ConnectorRow, restart: boolean): string[] {
  const { spec, detection } = row;
  const lines = [spec.summary];
  const command = detection?.state === 'missing' ? spec.install : spec.signIn;
  if (!detection) lines.push('Checking this machine…');
  else if (detection.state === 'ready')
    lines.push(
      row.enabled
        ? `${statusSentence(spec, detection.account)} ${spec.levels.length > 1 ? 'A changes how much the agent may do.' : ''}`.trim()
        : 'Ready. Press Space to turn it on.',
    );
  else if (detection.state === 'signin')
    lines.push(
      spec.kind === 'cli' && spec.id !== 'aws'
        ? `${detection.detail ?? 'Not signed in.'} Enter signs in here, or run ${command} in your own terminal.`
        : spec.kind === 'mcp-remote'
          ? `${detection.detail ?? 'Not signed in.'} Enter opens a browser sign-in. OMS keeps only the sign-in, in a private file.`
          : `${detection.detail ?? 'Needs a step.'}${command ? ` Run ${command} in your own terminal.` : ''}`,
    );
  else if (detection.state === 'missing')
    lines.push(`${detection.detail ?? 'Not installed.'}${command ? ` Install it with: ${command}` : ''}`);
  else lines.push(detection.detail ?? 'Could not check.');
  if (command && detection && detection.state !== 'ready') lines.push('Ctrl+X copies the command.');
  if (spec.id === 'aws')
    lines.push('V checks the credentials with AWS. Reads can include settings you consider private.');
  if (spec.id === 'solana-rpc')
    lines.push('Uses HELIUS_API_KEY from your shell when it is set, otherwise the public RPC.');
  if (restart) lines.push('Restart OMS for the agent to reach this one.');
  return lines.filter(Boolean);
}

/** Wide enough for the longest name, with a space after it. */
const LABEL_WIDTH = 18;
const ORDER: ConnectorGroup[] = ['code', 'team', 'cloud', 'solana'];

/** The /connectors screen: every integration in one list, what the agent may do with each, and how to connect it. */
export class ConnectorsPane {
  readonly body: Component;
  readonly input: Component & Focusable;
  readonly label = 'Connectors';
  private readonly harness: OmsSession;
  private readonly connectors: Connectors;
  private readonly options: ConnectorsOptions;
  private selected: ConnectorId = CATALOG[0]!.id;
  private scroll = 0;
  private message = '';
  private builtins: BuiltinRow[] = [];
  private checking = false;
  private flow: { id: ConnectorId; controller: AbortController; info?: DeviceInfo; label: string } | undefined;
  private hits: Array<{ y: number; id: ConnectorId }> = [];
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(harness: OmsSession, connectors: Connectors, options: ConnectorsOptions) {
    this.harness = harness;
    this.connectors = connectors;
    this.options = options;
    this.body = {
      invalidate() {},
      render: (width) => this.renderBody(width),
      handleMouse: (event) => this.handleMouse(event),
    };
    this.input = {
      focused: false,
      invalidate() {},
      render: (width) => [
        truncateToWidth(
          colorText(
            this.options.theme(),
            'muted',
            this.flow ? 'Waiting for you to finish in the browser · Esc cancel' : this.message || ' ',
          ),
          width,
          '',
        ),
      ],
      handleInput: (data) => this.handleInput(data),
    };
    this.unsubscribe = connectors.onChange(() => this.refresh());
    // Opening this screen ends the sign-in tip for good.
    connectors.dismissTip();
    queueMicrotask(() => {
      if (this.disposed) return;
      void builtinRows(harness).then(
        (rows) => {
          this.builtins = rows;
          this.refresh();
        },
        () => {},
      );
      // The first look is kept for the session; R looks again.
      if (!connectors.rows().some((row) => row.detection)) void this.check();
    });
  }

  /** Tailored to what the selected row can do right now. */
  get hint(): string {
    if (this.flow) return `Ctrl+X copy ${this.flow.info?.code ? 'code' : 'link'} · Esc cancel`;
    const row = this.row();
    const parts = ['↑↓ select', 'Space on/off'];
    if (row.enabled && row.spec.levels.length > 1) parts.push('A access');
    if (row.detection?.state === 'signin' && this.canSignInHere(row.spec)) parts.push('Enter sign in');
    parts.push('R recheck');
    if (this.canDisconnect(row)) parts.push('D disconnect');
    parts.push('Esc back');
    return parts.join(' · ');
  }

  private rows(): ConnectorRow[] {
    return this.connectors.rows();
  }
  private row(id = this.selected): ConnectorRow {
    return this.rows().find((row) => row.spec.id === id) ?? this.rows()[0]!;
  }
  private refresh(): void {
    if (!this.disposed) this.options.render();
  }
  private say(message: string): void {
    this.message = message;
    this.refresh();
  }
  private canSignInHere(spec: ConnectorSpec): boolean {
    return spec.kind === 'mcp-remote' || (spec.kind === 'cli' && !!spec.signIn && spec.id !== 'aws');
  }
  private canDisconnect(row: ConnectorRow): boolean {
    return row.enabled || (row.spec.kind === 'mcp-remote' && row.detection?.state === 'ready');
  }

  private async check(): Promise<void> {
    this.checking = true;
    this.say('Checking this machine…');
    try {
      await this.connectors.detect();
      this.say('');
    } catch {
      this.say('The check did not finish. Press R to try again.');
    } finally {
      this.checking = false;
    }
  }

  private toggle(row: ConnectorRow): void {
    if (row.enabled) {
      this.connectors.setEnabled(row.spec.id, false);
      this.say(`${row.spec.label} is off. The agent can no longer use it.`);
      return;
    }
    const state = row.detection?.state;
    if (state && state !== 'ready') {
      this.say(
        `${row.spec.label} is not ready yet. ${state === 'missing' ? 'Install it first.' : 'Sign in first (Enter).'}`,
      );
      return;
    }
    const result = this.connectors.setEnabled(row.spec.id, true);
    this.say(
      result.restart
        ? `${row.spec.label} is on. Restart OMS for the agent to reach it.`
        : result.saved
          ? `${row.spec.label} is on: ${accessLabel(row.spec, this.connectors.access(row.spec.id))}.`
          : `${row.spec.label} is on for this session. connectors.json could not be saved.`,
    );
  }

  private async signIn(row: ConnectorRow): Promise<void> {
    const controller = new AbortController();
    this.flow = { id: row.spec.id, controller, label: row.spec.label };
    this.refresh();
    try {
      const result = await this.connectors.signIn(row.spec.id, {
        signal: controller.signal,
        show: (info) => {
          if (this.flow) this.flow.info = info;
          this.refresh();
        },
      });
      this.flow = undefined;
      if (this.disposed) return;
      await this.connectors.detect();
      if (result.outcome === 'done' && this.row(row.spec.id).detection?.state === 'ready') {
        const on = this.connectors.setEnabled(row.spec.id, true);
        this.say(`Signed in. ${row.spec.label} is on${on.restart ? ' after you restart OMS' : ''}.`);
      } else this.say(result.message);
    } catch {
      this.flow = undefined;
      this.say('Sign-in did not finish. Try again.');
    }
  }

  private async copy(text: string, done: string): Promise<void> {
    try {
      await copyToClipboard(text);
      this.say(done);
    } catch {
      this.say(`Copy is not available here. Run: ${text}`);
    }
  }

  handleInput(data: string): void {
    if (this.disposed || isKeyRelease(data)) return;
    if (this.flow) {
      if (matchesKey(data, 'escape')) this.flow.controller.abort();
      else if (matchesKey(data, 'ctrl+x')) {
        const info = this.flow.info;
        const text = info?.code ?? info?.url;
        if (text) void this.copy(text, info?.code ? 'Code copied.' : 'Link copied.');
      }
      return;
    }
    const rows = this.rows();
    const index = Math.max(
      0,
      rows.findIndex((row) => row.spec.id === this.selected),
    );
    const move = (to: number) => {
      this.selected = rows[Math.max(0, Math.min(rows.length - 1, to))]!.spec.id;
      this.message = '';
      this.refresh();
    };
    const row = rows[index]!;
    if (matchesKey(data, 'escape')) this.options.close();
    else if (matchesKey(data, 'up')) move(index - 1);
    else if (matchesKey(data, 'down')) move(index + 1);
    else if (matchesKey(data, 'home')) move(0);
    else if (matchesKey(data, 'end')) move(rows.length - 1);
    else if (matchesKey(data, 'pageUp')) move(index - 4);
    else if (matchesKey(data, 'pageDown')) move(index + 4);
    else if (data === ' ') this.toggle(row);
    else if (matchesKey(data, 'enter')) {
      const state = row.detection?.state;
      if (state === 'signin' && this.canSignInHere(row.spec)) void this.signIn(row);
      else if (state === 'signin' || state === 'missing') {
        const command = state === 'missing' ? row.spec.install : row.spec.signIn;
        this.say(
          command
            ? `Run this in your own terminal: ${command} (Ctrl+X copies it), then press R.`
            : 'Nothing to do here.',
        );
      } else if (state === 'error') void this.check();
      else this.toggle(row);
    } else if (data.toLowerCase() === 'a') {
      if (!row.enabled) this.say('Turn it on first (Space).');
      else if (row.spec.levels.length < 2)
        this.say(`${row.spec.label} has one level: ${accessLabel(row.spec, row.access)}.`);
      else {
        const next = this.connectors.cycleAccess(row.spec.id);
        this.say(
          `${row.spec.label}: ${accessLabel(row.spec, next.access)}.${next.saved ? '' : ' connectors.json could not be saved.'}`,
        );
      }
    } else if (data.toLowerCase() === 'r') {
      if (!this.checking) void this.check();
    } else if (data.toLowerCase() === 'v' && row.spec.id === 'aws') {
      this.say('Asking AWS who you are…');
      void this.connectors
        .verifyAws()
        .then(() => this.say(this.row('aws').detection?.account ?? 'AWS did not answer.'));
    } else if (data.toLowerCase() === 'd' && this.canDisconnect(row)) {
      if (row.spec.kind === 'mcp-remote') {
        this.connectors.signOut(row.spec.id);
        this.say(`${row.spec.label} is disconnected. Its sign-in was removed from this machine.`);
      } else {
        this.connectors.setEnabled(row.spec.id, false);
        this.say(
          row.spec.signIn
            ? `${row.spec.label} is off in OMS. To sign out of it as well, run ${row.spec.signIn.replace('login', 'logout')} yourself.`
            : `${row.spec.label} is off in OMS.`,
        );
      }
    } else if (matchesKey(data, 'ctrl+x')) {
      const state = row.detection?.state;
      const command = state === 'missing' ? row.spec.install : (row.spec.signIn ?? row.spec.install);
      if (command) void this.copy(command, `Copied: ${command}`);
      else this.say('There is no command to copy for this one.');
    }
  }

  private handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.flow) return undefined;
    if (event.type === 'wheel') {
      this.scroll = Math.max(0, this.scroll + Math.sign(event.wheelDelta ?? 0));
      this.refresh();
      return { handled: true };
    }
    if (event.type !== 'click' || event.button !== 'left')
      return event.type === 'press' ? { handled: true } : undefined;
    const hit = this.hits.find((candidate) => candidate.y === event.y);
    if (!hit) return { handled: true };
    this.selected = hit.id;
    this.message = '';
    // The mark at the start of a row is its switch.
    if (event.x >= 2 && event.x <= 3) this.toggle(this.row(hit.id));
    else this.refresh();
    return { handled: true };
  }

  private renderBody(width: number): string[] {
    const theme = this.options.theme();
    const w = Math.max(1, width);
    const height = Math.max(3, this.options.bodyRows?.() ?? 18);
    const paint = (role: ThemeRole, text: string) => colorText(theme, role, text);
    const wrap = (role: ThemeRole, text: string) => wrapTextWithAnsi(paint(role, displayText(text, 2000)), w);
    this.hits = [];

    if (this.flow) return this.renderSignIn(w, height, wrap);

    const rows = this.rows();
    const selected = this.row();
    const detail = connectorDetail(selected, this.connectors.needsRestart(selected.spec.id)).flatMap((line, i) =>
      wrap(i === 0 ? 'foreground' : 'muted', line),
    );
    // The detail sits at the bottom; the list scrolls above it.
    const detailRows = Math.min(detail.length, Math.max(2, Math.floor(height / 3)));
    const listRows = Math.max(1, height - detailRows - 1);

    const lines: string[] = [];
    const lineOf = new Map<ConnectorId, number>();
    const problems = this.connectors.problems;
    for (const problem of problems) lines.push(...wrap('warning', problem));
    if (listRows >= 8 && !problems.length)
      lines.push(
        ...wrap(
          'muted',
          'Connectors let the agent use your tools. Nothing is shared until you turn one on, and keys stay out of OMS.',
        ),
        '',
      );
    for (const group of ORDER) {
      const inGroup = rows.filter((row) => row.spec.group === group);
      if (!inGroup.length) continue;
      lines.push(paint('muted', GROUP_LABEL[group]));
      for (const row of inGroup) {
        lineOf.set(row.spec.id, lines.length);
        const isSelected = row.spec.id === this.selected;
        const { glyph, role } = mark(row);
        const left = `${isSelected ? '›' : ' '} `;
        const label = row.spec.label.padEnd(LABEL_WIDTH);
        const text =
          paint(isSelected ? 'accent' : 'foreground', left) +
          paint(role, glyph) +
          ' ' +
          paint(isSelected ? 'accent' : 'foreground', label) +
          paint('muted', rowSummary(row));
        lines.push(truncateToWidth(text, w, paint('muted', '…')));
      }
    }
    if (this.builtins.length) {
      lines.push(paint('muted', 'built in'));
      for (const builtin of this.builtins) {
        const { glyph, role } = builtinMark(builtin);
        lines.push(
          truncateToWidth(
            `  ${paint(role, glyph)} ${paint('foreground', builtin.label.padEnd(Math.max(LABEL_WIDTH, builtin.label.length + 2)))}${paint('muted', builtin.detail + (builtin.manage ? ` · ${builtin.manage}` : ''))}`,
            w,
            paint('muted', '…'),
          ),
        );
      }
    }
    // Keep the selected row, and the heading above it, in view.
    const at = lineOf.get(this.selected) ?? 0;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, lines.length - listRows)));
    if (at < this.scroll + 1) this.scroll = Math.max(0, at - 1);
    if (at >= this.scroll + listRows) this.scroll = at - listRows + 1;
    const view = lines.slice(this.scroll, this.scroll + listRows);
    for (const [id, y] of lineOf) {
      const row = y - this.scroll;
      if (row >= 0 && row < listRows) this.hits.push({ y: row, id });
    }
    while (view.length < listRows) view.push('');
    return [...view, paint('border', '─'.repeat(w)), ...detail.slice(0, detailRows)];
  }

  private renderSignIn(width: number, height: number, wrap: (role: ThemeRole, text: string) => string[]): string[] {
    const flow = this.flow!;
    const theme = this.options.theme();
    const lines = [...wrap('foreground', `Sign in to ${flow.label}`), ''];
    const info = flow.info;
    if (info?.url) {
      lines.push(
        hyperlink(
          truncateToWidth(colorText(theme, 'accent', 'Open the sign-in page · Ctrl+X copies the link'), width, ''),
          info.url,
        ),
      );
      lines.push(...wrap('muted', info.url));
    }
    if (info?.code) lines.push('', ...wrap('foreground', `Code: ${info.code}`));
    if (!info) lines.push(...wrap('muted', 'Starting the sign-in…'));
    else
      lines.push(
        '',
        ...wrap(
          'muted',
          'Enter the code only if you just asked for it, and check the address first. Never approve a code someone sent you.',
        ),
      );
    return lines.slice(0, height);
  }

  dispose(): void {
    this.disposed = true;
    this.flow?.controller.abort();
    this.unsubscribe();
  }
}

function builtinMark(row: BuiltinRow): { glyph: string; role: ThemeRole } {
  return row.state === 'ready'
    ? { glyph: '●', role: 'success' }
    : row.state === 'off'
      ? { glyph: '○', role: 'muted' }
      : row.state === 'error'
        ? { glyph: '✕', role: 'error' }
        : { glyph: '◐', role: 'warning' };
}

/** A row for the workbench explorer's "connectors" section: its mark and the theme role to paint it with. */
export interface ExplorerRow {
  id: ConnectorId;
  label: string;
  glyph: string;
  role: ThemeRole;
  /** The same short summary the list shows. */
  detail: string;
}
/** The data for a "connectors" section in the workbench explorer. Opening one is `/connectors`. */
export function explorerSection(connectors: Pick<Connectors, 'rows'> | undefined): {
  title: string;
  rows: ExplorerRow[];
} {
  return {
    title: 'connectors',
    rows: (connectors?.rows() ?? []).map((row) => ({
      id: row.spec.id,
      label: row.spec.label,
      ...mark(row),
      detail: rowSummary(row),
    })),
  };
}

/** The workbench explorer's 'connectors' section: the connectors that are on and how they are, then a row to add more. */
export function sidebarSection(
  connectors: Pick<Connectors, 'rows'> | undefined,
  open: () => void,
): SidebarSection | undefined {
  if (!connectors) return undefined;
  const on = connectors.rows().filter((row) => row.enabled);
  return {
    id: 'connectors',
    title: 'connectors',
    items: [
      ...on.map((row) => {
        const { glyph, role } = mark(row);
        return { id: row.spec.id, label: row.spec.label, detail: glyph, detailRole: role, onActivate: open };
      }),
      { id: 'add', label: on.length ? 'Manage…' : 'Add connectors…', role: 'muted' as const, onActivate: open },
    ],
  };
}

const CHIP_DOT = { ok: 'success', signin: 'warning', error: 'error', unknown: 'info' } as const;
/** The status row's marks for the connectors that are on: `gh ●`, with the dot colored by how it is doing. */
export function connectorStatusChips(connectors: Pick<Connectors, 'chips'> | undefined): StatusChip[] {
  return statusChips(connectors).map((chip) => ({ text: chip.short, dot: CHIP_DOT[chip.state] }));
}
