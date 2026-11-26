import { object, stripThinking } from './input.ts';
import { modelSpec } from './pricing.ts';
import { readSse } from './sse.ts';
import { BlendError, UpstreamError, invalid } from './types.ts';
import type { ChatInput, Completion, Delta, Message, Provider, ToolCall, Usage } from './types.ts';

export const ENDPOINTS: Record<Provider, string> = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  xai: 'https://api.x.ai/v1/chat/completions',
  'opencode-go': 'https://opencode.ai/zen/go/v1/chat/completions',
  muse: 'https://api.meta.ai/v1/chat/completions',
};

const failure = () => new UpstreamError(502, 'Invalid upstream response.', 'parse_error');
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw failure();
  return value;
}
export function chatUsage(value: unknown): Usage {
  const u = object(value);
  const input = count(u.prompt_tokens ?? u.input_tokens);
  let output = count(u.completion_tokens ?? u.output_tokens);
  const reasoning = count(
    object(u.completion_tokens_details ?? u.output_tokens_details).reasoning_tokens ?? u.reasoning_tokens ?? 0,
  );
  if (reasoning && u.total_tokens === input + output + reasoning) output += reasoning;
  const cached = count(
    object(u.prompt_tokens_details ?? u.input_tokens_details).cached_tokens ?? u.cache_read_input_tokens ?? 0,
  );
  const cacheWrite = count(u.cache_creation_input_tokens ?? 0);
  if (cached + cacheWrite > input) throw failure();
  return { input, output, cached, cacheWrite };
}
export function anthropicUsage(value: unknown): Usage {
  const u = object(value);
  const cached = count(u.cache_read_input_tokens ?? 0),
    cacheWrite = count(u.cache_creation_input_tokens ?? 0);
  return {
    input: count(u.input_tokens) + cached + cacheWrite,
    cached,
    cacheWrite,
    output: count(u.output_tokens ?? 0),
  };
}
function json(text: string): Record<string, unknown> {
  try {
    return object(JSON.parse(text));
  } catch {
    throw failure();
  }
}
function finish(reason: unknown): string {
  return reason === 'tool_use'
    ? 'tool_calls'
    : reason === 'max_tokens'
      ? 'length'
      : reason === 'end_turn' || reason === 'stop_sequence'
        ? 'stop'
        : typeof reason === 'string'
          ? reason
          : 'stop';
}
function cleanMessage(value: unknown): Message {
  const m = object(value);
  const result: Message = {
    role: 'assistant',
    content: typeof m.content === 'string' ? stripThinking(m.content) : null,
  };
  if (m.tool_calls !== undefined) {
    if (!Array.isArray(m.tool_calls)) throw failure();
    result.tool_calls = m.tool_calls.map((raw) => {
      const c = object(raw),
        f = object(c.function);
      if (typeof c.id !== 'string' || !c.id || typeof f.name !== 'string' || typeof f.arguments !== 'string')
        throw failure();
      return { id: c.id, type: 'function', function: { name: f.name, arguments: f.arguments } };
    });
  }
  return result;
}
function messageDeltas(message: Message): Delta[] {
  const deltas: Delta[] = [];
  if (message.content) deltas.push({ content: message.content });
  message.tool_calls?.forEach((call, index) => deltas.push({ tool_calls: [{ index, ...call }] }));
  return deltas;
}

