import {
  CURSOR_MARKER,
  Input,
  SelectList,
  decodeKittyPrintable,
  hyperlink,
  matchesKey,
  renderFakeCursor,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui';
import { copyToClipboard } from '@earendil-works/pi-coding-agent';
import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import type { OmsSession, ProviderModelChoice } from '@oms/engine';
import { glyphsFor } from './glyphs.ts';
import { colorText, getTheme, THEME_IDS, type OmsTheme } from './theme.ts';
import { displayText } from './transcript.ts';

type SetupMode = 'model' | 'connect' | 'theme';
type SetupHarness = Pick<
  OmsSession,
  'listModels' | 'listProviders' | 'selectModel' | 'loginProvider' | 'importEnvironment'
>;
interface Choice {
  value: string;
  label: string;
  description: string;
  /** Searchable but not shown: the provider id. */
  keywords?: string;
}
interface SetupOptions {
  mode: SetupMode;
  query?: string;
  theme: () => OmsTheme;
  rows: () => number;
  bodyRows?: () => number;
  render: () => void;
  close: () => void;
  notice: (message: string) => void;
  /** A warning that stays until dismissed (credentials may be stored); defaults to `notice`. */
  warn?: (message: string) => void;
  selectTheme: (id: string) => boolean;
  /** The theme picker shows a theme as the cursor reaches it; closing without choosing restores the chosen one. */
  previewTheme?: (id: string) => void;
  copyAuthUrl?: (url: string) => Promise<void>;
}
const line = (value: string) => displayText(value, 400).replace(/\s+/g, ' ').trim();

/** Operator-only setup. No auth entry uses the task prompt, transcript, or undo history. */
export class SetupPane {
  readonly body: Component;
  readonly input: Component & Focusable;
  private readonly harness: SetupHarness;
  private readonly options: SetupOptions;
  private readonly search = new Input({ prompt: 'Filter: ' });
  private readonly controller = new AbortController();
  private stage: 'providers' | 'models' | 'auth' | 'theme';
  private choices: Choice[] = [];
  private shortlistProviders = false;
  private expandedProviders = false;
  private readonly models = new Map<string, ProviderModelChoice>();
  private list: SelectList | undefined;
  private listItems: Choice[] = [];
  private selected = '';
  private listRows = 0;
  private filter = '';
  private provider: string | undefined;
  private method: 'api_key' | 'oauth' | undefined;
  private key = '';
  private replaceKey = false;
  private pending = false;
  private disposed = false;
  private message = '';
  private note = '';
  private authLines: string[] = [];
  private authUrl: string | undefined;
  private authScroll = 0;
  private authDetailRows = 1;
  private prompt: AuthPrompt | undefined;
  private answer: ((value: string) => void) | undefined;

  constructor(harness: SetupHarness, options: SetupOptions) {
    this.harness = harness;
    this.options = options;
    this.stage = options.mode === 'theme' ? 'theme' : 'providers';
    this.search.setValue(line(options.query ?? '').slice(0, 256));
    if (this.stage === 'theme') {
      this.choices = THEME_IDS.map((id) => ({
        value: id,
        label: getTheme(id)!.name,
        description: id === options.theme().id ? 'current' : '',
      }));
      this.selected = options.theme().id;
    } else {
      this.buildTopLevel();
    }
    this.body = {
      invalidate() {},
      render: (width) => this.renderBody(width),
      // A click or the wheel on the list, with y counted from the list's first row.
      handleMouse: (event) =>
        this.listTop < 0 || !this.list ? undefined : this.list.handleMouse?.({ ...event, y: event.y - this.listTop }),
    };
    this.input = {
      focused: false,
      invalidate() {},
      render: (width) => {
        if (this.stage === 'auth' && this.prompt?.type !== 'select') {
          const value = this.prompt?.type === 'text' ? displayText(this.key, 16_384) : this.key ? '•••••••• ' : '';
          return [
            truncateToWidth(
              `${this.prompt?.type === 'text' ? 'Text' : this.prompt?.type === 'secret' ? 'Secret' : 'Code'}: ` +
                value +
                (this.input.focused && this.prompt ? CURSOR_MARKER + renderFakeCursor(' ') : ''),
              width,
              '',
            ),
          ];
        }
        this.search.focused = this.input.focused;
        return this.search.render(width);
      },
      handleInput: (data) => this.handleInput(data),
    };
    if (options.mode === 'connect' && /^import(?:\s|$)/.test(options.query ?? '')) {
      const path = (options.query ?? '').slice(6).trim();
      queueMicrotask(() => {
        if (!this.disposed) void this.importEnvironment(path);
      });
    }
  }

  get label(): string {
    if (this.stage === 'auth' || this.stage === 'models') return line(this.provider ?? '');
    return this.options.mode === 'model' ? 'Model' : this.options.mode === 'theme' ? 'Theme' : 'Sign in';
  }
  get hint(): string {
    if (this.stage === 'auth') {
      if (this.prompt?.type === 'select') return '↑↓ choose · enter select · ctrl+x copy link · esc cancel';
      return this.prompt
        ? 'enter submit · ctrl+x copy link · pgup/pgdn scroll · esc cancel'
        : 'ctrl+x copy link · pgup/pgdn scroll · esc cancel';
    }
    return this.stage === 'theme' ? '↑↓ preview · enter choose · esc cancel' : '↑↓ choose · enter select · esc back';
  }

  private buildTopLevel(): void {
    this.choices = [];
    this.models.clear();
    this.selected = '';
    this.list = undefined;
    const providers = this.harness.listProviders();
    // One catalog read: each listModels() rebuilds the whole catalog.
    const catalog = this.harness.listModels();
    this.shortlistProviders = this.options.mode === 'connect' || !providers.some((provider) => provider.configured);
    if (this.options.mode === 'model') {
      for (const provider of providers.filter((provider) => provider.configured)) {
        if (!catalog.some((model) => model.provider === provider.id)) continue;
        this.choices.push({
          value: JSON.stringify([provider.id, 'configured']),
          label:
            provider.id === 'openai-codex'
              ? 'Codex models'
              : provider.id === 'claude-code'
                ? 'Claude Code'
                : provider.id === 'xai'
                  ? 'Grok models'
                  : `${line(provider.name)} models`,
          description: provider.id === 'claude-code' ? 'Sonnet, Opus or Haiku' : '',
          keywords: provider.id,
        });
      }
    }
    const rows: { rank: number; choice: Choice }[] = [];
    for (const provider of providers) {
      if (
        this.options.mode === 'model' &&
        provider.configured &&
        catalog.some((model) => model.provider === provider.id)
      )
        continue;
      const connected = provider.configured ? 'Connected' : '';
      if (provider.apiKey)
        rows.push({
          rank: 4,
          choice: {
            value: JSON.stringify([provider.id, 'api_key']),
            label:
              provider.id === 'xai' ? 'Grok (xAI API key)' : line(provider.apiKeyLabel ?? `${provider.name} API key`),
            description: connected,
            keywords: provider.id,
          },
        });
      // Anthropic's own plans cannot be used here; the row existed only to say so.
      if (provider.oauth) {
        const codex = provider.id === 'openai-codex';
        const claude = provider.id === 'claude-code';
        const grok = provider.id === 'xai';
        rows.push({
          rank: codex ? 0 : claude ? 1 : grok ? 2 : 3,
          choice: {
            value: JSON.stringify([provider.id, 'oauth']),
            label: codex
              ? 'Codex (ChatGPT subscription)'
              : claude
                ? 'Claude Code (Claude subscription)'
                : grok
                  ? 'Grok (SuperGrok or X Premium)'
                  : line(provider.oauthName ?? provider.oauthLabel ?? `${provider.name} subscription`),
            description: connected,
            keywords: provider.id,
          },
        });
      }
      if (!provider.apiKey && !provider.oauth && !provider.oauthUnavailable && provider.configured) {
        rows.push({
          rank: 4,
          choice: {
            value: JSON.stringify([provider.id, 'configured']),
            label: line(provider.name),
            description: 'Connected',
            keywords: provider.id,
          },
        });
      }
    }
    rows.sort((a, b) => a.rank - b.rank || (a.rank >= 3 ? a.choice.label.localeCompare(b.choice.label) : 0));
    this.choices.push(...rows.map((row) => row.choice));
  }

  private setChoices(choices: Choice[]): void {
    this.choices = choices;
    this.selected = '';
    this.search.setValue('');
    this.list = undefined;
  }

  private showModels(provider: string): void {
    this.stage = 'models';
    this.provider = provider;
    this.models.clear();
    this.setChoices(
      this.harness
        .listModels()
        .filter((model) => model.provider === provider)
        .map((model) => {
          const value = JSON.stringify([model.provider, model.id]);
          this.models.set(value, model);
          return {
            value,
            label: line(`${model.provider}/${model.id}`),
            description: line(model.selectable === false ? `Unavailable · ${model.detail ?? model.name}` : model.name),
          };
        }),
    );
    this.message = '';
    this.note = '';
  }

  /** The body row the list's first item was drawn on last frame; -1 when no list is on screen. */
  private listTop = -1;

  private bodyHeight(): number {
    return Math.max(1, this.options.bodyRows?.() ?? this.options.rows() - 5);
  }

  private ensureList(): SelectList {
    const query = this.search.getValue().toLowerCase().trim();
    const rows = Math.max(1, Math.min(8, this.bodyHeight() - 4));
    if (!this.list || query !== this.filter || rows !== this.listRows) {
      const choices =
        this.stage === 'providers' &&
        this.shortlistProviders &&
        !this.expandedProviders &&
        !query &&
        this.choices.length > 3
          ? [
              ...this.choices.slice(0, 3),
              { value: 'other-providers', label: `Other providers (${this.choices.length - 3} more)`, description: '' },
            ]
          : this.choices;
      const items = choices
        .filter((choice) =>
          `${choice.label} ${choice.description} ${choice.keywords ?? ''}`.toLowerCase().includes(query),
        )
        .sort(
          (left, right) =>
            Number(right.label.toLowerCase().includes(query)) - Number(left.label.toLowerCase().includes(query)),
        );
      this.listItems = items;
      const palette = () => this.options.theme();
      this.list = new SelectList(items, rows, {
        selectedPrefix: (text) => colorText(palette(), 'accentFill', text.replace('→', glyphsFor().pointer)),
        selectedText: (text) => colorText(palette(), 'accent', text.replace(/^→/, glyphsFor().pointer)),
        description: (text) => colorText(palette(), 'muted', text),
        scrollInfo: (text) => colorText(palette(), 'muted', text),
        noMatch: () => colorText(palette(), 'warning', 'No matches · Ctrl+U clear · Esc back'),
      });
      this.list.setSelectedIndex(
        Math.max(
          0,
          items.findIndex((item) => item.value === this.selected),
        ),
      );
      this.list.onSelectionChange = (item) => {
        this.selected = item.value;
        if (this.stage === 'theme') this.options.previewTheme?.(item.value);
      };
      this.list.onSelect = (item) => {
        void this.choose(item.value);
      };
      this.filter = query;
      this.listRows = rows;
    }
    return this.list;
  }

  private renderBody(width: number): string[] {
    this.listTop = -1;
    const palette = this.options.theme();
    const title =
      this.stage === 'theme'
        ? 'Choose a theme'
        : this.stage === 'providers'
          ? this.options.mode === 'model'
            ? 'Choose a provider'
            : 'Choose how to sign in'
          : this.stage === 'models'
            ? 'Choose a model'
            : `Connect ${line(this.provider ?? '')}`;
    const lines = [colorText(palette, 'accent', truncateToWidth(title, width, ''))];
    if (this.stage === 'providers' && this.options.mode === 'model' && this.shortlistProviders)
      lines.push(
        ...wrapTextWithAnsi(colorText(palette, 'muted', 'No provider is connected yet. Choose one to sign in.'), width),
      );
    // The warning about keys is always shown where a key might be pasted; the filter tip goes first when rows run short.
    const connecting = this.stage === 'providers' && this.options.mode === 'connect';
    if (this.stage === 'providers' && !(connecting && this.bodyHeight() < 12))
      lines.push(...wrapTextWithAnsi(colorText(palette, 'muted', 'Type a provider name to filter.'), width));
    if (connecting)
      lines.push(
        ...wrapTextWithAnsi(colorText(palette, 'faint', 'Never paste keys or sign-in codes into chat.'), width),
      );
    if (this.note) lines.push(...wrapTextWithAnsi(colorText(palette, 'muted', line(this.note)), Math.max(1, width)));
    if (this.stage === 'auth' && this.authUrl) {
      lines.push(
        colorText(
          palette,
          'accent',
          hyperlink(truncateToWidth('Open this link to sign in · ctrl+x copy', width, ''), this.authUrl),
        ),
      );
    }
    if (this.message) lines.push(...wrapTextWithAnsi(colorText(palette, 'warning', this.message), Math.max(1, width)));
    if (this.provider === 'claude-code') {
      if (this.stage === 'auth')
        lines.push(
          ...wrapTextWithAnsi(
            'Needs the Claude Code CLI · run `claude auth login` in another terminal, then reopen /connect',
            Math.max(1, width),
          ),
        );
    }
    if (this.stage === 'auth') {
      lines.push(
        ...[
          ...(this.authUrl ? [hyperlink(this.authUrl, this.authUrl)] : []),
          ...this.authLines,
          ...(this.prompt && this.prompt.type !== 'select' ? [line(this.prompt.message)] : []),
        ].flatMap((text) => wrapTextWithAnsi(colorText(palette, 'muted', text), Math.max(1, width))),
      );
      if (this.prompt?.type === 'select') {
        this.listTop = 2;
        const fixed = [
          lines[0]!,
          colorText(palette, 'accent', truncateToWidth(line(this.prompt.message), width, '')),
          ...this.ensureList().render(width),
        ];
        const details = lines.slice(1);
        this.authDetailRows = Math.max(0, this.bodyHeight() - fixed.length);
        this.authScroll = Math.min(this.authScroll, Math.max(0, details.length - this.authDetailRows));
        return [...fixed, ...details.slice(this.authScroll, this.authScroll + this.authDetailRows)];
      }
    } else {
      const list = this.ensureList();
      const highlighted = list.getSelectedItem();
      const highlightedModel = highlighted ? this.models.get(highlighted.value) : undefined;
      if (highlightedModel?.detail)
        lines.push(
          ...wrapTextWithAnsi(
            colorText(
              palette,
              highlightedModel.selectable === false ? 'warning' : 'muted',
              line(highlightedModel.detail),
            ),
            Math.max(1, width),
          ),
        );
      if (this.stage === 'models') {
        const selected = list.getSelectedItem();
        const model = selected ? this.models.get(selected.value) : undefined;
        if (model)
          lines.push(
            ...wrapTextWithAnsi(
              colorText(palette, 'accent', `Selected: ${displayText(`${model.provider}/${model.id}`, 16_384)}`),
              Math.max(1, width),
            ),
          );
      }
      this.listTop = lines.length;
      lines.push(...list.render(width));
    }
    if (this.stage === 'auth' && this.prompt?.type !== 'select') {
      const height = this.bodyHeight();
      this.authDetailRows = height;
      this.authScroll = Math.min(this.authScroll, Math.max(0, lines.length - height));
      return lines.slice(this.authScroll, this.authScroll + height);
    }
    return lines;
  }

  private authPrompt(prompt: AuthPrompt): Promise<string> {
    const signal = prompt.signal ? AbortSignal.any([this.controller.signal, prompt.signal]) : this.controller.signal;
    signal.throwIfAborted();
    this.prompt = prompt;
    this.authScroll = 0;
    this.key = '';
    this.replaceKey = false;
    if (prompt.type === 'select')
      this.setChoices(
        prompt.options.map((option) => ({
          value: option.id,
          label: line(option.label),
          description: line(option.description ?? ''),
        })),
      );
    // ES2023 baseline does not include Promise.withResolvers.
    return new Promise<string>((resolve, reject) => {
      const clear = () => {
        signal.removeEventListener('abort', abort);
        this.prompt = undefined;
        this.answer = undefined;
        this.key = '';
        if (!this.disposed) this.options.render();
      };
      const abort = () => {
        clear();
        reject(new Error('Setup cancelled'));
      };
      this.answer = (value) => {
        clear();
        resolve(value);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else this.options.render();
    });
  }

  private setAuthUrl(url: string): void {
    // Keep the SDK URL byte-for-byte. Never truncate, decode or reconstruct OAuth parameters.
    // Reject unsafe terminal-link targets instead of silently changing the sign-in request.
    if (/[\s\p{Cc}\p{Cf}]/u.test(url) || !['https:', 'http:'].includes(new URL(url).protocol)) {
      throw new Error('Invalid provider sign-in URL');
    }
    this.authUrl = url;
  }

  private async copyAuthUrl(): Promise<void> {
    if (!this.authUrl) return;
    try {
      await (this.options.copyAuthUrl ?? copyToClipboard)(this.authUrl);
      if (!this.disposed) this.message = 'Link copied';
    } catch {
      if (!this.disposed) this.message = "Couldn't copy · select the link instead";
    }
    if (!this.disposed) this.options.render();
  }

  private notify(event: AuthEvent): void {
    if (this.disposed) return;
    if (event.type === 'auth_url') {
      this.setAuthUrl(event.url);
      this.authLines = [line(event.instructions ?? '')].filter(Boolean);
    } else if (event.type === 'device_code') {
      this.setAuthUrl(event.verificationUri);
      this.authLines = [`Device code: ${line(event.userCode)}`];
    } else if (event.type === 'info') {
      this.authLines = [
        line(event.message),
        ...(event.links ?? []).map((link) => {
          if (/[\s\p{Cc}\p{Cf}]/u.test(link.url) || !['http:', 'https:'].includes(new URL(link.url).protocol)) {
            throw new Error('Invalid provider information URL');
          }
          return hyperlink(link.label ? line(link.label) : link.url, link.url);
        }),
      ];
    }
    // Progress must not erase the URL/code that the operator still needs.
    this.options.render();
  }

  private async choose(value: string): Promise<void> {
    if (this.disposed) return;
    if (this.stage === 'auth') {
      if (this.prompt?.type === 'select') this.answer?.(value);
      return;
    }
    if (this.pending) return;
    if (this.stage === 'theme') {
      if (this.options.selectTheme(value)) this.options.close();
      return;
    }
    if (this.stage === 'providers' && !this.models.has(value)) {
      if (value === 'other-providers') {
        this.expandedProviders = true;
        this.setChoices(this.choices);
        this.options.render();
        return;
      }
      const [provider, method] = JSON.parse(value) as [string, 'api_key' | 'oauth' | 'configured'];
      const entry = this.harness.listProviders().find((item) => item.id === provider);
      if (!entry) return;
      if (method === 'oauth' && entry.oauthUnavailable) {
        this.message = line(entry.oauthUnavailable);
        this.options.render();
        return;
      }
      if ((this.options.mode === 'model' && entry.configured) || method === 'configured') {
        this.showModels(provider);
        this.options.render();
        return;
      }
      await this.login(provider, method);
      return;
    }
    // Re-read readiness when Enter is pressed; credentials and remaining limits may have changed.
    const previous = this.models.get(value);
    const model =
      previous &&
      this.harness.listModels().find((model) => model.provider === previous.provider && model.id === previous.id);
    if (!model) return;
    if (model.selectable === false) {
      this.message = line(model.detail ?? 'Model needs provider setup');
      this.options.render();
      return;
    }
    this.pending = true;
    this.options.render();
    try {
      await this.harness.selectModel(model.provider, model.id);
      if (!this.disposed) {
        this.options.notice(
          model.provider === 'claude-code'
            ? `Model: ${line(model.provider)}/${line(model.id)} (native Claude chat)`
            : `Model: ${line(model.provider)}/${line(model.id)}`,
        );
        this.options.close();
      }
    } catch {
      const current = this.harness
        .listModels()
        .find((item) => item.provider === model.provider && item.id === model.id);
      this.message =
        current?.selectable === false && current.detail
          ? line(current.detail)
          : "Couldn't switch model · check /connect";
    } finally {
      this.pending = false;
      if (!this.disposed) this.options.render();
    }
  }

  private async importEnvironment(path: string): Promise<void> {
    this.stage = 'auth';
    this.provider = 'environment import';
    this.method = 'api_key';
    this.pending = true;
    this.search.setValue('');
    try {
      if (!path) path = await this.authPrompt({ type: 'text', message: 'Private environment file path (not a key)' });
      if (!path.trim()) throw new Error('A file path is required');
      const result = await this.harness.importEnvironment(path, {
        signal: this.controller.signal,
        prompt: (prompt) => this.authPrompt(prompt),
        notify: (event) => this.notify(event),
      });
      if (!this.disposed) {
        const uncertain = result.outcomes.some((item) => item.status === 'may_have_saved');
        (uncertain ? (this.options.warn ?? this.options.notice) : this.options.notice)(
          result.outcomes
            .map(
              (item) =>
                `${line(item.name)}: ${item.status === 'may_have_saved' ? 'may have been saved; check configuration before retrying' : item.status}`,
            )
            .join(' · ') || 'No provider keys found in that file',
        );
        this.options.close();
      }
    } catch {
      if (!this.disposed) this.message = 'Import failed · file must be yours, mode 0600, with KEY=value lines';
    } finally {
      this.pending = false;
      this.key = '';
      if (!this.disposed) this.options.render();
    }
  }

  private async login(provider: string, method: 'api_key' | 'oauth'): Promise<void> {
    this.note = '';
    this.stage = 'auth';
    this.provider = provider;
    this.method = method;
    this.pending = true;
    this.message = '';
    this.authLines = [];
    this.authUrl = undefined;
    this.options.render();
    const interaction: AuthInteraction = {
      signal: this.controller.signal,
      prompt: (prompt) => this.authPrompt(prompt),
      notify: (event) => this.notify(event),
    };
    try {
      await this.harness.loginProvider(provider, method, interaction);
      if (!this.disposed && !this.controller.signal.aborted) {
        this.authLines = [];
        this.authUrl = undefined;
        this.showModels(provider);
        this.options.notice(
          provider === 'claude-code'
            ? 'Claude Code is ready · pick a model'
            : `Connected to ${line(this.harness.listProviders().find((item) => item.id === provider)?.name ?? provider)} · pick a model`,
        );
      }
    } catch {
      if (!this.disposed && !this.controller.signal.aborted) {
        this.message =
          provider === 'claude-code'
            ? 'Claude Code is not ready · run `claude auth login`, then /connect'
            : 'Setup incomplete · credentials may already be saved; check your configuration before trying again';
      }
    } finally {
      this.pending = false;
      this.key = '';
      if (!this.disposed) this.options.render();
    }
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, 'escape') || (this.stage !== 'auth' && matchesKey(data, 'left') && !this.search.getValue())) {
      if (this.stage === 'providers' && this.expandedProviders) {
        this.expandedProviders = false;
        this.setChoices(this.choices);
        this.options.render();
        return;
      }
      this.controller.abort();
      this.key = '';
      this.options.close();
      return;
    }
    if (this.stage === 'auth' && matchesKey(data, 'ctrl+x')) {
      void this.copyAuthUrl();
      return;
    }
    if (this.stage === 'auth' && (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown'))) {
      this.authScroll = Math.max(
        0,
        this.authScroll + (matchesKey(data, 'pageUp') ? -1 : 1) * Math.max(1, this.authDetailRows),
      );
      this.options.render();
      return;
    }
    if (this.pending && !this.prompt) return;
    if (this.stage === 'auth' && this.prompt?.type !== 'select') {
      if (!this.prompt) return;
      if (matchesKey(data, 'enter')) {
        if (this.key || this.prompt.type === 'text') this.answer?.(this.key);
        return;
      }
      if (matchesKey(data, 'ctrl+u')) {
        this.key = '';
        this.replaceKey = false;
      } else if (matchesKey(data, 'ctrl+a')) this.replaceKey = true;
      else if (matchesKey(data, 'backspace') || matchesKey(data, 'delete')) {
        this.key = this.replaceKey ? '' : this.key.slice(0, -1);
        this.replaceKey = false;
      } else {
        const value =
          data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')
            ? data.slice(6, -6)
            : (decodeKittyPrintable(data) ?? data);
        if (
          value &&
          !/[\p{Cc}\p{Cf}]/u.test(value) &&
          (this.replaceKey ? 0 : this.key.length) + value.length <= 16_384
        ) {
          this.key = (this.replaceKey ? '' : this.key) + value;
          this.replaceKey = false;
          this.message = '';
        }
      }
    } else if (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) {
      const list = this.ensureList();
      const index = this.listItems.findIndex((item) => item.value === list.getSelectedItem()?.value);
      list.setSelectedIndex(
        Math.max(
          0,
          Math.min(this.listItems.length - 1, index + (matchesKey(data, 'pageUp') ? -this.listRows : this.listRows)),
        ),
      );
      this.selected = list.getSelectedItem()?.value ?? '';
    } else if ((['up', 'down', 'enter'] as const).some((key) => matchesKey(data, key))) {
      this.ensureList().handleInput(data);
    } else if (!matchesKey(data, 'tab') && !matchesKey(data, 'shift+tab')) {
      this.search.handleInput(data);
      if (this.search.getValue().length > 256) this.search.setValue(this.search.getValue().slice(0, 256));
    }
    this.options.render();
  }

  dispose(): void {
    this.disposed = true;
    this.controller.abort();
    this.key = '';
    this.authLines = [];
    this.authUrl = undefined;
  }
}
