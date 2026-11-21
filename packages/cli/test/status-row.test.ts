import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { glyphsFor } from '../src/tui/glyphs.ts';
import {
  budgetFact,
  contextFact,
  costFact,
  edge,
  gitBranch,
  shortModelName,
  statusHints,
  statusRow,
  type StatusFact,
} from '../src/tui/status-row.ts';
import { getTheme } from '../src/tui/theme.ts';

const theme = getTheme('oms-ember')!;
const glyphs = glyphsFor({});
const plain = (text: string) => stripTerminalSequences(text);

test('model names are short: no vendor, no date, dotted versions', () => {
  const table: [string, string][] = [
    ['anthropic/claude-sonnet-4-5-20250929', 'sonnet-4.5'],
    ['claude-opus-4-1-20250805', 'opus-4.1'],
    ['claude-3-5-sonnet-20241022', '3.5-sonnet'],
    ['claude-sonnet-latest', 'sonnet'],
    ['gpt-5.1-codex', 'gpt-5.1-codex'],
    ['grok-code-fast-1', 'grok-code-fast-1'],
    ['gemini-2.5-pro', 'gemini-2.5-pro'],
    ['openrouter/anthropic/claude-haiku-4-5', 'haiku-4.5'],
    ['sonnet', 'sonnet'],
    ['a-very-long-model-name-that-keeps-going-and-going', 'a-very-long-model-name-…'],
    ['test\nmodel', 'test model'],
  ];
  for (const [id, short] of table) assert.equal(shortModelName(id), short, id);
});

test('context turns warning at 80% and error at 95%, as a whole number with a label', () => {
  assert.deepEqual(contextFact(23.4), { key: 'context', text: '23% ctx', role: 'muted' });
  assert.equal(contextFact(79.4).role, 'muted');
  assert.equal(contextFact(80).role, 'warning');
  assert.equal(contextFact(94.9).role, 'error');
  assert.equal(contextFact(95).role, 'error');
  assert.equal(contextFact(100).text, '100% ctx');
});

test('cost shows from half a cent, to the cent', () => {
  assert.equal(costFact(4999), undefined);
  assert.equal(costFact(5000)?.text, '$0.01');
  assert.equal(costFact(420_000)?.text, '$0.42');
  assert.equal(costFact(12_345_678)?.text, '$12.35');
});

test('the budget only speaks when it is nearly spent or used up', () => {
  const budget = (left: number, extra: Partial<Parameters<typeof budgetFact>[0]> = {}) => ({
    caps: { tokens: 1000, spendMicroUsd: 1000, wallClockMs: 1000 },
    remaining: { tokens: left * 10, spendMicroUsd: 1000, wallClockMs: 1000 },
    exhausted: false,
    executionMode: 'bounded',
    ...extra,
  });
  assert.equal(budgetFact(budget(50)), undefined);
  assert.deepEqual(budgetFact(budget(8)), { key: 'budget', text: 'budget 8% left', role: 'warning' });
  assert.deepEqual(budgetFact(budget(0, { exhausted: true })), {
    key: 'budget',
    text: 'budget used up',
    role: 'error',
  });
  // An interactive turn does not count the spend cap.
  assert.equal(
    budgetFact(
      budget(50, { executionMode: 'interactive', remaining: { tokens: 500, spendMicroUsd: 0, wallClockMs: 900 } }),
    ),
    undefined,
  );
});

