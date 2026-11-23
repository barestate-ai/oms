import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { emptySavings, parseSavings, recordTurn, type TurnUsage } from '../src/tui/savings.ts';
import { interfacePreferences, readTuiPreferences } from '../src/tui/preferences.ts';
import { getTheme } from '../src/tui/theme.ts';
import { Conversation } from '../src/tui/transcript.ts';

const opus = (input: number): TurnUsage => ({
  model: 'claude-opus-5-5',
  input,
  output: 2000,
  cacheRead: 0,
  cacheWrite: 0,
});
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());

test('the first task gets a receipt at the published ratio, priced from the catalog', () => {
  const { state, receipt } = recordTurn(emptySavings(), [opus(100_000)]);
  assert.equal(receipt?.kind, 'first');
  assert.equal(receipt.rival, 'Claude Code');
  assert.equal(receipt.inputTokens, 100_000);
  assert.equal(receipt.rivalTokens, Math.round((100_000 * 475_987) / 183_079));
  assert.equal(receipt.percent, 62);
  // Opus: $4/M input, $20/M output.
  assert.equal(receipt.omsMicroUsd, 400_000 + 40_000);
  assert.equal(state.tasks, 1);
  assert.equal(state.keptTokens, receipt.rivalTokens - 100_000);
});

test('the Claude Code adapter names count as the same model', () => {
  assert.equal(recordTurn(emptySavings(), [{ ...opus(50_000), model: 'opus' }]).receipt?.model, 'Opus 5.5');
});

test('questions and unbenchmarked models show nothing', () => {
  assert.equal(recordTurn(emptySavings(), [opus(5_000)]).receipt, undefined);
  assert.equal(recordTurn(emptySavings(), [opus(5_000)]).state.tasks, 0);
  const other = recordTurn(emptySavings(), [{ ...opus(90_000), model: 'deepseek-v4-pro' }]);
  assert.deepEqual(other, { state: emptySavings() });
});

test('the receipt shows on tasks 1, 12 and 15, then every 25th', () => {
  let state = emptySavings();
  const kinds: string[] = [];
  for (let task = 1; task <= 75; task++) {
    const turn = recordTurn(state, [opus(150_000)]);
    state = turn.state;
    if (turn.receipt) kinds.push(`${task}:${turn.receipt.kind}`);
  }
  assert.deepEqual(kinds, ['1:first', '12:repeat', '15:repeat', '25:repeat', '50:repeat', '75:repeat']);
  assert.equal(state.tasks, 75);
});

test('a saved total survives only when well formed', () => {
  assert.deepEqual(parseSavings({ tasks: 2, keptTokens: 10, keptMicroUsd: 3, off: true }), {
    tasks: 2,
    keptTokens: 10,
    keptMicroUsd: 3,
  });
  assert.equal(parseSavings({ tasks: -1, keptTokens: 0, keptMicroUsd: 0 }), undefined);
  assert.equal(parseSavings('x'), undefined);
});

test('the receipt draws under the footer of a turn that worked', () => {
  const clock = { now: 1_000_000 };
  const conversation = new Conversation([], undefined, {
    now: () => clock.now,
    receipt: (usage) => recordTurn(emptySavings(), usage).receipt,
  });
  conversation.applyTheme(getTheme('gruvbox')!);
  const reply = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Done.' }],
    stopReason: 'stop',
    usage: { input: 20_000, output: 4000, cacheRead: 162_000, cacheWrite: 0, totalTokens: 186_000, cost: {} },
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    timestamp: 2,
  };
  conversation.accept({ type: 'agent_start' } as never);
  conversation.accept({ type: 'message_start', message: reply } as never);
  conversation.accept({ type: 'message_end', message: reply } as never);
  clock.now += 252_000;
  conversation.accept({ type: 'agent_settled', aborted: false } as never);
  const rows = plain(conversation.render(80));
  assert.ok(rows.includes('  Worked 4m 12s · ↓ 4k'));
  assert.ok(rows.some((row) => row.includes('OMS receipt')));
  assert.ok(rows.some((row) => /This task · Opus 5\.5 +182k input tokens +\$0\.19/.test(row)));
  assert.ok(rows.some((row) => /You kept +~291k tokens \(62%\)/.test(row)));
  assert.ok(rows.some((row) => /You just saved ~291k tokens \(~\$0\.18\)/.test(row)));
  assert.ok(rows.some((row) => row.includes('barestate.xyz/oh-my-sol')));
  assert.ok(conversation.render(40).length > 0, 'a narrow terminal still draws it');
});

test('hour-long cache writes are priced at the long-write rate', () => {
  const short = recordTurn(emptySavings(), [{ ...opus(0), cacheWrite: 100_000 }]).receipt!;
  const long = recordTurn(emptySavings(), [{ ...opus(0), cacheWrite: 100_000, cacheWrite1h: 100_000 }]).receipt!;
  assert.ok(long.omsMicroUsd! > short.omsMicroUsd!);
});

const settle = (stopReason: string, ms: number) => {
  const clock = { now: 0 };
  const seen: TurnUsage[][] = [];
  const conversation = new Conversation([], undefined, {
    now: () => clock.now,
    receipt: (usage) => void seen.push([...usage]) as undefined,
  });
  const reply = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Done.' }],
    stopReason,
    usage: { input: 50_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 50_100, cost: {} },
    model: 'claude-opus-5-5',
    timestamp: 1,
  };
  conversation.accept({ type: 'agent_start' } as never);
  conversation.accept({ type: 'message_end', message: reply } as never);
  clock.now += ms;
  conversation.accept({ type: 'agent_settled', aborted: false } as never);
  return seen;
};

test('a fast turn still counts, and a turn that ended on a provider error does not', () => {
  assert.equal(settle('stop', 1000).length, 1);
  assert.equal(settle('error', 60_000).length, 0);
});

test('two chats on the same state root both add to the saved total', () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-savings-'));
  try {
    const first = interfacePreferences(root);
    const second = interfacePreferences(root);
    for (const chat of [first, second]) chat.onSavingsChange(recordTurn(chat.readSavings(), [opus(100_000)]).state);
    assert.equal(readTuiPreferences(root).savings?.tasks, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
