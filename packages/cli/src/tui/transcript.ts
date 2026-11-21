import { stripTerminalSequences, wrapTextWithAnsi, type Component, type TUI } from '@earendil-works/pi-tui';
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  getMarkdownTheme,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { commandNamesEnvFile, isEnvFile, maskEnvFile, maskSecrets } from './secret-mask.ts';
import { installPiTheme } from './pi-theme.ts';
import type { OmsTheme } from './theme.ts';

const ENTRY_CHARS = 12_000;
const HISTORY_CHARS = 192_000;
const HISTORY_ENTRIES = 160;

/** All provider, repository, tool and metadata strings cross this boundary before rendering. */
export function displayText(value: string, limit = ENTRY_CHARS): string {
  const clipped = value.length > limit;
  const text = maskSecrets(
    stripTerminalSequences(value.slice(0, limit))
      .replace(/\r\n|\r/g, '\n')
      .replace(/\t/g, '    ')
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ''),
  );
  return text + (clipped ? '\n[display truncated]' : '');
}

/** Chrome components return physical rows; multiline content belongs only in the editor/transcript. */
export function singleLine(value: string, limit: number): string {
  return displayText(value, limit).replace(/\s+/g, ' ').trim();
}

/** One line cut at `limit` characters with an ellipsis; secrets are masked before the cut. */
export function clipLine(value: string, limit: number): string {
  const line = singleLine(value, 4000);
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/** Bounded diagnostic projection; does not invoke toJSON or retain provider objects. */
export function describeValue(value: unknown, depth = 0): string {
  if (typeof value === 'string') return displayText(value, 3000);
  if (value === null || typeof value !== 'object') return String(value);
  if (depth >= 3) return '[…]';
  if (Array.isArray(value))
    return value
      .slice(0, 12)
      .map((item) => describeValue(item, depth + 1))
      .join(', ')
      .slice(0, 4000);
  const parts: string[] = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    parts.push(`${displayText(key, 80)}: ${describeValue((value as Record<string, unknown>)[key], depth + 1)}`);
    if (parts.length === 12) break;
  }
  return parts.join('\n').slice(0, 4000);
}

/** What the transcript needs from its host to draw tool calls the way pi does. */
export interface ConversationOptions {
  /** The registered tool, whose own renderers draw its call and result. */
  toolDefinition?: (name: string) => unknown;
  cwd?: string;
  requestRender?: () => void;
}

/** Whether a tool call touches an env file, so every value in its arguments and output is hidden, not only secret-named ones. */
function touchesEnvFile(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  const { path, file_path: filePath, command } = args as Record<string, unknown>;
  return isEnvFile(path) || isEnvFile(filePath) || commandNamesEnvFile(command);
}

function maskValue(value: unknown, mask: (text: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return mask(value);
  if (depth > 4 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => maskValue(item, mask, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskValue(item, mask, depth + 1)]));
}

/** Arguments as the screen shows them. The model's own copy is untouched. */
function argsForDisplay(args: unknown): unknown {
  return maskValue(args, touchesEnvFile(args) ? maskEnvFile : maskSecrets);
}

interface Item {
  key: string;
  component: Component;
}

let themed = false;
function ensureTheme(): void {
  if (themed) return;
  initTheme();
  themed = true;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return displayText(content);
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content.slice(0, 128)) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') text += displayText(block.text) + '\n';
    else if (block.type === 'image') text += '[image]\n';
    if (text.length >= ENTRY_CHARS) break;
  }
  return displayText(text.trimEnd());
}

/** Every provider string crosses displayText before a pi component draws it. */
function assistantForDisplay(message: AssistantMessage, diagnostic: string): AssistantMessage {
  const content = (message.content ?? []).slice(0, 128).map((block) => {
    if (block.type === 'text') return { ...block, text: displayText(block.text) };
    if (block.type === 'thinking') return { ...block, thinking: displayText(block.thinking) };
    return block;
  });
  const budget = ENTRY_CHARS - diagnostic.length - 1 - '\n[display truncated]'.length;
  let used = 0;
  const bounded = content.map((block) => {
    if (block.type === 'text' || block.type === 'thinking') {
      const field = block.type === 'text' ? 'text' : 'thinking';
      const value = displayText((block as never)[field], Math.max(0, diagnostic ? budget - used : ENTRY_CHARS));
      used += value.length;
      return { ...block, [field]: value };
    }
    return block;
  });
  return {
    ...message,
    content: bounded,
    ...(diagnostic ? { errorMessage: diagnostic, stopReason: 'error' } : { errorMessage: undefined }),
  } as AssistantMessage;
}

