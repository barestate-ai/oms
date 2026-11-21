import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import type { OmsSession } from '@oms/engine';
import {
  TasksDashboard,
  age,
  collectRows,
  summary,
  transcriptText,
  type DashboardSources,
} from '../src/tui/tasks-dashboard.ts';
import { getTheme } from '../src/tui/theme.ts';
import { chatFixture, fixture, withHelpers } from '../test-support/fake-session.ts';

const NOW = 1_000_000;
const sources: DashboardSources = {
  tasks: () => [{ id: 'old-task', since: NOW - 3 * 86_400_000 }],
  worktrees: async () => [{ path: '/work/feature', branch: 'feature/x' }],
};

test('ages are the fewest characters', () => {
  assert.equal(age(undefined, NOW), '');
  assert.equal(age(NOW - 12_000, NOW), '12s');
  assert.equal(age(NOW - 4 * 60_000, NOW), '4m');
  assert.equal(age(NOW - 3 * 3_600_000, NOW), '3h');
  assert.equal(age(NOW - 2 * 86_400_000, NOW), '2d');
  assert.equal(age(NOW + 5000, NOW), '0s');
});

test("a task session lists itself, with its requirements, then the workspace's other tasks", async () => {
  const f = fixture();
  const rows = await collectRows({
    harness: f.harness as unknown as OmsSession,
    now: NOW,
    busy: false,
    awaiting: false,
    startedAt: NOW - 60_000,
    sources,
  });
  assert.deepEqual(
    rows.map((row) => [row.kind, row.state, row.name]),
    [
      ['session', 'idle', 'rental-ledger · rent'],
      ['task', 'idle', 'old-task'],
    ],
  );
  assert.match(rows[0]!.detail, /This task · 0\/2 requirements/);
  const busy = await collectRows({
    harness: f.harness as unknown as OmsSession,
    now: NOW,
    busy: true,
    awaiting: false,
    startedAt: 0,
    sources,
  });
  assert.equal(busy[0]!.state, 'working');
  const waiting = await collectRows({
    harness: f.harness as unknown as OmsSession,
    now: NOW,
    busy: true,
    awaiting: true,
    startedAt: 0,
    sources,
  });
  assert.equal(waiting[0]!.state, 'awaiting');
  assert.match(waiting[0]!.detail, /Waiting for your answer/);
});

test('a chat lists its helper agents with states and its other worktrees', async () => {
  const f = chatFixture();
  withHelpers(f);
  const rows = await collectRows({
    harness: f.harness as unknown as OmsSession,
    now: NOW,
    busy: false,
    awaiting: false,
    startedAt: 0,
    sources,
  });
  assert.deepEqual(
    rows.map((row) => [row.kind, row.state, row.name, row.detail]),
    [
      ['session', 'idle', 'rental-ledger', 'This folder'],
      ['helper', 'done', 'explore · find vault PDA seeds', 'Done'],
      ['helper', 'idle', 'build · add close_vault', 'Waiting for build#1'],
    ],
  );
  Object.assign(f.harness, { folder: { ...(f.harness as unknown as { folder: object }).folder, git: true } });
  const withTrees = await collectRows({
    harness: f.harness as unknown as OmsSession,
    now: NOW,
    busy: false,
    awaiting: false,
    startedAt: 0,
    sources,
  });
  assert.equal(withTrees.at(-1)!.name, 'feature/x');
  assert.equal(withTrees.at(-1)!.kind, 'worktree');
  assert.deepEqual(
    summary(withTrees).map((chip) => chip.text),
    ['○ 3 idle', '✓ 1 done'],
  );
});

test('the summary counts each state and leaves empty ones out', () => {
  const chips = summary([
    { key: '1', kind: 'helper', state: 'working', name: '', detail: '' },
    { key: '2', kind: 'helper', state: 'working', name: '', detail: '' },
    { key: '3', kind: 'helper', state: 'awaiting', name: '', detail: '' },
    { key: '4', kind: 'helper', state: 'idle', name: '', detail: '' },
  ]);
  assert.deepEqual(
    chips.map((chip) => chip.text),
    ['◆ 1 awaiting', '● 2 working', '○ 1 idle'],
  );
});

test('helper conversations read as plain text without tool arguments', () => {
  const text = transcriptText([
    { role: 'user', content: 'find the vault seeds' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking.' },
        { type: 'toolCall', name: 'read', arguments: { path: '/secret/.env' } },
      ],
    },
    { role: 'toolResult', content: [{ type: 'text', text: 'seeds = [b"vault"]' }] },
    { role: 'assistant', content: [] },
  ]);
  assert.match(text, /Task\nfind the vault seeds/);
  assert.match(text, /Helper\nLooking\.\n\[tool: read\]/);
  assert.match(text, /Result\nseeds/);
  assert.doesNotMatch(text, /secret|\.env/);
  assert.equal(transcriptText([]), 'No messages yet.');
});

test('the dashboard shows glyphs, ages and chips; Enter on a session goes back, a helper opens its text, another task shows its command', async () => {
  const f = chatFixture();
  withHelpers(f);
  Object.assign(f.harness, { folder: { ...(f.harness as unknown as { folder: object }).folder, git: true } });
  const log: string[] = [];
  const dashboard = new TasksDashboard({
    theme: () => getTheme('gruvbox')!,
    render() {},
    harness: f.harness as unknown as OmsSession,
    busy: () => true,
    awaiting: () => false,
    startedAt: NOW - 120_000,
    sources,
    now: () => NOW,
    back: () => log.push('back'),
    openReport: (id, text, title) => log.push(`report ${id} ${title} ${text.split('\n')[0]}`),
    copy: (text) => log.push(`copy ${text}`),
    say: (message) => log.push(`say ${message}`),
    requestFocus() {},
  });
  await dashboard.refresh();
  const screen = () =>
    renderLayoutFrame(dashboard.body, 100, 8, () => {}).lines.map((line) => stripTerminalSequences(line));
  const shown = screen();
  assert.match(shown[0]!, /Tasks +● 1 working · ○ 2 idle · ✓ 1 done/);
  assert.match(shown[1]!, /● rental-ledger +Agent working +2m/);
  assert.match(shown[2]!, /✓ explore · find vault PDA seeds +Done +/);
  assert.match(shown[3]!, /○ build · add close_vault +Waiting for build#1/);
  dashboard.handleInput('\r');
  assert.deepEqual(log, ['back']);
  dashboard.handleInput('\x1b[B');
  dashboard.handleInput('\r');
  assert.match(log.at(-1)!, /^report helper-explore#1 helper explore#1 No messages yet\.$/);
  dashboard.handleInput('\x1b[F');
  dashboard.handleInput('\r');
  assert.match(log.at(-2)!, /^copy cd \/work\/feature && (oms|npx @barestate\/oms)$/);
  assert.match(log.at(-1)!, /^say Another task opens in its own session\. Copied: cd \/work\/feature/);
  assert.equal(dashboard.handleInput('x'), false);
  dashboard.dispose();
});
