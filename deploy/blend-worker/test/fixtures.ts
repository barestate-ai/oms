import type { ChatInput, Completion, Dependencies, Message, Provider, RequestLog } from '../src/core/types.ts';
import { MemorySessions } from '../src/core/sessions.ts';

export const SECRET = 'PRIVATE-PROMPT-AND-KEY-DO-NOT-LOG';
export const tool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
};
export const call = {
  id: 'call_1',
  type: 'function' as const,
  function: { name: 'read_file', arguments: '{"path":"src/lib.rs"}' },
};
export const messages: Message[] = [
  { role: 'system', content: SECRET },
  { role: 'user', content: 'Read src/lib.rs' },
];
export function input(stream = false): ChatInput {
  return {
    model: 'single',
    messages: structuredClone(messages),
    stream,
    maxTokens: 1024,
    tools: [tool as NonNullable<ChatInput['tools']>[number]],
  };
}
export const zero = { input: 0, output: 0, cached: 0, cacheWrite: 0 };
export function completion(text: string | null = 'ok'): Completion {
  return {
    message: { role: 'assistant', content: text },
    usage: { input: 100, cached: 20, cacheWrite: 0, output: 30 },
    finishReason: 'stop',
    deltas: text ? [{ content: text }] : [],
  };
}
export const chatTokens = {
  prompt_tokens: 100,
  completion_tokens: 30,
  total_tokens: 130,
  prompt_tokens_details: { cached_tokens: 20 },
};
export function chatData(content: string | null = 'ok', tools = false) {
  return {
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, reasoning_content: SECRET, ...(tools ? { tool_calls: [call] } : {}) },
        finish_reason: tools ? 'tool_calls' : 'stop',
      },
    ],
    usage: chatTokens,
  };
}
export function sse(events: Array<Record<string, unknown> | string>, crlf = false): Response {
  const text = events
    .map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`)
    .join('')
    .replace(/\n/g, crlf ? '\r\n' : '\n');
  const data = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < data.length; i += 3) controller.enqueue(data.slice(i, i + 3));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
export function chatStream(tools = true): Response {
  return sse(
    [
      { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: SECRET } }] },
      { choices: [{ index: 0, delta: { content: '🦀ok' } }] },
      ...(tools
        ? [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: call.id,
                        type: 'function',
                        function: { name: 'read_file', arguments: '{"path":' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"src/lib.rs"}' } }] } }],
            },
          ]
        : []),
      { choices: [{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }] },
      { choices: [], usage: chatTokens },
      '[DONE]',
    ],
    true,
  );
}
export const anthTokens = {
  input_tokens: 100,
  cache_read_input_tokens: 20,
  cache_creation_input_tokens: 10,
  output_tokens: 40,
};
export function anthropicData() {
  return {
    content: [
      { type: 'thinking', thinking: SECRET },
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: call.id, name: 'read_file', input: { path: 'src/lib.rs' } },
    ],
    usage: anthTokens,
    stop_reason: 'tool_use',
  };
}
export function anthropicStream() {
  return sse([
    { type: 'message_start', message: { usage: { ...anthTokens, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: SECRET } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: call.id, name: 'read_file', input: {} },
    },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"src/lib.rs"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
    { type: 'message_stop' },
  ]);
}
export function dependencies(model = 'grok-4.3'): { deps: Dependencies; logs: RequestLog[] } {
  const logs: RequestLog[] = [];
  return {
    logs,
    deps: {
      fetch: async () => Response.json(chatData()),
      keys: Object.fromEntries(['anthropic', 'xai', 'opencode-go', 'muse'].map((p) => [p, SECRET])) as Record<
        Provider,
        string
      >,
      sessions: new MemorySessions(),
      profiles: { single: { type: 'single', model } },
      log: (line) => {
        logs.push(line);
      },
      now: () => Date.parse('2026-11-20T12:00:00Z'),
    },
  };
}
export function request(body: Record<string, unknown> = {}, session?: string): Request {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(session ? { 'x-blend-session': session } : {}) },
    body: JSON.stringify({ model: 'single', messages, ...body }),
  });
}