export class Conversation implements Component {
  private readonly items: Item[] = [];
  private readonly tools = new Map<string, ToolExecutionComponent>();
  private readonly envCalls = new Set<string>();
  private readonly formatError: (message: string, recordedProvider?: string) => string;
  private readonly options: ConversationOptions;
  private readonly ui: TUI;
  private sequence = 0;
  private currentMessage: string | undefined;
  private streaming: { key: string; component: AssistantMessageComponent } | undefined;
  private trimmed = false;
  private toolsExpanded = false;
  private thinkingHidden = false;
  focused = false;

  constructor(
    messages: readonly unknown[],
    formatError: (message: string, recordedProvider?: string) => string = (text) => text,
    options: ConversationOptions = {},
  ) {
    ensureTheme();
    this.formatError = formatError;
    this.options = options;
    this.ui = { requestRender: () => options.requestRender?.(), terminal: { columns: 80, rows: 24 } } as unknown as TUI;
    for (const message of messages.slice(-HISTORY_ENTRIES)) this.restore(message, `history-${this.sequence++}`);
    this.trimmed ||= messages.length > HISTORY_ENTRIES;
  }
  invalidate(): void {
    for (const item of this.items) item.component.invalidate?.();
  }

  /** Draw every message, tool, diff and code block with this OMS theme from the next render. */
  applyTheme(theme: OmsTheme): void {
    installPiTheme(theme);
    this.invalidate();
  }

  /** Forget everything shown, for a fresh conversation. */
  clear(): void {
    this.items.length = 0;
    this.tools.clear();
    this.envCalls.clear();
    this.trimmed = false;
    this.currentMessage = undefined;
    this.streaming = undefined;
  }

  /** Ctrl+O: show every tool call and result in full, or back to the short form. */
  toggleToolOutput(): boolean {
    this.toolsExpanded = !this.toolsExpanded;
    for (const item of this.items)
      if (item.component instanceof ToolExecutionComponent || item.component instanceof BashExecutionComponent)
        item.component.setExpanded(this.toolsExpanded);
    return this.toolsExpanded;
  }

  /** Ctrl+T: hide or show the model's thinking. */
  toggleThinking(): boolean {
    this.thinkingHidden = !this.thinkingHidden;
    for (const item of this.items)
      if (item.component instanceof AssistantMessageComponent) item.component.setHideThinkingBlock(this.thinkingHidden);
    return this.thinkingHidden;
  }

  note(_label: string, text: string): void {
    const lines = displayText(text);
    this.put({
      key: `notice-${this.sequence++}`,
      component: { invalidate() {}, render: (width) => ['', ...wrapTextWithAnsi(lines, Math.max(1, width - 1))] },
    });
  }

  private put(item: Item): void {
    const existing = this.items.findIndex((entry) => entry.key === item.key);
    if (existing >= 0) this.items[existing] = item;
    else this.items.push(item);
    while (this.items.length > HISTORY_ENTRIES) {
      const dropped = this.items.shift()!;
      for (const [id, tool] of this.tools) if (tool === dropped.component) this.tools.delete(id);
      this.trimmed = true;
    }
  }

  private toolComponent(id: string, name: string, args: unknown): ToolExecutionComponent {
    const known = this.tools.get(id);
    if (known) return known;
    if (touchesEnvFile(args)) this.envCalls.add(id);
    const component = new ToolExecutionComponent(
      displayText(name, 80),
      id,
      argsForDisplay(args),
      { showImages: false },
      this.options.toolDefinition?.(name) as never,
      this.ui,
      this.options.cwd ?? process.cwd(),
    );
    component.setExpanded(this.toolsExpanded);
    this.tools.set(id, component);
    this.put({ key: `tool-${id}`, component });
    return component;
  }

  /** Tool output as the screen shows it, whether live, expanded with Ctrl+O or restored from history. */
  private resultForDisplay(id: string, content: unknown): never {
    const mask = this.envCalls.has(id) ? maskEnvFile : maskSecrets;
    return (
      Array.isArray(content)
        ? content.map((block) =>
            block && block.type === 'text' && typeof block.text === 'string'
              ? { ...block, text: mask(block.text) }
              : block,
          )
        : []
    ) as never;
  }

  private detailsForDisplay(id: string, details: unknown): unknown {
    return maskValue(details, this.envCalls.has(id) ? maskEnvFile : maskSecrets);
  }

  private assistant(message: AssistantMessage, key: string, streaming: boolean): void {
    const diagnostic = message.errorMessage
      ? displayText(this.formatError(message.errorMessage, message.provider), 3000)
      : '';
    const shown = assistantForDisplay(message, diagnostic);
    if (this.streaming?.key === key) {
      this.streaming.component.updateContent(shown, streaming);
    } else {
      const visible = shown.content.some(
        (block) => (block.type === 'text' && block.text.trim()) || block.type === 'thinking',
      );
      if (!visible && !diagnostic) return;
      const component = new AssistantMessageComponent(shown, this.thinkingHidden, getMarkdownTheme());
      this.put({ key, component });
      if (streaming) this.streaming = { key, component };
    }
    for (const block of shown.content)
      if (block.type === 'toolCall') {
        const known = this.tools.has(block.id);
        const tool = this.toolComponent(block.id, block.name, block.arguments);
        if (known) {
          if (touchesEnvFile(block.arguments)) this.envCalls.add(block.id);
          tool.updateArgs(argsForDisplay(block.arguments) as never);
        }
      }
  }