const CACHE = { type: 'ephemeral', ttl: '5m' };
export function anthropicBody(input: ChatInput, model: string): Record<string, unknown> {
  const system = input.messages
    .filter((m) => m.role === 'system' && m.content)
    .map((m) => ({ type: 'text', text: m.content }));
  const messages: Array<{ role: 'user' | 'assistant'; content: Record<string, unknown>[] }> = [];
  for (const m of input.messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks: Record<string, unknown>[] = [];
    if (m.role === 'tool') blocks.push({ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' });
    else {
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.tool_calls ?? []) {
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          invalid('Tool-call arguments must be JSON objects for Anthropic.');
        }
        if (!args || typeof args !== 'object' || Array.isArray(args))
          invalid('Tool-call arguments must be JSON objects for Anthropic.');
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: args });
      }
    }
    if (!blocks.length) continue;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  // Three breakpoints at most: system plus two recent message blocks.
  const systems: Record<string, unknown>[] = system;
  if (systems.length) systems.at(-1)!.cache_control = CACHE;
  for (const m of messages.slice(-2)) m.content.at(-1)!.cache_control = CACHE;
  const body: Record<string, unknown> = { model, max_tokens: input.maxTokens, messages, stream: input.stream };
  if (system.length) body.system = system;
  if (input.temperature !== undefined) body.temperature = input.temperature;
  if (input.topP !== undefined) body.top_p = input.topP;
  if (input.stop) body.stop_sequences = input.stop;
  if (input.tools?.length)
    body.tools = input.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  if (input.toolChoice !== undefined) {
    const name = object(object(input.toolChoice).function).name;
    body.tool_choice =
      typeof name === 'string'
        ? { type: 'tool', name }
        : { type: input.toolChoice === 'required' ? 'any' : input.toolChoice };
  }
  return body;
}
function chatBody(input: ChatInput, model: string, provider: Provider): Record<string, unknown> {
  return {
    model,
    messages: input.messages,
    stream: input.stream,
    max_completion_tokens: input.maxTokens,
    ...(input.stream ? { stream_options: { include_usage: true } } : {}),
    ...(input.tools?.length ? { tools: input.tools } : {}),
    ...(input.toolChoice !== undefined ? { tool_choice: input.toolChoice } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { top_p: input.topP } : {}),
    ...(input.stop ? { stop: input.stop } : {}),
    ...(provider === 'muse' ? { store: false } : {}),
  };
}

async function chatResponse(response: Response, input: ChatInput, onUsage: (u: Usage) => void): Promise<Completion> {
  if (!input.stream) {
    const data = json(await response.text());
    if (data.usage) onUsage(chatUsage(data.usage));
    if (data.error) throw new UpstreamError(502, 'Upstream returned an error.', 'provider_error', true);
    if (!Array.isArray(data.choices) || !data.choices.length) throw failure();
    const choice = object(data.choices[0]);
    const usage = chatUsage(data.usage);
    onUsage(usage);
    const message = cleanMessage(choice.message);
    return {
      message,
      finishReason: finish(choice.finish_reason),
      usage,
      deltas: messageDeltas(message),
      reasoningChars:
        typeof object(choice.message).reasoning_content === 'string'
          ? String(object(choice.message).reasoning_content).length
          : 0,
    };
  }
  if (!response.body) throw failure();
  const deltas: Delta[] = [],
    calls = new Map<number, ToolCall>();
  let text = '',
    reasoningChars = 0,
    reason = 'stop',
    ended = false,
    usage: Usage | undefined;
  for await (const event of readSse(response.body)) {
    if (event.data === '[DONE]') {
      ended = true;
      break;
    }
    const data = json(event.data);
    if (data.usage) {
      usage = chatUsage(data.usage);
      onUsage(usage);
    }
    if (event.event === 'error' || data.error)
      throw new UpstreamError(502, 'Upstream stream failed.', 'stream_error', true);
    if (!Array.isArray(data.choices) || !data.choices.length) continue;
    const choice = object(data.choices[0]),
      delta = object(choice.delta);
    if (typeof delta.reasoning_content === 'string') reasoningChars += delta.reasoning_content.length;
    if (choice.finish_reason) reason = finish(choice.finish_reason);
    if (typeof delta.content === 'string') {
      text += delta.content;
      deltas.push({ content: delta.content });
    }
    if (Array.isArray(delta.tool_calls))
      for (const raw of delta.tool_calls) {
        const c = object(raw),
          fn = object(c.function),
          index = count(c.index);
        const current = calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        const part: NonNullable<Delta['tool_calls']>[number] = { index };
        if (typeof c.id === 'string') {
          current.id += c.id;
          part.id = c.id;
          part.type = 'function';
        }
        part.function = {};
        if (typeof fn.name === 'string') {
          current.function.name += fn.name;
          part.function.name = fn.name;
        }
        if (typeof fn.arguments === 'string') {
          current.function.arguments += fn.arguments;
          part.function.arguments = fn.arguments;
        }
        calls.set(index, current);
        deltas.push({ tool_calls: [part] });
      }
  }
  if (!ended) throw new UpstreamError(502, 'Truncated upstream event stream.', 'truncated_stream', true);
  if (!usage) throw failure();
  const tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  if (tool_calls.some((c) => !c.id || !c.function.name)) throw failure();
  const message: Message = {
    role: 'assistant',
    content: stripThinking(text) || null,
    ...(tool_calls.length ? { tool_calls } : {}),
  };
  // Embedded reasoning tags may span delta boundaries. Never forward their fragments.
  return {
    message,
    finishReason: reason,
    usage,
    deltas: text === stripThinking(text) ? deltas : messageDeltas(message),
    reasoningChars,
  };
}

