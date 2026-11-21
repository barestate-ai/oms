import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conversation } from '../src/tui/transcript.ts';

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content: unknown[], stopReason = 'stop') => ({
  role: 'assistant',
  content,
  stopReason,
  usage,
  api: 'x',
  provider: 'p',
  model: 'm',
  timestamp: 2,
});
const prose = (n: number) =>
  `## Step ${n}\n\n` +
  Array.from({ length: 50 }, (_, i) => `- point ${i} with \`code\` and **bold** text that goes on a little while`).join(
    '\n',
  ) +
  '\n\n```ts\nconst a = 1;\n```\n';

/** A long saved conversation: a prompt, an answer in Markdown, a command, a read and an edit, many times. */
function history(turns: number): unknown[] {
  const messages: unknown[] = [];
  for (let n = 0; n < turns; n++) {
    messages.push({ role: 'user', content: `Do step ${n}`, timestamp: n });
    messages.push(
      assistant(
        [
          { type: 'text', text: prose(n) },
          { type: 'toolCall', id: `b${n}`, name: 'bash', arguments: { command: `step ${n}` } },
          { type: 'toolCall', id: `e${n}`, name: 'edit', arguments: { path: 'a.rs', edits: [] } },
        ],
        'toolUse',
      ),
    );
    messages.push({
      role: 'toolResult',
      toolCallId: `b${n}`,
      content: [{ type: 'text', text: Array.from({ length: 30 }, (_, i) => `out ${i}`).join('\n') }],
    });
    messages.push({
      role: 'toolResult',
      toolCallId: `e${n}`,
      content: [{ type: 'text', text: 'ok' }],
      details: { diff: ' 1 a\n-2 b\n+2 c\n 3 d' },
    });
  }
  return messages;
}

test('a 2,000-line conversation redraws only the streaming answer in each frame', () => {
  const conversation = new Conversation(history(35), undefined, { cwd: '/work' });
  const accept = (event: unknown) => conversation.accept(event as never);
  const started = performance.now();
  const lines = conversation.render(100);
  const cold = performance.now() - started;
  assert.ok(lines.length > 2000, `a long conversation (${lines.length} rows)`);

  // The answer streams in word by word, a frame after each.
  const message = assistant([{ type: 'text', text: 'Streaming' }]);
  accept({ type: 'message_start', message });
  conversation.render(100);
  const before = new Map(conversation.redraws);
  const frames = 200;
  const times: number[] = [];
  let text = 'Streaming';
  for (let i = 0; i < frames; i++) {
    text += ` word${i} with **markdown** and \`code\``;
    accept({ type: 'message_update', message: assistant([{ type: 'text', text }]) });
    const t = performance.now();
    conversation.render(100);
    times.push(performance.now() - t);
  }
  const redrawn = [...conversation.redraws].filter(([key, count]) => count !== (before.get(key) ?? 0));
  assert.equal(redrawn.length, 1, `only the streaming entry is drawn again: ${redrawn.map(([key]) => key)}`);
  assert.equal(redrawn[0]![1] - (before.get(redrawn[0]![0]) ?? 0), frames);

  times.sort((a, b) => a - b);
  const median = times[Math.floor(frames / 2)]!;
  console.log(
    `# ${lines.length} rows: first frame ${cold.toFixed(1)} ms, streaming frame median ${median.toFixed(2)} ms`,
  );
  // The design budget is 4 ms for a frame.
  assert.ok(median < 4, `a streaming frame took ${median.toFixed(2)} ms`);
});

test('a frame with nothing new draws nothing again, and a new width or Ctrl+O draws everything once', () => {
  const conversation = new Conversation(history(5), undefined, { cwd: '/work' });
  const first = conversation.render(100);
  const drawn = new Map(conversation.redraws);
  const second = conversation.render(100);
  assert.deepEqual(second, first);
  assert.deepEqual(conversation.redraws, drawn, 'an unchanged conversation is not drawn again');
  conversation.render(80);
  const widened = [...conversation.redraws].filter(([key, count]) => count > (drawn.get(key) ?? 0));
  assert.equal(widened.length, drawn.size, 'a new width draws every entry once');
  const at80 = new Map(conversation.redraws);
  conversation.render(80);
  assert.deepEqual(conversation.redraws, at80);
  conversation.toggleToolOutput();
  conversation.render(80);
  assert.ok([...conversation.redraws].some(([key, count]) => count > (at80.get(key) ?? 0)));
});
