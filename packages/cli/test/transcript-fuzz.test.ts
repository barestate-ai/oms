import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Conversation } from '../src/tui/transcript.ts';

/** A repeatable pseudo-random generator: the same sequence of odd events on every run. */
function generator(seed: number) {
  let state = seed;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)]!;
  return { next, pick };
}

test('whatever events and history arrive, every row is one physical line inside the width', () => {
  const { next, pick } = generator(20_251_121);
  const odd = () =>
    pick<unknown>([
      undefined,
      null,
      0,
      true,
      '',
      'a\x1b[31mb\x1b]52;c;X\x07',
      '‮',
      'é'.repeat(50),
      { a: 1 },
      [1, 2],
      'line\n'.repeat(30),
      '{"results":[1]}',
      'custom program error: 0xbc4',
      'Command exited with code 3',
      'word '.repeat(2600),
      '\r\n',
    ]);
  const text = () =>
    pick([
      '',
      'x',
      'a\x1b[31mb',
      'é'.repeat(50),
      'line\n'.repeat(30),
      '```ts\ncode',
      '# h\n- a\n',
      'word '.repeat(2600),
    ]);
  const names = [
    'read',
    'bash',
    'edit',
    'write',
    'ls',
    'grep',
    'find',
    'agent',
    'web_fetch',
    'decode_error',
    'x\ny',
    '',
  ];
  const block = () =>
    pick<unknown>([
      { type: 'text', text: text() },
      { type: 'thinking', thinking: text() },
      { type: 'toolCall', id: String(Math.floor(next() * 5)), name: pick(names), arguments: odd() },
      { type: 'image' },
      odd(),
    ]);
  const message = () => ({
    role: pick(['user', 'assistant', 'toolResult', 'bashExecution', 'system', undefined]),
    content: pick<unknown>([odd(), [block(), block()], [block()]]),
    stopReason: pick(['stop', 'error', 'aborted', 'length', 'toolUse', undefined]),
    errorMessage: pick<unknown>([undefined, text()]),
    toolCallId: String(Math.floor(next() * 5)),
    isError: next() < 0.3,
    details: odd(),
    command: odd(),
    output: odd(),
    exitCode: odd(),
    cancelled: next() < 0.2,
    usage: odd(),
  });
  for (let round = 0; round < 40; round++) {
    const conversation = new Conversation(
      Array.from({ length: Math.floor(next() * 6) }, message) as never[],
      undefined,
      {
        cwd: pick(['/w', undefined, '']),
        rows: () => 40,
      },
    );
    for (let step = 0; step < 8; step++) {
      conversation.accept({
        type: pick([
          'message_start',
          'message_update',
          'message_end',
          'tool_execution_start',
          'tool_execution_update',
          'tool_execution_end',
          'agent_start',
          'agent_settled',
        ]),
        message: message(),
        toolCallId: String(Math.floor(next() * 5)),
        toolName: pick(names),
        args: odd(),
        partialResult: odd(),
        result: odd(),
        isError: next() < 0.5,
        aborted: next() < 0.5,
      } as never);
      if (next() < 0.2) conversation.note(String(odd() ?? ''), String(odd() ?? ''));
      if (next() < 0.1) conversation.toggleToolOutput();
      if (next() < 0.1) conversation.toggleThinking();
      const width = pick([1, 2, 5, 20, 40, 80, 200]);
      const lines = conversation.render(width);
      for (const line of lines) {
        assert.ok(!line.includes('\n'), 'a row never holds a line break');
        assert.ok(visibleWidth(line) <= width, `a row is wider than ${width}`);
      }
      if (next() < 0.3) conversation.click(Math.floor(next() * Math.max(1, lines.length)));
    }
  }
});
