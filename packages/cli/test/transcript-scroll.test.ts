import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatFixture, clickText, start } from '../test-support/fake-session.ts';

const say = (text: string) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason: 'stop',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
});
const WHEEL_UP = '\x1b[<64;20;5M';
const WHEEL_DOWN = '\x1b[<65;20;5M';

test('scrolled up, output that arrives shows ▼ new output until the view is back at the end', async () => {
  const f = chatFixture();
  const { terminal, close } = start(f.harness, 100, 20);
  try {
    await terminal.screen();
    for (let i = 0; i < 40; i++) {
      const message = say(`older line ${i}`);
      f.emit({ type: 'message_start', message });
      f.emit({ type: 'message_end', message });
    }
    await terminal.until((s) => s.includes('older line 39'));
    assert.ok(!(await terminal.screen()).includes('new output'));
    for (let i = 0; i < 12; i++) terminal.send(WHEEL_UP);
    await terminal.until((s) => !s.includes('older line 39'));
    const fresh = say('fresh output');
    f.emit({ type: 'message_start', message: fresh });
    f.emit({ type: 'message_end', message: fresh });
    const screen = await terminal.until((s) => s.includes('▼ new output'));
    assert.ok(!screen.includes('fresh output'), 'the view stays where the reader is');
    for (let i = 0; i < 60; i++) terminal.send(WHEEL_DOWN);
    const end = await terminal.until((s) => s.includes('fresh output'));
    assert.ok(!end.includes('new output'), 'at the end the chip goes');
  } finally {
    f.promptGate.resolve();
    f.abortGate.resolve();
    await close();
  }
});

test('a click opens and folds the entry under it, and a click on the chip goes to the end', async () => {
  const f = chatFixture();
  const { terminal, close } = start(f.harness, 100, 24);
  try {
    await terminal.screen();
    const out = Array.from({ length: 40 }, (_, i) => `output row ${i}`).join('\n');
    f.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'build' } });
    f.emit({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      isError: false,
      result: { content: [{ type: 'text', text: out }] },
    });
    const folded = await terminal.until((s) => s.includes('output row 39'));
    assert.ok(folded.includes('… +35 lines') && !folded.includes('output row 10'));
    clickText(terminal, folded, '… +35 lines');
    // Open, the entry is taller than the view, which follows the end.
    const open = await terminal.until((s) => s.includes('output row 30') && !s.includes('output row 10'));
    assert.ok(!open.includes('… +35 lines'));
    clickText(terminal, open, 'output row 30');
    await terminal.until((s) => s.includes('… +35 lines') && !s.includes('output row 30'));

    for (let i = 0; i < 40; i++) {
      const message = say(`older line ${i}`);
      f.emit({ type: 'message_start', message });
      f.emit({ type: 'message_end', message });
    }
    await terminal.until((s) => s.includes('older line 39'));
    for (let i = 0; i < 12; i++) terminal.send(WHEEL_UP);
    await terminal.until((s) => !s.includes('older line 39'));
    const fresh = say('fresh output');
    f.emit({ type: 'message_start', message: fresh });
    f.emit({ type: 'message_end', message: fresh });
    const chip = await terminal.until((s) => s.includes('▼ new output'));
    clickText(terminal, chip, '▼ new output');
    await terminal.until((s) => s.includes('fresh output') && !s.includes('new output'));
  } finally {
    f.promptGate.resolve();
    f.abortGate.resolve();
    await close();
  }
});