test('the git branch comes from HEAD, in a repository and in a worktree, and is absent when detached', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'oms-branch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'repo');
  mkdirSync(join(repository, '.git'), { recursive: true });
  writeFileSync(join(repository, '.git', 'HEAD'), 'ref: refs/heads/oms/escrow\n');
  assert.equal(gitBranch(repository), 'oms/escrow');
  const worktree = join(root, 'worktree');
  mkdirSync(worktree);
  mkdirSync(join(root, 'gitdir'));
  writeFileSync(join(root, 'gitdir', 'HEAD'), 'ref: refs/heads/feature\n');
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(root, 'gitdir')}\n`);
  assert.equal(gitBranch(worktree), 'feature');
  writeFileSync(join(repository, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
  assert.equal(gitBranch(repository), undefined);
  assert.equal(gitBranch(join(root, 'nowhere')), undefined);
});

const fact = (key: StatusFact['key'], text: string, extra: Partial<StatusFact> = {}): StatusFact => ({
  key,
  text,
  role: 'muted',
  ...extra,
});
const FACTS = [
  fact('folder', 'escrow'),
  fact('branch', 'oms/escrow'),
  fact('chip', 'surfpool', { dot: 'success' }),
  fact('model', 'sonnet-4.5'),
  { key: 'context', text: '23% ctx', role: 'muted' } as StatusFact,
  fact('cost', '$0.42'),
  { key: 'yolo', text: 'YOLO', role: 'error', bold: true } as StatusFact,
];
const HINTS = [
  ['/', 'commands'],
  ['?', 'shortcuts'],
  ['ctrl+q', 'quit'],
] as const;

test('the status row has hints left, facts right, separated by dots, and fits its width', () => {
  const row = statusRow(theme, glyphs, { width: 120, hints: HINTS, facts: FACTS });
  assert.equal(visibleWidth(row) <= 120, true);
  assert.equal(
    plain(row).trimEnd().replace(/ {3,}/, '   '),
    '  / commands · ? shortcuts · ctrl+q quit   escrow · oms/escrow · ● surfpool · sonnet-4.5 · 23% ctx · $0.42 · YOLO',
  );
  assert.ok(row.includes('\x1b[1mYOLO'), 'YOLO is bold');
});

test('narrow rows drop facts in order: cost, branch, chips, model, folder; context and YOLO stay', () => {
  const sides = (width: number) => {
    const [left, right] = plain(statusRow(theme, glyphs, { width, hints: HINTS, facts: FACTS }))
      .trim()
      .split(/ {2,}/);
    return [left!, right!];
  };
  const every = '/ commands · ? shortcuts · ctrl+q quit';
  const all = 'escrow · oms/escrow · ● surfpool · sonnet-4.5 · 23% ctx · $0.42 · YOLO';
  assert.deepEqual(sides(120), [every, all]);
  // The first hint always survives; hints beyond it come back only when the facts leave room.
  assert.deepEqual(sides(100), ['/ commands', all]);
  assert.deepEqual(sides(80), ['/ commands', all.replace(' · $0.42', '')]);
  assert.deepEqual(sides(70), ['/ commands', 'escrow · ● surfpool · sonnet-4.5 · 23% ctx · YOLO']);
  assert.deepEqual(sides(60), ['/ commands', 'escrow · sonnet-4.5 · 23% ctx · YOLO']);
  assert.deepEqual(sides(50), ['/ commands', 'escrow · 23% ctx · YOLO']);
  assert.deepEqual(sides(30), ['/ commands', '23% ctx · YOLO']);
  // Context and YOLO are never dropped, even when nothing else fits.
  const [hintless] = [plain(statusRow(theme, glyphs, { width: 24, hints: HINTS, facts: FACTS })).trim()];
  assert.equal(hintless, '23% ctx · YOLO');
});

test('a toast replaces the hints, and the facts give way until it fits', () => {
  const row = (toast: string, width: number) =>
    plain(statusRow(theme, glyphs, { width, hints: HINTS, facts: FACTS, toast }));
  assert.match(row('Theme set to Ember', 120), /^ {2}Theme set to Ember {3,}escrow · oms\/escrow/);
  assert.doesNotMatch(row('Theme set to Ember', 120), /commands/);
  const narrow = row('Cancellation requested; awaiting the live session outcome.', 90);
  assert.ok(narrow.includes('Cancellation requested; awaiting the live session outcome.'), narrow);
  assert.ok(narrow.includes('23% ctx') && narrow.includes('YOLO'));
  assert.ok(!narrow.includes('oms/escrow') && !narrow.includes('sonnet-4.5'), 'facts were dropped to make room');
});

test('the narrow margin is one column and the hints state follows the screen', () => {
  assert.equal(edge(79), 1);
  assert.equal(edge(80), 2);
  const base = { overlay: false, busy: false, popup: false, view: 'harness', focus: 'input' } as const;
  const text = (state: Parameters<typeof statusHints>[0]) =>
    statusHints(state)
      .map((hint) => hint.join(' '))
      .join(' · ');
  assert.equal(text(base), '/ commands · ? shortcuts · ctrl+q quit');
  assert.equal(text({ ...base, busy: true }), 'esc interrupt · / commands');
  assert.equal(text({ ...base, popup: true }), '↑↓ choose · tab complete · enter run');
  assert.equal(text({ ...base, usage: '/error <code> [program]' }), 'usage /error <code> [program] · enter run');
  assert.equal(
    text({ ...base, approval: 'once-or-session' }),
    'y allow once · s allow for this session · n / esc deny',
  );
  assert.equal(text({ ...base, approval: 'once' }), 'y allow once · n / esc deny');
  assert.equal(text({ ...base, overlay: true }), '', 'an overlay carries its own hints in its border');
  assert.equal(text({ ...base, view: 'workbench', focus: 'editor' }), 'ctrl+k commands · ctrl+p files · ctrl+s save');
  assert.equal(text({ ...base, focus: 'terminal' }), 'ctrl+l chat · ctrl+k commands');
  assert.equal(text({ ...base, focus: 'conversation' }), 'esc back to chat · ↑↓ scroll');
});