async function anthropicResponse(
  response: Response,
  input: ChatInput,
  onUsage: (u: Usage) => void,
): Promise<Completion> {
  if (!input.stream) {
    const data = json(await response.text());
    if (data.error) {
      if (data.usage) onUsage(anthropicUsage(data.usage));
      throw new UpstreamError(502, 'Upstream returned an error.', 'provider_error', true);
    }
    if (!Array.isArray(data.content)) throw failure();
    const usage = anthropicUsage(data.usage);
    onUsage(usage);
    let text = '';
    const calls: ToolCall[] = [];
    for (const raw of data.content) {
      const block = object(raw);
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      if (block.type === 'tool_use') {
        if (typeof block.id !== 'string' || typeof block.name !== 'string') throw failure();
        calls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }
    const message: Message = {
      role: 'assistant',
      content: stripThinking(text) || null,
      ...(calls.length ? { tool_calls: calls } : {}),
    };
    return { message, finishReason: finish(data.stop_reason), usage, deltas: messageDeltas(message) };
  }
  if (!response.body) throw failure();
  const deltas: Delta[] = [],
    calls = new Map<number, { call: ToolCall; index: number; initial: unknown; partial: boolean }>();
  let text = '',
    reason = 'stop',
    ended = false,
    rawUsage: Record<string, unknown> = {},
    usage: Usage | undefined;
  for await (const event of readSse(response.body)) {
    const data = json(event.data),
      type = data.type ?? event.event;
    if (type === 'error') throw new UpstreamError(502, 'Upstream stream failed.', 'stream_error', true);
    if (type === 'message_start') {
      rawUsage = { ...object(object(data.message).usage) };
      usage = anthropicUsage(rawUsage);
      onUsage(usage);
    } else if (type === 'content_block_start') {
      const b = object(data.content_block);
      if (b.type === 'text' && typeof b.text === 'string' && b.text) {
        text += b.text;
        deltas.push({ content: b.text });
      }
      if (b.type === 'tool_use') {
        if (typeof b.id !== 'string' || typeof b.name !== 'string') throw failure();
        const index = calls.size;
        const call: ToolCall = { id: b.id, type: 'function', function: { name: b.name, arguments: '' } };
        calls.set(count(data.index), { call, index, initial: b.input ?? {}, partial: false });
        deltas.push({
          tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }],
        });
      }
    } else if (type === 'content_block_delta') {
      const d = object(data.delta);
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        text += d.text;
        deltas.push({ content: d.text });
      }
      if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        const c = calls.get(count(data.index));
        if (!c) throw failure();
        c.partial = true;
        c.call.function.arguments += d.partial_json;
        deltas.push({ tool_calls: [{ index: c.index, function: { arguments: d.partial_json } }] });
      }
    } else if (type === 'content_block_stop') {
      const c = calls.get(count(data.index));
      if (c && !c.partial) {
        c.call.function.arguments = JSON.stringify(c.initial);
        deltas.push({ tool_calls: [{ index: c.index, function: { arguments: c.call.function.arguments } }] });
      }
    } else if (type === 'message_delta') {
      rawUsage = { ...rawUsage, ...object(data.usage) };
      usage = anthropicUsage(rawUsage);
      onUsage(usage);
      reason = finish(object(data.delta).stop_reason);
    } else if (type === 'message_stop') {
      ended = true;
      break;
    }
  }
  if (!ended) throw new UpstreamError(502, 'Truncated upstream event stream.', 'truncated_stream', true);
  if (!usage) throw failure();
  const tool_calls = [...calls.values()].map((c) => c.call);
  const message: Message = {
    role: 'assistant',
    content: stripThinking(text) || null,
    ...(tool_calls.length ? { tool_calls } : {}),
  };
  return {
    message,
    finishReason: reason,
    usage,
    deltas: text === stripThinking(text) ? deltas : messageDeltas(message),
  };
}

