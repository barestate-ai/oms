import { invalid } from './types.ts';
import type { ChatInput, Message, ToolCall } from './types.ts';

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function stripThinking(text: string): string {
  return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
}
function content(value: unknown, assistant: boolean): string | null {
  if (value === null && assistant) return null;
  if (typeof value === 'string') return assistant ? stripThinking(value) : value;
  if (!Array.isArray(value)) invalid();
  return value
    .map((part) => {
      const block = object(part);
      if (['thinking', 'reasoning', 'redacted_thinking'].includes(String(block.type))) return '';
      if (block.type !== 'text' || typeof block.text !== 'string') invalid('Only text message content is supported.');
      return assistant ? stripThinking(block.text) : block.text;
    })
    .join('');
}
function toolCall(value: unknown): ToolCall {
  const call = object(value),
    fn = object(call.function);
  if (
    typeof call.id !== 'string' ||
    !call.id ||
    call.type !== 'function' ||
    typeof fn.name !== 'string' ||
    !/^[\w-]{1,64}$/.test(fn.name) ||
    typeof fn.arguments !== 'string'
  )
    invalid();
  return { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
}
export function parseInput(value: unknown): ChatInput {
  const input = object(value);
  if (
    typeof input.model !== 'string' ||
    !Array.isArray(input.messages) ||
    !input.messages.length ||
    (input.stream !== undefined && typeof input.stream !== 'boolean') ||
    (input.n !== undefined && input.n !== 1)
  )
    invalid();
  const messages: Message[] = input.messages.map((raw) => {
    const m = object(raw);
    const role = m.role === 'developer' ? 'system' : m.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') invalid();
    const message: Message = {
      role,
      content: content(m.content ?? (role === 'assistant' ? null : undefined), role === 'assistant'),
    };
    if (role === 'assistant' && m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls)) invalid();
      message.tool_calls = m.tool_calls.map(toolCall);
    }
    if (role === 'tool') {
      if (typeof m.tool_call_id !== 'string' || !m.tool_call_id) invalid();
      message.tool_call_id = m.tool_call_id;
    }
    return message;
  });
  for (const name of ['max_tokens', 'max_completion_tokens'])
    if (input[name] !== undefined && (!Number.isSafeInteger(input[name]) || Number(input[name]) < 1)) invalid();
  const result: ChatInput = {
    model: input.model,
    messages,
    stream: input.stream === true,
    maxTokens: Number(input.max_completion_tokens ?? input.max_tokens ?? 1024),
  };
  if (input.oms_failed_tool_calls !== undefined) {
    const ids = input.oms_failed_tool_calls;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) invalid();
    result.failedToolCalls = ids;
  }
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) invalid();
    result.tools = input.tools.map((raw) => {
      const tool = object(raw),
        fn = object(tool.function);
      if (
        tool.type !== 'function' ||
        typeof fn.name !== 'string' ||
        !/^[\w-]{1,64}$/.test(fn.name) ||
        !fn.parameters ||
        typeof fn.parameters !== 'object' ||
        Array.isArray(fn.parameters) ||
        (fn.description !== undefined && typeof fn.description !== 'string')
      )
        invalid();
      return {
        type: 'function',
        function: {
          name: fn.name,
          parameters: object(fn.parameters),
          ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
        },
      };
    });
  }
  if (input.tool_choice !== undefined) {
    const choice = object(input.tool_choice);
    if (
      !['auto', 'none', 'required'].includes(String(input.tool_choice)) &&
      !(choice.type === 'function' && typeof object(choice.function).name === 'string')
    )
      invalid();
    result.toolChoice = input.tool_choice;
  }
  for (const [source, target] of [
    ['temperature', 'temperature'],
    ['top_p', 'topP'],
  ] as const)
    if (input[source] !== undefined) {
      if (typeof input[source] !== 'number' || !Number.isFinite(input[source])) invalid();
      result[target] = input[source];
    }
  if (input.stop !== undefined) {
    const stop = typeof input.stop === 'string' ? [input.stop] : input.stop;
    if (!Array.isArray(stop) || stop.some((x) => typeof x !== 'string')) invalid();
    result.stop = stop;
  }
  return result;
}
