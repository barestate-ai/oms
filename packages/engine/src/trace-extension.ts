/**
 * Trace extension: mirrors the session into the append-only JSONL trace from
 * `@oms/core` and, optionally, redacts what the model itself sees.
 *
 * Two invariants it must never break:
 *
 * - A trace failure never breaks a turn. `createTraceWriter().append` returns a result
 *   instead of throwing, and this file additionally catches anything a sink or a
 *   redactor does throw, so a full disk or an unwritable path only loses trace lines.
 * - Secrets stay out of both sinks. Every event is passed through the injected
 *   redactor before it reaches the writer, and with `redactModelView` the same
 *   redactor rewrites `content` *and* `structuredContent` of a tool result, because
 *   Pi drops structured content when only `content` is replaced
 *   (docs/extensions.md, tool_result section).
 */

import type {
  AgentBeforeSettleEvent,
  ExtensionFactory,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultEventResult,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import type { TraceEventInput, TraceWriteResult } from '@oms/core';
import { hideKnowledgeBlocks, knowledgeTopic, KNOWLEDGE_TOOL_NAMES } from './runtime/knowledge-service.ts';

/** The slice of `createTraceWriter()` this extension needs. */
export interface TraceSink {
  append(event: TraceEventInput): TraceWriteResult;
}

/**
 * Deep redactor: scrubs every string in the value it is given. `createDeepRedactor`
 * from `@oms/core` drops in here as-is; identity is allowed because the redactor
 * decision belongs to the caller.
 */
export type Redactor = (value: unknown) => unknown;

export interface TraceWriteFailure {
  readonly code: string;
  readonly message: string;
}

export interface TraceExtensionOptions {
  readonly writer: TraceSink;
  /** Deep redactor applied to every field written to the trace. Defaults to identity. */
  readonly redact?: Redactor;
  /** Apply the same redactor to the tool result the model sees. */
  readonly redactModelView?: boolean;
  /** Called with each failed write. Never allowed to throw into the session. */
  readonly onWriteError?: (failure: TraceWriteFailure) => void;
}

const identity: Redactor = (value: unknown): unknown => value;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Text blocks of an assistant message, joined; empty for any other role. */
function assistantText(message: unknown): string {
  const record = asRecord(message);
  if (record === null || record['role'] !== 'assistant' || !Array.isArray(record['content'])) return '';
  const parts: string[] = [];
  for (const entry of record['content'] as unknown[]) {
    const blockItem = asRecord(entry);
    if (blockItem === null) continue;
    if (blockItem['type'] === 'text' && typeof blockItem['text'] === 'string') parts.push(blockItem['text']);
  }
  return parts.join('\n');
}

function toolCallNames(message: unknown): string[] {
  const record = asRecord(message);
  if (record === null || record['role'] !== 'assistant' || !Array.isArray(record['content'])) return [];
  const names: string[] = [];
  for (const entry of record['content'] as unknown[]) {
    const blockItem = asRecord(entry);
    if (blockItem === null) continue;
    if (blockItem['type'] === 'toolCall' && typeof blockItem['name'] === 'string') names.push(blockItem['name']);
  }
  return names;
}

function usageOf(message: unknown): Record<string, unknown> | undefined {
  const record = asRecord(message);
  if (record === null) return undefined;
  const usage = asRecord(record['usage']);
  return usage ?? undefined;
}

export function createTraceExtension(options: TraceExtensionOptions): ExtensionFactory {
  const writer = options.writer;
  const redact = options.redact ?? identity;

  const report = (failure: TraceWriteFailure): void => {
    // A failing error callback is the caller's bug, but it still must not break a turn.
    try {
      options.onWriteError?.(failure);
    } catch {
      // Dropped: nothing above this can react to a trace problem.
    }
  };

  const write = (input: TraceEventInput): void => {
    try {
      const safe = redact(input) as TraceEventInput;
      const result = writer.append(safe);
      if (!result.ok) report({ code: result.code, message: result.message });
    } catch (error) {
      report({ code: 'E_TRACE', message: errorMessage(error) });
    }
  };

  const onTurnEnd = (event: TurnEndEvent): void => {
    const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
    write({
      type: 'turn',
      turnIndex: event.turnIndex,
      text: hideKnowledgeBlocks(assistantText(event.message)),
      toolCalls: toolCallNames(event.message),
      toolResults: toolResults.map((result) => {
        const record = asRecord(result) ?? {};
        return {
          toolCallId: typeof record['toolCallId'] === 'string' ? record['toolCallId'] : '',
          toolName: typeof record['toolName'] === 'string' ? record['toolName'] : '',
          isError: record['isError'] === true,
        };
      }),
      usage: usageOf(event.message),
      outcome: event.outcome,
    });
  };

  const onToolCall = (event: ToolCallEvent): void => {
    write({
      type: 'tool_call',
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: asRecord(event.input) ?? {},
    });
  };

  const onToolResult = (event: ToolResultEvent): ToolResultEventResult | undefined => {
    const knowledge = KNOWLEDGE_TOOL_NAMES.includes(event.toolName);
    write({
      type: 'tool_result',
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      isError: event.isError === true,
      content: knowledge
        ? [{ type: 'text', text: `${event.isError ? 'Solana knowledge unavailable' : 'fetched Solana knowledge'}: ${knowledgeTopic(event.input)}` }]
        : event.content.map((part) => part.type === 'text' ? { ...part, text: hideKnowledgeBlocks(part.text) } : part),
      structuredContent: knowledge ? undefined : event.structuredContent,
    });
    if (options.redactModelView !== true) return undefined;

    // The redactor keeps the shape and rewrites strings inside it, so these casts
    // restore the types the event already had.
    const content = redact(event.content) as ToolResultEvent['content'];
    const structuredContent =
      event.structuredContent === undefined
        ? undefined
        : (redact(event.structuredContent) as ToolResultEvent['structuredContent']);
    // `structuredContent` must travel with a replaced `content`, or Pi drops it.
    return structuredContent === undefined ? { content } : { content, structuredContent };
  };

  const onBeforeSettle = (event: AgentBeforeSettleEvent): void => {
    write({
      type: 'settle',
      outcome: event.outcome,
      canContinue: event.context?.canContinue === true,
      pendingMessages: Array.isArray(event.context?.pendingMessages) ? event.context.pendingMessages.length : 0,
    });
  };

  return (pi) => {
    pi.on('turn_end', onTurnEnd);
    pi.on('tool_call', onToolCall);
    pi.on('tool_result', onToolResult);
    pi.on('agent_before_settle', onBeforeSettle);
  };
}