  /** A message from saved history or the event stream, drawn as pi draws it. */
  private restore(value: unknown, key: string): void {
    if (!value || typeof value !== 'object') return;
    const message = value as { role?: string; [field: string]: unknown };
    if (message.role === 'toolResult') {
      const tool = this.tools.get(String(message.toolCallId));
      if (tool)
        tool.updateResult({
          content: this.resultForDisplay(String(message.toolCallId), message.content),
          details: this.detailsForDisplay(String(message.toolCallId), message.details),
          isError: message.isError === true,
        });
      return;
    }
    if (message.role === 'assistant') {
      const assistant = message as unknown as AssistantMessage;
      this.assistant(assistant, key, false);
      if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted')
        for (const block of assistant.content ?? [])
          if (block.type === 'toolCall')
            this.tools.get(block.id)?.updateResult({
              content: [{ type: 'text', text: displayText(assistant.errorMessage ?? 'Operation aborted', 400) }],
              isError: true,
            });
      return;
    }
    if (message.role === 'bashExecution') {
      const command = displayText(String(message.command ?? ''), 2000);
      const component = new BashExecutionComponent(command, this.ui, message.excludeFromContext === true);
      component.setExpanded(this.toolsExpanded);
      if (message.output) {
        const output = displayText(String(message.output));
        component.appendOutput(commandNamesEnvFile(message.command) ? maskEnvFile(output) : output);
      }
      component.setComplete(
        typeof message.exitCode === 'number' ? message.exitCode : undefined,
        message.cancelled === true,
      );
      this.put({ key, component });
      return;
    }
    if (message.role === 'user') {
      const text = textOf(message.content);
      if (text) this.put({ key, component: new UserMessageComponent(text, getMarkdownTheme()) });
      return;
    }
    const diagnostic = typeof message.errorMessage === 'string' ? displayText(message.errorMessage, 3000) : '';
    const text = textOf(message.content);
    if (text || diagnostic) this.note('', [text, diagnostic].filter(Boolean).join('\n'));
  }

  accept(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'message_start': {
        this.currentMessage = `message-${this.sequence++}`;
        if ((event.message as { role?: string }).role === 'assistant')
          this.assistant(event.message as AssistantMessage, this.currentMessage, true);
        else this.restore(event.message, this.currentMessage);
        break;
      }
      case 'message_update':
      case 'message_end': {
        const message = event.message as { role?: string };
        if (message.role !== 'assistant') {
          if (event.type === 'message_end') this.currentMessage = undefined;
          break;
        }
        this.currentMessage ??= `message-${this.sequence++}`;
        const streaming = event.type === 'message_update';
        this.assistant(event.message as AssistantMessage, this.currentMessage, streaming);
        if (event.type === 'message_end') {
          const done = event.message as AssistantMessage;
          for (const block of done.content ?? [])
            if (block.type === 'toolCall') {
              const tool = this.tools.get(block.id);
              if (done.stopReason === 'error' || done.stopReason === 'aborted')
                tool?.updateResult({
                  content: [{ type: 'text', text: displayText(done.errorMessage ?? 'Operation aborted', 400) }],
                  isError: true,
                });
              else tool?.setArgsComplete();
            }
          this.streaming = undefined;
          this.currentMessage = undefined;
        }
        break;
      }
      case 'tool_execution_start':
        this.toolComponent(event.toolCallId, event.toolName, event.args).markExecutionStarted();
        break;
      case 'tool_execution_update':
        this.toolComponent(event.toolCallId, event.toolName, event.args).updateResult(
          {
            ...(event.partialResult as { content: never[] }),
            content: this.resultForDisplay(event.toolCallId, (event.partialResult as { content?: unknown }).content),
            isError: false,
          },
          true,
        );
        break;
      case 'tool_execution_end': {
        const result = event.result as { content?: never[]; details?: unknown } | undefined;
        this.toolComponent(event.toolCallId, event.toolName, undefined).updateResult({
          content: this.resultForDisplay(event.toolCallId, result?.content),
          details: this.detailsForDisplay(event.toolCallId, result?.details),
          isError: event.isError,
          durationMs: (event as { durationMs?: number }).durationMs,
        });
        break;
      }
    }
    this.options.requestRender?.();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const lines: string[] = this.trimmed ? ['[earlier display history omitted; session history is retained]'] : [];
    for (const item of this.items) lines.push(...item.component.render(width));
    return lines.slice(-6000);
  }
}
