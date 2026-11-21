import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HarnessSession } from '@oms/engine';
import { claudeChatStatus, nativeChatDisplayHistory } from '../src/tui/claude-chat.ts';

function fixture(provider = 'claude-code') {
  const messages = [{ role: 'user', content: 'Previous OMS history' }];
  const calls: string[] = [];
  let status: { sessionId?: string; state: 'new' | 'ready' | 'disconnected'; detail?: string } = { state: 'new' };
  const harness = {
    session: { model: { provider, id: 'sonnet' }, messages, sessionManager: {} },
    nativeChat: {
      status: () => status,
      async reconnect() {
        calls.push('reconnect');
        status = { sessionId: status.sessionId, state: 'ready' };
      },
      async reset() {
        calls.push('reset');
        status = { sessionId: 'fresh-native-id', state: 'new' };
      },
    },
  } as unknown as HarnessSession;
  return {
    harness,
    calls,
    messages,
    status(value: typeof status) {
      status = value;
    },
  };
}

test('restart display restores durable native boundaries in order without modifying model history', () => {
  const f = fixture();
  const oldMessage = { role: 'user', content: 'Old native question' };
  const newMessage = { role: 'user', content: 'New native question' };
  f.harness.session.sessionManager.getBranch = () =>
    [
      { type: 'message', message: oldMessage },
      { type: 'custom', customType: 'unrelated-private-state', data: { secret: 'do-not-render' } },
      { type: 'custom', customType: 'oms.claude.native-boundary', data: { sessionId: 'fresh-native-id' } },
      { type: 'message', message: newMessage },
    ] as ReturnType<typeof f.harness.session.sessionManager.getBranch>;
  const before = structuredClone(f.messages);
  const display = nativeChatDisplayHistory(f.harness);
  assert.equal(display[0], oldMessage);
  assert.match(JSON.stringify(display[1]), /new Claude chat.*fresh-native-id/);
  assert.equal(display[2], newMessage);
  assert.equal(JSON.stringify(display).includes('do-not-render'), false);
  assert.deepEqual(f.messages, before);
});

test('native status reports observed state and ID without starting or reconnecting a chat', () => {
  const f = fixture();
  assert.match(claudeChatStatus(f.harness), /Native Claude session: not started\nState: new/);
  f.status({ sessionId: 'existing-native-id', state: 'disconnected', detail: 'Process stopped' });
  const output = claudeChatStatus(f.harness);
  assert.match(output, /existing-native-id\nState: disconnected\nProcess stopped/);
  assert.match(output, /Claude Code keeps this history · \/clear starts a new chat$/);
  assert.doesNotMatch(output, /\/claude/);
  assert.deepEqual(f.calls, []);
});

test('inactive Claude history is visible through session status without mutating either conversation', () => {
  const f = fixture('openai');
  f.status({ sessionId: 'retained-native-id', state: 'disconnected' });
  const before = structuredClone(f.messages);
  const output = claudeChatStatus(f.harness);
  assert.match(output, /retained-native-id/);
  assert.match(output, /Claude Code is not selected · \/model to switch back to its saved chat$/);
  assert.deepEqual(f.messages, before);
  assert.deepEqual(f.calls, []);
});

test('older runtime status is explicit when native controls are unavailable', () => {
  const f = fixture();
  delete f.harness.nativeChat;
  assert.match(claudeChatStatus(f.harness), /unavailable here/);
});
