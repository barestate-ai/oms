import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import type { HarnessSettingsControls, HarnessSettingsSnapshot } from '@oms/engine';
import { HarnessSettingsPane } from '../src/tui/harness-settings.ts';
import { getTheme } from '../src/tui/theme.ts';

function fixture(supportsThinking = true) {
  const state: HarnessSettingsSnapshot = {
    thinkingLevel: 'off',
    availableThinkingLevels: supportsThinking ? ['off', 'low', 'high'] : [],
    supportsThinking,
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    httpIdleTimeoutMs: 300_000,
    defaultModel: 'synthetic/model',
  };
  const changes: string[] = [];
  const controls: HarnessSettingsControls = {
    snapshot: () => ({ ...state }),
    async setThinkingLevel(value) {
      state.thinkingLevel = value;
      changes.push(`thinking:${value}`);
    },
    async setSteeringMode(value) {
      state.steeringMode = value;
      changes.push(`steering:${value}`);
    },
    async setFollowUpMode(value) {
      state.followUpMode = value;
      changes.push(`followup:${value}`);
    },
    async setHttpIdleTimeoutMs(value) {
      state.httpIdleTimeoutMs = value;
      changes.push(`http:${value}`);
    },
  };
  let closed = false;
  const pane = new HarnessSettingsPane(
    { settings: controls },
    {
      theme: () => getTheme('gruvbox')!,
      rows: () => 30,
      render() {},
      close() {
        closed = true;
      },
      notice() {},
    },
  );
  return {
    pane,
    changes,
    state,
    closed: () => closed,
    screen: (width = 100) => stripVTControlCharacters(pane.body.render(width).join('\n')),
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('settings list changes the actual controls and reflects persisted values without closing the pane', async () => {
  const f = fixture();
  assert.equal(f.pane.label, 'Settings');
  assert.doesNotMatch(f.screen(), /Harness settings|SETTINGS|policy/);
  f.pane.handleInput('Thinking');
  f.pane.handleInput('\r');
  await flush();
  assert.deepEqual(f.changes, ['thinking:low']);
  assert.equal(f.state.thinkingLevel, 'low');
  assert.equal(f.closed(), false);
  assert.match(f.screen(), /low/);
  f.pane.handleInput('\x1b');
  assert.equal(f.closed(), true);
});

test('unsupported thinking and policy-fixed rows cannot manufacture setting changes', async () => {
  const f = fixture(false);
  f.pane.handleInput('Thinking');
  assert.match(f.screen(), /unavailable|not support/i);
  f.pane.handleInput('\r');
  await flush();
  assert.deepEqual(f.changes, []);
  f.pane.handleInput('\x15');
  f.pane.handleInput('Spend guards');
  assert.match(f.screen(), /compaction|retries/i);
  f.pane.handleInput('\r');
  await flush();
  assert.deepEqual(f.changes, []);
});

test('HTTP and queue preferences use canonical controls, while disposal prevents further mutation', async () => {
  const f = fixture();
  f.pane.handleInput('Messages while');
  f.pane.handleInput('\r');
  await flush();
  assert.deepEqual(f.changes, ['steering:all']);
  f.pane.handleInput('\x15');
  f.pane.handleInput('timeout');
  f.pane.handleInput('\r');
  await flush();
  assert.equal(f.changes[1], 'http:0');
  f.pane.dispose();
  f.pane.handleInput('\r');
  await flush();
  assert.equal(f.changes.length, 2);
});