export function estimatedInput(model: string, input: ChatInput): number {
  const provider = modelSpec(model).provider;
  return (
    utf8Bytes(
      JSON.stringify(provider === 'anthropic' ? anthropicBody(input, model) : chatBody(input, model, provider)),
    ) + 1024
  );
}
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export async function callUpstream(
  model: string,
  input: ChatInput,
  options: {
    fetch: typeof fetch;
    key: string | undefined;
    session: string;
    signal: AbortSignal;
    onUsage: (usage: Usage) => void;
    onStatus?: (status: number) => void;
  },
): Promise<Completion> {
  if (!options.key) throw new UpstreamError(503, 'Provider is not configured.', 'not_configured');
  const provider = modelSpec(model).provider;
  const body = provider === 'anthropic' ? anthropicBody(input, model) : chatBody(input, model, provider);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (provider === 'anthropic') {
    headers['x-api-key'] = options.key;
    headers['anthropic-version'] = '2023-06-01';
  } else headers.authorization = `Bearer ${options.key}`;
  if (provider === 'opencode-go') {
    headers['user-agent'] = 'OMS-Blend/0.0.1 coding-agent';
    headers['x-opencode-session'] = options.session;
  }
  try {
    const response = await options.fetch(ENDPOINTS[provider], {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    options.onStatus?.(response.status);
    if (!response.ok) {
      if (response.body) {
        const reader = response.body.getReader();
        let text = '',
          size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1024 * 1024) break;
            text += new TextDecoder().decode(value);
          }
          const data = json(text);
          if (data.usage) {
            const value = object(data.usage);
            options.onUsage(
              provider === 'anthropic'
                ? anthropicUsage(value)
                : chatUsage({ ...value, completion_tokens: value.completion_tokens ?? value.output_tokens ?? 0 }),
            );
          }
        } catch {
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      throw new UpstreamError(
        response.status === 429 ? 429 : 502,
        response.status === 429 ? 'Upstream rate limit exceeded.' : 'Upstream request failed.',
        response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'http_5xx' : 'http_4xx',
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    return await (provider === 'anthropic'
      ? anthropicResponse(response, input, options.onUsage)
      : chatResponse(response, input, options.onUsage));
  } catch (error) {
    if (error instanceof BlendError) throw error;
    throw new UpstreamError(
      options.signal.aborted ? 504 : 502,
      options.signal.aborted ? 'Upstream request timed out or was cancelled.' : 'Upstream request failed.',
      options.signal.aborted ? (options.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled') : 'transport',
      !options.signal.aborted || options.signal.reason?.name === 'TimeoutError',
    );
  }
}
