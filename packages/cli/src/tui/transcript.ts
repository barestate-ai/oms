import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { commandNamesEnvFile, isEnvFile, maskEnvFile, maskSecrets } from './secret-mask.ts';
import { installPiTheme } from './pi-theme.ts';
import { DEFAULT_THEME_ID, getTheme, type OmsTheme } from './theme.ts';
import type { Args, HelperDisplay, ToolCall } from './display-tools.ts';
import { groupable, renderExplore, renderTool, type Rendered, type RowContext } from './tool-rows.ts';
import {
  errorRows,
  footerRow,
  glyphsFor,
  newOutputChip,
  noteRows,
  proseRows,
  reducedMotion,
  Style,
  thoughtRows,
  userBand,
} from './transcript-render.ts';

export { copyableText } from './transcript-render.ts';

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

/** What the transcript needs from its host. */
export interface ConversationOptions {
  /** Where a helper agent's own conversation comes from, for Ctrl+O on its row. */
  helpers?: HelperDisplay | undefined;
  cwd?: string;
  requestRender?: () => void;
  /** The terminal's height: a prompt band gets a row of padding above and below from 30 rows. */
  rows?: () => number;
  /** The clock, for the elapsed times and the blinking dot. */
  now?: () => number;
  /** Rows of output Ctrl+O shows for one call. */
  expandedLines?: number;
  env?: Readonly<Record<string, string | undefined>>;
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

const ARGUMENT_CHARS = 20_000;
/** What the screen shows of a string the model or a tool produced: no terminal sequences, no secrets. */
const cleaner = (mask: (text: string) => string) => (text: string) => mask(displayText(text, ARGUMENT_CHARS));

/** Arguments as the screen shows them. The model's own copy is untouched. */
function argsForDisplay(args: unknown): Args {
  const shown = maskValue(args, cleaner(touchesEnvFile(args) ? maskEnvFile : maskSecrets));
  return shown && typeof shown === 'object' && !Array.isArray(shown) ? (shown as Args) : {};
}

/** The text blocks of a result as one string, long output kept at its start and end. */
const OUTPUT_CHARS = 24_000;
function resultText(content: unknown, mask: (text: string) => string): string {
  if (!Array.isArray(content)) return '';
  const text = content
    .slice(0, 64)
    .map((block: { type?: string; text?: unknown }) =>
      block && block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : block?.type === 'image'
          ? '[image]'
          : '',
    )
    .join('\n');
  const bounded =
    text.length > OUTPUT_CHARS
      ? `${text.slice(0, 6000)}\n[… output omitted …]\n${text.slice(-(OUTPUT_CHARS - 6000))}`
      : text;
  return mask(displayText(bounded, OUTPUT_CHARS + 100));
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

const contentOf = (message: AssistantMessage): AssistantMessage['content'] =>
  Array.isArray(message.content) ? message.content.filter((block) => block && typeof block === 'object') : [];

/** Every provider string crosses displayText before it is drawn. */
function assistantForDisplay(message: AssistantMessage, diagnostic: string): AssistantMessage {
  const content = contentOf(message)
    .slice(0, 128)
    .map((block) => {
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

// ---------------------------------------------------------------- entries

interface Base {
  key: string;
  /** Changes whenever the entry does, so its drawn rows can be reused until then. */
  rev: number;
}
interface UserEntry extends Base {
  kind: 'user';
  text: string;
}
interface AssistantEntry extends Base {
  kind: 'assistant';
  blocks: { type: 'text' | 'thinking'; text: string }[];
  streaming: boolean;
  thinkStart?: number;
  thinkMs?: number;
  /** A failure, interruption or cut-off the response ended with. */
  ending?: { label: string; text: string; tone: 'error' | 'warning' };
}
interface ToolEntry extends Base {
  kind: 'tool';
  call: ToolCall;
}
interface NoteEntry extends Base {
  kind: 'note';
  label: string;
  text: string;
}
interface FooterEntry extends Base {
  kind: 'footer';
  ms: number;
  tokens: number;
}
type Entry = UserEntry | AssistantEntry | ToolEntry | NoteEntry | FooterEntry;

/** One drawn thing: an entry, or a run of read-only calls drawn as one. */
interface Block {
  key: string;
  entries: Entry[];
}
interface Drawn extends Rendered {
  theme: OmsTheme;
  sig: string;
  /** A click opens or folds it. */
  clickable: boolean;
}

/** The theme the conversations drawn after the first one use until told otherwise. */
let activeTheme: OmsTheme | undefined;

const PULSE_MS = 500;
/** A turn shorter than this says nothing about how long it worked. */
const FOOTER_AFTER_MS = 5000;

export class Conversation {
  private readonly items: Entry[] = [];
  private readonly tools = new Map<string, ToolEntry>();
  private readonly envCalls = new Set<string>();
  private readonly formatError: (message: string, recordedProvider?: string) => string;
  private readonly options: ConversationOptions;
  private readonly now: () => number;
  private readonly cache = new Map<string, Drawn>();
  private style: Style;
  private theme: OmsTheme;
  private sequence = 0;
  private revision = 0;
  private currentMessage: string | undefined;
  private streaming: { key: string; entry: AssistantEntry } | undefined;
  private trimmed = false;
  private toolsExpanded = false;
  /** Thinking shows as 'Thought for 3s' until Ctrl+T opens it. */
  private thinkingHidden = true;
  private turn: { start: number; tokens: number } | undefined;
  private pulse: ReturnType<typeof setInterval> | undefined;
  private seen = 0;
  private chipRow: number | undefined;
  /** Entries the reader opened or folded with a click, by block key. */
  private readonly opened = new Set<string>();
  /** Where each block was in the last render(), for clicks. */
  private layout: { key: string; start: number; end: number; clickable: boolean }[] = [];
  /** Rows drawn since the last reset, per block key: what a frame had to draw again (for tests). */
  readonly redraws = new Map<string, number>();
  focused = false;

  constructor(
    messages: readonly unknown[],
    formatError: (message: string, recordedProvider?: string) => string = (text) => text,
    options: ConversationOptions = {},
  ) {
    this.formatError = formatError;
    this.options = options;
    this.now = options.now ?? Date.now;
    if (!activeTheme) {
      activeTheme = getTheme(DEFAULT_THEME_ID)!;
      installPiTheme(activeTheme);
    }
    this.theme = activeTheme;
    this.style = new Style(this.theme, glyphsFor(options.env));
    for (const message of messages.slice(-HISTORY_ENTRIES)) this.restore(message, `history-${this.sequence++}`);
    this.trimmed ||= messages.length > HISTORY_ENTRIES;
    // A call with no result in saved history never finished.
    for (const tool of this.tools.values())
      if (tool.call.state === 'pending') {
        tool.call.state = 'interrupted';
        this.touch(tool);
      }
    this.seen = this.revision;
  }

  /** Forget the rows drawn so far (the theme or the terminal changed). */
  invalidate(): void {
    this.cache.clear();
  }

  /** Draw every message, tool, diff and code block with this OMS theme from the next render. */
  applyTheme(theme: OmsTheme): void {
    activeTheme = theme;
    installPiTheme(theme);
    this.theme = theme;
    this.style = new Style(theme, glyphsFor(this.options.env));
    this.invalidate();
  }

  /** Forget everything shown, for a fresh conversation. */
  clear(): void {
    this.items.length = 0;
    this.tools.clear();
    this.envCalls.clear();
    this.cache.clear();
    this.opened.clear();
    this.layout = [];
    this.trimmed = false;
    this.currentMessage = undefined;
    this.streaming = undefined;
    this.turn = undefined;
    this.revision++;
    this.seen = this.revision;
    this.syncPulse();
  }

  /** Ctrl+O: show every tool call and result in full, or back to the short form (clicks are forgotten). */
  toggleToolOutput(): boolean {
    this.toolsExpanded = !this.toolsExpanded;
    this.opened.clear();
    return this.toolsExpanded;
  }

  /** Ctrl+T: open the model's thinking, or fold it back to 'Thought for 3s'. Returns whether it is folded. */
  toggleThinking(): boolean {
    this.thinkingHidden = !this.thinkingHidden;
    return this.thinkingHidden;
  }

  note(label: string, text: string): void {
    const key = `notice-${this.sequence++}`;
    this.put({ kind: 'note', key, rev: 0, label: singleLine(label, 80), text: displayText(text) });
  }

  private touch(entry: Entry): void {
    entry.rev = ++this.revision;
  }

  private put(entry: Entry): void {
    this.touch(entry);
    const existing = this.items.findIndex((item) => item.key === entry.key);
    if (existing >= 0) this.items[existing] = entry;
    else this.items.push(entry);
    while (this.items.length > HISTORY_ENTRIES) {
      const dropped = this.items.shift()!;
      this.opened.delete(dropped.key);
      if (dropped.kind === 'tool') this.tools.delete(dropped.call.id);
      this.trimmed = true;
    }
  }

  private tool(id: string, name: string, args: unknown): ToolEntry {
    const known = this.tools.get(id);
    if (known) return known;
    if (touchesEnvFile(args)) this.envCalls.add(id);
    const entry: ToolEntry = {
      kind: 'tool',
      key: `tool-${id}`,
      rev: 0,
      call: { id, name: singleLine(name, 80), args: argsForDisplay(args), state: 'pending', text: '' },
    };
    this.tools.set(id, entry);
    this.put(entry);
    return entry;
  }

  private mask(id: string): (text: string) => string {
    return this.envCalls.has(id) ? maskEnvFile : maskSecrets;
  }

  private details(id: string, details: unknown): ToolCall['details'] {
    const shown = maskValue(details, cleaner(this.mask(id)));
    return shown && typeof shown === 'object' && !Array.isArray(shown) ? (shown as Record<string, unknown>) : undefined;
  }

  private finish(
    entry: ToolEntry,
    result: { content?: unknown; details?: unknown; isError: boolean; durationMs?: number | undefined },
  ): void {
    const { call } = entry;
    call.state = result.isError ? 'error' : 'done';
    call.text = resultText(result.content, this.mask(call.id));
    if (result.details !== undefined) call.details = this.details(call.id, result.details);
    call.durationMs =
      result.durationMs ?? (call.startedAt === undefined ? undefined : Math.max(0, this.now() - call.startedAt));
    this.touch(entry);
  }

  private assistant(message: AssistantMessage, key: string, streaming: boolean): void {
    const diagnostic = message.errorMessage
      ? displayText(this.formatError(message.errorMessage, message.provider), 3000)
      : '';
    const shown = assistantForDisplay(message, diagnostic);
    const blocks: AssistantEntry['blocks'] = [];
    for (const block of shown.content) {
      const text = block.type === 'text' ? block.text.trim() : block.type === 'thinking' ? block.thinking.trim() : '';
      if (!text) continue;
      const last = blocks.at(-1);
      if (block.type === 'thinking' && last?.type === 'thinking') last.text += `\n\n${text}`;
      else blocks.push({ type: block.type as 'text' | 'thinking', text });
    }
    const hasToolCalls = shown.content.some((block) => block.type === 'toolCall');
    let ending: AssistantEntry['ending'];
    if (shown.stopReason === 'length')
      ending = { label: 'Cut off', text: 'The response was truncated before it finished.', tone: 'warning' };
    else if (!hasToolCalls && shown.stopReason === 'aborted')
      ending = {
        label: 'Interrupted',
        text: shown.errorMessage && shown.errorMessage !== 'Request was aborted' ? shown.errorMessage : '',
        tone: 'warning',
      };
    else if (!hasToolCalls && shown.stopReason === 'error')
      ending = { label: 'Error', text: shown.errorMessage || 'Unknown error', tone: 'error' };
    const entry = this.streaming?.key === key ? this.streaming.entry : undefined;
    if (entry) {
      entry.blocks = blocks;
      entry.streaming = streaming;
      if (ending) entry.ending = ending;
      else delete entry.ending;
      this.timeThinking(entry);
      this.touch(entry);
    } else if (blocks.length || ending) {
      const created: AssistantEntry = {
        kind: 'assistant',
        key,
        rev: 0,
        blocks,
        streaming,
        ...(ending ? { ending } : {}),
      };
      this.timeThinking(created);
      this.put(created);
      if (streaming) this.streaming = { key, entry: created };
    }
    for (const block of shown.content)
      if (block.type === 'toolCall') {
        const known = this.tools.get(block.id);
        const tool = this.tool(block.id, block.name, block.arguments);
        if (known) {
          if (touchesEnvFile(block.arguments)) this.envCalls.add(block.id);
          tool.call.args = argsForDisplay(block.arguments);
          this.touch(tool);
        }
      }
  }

  /** How long the model thought, for a message seen streaming: from its first words of thinking to its first words after. */
  private timeThinking(entry: AssistantEntry): void {
    if (entry.streaming && entry.blocks.some((block) => block.type === 'thinking')) entry.thinkStart ??= this.now();
    if (entry.thinkStart === undefined || entry.thinkMs !== undefined) return;
    const spoke = entry.blocks.some(
      (block, index) => block.type === 'text' && entry.blocks.slice(0, index).some((b) => b.type === 'thinking'),
    );
    if (!entry.streaming || spoke) entry.thinkMs = this.now() - entry.thinkStart;
  }

  /** A message from saved history or the event stream. */
  private restore(value: unknown, key: string): void {
    if (!value || typeof value !== 'object') return;
    const message = value as { role?: string; [field: string]: unknown };
    if (message.role === 'toolResult') {
      const entry = this.tools.get(String(message.toolCallId));
      if (entry)
        this.finish(entry, { content: message.content, details: message.details, isError: message.isError === true });
      return;
    }
    if (message.role === 'assistant') {
      const assistant = message as unknown as AssistantMessage;
      this.assistant(assistant, key, false);
      if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted')
        for (const block of contentOf(assistant))
          if (block.type === 'toolCall') this.failCall(block.id, assistant.errorMessage);
      return;
    }
    if (message.role === 'bashExecution') {
      const command = displayText(String(message.command ?? ''), 2000);
      const exit =
        typeof message.exitCode === 'number' && message.exitCode !== 0
          ? `\n\nCommand exited with code ${message.exitCode}`
          : '';
      const output = message.output ? displayText(String(message.output)) : '';
      const masked = commandNamesEnvFile(message.command) ? maskEnvFile(output) : output;
      const failed = message.cancelled === true || !!exit;
      this.put({
        kind: 'tool',
        key,
        rev: 0,
        call: {
          id: key,
          name: 'bash',
          args: { command },
          state: failed ? 'error' : 'done',
          text: masked + (message.cancelled === true ? '\n\nCommand aborted' : exit),
          user: true,
        },
      });
      return;
    }
    if (message.role === 'user') {
      const text = textOf(message.content);
      if (text) this.put({ kind: 'user', key, rev: 0, text });
      return;
    }
    const diagnostic = typeof message.errorMessage === 'string' ? displayText(message.errorMessage, 3000) : '';
    const text = textOf(message.content);
    if (text || diagnostic) this.note('', [text, diagnostic].filter(Boolean).join('\n'));
  }

  private failCall(id: string, errorMessage: string | undefined): void {
    const entry = this.tools.get(id);
    if (entry)
      this.finish(entry, {
        content: [{ type: 'text', text: displayText(errorMessage ?? 'Operation aborted', 400) }],
        isError: true,
      });
  }

  accept(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.turn = { start: this.now(), tokens: 0 };
        break;
      case 'agent_settled': {
        const { turn } = this;
        this.turn = undefined;
        // Nothing runs once the agent has settled: a call still shown running never reported back.
        for (const entry of this.tools.values())
          if (entry.call.state === 'pending' || entry.call.state === 'running') {
            entry.call.state = 'interrupted';
            this.touch(entry);
          }
        if (turn && !event.aborted && this.now() - turn.start >= FOOTER_AFTER_MS)
          this.put({
            kind: 'footer',
            key: `footer-${this.sequence++}`,
            rev: 0,
            ms: this.now() - turn.start,
            tokens: turn.tokens,
          });
        break;
      }
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
          if (this.turn) this.turn.tokens += Number(done.usage?.output) || 0;
          if (done.stopReason === 'error' || done.stopReason === 'aborted')
            for (const block of contentOf(done))
              if (block.type === 'toolCall') this.failCall(block.id, done.errorMessage);
          this.streaming = undefined;
          this.currentMessage = undefined;
        }
        break;
      }
      case 'tool_execution_start': {
        const entry = this.tool(event.toolCallId, event.toolName, event.args);
        entry.call.state = 'running';
        entry.call.startedAt ??= this.now();
        this.touch(entry);
        break;
      }
      case 'tool_execution_update': {
        const entry = this.tool(event.toolCallId, event.toolName, event.args);
        const partial = (event.partialResult ?? {}) as { content?: unknown; details?: unknown };
        entry.call.state = 'running';
        entry.call.startedAt ??= this.now();
        entry.call.text = resultText(partial.content, this.mask(event.toolCallId));
        if (partial.details !== undefined) entry.call.details = this.details(event.toolCallId, partial.details);
        this.touch(entry);
        break;
      }
      case 'tool_execution_end': {
        const result = event.result as { content?: unknown; details?: unknown } | undefined;
        this.finish(this.tool(event.toolCallId, event.toolName, undefined), {
          content: result?.content,
          details: result?.details,
          isError: event.isError,
          durationMs: (event as { durationMs?: number }).durationMs,
        });
        break;
      }
    }
    this.syncPulse();
    this.options.requestRender?.();
  }

  /** The running dots blink and the elapsed times count only while a call is going, so the clock runs only then. */
  private syncPulse(): void {
    const live = [...this.tools.values()].some(({ call }) => call.state === 'pending' || call.state === 'running');
    if (live && !this.pulse && this.options.requestRender) {
      this.pulse = setInterval(() => this.options.requestRender?.(), PULSE_MS);
      this.pulse.unref();
    } else if (!live && this.pulse) {
      clearInterval(this.pulse);
      this.pulse = undefined;
    }
  }

  // ------------------------------------------------------------ drawing

  /** Entries as drawn blocks: consecutive read-only calls fold into one 'Explored' block. */
  private blocks(): Block[] {
    const blocks: Block[] = [];
    let run: ToolEntry[] = [];
    const flush = () => {
      if (run.length > 1) blocks.push({ key: `explore-${run[0]!.key}`, entries: run });
      else if (run.length) blocks.push({ key: run[0]!.key, entries: run });
      run = [];
    };
    for (const entry of this.items) {
      if (entry.kind === 'tool' && groupable(entry.call, this.options.cwd)) run.push(entry);
      else {
        flush();
        blocks.push({ key: entry.key, entries: [entry] });
      }
    }
    flush();
    return blocks;
  }

  private draw(block: Block, width: number, hint: boolean, now: number, lit: boolean): Drawn {
    const slot = `${block.key}${hint ? '+hint' : ''}`;
    const rows = this.options.rows?.() ?? 0;
    const open = this.toolsExpanded || this.opened.has(block.key);
    const sig = `${width}|${this.toolsExpanded ? 1 : 0}${this.opened.has(block.key) ? 1 : 0}|${this.thinkingHidden ? 1 : 0}|${rows >= 30 ? 1 : 0}|${block.entries.map((entry) => entry.rev).join(',')}`;
    const cached = this.cache.get(slot);
    if (cached && cached.theme === this.theme && cached.sig === sig) return cached;
    const made = this.render1(block, width, hint, now, lit, rows >= 30, open);
    // Whatever the layout above did, no row is wider than the view.
    const lines = made.lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, '') : line));
    const thoughts =
      block.entries[0]?.kind === 'assistant' && block.entries[0].blocks.some((b) => b.type === 'thinking');
    const drawn: Drawn = {
      ...made,
      lines,
      theme: this.theme,
      sig,
      clickable: made.collapsed || this.opened.has(block.key) || thoughts,
    };
    this.redraws.set(block.key, (this.redraws.get(block.key) ?? 0) + 1);
    if (drawn.volatile) this.cache.delete(slot);
    else this.cache.set(slot, drawn);
    return drawn;
  }

  private render1(
    block: Block,
    width: number,
    hint: boolean,
    now: number,
    lit: boolean,
    pad: boolean,
    open: boolean,
  ): Rendered {
    const s = this.style;
    const first = block.entries[0]!;
    const context: RowContext = {
      style: s,
      width,
      expanded: open,
      hint,
      now,
      lit,
      limit: this.options.expandedLines ?? 100,
      helpers: this.options.helpers,
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
    };
    if (block.entries.length > 1)
      return renderExplore(
        block.entries.map((entry) => (entry as ToolEntry).call),
        context,
      );
    switch (first.kind) {
      case 'tool':
        return renderTool(first.call, context);
      case 'user': {
        const band = userBand(s, first.text, width, { expanded: open, hint, pad });
        return { lines: band.lines, collapsed: band.clipped, volatile: false };
      }
      case 'footer':
        return { lines: [footerRow(s, first.ms, first.tokens)], collapsed: false, volatile: false };
      case 'note': {
        if (/ failed$/i.test(first.label)) {
          const error = errorRows(s, first.text, width, { expanded: open, hint });
          return { lines: error.lines, collapsed: error.collapsed, volatile: false };
        }
        return { lines: noteRows(s, first.label, first.text, width), collapsed: false, volatile: false };
      }
      case 'assistant': {
        const parts: string[][] = [];
        for (const part of first.blocks) {
          if (part.type === 'text') parts.push(proseRows(s, part.text, width));
          else
            parts.push(
              thoughtRows(s, part.text, width, {
                live: first.streaming && first.thinkMs === undefined,
                expanded: !this.thinkingHidden || this.opened.has(block.key),
                ...(first.thinkMs === undefined ? {} : { ms: first.thinkMs }),
              }),
            );
        }
        let collapsed = false;
        if (first.ending) {
          const error = errorRows(s, first.ending.text, width, { expanded: open, hint, ...first.ending });
          parts.push(error.lines);
          collapsed = error.collapsed;
        }
        const lines = parts.flatMap((rows, index) => (index ? ['', ...rows] : rows));
        return { lines, collapsed, volatile: false };
      }
    }
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const now = this.now();
    const lit = reducedMotion(this.options.env) || Math.floor(now / PULSE_MS) % 2 === 0;
    const blocks = this.blocks();
    const plain = blocks.map((block) => this.draw(block, width, false, now, lit));
    // Only the latest entry that is cut short names the key that expands it.
    const latest = this.toolsExpanded ? -1 : plain.findLastIndex((drawn) => drawn.collapsed);
    if (latest >= 0) plain[latest] = this.draw(blocks[latest]!, width, true, now, lit);
    const lines: string[] = this.trimmed ? [this.style.faint(`${this.style.g.more} earlier entries hidden`)] : [];
    const layout: Conversation['layout'] = [];
    for (const [index, drawn] of plain.entries()) {
      if (!drawn.lines.length) continue;
      if (lines.length) lines.push('');
      layout.push({
        key: blocks[index]!.key,
        start: lines.length,
        end: lines.length + drawn.lines.length,
        clickable: drawn.clickable,
      });
      for (const line of drawn.lines) lines.push(line);
    }
    const cut = Math.max(0, lines.length - 6000);
    this.layout = layout.map((entry) => ({ ...entry, start: entry.start - cut, end: entry.end - cut }));
    // Drop what is no longer shown (a replaced block, an old width).
    if (this.cache.size > 2 * blocks.length + 8 || this.redraws.size > 2 * blocks.length + 8) {
      const live = new Set(blocks.flatMap((block) => [block.key, `${block.key}+hint`]));
      for (const slot of this.cache.keys()) if (!live.has(slot)) this.cache.delete(slot);
      for (const key of this.redraws.keys()) if (!live.has(key)) this.redraws.delete(key);
    }
    return cut ? lines.slice(cut) : lines;
  }

  /**
   * A click on row `row` of the view's content, which has `above` rows (the art) before what render() returned: it
   * opens or folds the entry there, or, on the '▼ new output' chip, asks the view to go to the end.
   */
  click(row: number, above = 0): 'end' | 'toggled' | undefined {
    if (row === this.chipRow) return 'end';
    const hit = this.layout.find((entry) => row - above >= entry.start && row - above < entry.end);
    if (!hit?.clickable) return undefined;
    if (!this.opened.delete(hit.key)) this.opened.add(hit.key);
    this.options.requestRender?.();
    return 'toggled';
  }

  // ------------------------------------------------------------ following the end

  /**
   * '▼ new output' over the bottom row of the view while it is scrolled up and something arrived since it left the end.
   * `lines` is what render() returned (plus anything above it); the view says where it is looking.
   */
  withNewOutput(
    lines: string[],
    view: { isFollowingEnd: boolean; scrollTop: number; viewportHeight: number },
    width: number,
  ): string[] {
    if (view.isFollowingEnd) this.seen = this.revision;
    this.chipRow = this.chipRowFor(view, lines.length);
    if (this.chipRow === undefined) return lines;
    const out = lines.slice();
    out[this.chipRow] = newOutputChip(this.style, width);
    return out;
  }

  /** Whether the chip would be on another row now than when it was last drawn (the view moved or resized). */
  newOutputStale(view: { isFollowingEnd: boolean; scrollTop: number; viewportHeight: number }, rows: number): boolean {
    return this.chipRowFor(view, rows) !== this.chipRow;
  }

  private chipRowFor(
    view: { isFollowingEnd: boolean; scrollTop: number; viewportHeight: number },
    rows: number,
  ): number | undefined {
    if (view.isFollowingEnd || this.revision === this.seen || view.viewportHeight < 3) return undefined;
    const row = view.scrollTop + view.viewportHeight - 1;
    return row >= 0 && row < rows ? row : undefined;
  }
}
