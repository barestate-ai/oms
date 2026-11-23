import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { emptySavings, parseSavings, recordTurn, savingsSummary, type TurnUsage } from '../src/tui/savings.ts';
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

test('questions, unbenchmarked models and a turned-off receipt show nothing', () => {
  assert.equal(recordTurn(emptySavings(), [opus(5_000)]).receipt, undefined);
  assert.equal(recordTurn(emptySavings(), [opus(5_000)]).state.tasks, 0);
  const other = recordTurn(emptySavings(), [{ ...opus(90_000), model: 'deepseek-v4-pro' }]);
  assert.deepEqual(other, { state: emptySavings() });
  const off = recordTurn({ ...emptySavings(), off: true }, [opus(100_000)]);
  assert.equal(off.receipt, undefined);
  assert.equal(off.state.tasks, 1, 'the total still counts');
});

test('after the first, the receipt comes back on the fifth task and then only at milestones', () => {
  let state = emptySavings();
  const kinds: string[] = [];
  for (let task = 1; task <= 12; task++) {
    const turn = recordTurn(state, [opus(150_000)]);
    state = turn.state;
    if (turn.receipt) kinds.push(`${task}:${turn.receipt.kind}`);
  }
  // Each task keeps ~240k, so the 1M mark falls on the fifth task (shown as the repeat) and nothing until 5M.
  assert.deepEqual(kinds, ['1:first', '5:repeat']);
  state = { ...state, keptTokens: 4_900_000 };
  assert.equal(recordTurn(state, [opus(150_000)]).receipt?.milestone, 5_000_000);
});

test('a saved total survives only when well formed', () => {
  assert.deepEqual(parseSavings({ tasks: 2, keptTokens: 10, keptMicroUsd: 3, off: true }), {
    tasks: 2,
    keptTokens: 10,
    keptMicroUsd: 3,
    off: true,
  });
  assert.equal(parseSavings({ tasks: -1, keptTokens: 0, keptMicroUsd: 0 }), undefined);
  assert.equal(parseSavings('x'), undefined);
  assert.match(savingsSummary(emptySavings()), /No finished tasks/);
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
  assert.ok(rows.some((row) => row.includes('barestate.xyz/oh-my-sol')));
  assert.ok(conversation.render(40).length > 0, 'a narrow terminal still draws it');
});

test('hour-long cache writes are priced at the long-write rate', () => {
  const short = recordTurn(emptySavings(), [{ ...opus(0), cacheWrite: 100_000 }]).receipt!;
  const long = recordTurn(emptySavings(), [{ ...opus(0), cacheWrite: 100_000, cacheWrite1h: 100_000 }]).receipt!;
  assert.ok(long.omsMicroUsd! > short.omsMicroUsd!);
});

test('milestones before the fifth task wait for the fifth-task receipt', () => {
  const early = recordTurn({ tasks: 2, keptTokens: 900_000, keptMicroUsd: 0 }, [opus(150_000)]);
  assert.equal(early.receipt, undefined);
  assert.equal(early.state.tasks, 3);
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
