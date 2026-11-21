import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conversation } from '../src/tui/transcript.ts';

const cwd = '/work/project';
const options = { cwd };
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const plain = (lines: string[]) => lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

const KEY = 'sk-test-1234567890abcdef';
const ENV = `# local\nAPI_KEY=${KEY}\nRPC_URL=http://localhost:8899\n`;
const assistant = (content: unknown[]) => ({
  role: 'assistant',
  content,
  stopReason: 'toolUse',
  usage,
  api: 'x',
  provider: 'p',
  model: 'm',
  timestamp: 2,
});
const history = [
  { role: 'user', content: 'Read .env', timestamp: 1 },
  assistant([
    { type: 'text', text: `The key is ${KEY} and DB_PASSWORD=hunter2 is set.` },
    { type: 'toolCall', id: 'r1', name: 'read', arguments: { path: '.env' } },
    { type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'cat .env' } },
    { type: 'toolCall', id: 'b2', name: 'bash', arguments: { command: 'env | head' } },
  ]),
  { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: [{ type: 'text', text: ENV }], isError: false },
  { role: 'toolResult', toolCallId: 'b1', toolName: 'bash', content: [{ type: 'text', text: ENV }], isError: false },
  {
    role: 'toolResult',
    toolCallId: 'b2',
    toolName: 'bash',
    content: [{ type: 'text', text: `HOME=/Users/dev\nGITHUB_TOKEN=ghp_${'a'.repeat(36)}\nOTHER=${KEY}\n` }],
    isError: false,
  },
];

function screens(conversation: Conversation) {
  const collapsed = plain(conversation.render(100));
  conversation.toggleToolOutput();
  return { collapsed, expanded: plain(conversation.render(100)) };
}

function assertHidden({ collapsed, expanded }: { collapsed: string; expanded: string }) {
  for (const screen of [collapsed, expanded]) {
    for (const secret of [KEY, 'hunter2', 'ghp_aaaa', 'localhost:8899', 'ghp_'])
      assert.ok(!screen.includes(secret), `${secret} is not on screen`);
  }
  assert.match(expanded, /API_KEY=••••/);
  assert.match(expanded, /RPC_URL=••••/);
  assert.match(expanded, /# local/);
  assert.match(expanded, /GITHUB_TOKEN=••••/);
  assert.match(expanded, /HOME=\/Users\/dev/, 'ordinary variables outside env files stay');
  assert.match(expanded, /DB_PASSWORD=••••/);
}

test('secret values never reach the screen, collapsed or after Ctrl+O', () => {
  assertHidden(screens(new Conversation(history, undefined, options)));
});

test('the same holds for a live conversation', () => {
  const conversation = new Conversation([], undefined, options);
  const accept = (event: unknown) => conversation.accept(event as never);
  const [, call, ...results] = history as [unknown, ReturnType<typeof assistant>, ...Record<string, unknown>[]];
  accept({ type: 'message_start', message: call });
  accept({ type: 'message_end', message: call });
  for (const result of results) {
    accept({ type: 'tool_execution_start', toolCallId: result.toolCallId, toolName: result.toolName, args: {} });
    accept({
      type: 'tool_execution_end',
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      isError: false,
      result: { content: result.content },
    });
  }
  assertHidden(screens(conversation));
});

test('writing an env file does not show its values when expanded', () => {
  const write = assistant([
    { type: 'text', text: 'Writing it.' },
    { type: 'toolCall', id: 'w1', name: 'write', arguments: { path: '.env.local', content: ENV } },
  ]);
  const conversation = new Conversation(
    [
      write,
      {
        role: 'toolResult',
        toolCallId: 'w1',
        toolName: 'write',
        content: [{ type: 'text', text: 'ok' }],
        details: { created: true, lines: 3 },
        isError: false,
      },
    ],
    undefined,
    options,
  );
  const { collapsed, expanded } = screens(conversation);
  for (const screen of [collapsed, expanded]) assert.ok(!screen.includes(KEY) && !screen.includes('8899'));
  assert.match(expanded, /RPC_URL=••••/);
});

test('what the model received is unchanged by display masking', () => {
  const before = JSON.stringify(history);
  screens(new Conversation(history, undefined, options));
  assert.equal(JSON.stringify(history), before);
});
