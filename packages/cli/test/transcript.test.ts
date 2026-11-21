import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conversation } from '../src/tui/transcript.ts';

const cwd = '/work/project';
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const plain = (lines: string[]) =>
  lines
    .join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\]133;[A-C]\x07/g, '');

const BIG = Array.from({ length: 80 }, (_, i) => `line ${i + 1} of the file`).join('\n');
const calls = [
  { id: 'r1', name: 'read', arguments: { path: 'src/big.ts', offset: 1, limit: 80 } },
  { id: 'w1', name: 'write', arguments: { path: 'hello.mjs', content: 'console.log("hello");\nconsole.log(1);\n' } },
  { id: 'w2', name: 'write', arguments: { path: 'old.txt', content: 'new line\n' } },
  { id: 'e1', name: 'edit', arguments: { path: 'hello.mjs', edits: [{ oldText: 'hello', newText: 'hi' }] } },
  { id: 'b1', name: 'bash', arguments: { command: 'node hello.mjs' } },
  { id: 'f1', name: 'web_fetch', arguments: { url: 'https://solana.com/docs' } },
  { id: 's1', name: 'solana_docs_search', arguments: { query: 'priority fees' } },
];
const results: Record<string, { text: string; details?: unknown }> = {
  r1: { text: BIG },
  w1: { text: 'Successfully wrote', details: { created: true, lines: 2 } },
  w2: { text: 'Successfully wrote', details: { created: false, lines: 1, diff: '-1 old line\n+1 new line' } },
  e1: { text: 'Edited', details: { diff: '-1 console.log("hello");\n+1 console.log("hi");', firstChangedLine: 1 } },
  b1: { text: Array.from({ length: 12 }, (_, i) => `out ${i + 1}`).join('\n') + '\n' },
  f1: { text: '{"raw":"json","blob":true}' },
  s1: { text: '{"results":[{"title":"raw json"}]}' },
};
const assistant = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'Plan: write, run, edit.' },
    { type: 'text', text: 'Working on it.' },
    ...calls.map((call) => ({ type: 'toolCall', ...call })),
  ],
  stopReason: 'toolUse',
  usage,
  api: 'x',
  provider: 'p',
  model: 'm',
  timestamp: 2,
};
const options = { cwd };

