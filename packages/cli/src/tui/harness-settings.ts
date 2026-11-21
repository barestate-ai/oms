import {
  SettingsList,
  truncateToWidth,
  type Component,
  type Focusable,
  type SettingItem,
} from '@earendil-works/pi-tui';
import type { HarnessSession, HarnessSettingsSnapshot } from '@oms/engine';
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

/** The upstream settings list, with only live harness controls and explicit noninteractive policy rows. */
export class HarnessSettingsPane {
  readonly body: Component;
  readonly input: Component & Focusable;
  private readonly harness: Pick<HarnessSession, 'settings'>;
  private readonly options: HarnessSettingsOptions;
  private list: SettingsList | undefined;
  private listRows = 0;
  /** The body row the list's search field was drawn on last frame. */
  private listTop = 0;
  private pending = false;
  private disposed = false;
  private message = '';

  constructor(harness: Pick<HarnessSession, 'settings'>, options: HarnessSettingsOptions) {
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
        truncateToWidth(
          colorText(options.theme(), 'muted', this.pending ? 'Saving preference…' : 'Type to filter'),
          width,
          '',
        ),
      ],
    };
  }

  get label(): string {
    return 'Settings';
  }
  get hint(): string {
    return '↑↓ choose · enter change · type to filter · esc close';
  }

  private items(state: HarnessSettingsSnapshot): SettingItem[] {
    return [
      {
        id: 'thinking',
        label: 'Thinking',
        currentValue: state.supportsThinking ? state.thinkingLevel : 'unavailable',
        description: state.supportsThinking
          ? 'Applies now and saves the default plus this model’s thinking preference.'
          : 'The current model does not support thinking. Choose a reasoning model with /model.',
        ...(state.supportsThinking ? { values: state.availableThinkingLevels } : {}),
      },
      {
        id: 'steering',
        label: 'Steering queue',
        currentValue: state.steeringMode,
        values: ['one-at-a-time', 'all'],
        description: 'How queued steering messages reach the live agent. Existing messages are retained.',
      },
      {
        id: 'followup',
        label: 'Follow-up queue',
        currentValue: state.followUpMode,
        values: ['one-at-a-time', 'all'],
        description:
          'How queued follow-ups reach the live agent after its current work. Existing messages are retained.',
      },
      {
        id: 'http',
        label: 'HTTP idle (ms)',
        currentValue: String(state.httpIdleTimeoutMs),
        values: [...new Set(['30000', '60000', '120000', '300000', '0', String(state.httpIdleTimeoutMs)])],
        description:
          'Applies to the next provider request. 0 disables the idle timeout; the task wall-clock budget still applies.',
      },
      {
        id: 'model',
        label: 'Default model',
        currentValue: displayText(state.defaultModel, 200),
        description: 'Use /model to choose and save a model from the configured provider catalog.',
      },
      {
        id: 'compaction',
        label: 'Compaction',
        currentValue: 'off · policy',
        description:
          'Budget guard: automatic summaries and branch summaries would create additional unmetered model calls.',
      },
      {
        id: 'warming',
        label: 'Cache warming',
        currentValue: 'off · policy',
        description: 'Budget guard: no background or speculative model requests.',
      },
      {
        id: 'retry',
        label: 'Retries',
        currentValue: 'off · policy',
        description: 'Budget guard: provider and agent retries cannot create hidden extra requests.',
      },
      {
        id: 'transport',
        label: 'Transport',
        currentValue: 'SSE · policy',
        description:
          'Only the priced, metered streaming path is enabled; websocket and cached transports are constrained.',
      },
      {
        id: 'resources',
        label: 'Host resources',
        currentValue: 'off · policy',
        description:
          'No repository/global executable discovery, packages, extensions, skills or prompts. Project settings are never trusted.',
      },
      {
        id: 'tools',
        label: 'Execution backend',
        currentValue: state.executionBackend ?? 'docker',
        description:
          state.executionBackend === 'host'
            ? 'No sandbox. Commands need approval; network is unrestricted. Set OMS_SANDBOX=docker or launch with --sandbox docker for a new task.'
            : 'Strict Docker sandbox. Set OMS_SANDBOX=host or launch with --sandbox host for a new task. Backend identity is pinned per task.',
      },
      {
        id: 'telemetry',
        label: 'Telemetry',
        currentValue: 'off · policy',
        description:
          'Analytics and install telemetry are disabled. Credentials and device identity are never shown in settings.',
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
      colorText(palette, 'muted', 'Harness settings are private and saved on this device.'),
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
        if (value !== 'all' && value !== 'one-at-a-time') throw new Error('Unsupported queue mode');
        if (id === 'steering') await controls.setSteeringMode(value);
        else await controls.setFollowUpMode(value);
      } else if (id === 'http') await controls.setHttpIdleTimeoutMs(Number(value));
      if (!this.disposed) this.options.notice('Harness preference saved. No model request was sent.');
    } catch {
      if (!this.disposed)
        this.message = 'Preference could not be saved. Check private settings; the current session may have changed.';
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
