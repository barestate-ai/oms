import {
  SettingsList,
  truncateToWidth,
  type Component,
  type Focusable,
  type SettingItem,
} from '@earendil-works/pi-tui';
import type { HarnessSettingsSnapshot, OmsSession } from '@oms/engine';
import { hostSandbox } from '@oms/sandbox';
import { glyphsFor } from './glyphs.ts';
import { colorText, type OmsTheme } from './theme.ts';
import { displayText } from './transcript.ts';

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m|\x1b_pi:[^\x07]*\x07/g, '');

interface HarnessSettingsOptions {
  theme: () => OmsTheme;
  rows: () => number;
  bodyRows?: () => number;
  render: () => void;
  close: () => void;
  notice: (message: string) => void;
}

/** What the pane reads of a session: its settings, and for the sandbox row which kind it is and whether YOLO is on. */
export type HarnessSettingsHost = Pick<OmsSession, 'settings'> & {
  kind?: OmsSession['kind'];
  yolo?: { enabled(): boolean };
};

const QUEUE_LABELS = { 'one-at-a-time': 'one at a time', all: 'all at once' } as const;
const queueMode = (label: string): 'one-at-a-time' | 'all' | undefined =>
  label === QUEUE_LABELS.all ? 'all' : label === QUEUE_LABELS['one-at-a-time'] ? 'one-at-a-time' : undefined;

