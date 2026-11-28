import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatFixture, start } from '../test-support/fake-session.ts';

const reply = (text: string, stopReason = 'stop') => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason,
});

test('/handover has the agent write a note, then starts a new conversation from it', async () => {
  const f = chatFixture();
  f.messages.push({ role: 'user', content: 'fix the parser' }, reply('Fixed.'));
  const { terminal, close } = start(f.harness, 100, 30);
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('/handover the failing CI job');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    assert.match(f.prompts[0]!, /handover note[\s\S]*Make sure it covers: the failing CI job$/);
    assert.equal(f.clears(), 0, 'nothing is cleared while the note is being written');
    f.messages.push(reply('Goal: ship the parser fix.\nNext steps: rerun CI.'));
    f.promptGate.resolve();
    await terminal.until(() => f.prompts.length === 2);
    assert.equal(f.clears(), 1);
    assert.match(f.prompts[1]!, /^This is a handover from the previous session[\s\S]*Goal: ship the parser fix\./);
    await terminal.until((s) => s.includes('it starts from the handover note'));
  } finally {
    f.abortGate.resolve();
    await close();
  }
});

test('/handover keeps the conversation when no note comes back', async () => {
  const f = chatFixture();
  f.messages.push({ role: 'user', content: 'fix the parser' }, reply('Fixed.'));
  const { terminal, close } = start(f.harness, 100, 30);
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('/handover');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    f.messages.push(reply('', 'error'));
    f.promptGate.resolve();
    await terminal.until((s) => s.includes('this conversation continues'));
    assert.equal(f.clears(), 0);
    assert.equal(f.prompts.length, 1);
  } finally {
    f.abortGate.resolve();
    await close();
  }
});

test('/handover refuses an empty conversation', async () => {
  const f = chatFixture();
  const { terminal, close } = start(f.harness, 100, 30);
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('/handover');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Nothing to hand over yet'));
    assert.equal(f.prompts.length, 0);
  } finally {
    await close();
  }
});