function streamed(): Conversation {
  const conversation = new Conversation([], undefined, options);
  const accept = (event: unknown) => conversation.accept(event as never);
  accept({ type: 'message_start', message: { role: 'user', content: 'Do the task', timestamp: 1 } });
  accept({ type: 'message_start', message: assistant });
  accept({ type: 'message_end', message: assistant });
  for (const call of calls) {
    accept({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
    const result = results[call.id]!;
    accept({
      type: 'tool_execution_end',
      toolCallId: call.id,
      toolName: call.name,
      isError: false,
      result: { content: [{ type: 'text', text: result.text }], details: result.details },
    });
  }
  return conversation;
}

test('tool calls are one-line rows that say what happened, not what was read or written', () => {
  const screen = plain(streamed().render(100));
  assert.match(screen, /∴ Thought/, 'thinking is one folded line');
  assert.ok(!screen.includes('Plan: write, run, edit.'), 'the thinking itself waits for Ctrl+T');
  assert.match(screen, /● Read {2}src\/big\.ts:1-80\n {2}⎿ {2}80 lines/);
  assert.ok(!screen.includes('line 40 of the file'), 'a read never dumps the file');
  assert.match(screen, /● Wrote {2}hello\.mjs\n {2}⎿ {2}2 lines/);
  assert.ok(!screen.includes('console.log(1)'), 'a new file shows no content');
  assert.match(screen, /● Wrote {2}old\.txt {2}\+1 −1/);
  assert.match(screen, /1 − old line/);
  assert.match(screen, /1 \+ new line/);
  assert.match(screen, /● Edited {2}hello\.mjs {2}\+1 −1/);
  assert.match(screen, /1 − console\.log\("hello"\);/);
  assert.match(screen, /1 \+ console\.log\("hi"\);/);
  assert.match(screen, /● Ran {2}node hello\.mjs/);
  assert.match(screen, /out 12/);
  assert.match(screen, /out 1\n/, 'a command shows its first rows');
  assert.match(screen, /… \+7 lines/, 'and its last, with the count of what is left out');
  assert.doesNotMatch(screen, /out 5\n/);
  assert.match(screen, /● Explored {2}1 search · 1 page/);
  assert.match(screen, /Searched "priority fees"/);
  assert.match(screen, /Opened solana\.com\/docs/);
  assert.ok(!screen.includes('"raw"') && !screen.includes('"results"'), 'no raw JSON');
});

test('Ctrl+O shows the whole output and Ctrl+T opens the thinking', () => {
  const conversation = streamed();
  assert.equal(conversation.toggleToolOutput(), true);
  const expanded = plain(conversation.render(100));
  assert.match(expanded, /line 40 of the file/);
  assert.match(expanded, /console\.log\(1\)/);
  assert.match(expanded, /out 1\n/);
  assert.match(expanded, /out 5\n/);
  assert.match(expanded, /Searched Solana docs "priority fees" · 1 result/);
  assert.equal(conversation.toggleThinking(), false, 'false: the thinking is no longer folded');
  assert.match(plain(conversation.render(100)), /Plan: write, run, edit\./);
  assert.equal(conversation.toggleThinking(), true);
  assert.ok(!plain(conversation.render(100)).includes('Plan: write, run, edit.'));
});

test('a restored conversation reads the same as the live one', () => {
  const live = plain(streamed().render(100));
  const history = [
    { role: 'user', content: 'Do the task', timestamp: 1 },
    assistant,
    ...calls.map((call) => ({
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: results[call.id]!.text }],
      details: results[call.id]!.details,
      isError: false,
      timestamp: 3,
    })),
  ];
  const restored = plain(new Conversation(history, undefined, options).render(100));
  const strip = (text: string) => text.replace(/Took [\d.]+s/g, '').replace(/\s+/g, ' ');
  assert.equal(strip(restored), strip(live));
});

test('an absolute path inside the folder is shown relative to it, and the edit diff still appears', () => {
  const absolute = [
    { ...calls[3]!, arguments: { path: `${cwd}/src/hello.mjs`, edits: [{ oldText: 'hello', newText: 'hi' }] } },
    { ...calls[0]!, arguments: { path: `${cwd}/src/big.ts` } },
  ];
  const message = { ...assistant, content: absolute.map((call) => ({ type: 'toolCall', ...call })) };
  const conversation = new Conversation([], undefined, options);
  conversation.accept({ type: 'message_start', message } as never);
  conversation.accept({ type: 'message_end', message } as never);
  for (const call of absolute) {
    conversation.accept({
      type: 'tool_execution_start',
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    } as never);
    const result = results[call.id]!;
    conversation.accept({
      type: 'tool_execution_end',
      toolCallId: call.id,
      toolName: call.name,
      isError: false,
      result: { content: [{ type: 'text', text: result.text }], details: result.details },
    } as never);
  }
  const screen = plain(conversation.render(100));
  assert.match(screen, /Edited {2}src\/hello\.mjs/);
  assert.match(screen, /Read {2}src\/big\.ts/);
  assert.ok(!screen.includes(cwd), 'the folder prefix is dropped');
  assert.match(screen, /1 \+ console\.log\("hi"\);/);
});

test('only the latest collapsed entry names the key that expands it', () => {
  const screen = plain(streamed().render(100));
  assert.equal(screen.match(/ctrl\+o to expand/g)?.length, 1);
  assert.match(screen, /Opened solana\.com\/docs \(ctrl\+o to expand\)$/, 'on the last entry');
});
