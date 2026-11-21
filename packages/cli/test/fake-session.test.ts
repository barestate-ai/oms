import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatFixture, start } from '../test-support/fake-session.ts';

test('the fake session kit drives a chat from first screen to quit', async () => {
  const f = chatFixture();
  const { terminal, close } = start(f.harness, 100, 30);
  try {
    await terminal.until((s) => s.includes('/help'));
    terminal.send('hello from the kit');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    assert.deepEqual(f.prompts, ['hello from the kit']);
  } finally {
    f.promptGate.resolve();
    f.abortGate.resolve();
    await close();
  }
  assert.equal(f.listeners.size, 0);
});