/** 30000 reads `30s`, 300000 `5m`, and 0 (no timeout) `off`. */
const timeoutLabel = (ms: number): string =>
  ms === 0 ? 'off' : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`;
function timeoutMs(label: string): number | undefined {
  if (label === 'off') return 0;
  const match = /^(\d+)([sm])$/.exec(label);
  return match ? Number(match[1]) * (match[2] === 'm' ? 60_000 : 1000) : undefined;
}

/** The upstream settings list, with only live controls and two fixed rows that say what stays off. */
export class HarnessSettingsPane {
  readonly body: Component;
  readonly input: Component & Focusable;
  private readonly harness: HarnessSettingsHost;
  private readonly options: HarnessSettingsOptions;
  private list: SettingsList | undefined;
  private listRows = 0;
  /** The body row the list's search field was drawn on last frame. */
  private listTop = 0;
  private pending = false;
  private disposed = false;
  private message = '';

  constructor(harness: HarnessSettingsHost, options: HarnessSettingsOptions) {
    this.harness = harness;
    this.options = options;
    this.body = {
      invalidate: () => this.list?.invalidate(),
      render: (width) => this.renderBody(width),
      // The list expects a blank row under its search row, which the tidy layout drops: count it back in.
      handleMouse: (event) =>
        this.list?.handleMouse?.({
          ...event,
          y: event.y - this.listTop + (event.y - this.listTop >= 1 ? 1 : 0),
        }),
    };
    this.input = {
      focused: false,
      invalidate() {},
      handleInput: (data) => this.handleInput(data),
      render: (width) => [
        truncateToWidth(colorText(options.theme(), 'muted', this.pending ? 'Saving…' : ''), width, ''),
      ],
    };
  }

  get label(): string {
    return 'Settings';
  }
  get hint(): string {
    return '↑↓ choose · enter change · esc close';
  }

  /** The Sandbox row: what actually confines commands here, never a guess. */
  private sandboxRow(state: HarnessSettingsSnapshot): SettingItem {
    const chat = this.harness.kind !== 'task';
    const backend = state.executionBackend ?? (chat ? 'host' : undefined);
    const sandboxed = backend === 'host' && hostSandbox() === 'seatbelt' && !this.harness.yolo?.enabled();
    const [value, description] =
      backend === 'docker'
        ? ['Docker', 'Fixed for this task']
        : sandboxed
          ? [
              'macOS sandbox',
              chat
                ? 'Commands are confined to this folder · /yolo turns this off'
                : 'Commands are confined to this task',
            ]
          : chat
            ? this.harness.yolo?.enabled()
              ? ['none (YOLO)', 'Commands run without approval · /yolo turns this off']
              : ['none', 'Risky commands ask first · /yolo skips asking']
            : ['none', 'Commands ask first · use --sandbox docker for a new task'];
    return { id: 'sandbox', label: 'Sandbox', currentValue: value, description };
  }

  private items(state: HarnessSettingsSnapshot): SettingItem[] {
    return [
      {
        id: 'thinking',
        label: 'Thinking',
        currentValue: state.supportsThinking ? state.thinkingLevel : 'unavailable',
        description: state.supportsThinking
          ? 'How much the model reasons before answering'
          : "This model doesn't support thinking · /model to pick another",
        ...(state.supportsThinking ? { values: state.availableThinkingLevels } : {}),
      },
      {
        id: 'steering',
        label: 'Messages while busy',
        currentValue: QUEUE_LABELS[state.steeringMode],
        values: Object.values(QUEUE_LABELS),
        description: 'Send what you type while the agent works one at a time, or all at once',
      },
      {
        id: 'followup',
        label: 'Follow-ups',
        currentValue: QUEUE_LABELS[state.followUpMode],
        values: Object.values(QUEUE_LABELS),
        description: 'Send queued follow-ups one at a time, or all at once',
      },
      {
        id: 'http',
        label: 'Request timeout',
        currentValue: timeoutLabel(state.httpIdleTimeoutMs),
        values: [...new Set([30_000, 60_000, 120_000, 300_000, 0, state.httpIdleTimeoutMs].map(timeoutLabel))],
        description: 'How long to wait on a model that goes quiet · off waits as long as it takes',
      },
      {
        id: 'model',
        label: 'Default model',
        currentValue: displayText(state.defaultModel, 200),
        description: 'Change with /model',
      },
      ...(state.executionBackend || this.harness.kind !== 'task' ? [this.sandboxRow(state)] : []),
      {
        id: 'guards',
        label: 'Spend guards',
        currentValue: 'on',
        description: 'No auto-compaction, retries, cache warming or background requests',
      },
      {
        id: 'telemetry',
        label: 'Telemetry',
        currentValue: 'off',
        description: 'No analytics or install telemetry',
      },
    ];
  }

  private ensureList(): SettingsList {
    // The pane's own line, the list's search row, its counter and a two-row description leave the rest for settings.
    const rows = Math.max(
      1,
      Math.min(10, (this.options.bodyRows?.() ?? this.options.rows() - 5) - 5 - (this.message ? 1 : 0)),
    );
    if (!this.list || rows !== this.listRows) {
      const palette = () => this.options.theme();
      this.list = new SettingsList(
        this.items(this.harness.settings.snapshot()),
        rows,
        {
          label: (text, selected) => colorText(palette(), selected ? 'accent' : 'foreground', text),
          value: (text, selected) => colorText(palette(), selected ? 'accent' : 'muted', text),
          description: (text) => colorText(palette(), 'muted', text),
          cursor: `${glyphsFor().pointer} `,
          hint: (text) => colorText(palette(), 'muted', text),
        },
        (id, value) => {
          void this.change(id, value);
        },
        this.options.close,
        { enableSearch: true },
      );
      this.listRows = rows;
    }
    return this.list;
  }

  /**
   * The list draws a search row, blank rows and its own key hint; the panel's border already says the keys. Keep the
   * search row (the filter you type into) with a prompt and a placeholder, and drop the blanks and the second hint.
   */
  private tidy(lines: string[], palette: OmsTheme): string[] {
    if (lines.length < 4) return lines;
    const counter = lines.findIndex((line) => /^\s*\(\d+\/\d+\)\s*$/.test(plain(line)));
    const out = lines.filter(
      (line, index) =>
        !(
          (index === 1 && !plain(line).trim()) ||
          (counter >= 0 && index === counter + 1 && !plain(line).trim()) ||
          index === lines.length - 1 ||
          (index === lines.length - 2 && !plain(line).trim())
        ),
    );
    const search = out[0] ?? '';
    const query = plain(search).replace(/^> /, '').trim();
    out[0] = `${colorText(palette, 'accent', glyphsFor().prompt)} ${search.replace(/^> /, '')}`;
    if (!query) out[0] = out[0].replace(/\s+$/, '') + colorText(palette, 'faint', 'Search settings');
    return out;
  }

  private renderBody(width: number): string[] {
    const palette = this.options.theme();
    this.listTop = this.message ? 2 : 1;
    const lines = [
      ...(this.message ? [colorText(palette, 'warning', this.message)] : []),
      ...this.tidy(this.ensureList().render(Math.max(48, width)), palette),
    ];
    return lines
      .slice(0, Math.max(1, this.options.bodyRows?.() ?? this.options.rows() - 5))
      .map((line) => truncateToWidth(line, width, ''));
  }

  private async change(id: string, value: string): Promise<void> {
    if (this.pending || this.disposed) return;
    this.pending = true;
    this.message = '';
    this.options.render();
    try {
      const controls = this.harness.settings;
      if (id === 'thinking') {
        const level = controls.snapshot().availableThinkingLevels.find((level) => level === value);
        if (level === undefined) throw new Error('Unsupported thinking level');
        await controls.setThinkingLevel(level);
      } else if (id === 'steering' || id === 'followup') {
        const mode = queueMode(value);
        if (mode === undefined) throw new Error('Unsupported queue mode');
        if (id === 'steering') await controls.setSteeringMode(mode);
        else await controls.setFollowUpMode(mode);
      } else if (id === 'http') {
        const ms = timeoutMs(value);
        if (ms === undefined) throw new Error('Unsupported timeout');
        await controls.setHttpIdleTimeoutMs(ms);
      }
      if (!this.disposed) this.options.notice('Saved');
    } catch {
      if (!this.disposed) this.message = "Couldn't save setting";
    } finally {
      this.pending = false;
      if (!this.disposed) {
        for (const item of this.items(this.harness.settings.snapshot()))
          this.list?.updateValue(item.id, item.currentValue);
        this.options.render();
      }
    }
  }

  handleInput(data: string): void {
    if (this.disposed || this.pending) return;
    this.ensureList().handleInput(data);
    this.options.render();
  }

  dispose(): void {
    this.disposed = true;
  }
}
