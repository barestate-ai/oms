import assert from 'node:assert/strict';
import test from 'node:test';
import { costUsd, MODELS } from '../src/core/pricing.ts';
import { zero } from './fixtures.ts';
const at = Date.parse('2026-11-20T12:00:00Z');
function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}
test('15 shortlisted models: cached, uncached and output cost at list rates', () => {
  assert.equal(Object.keys(MODELS).length, 15);
  const expected: Record<string, number[]> = {
    'claude-fable-5-2': [8, 40, 0.2],
    'claude-opus-5-5': [4, 20, 0.2],
    'claude-sonnet-5-5': [2, 10, 0.1],
    'claude-haiku-5-5': [0.1, 0.5, 0.01],
    'grok-4.7': [2, 6, 0.5],
    'grok-4.3': [1.25, 2.5, 0.2],
    'deepseek-v4-pro': [0.66, 1.98, 0.022],
    'deepseek-v4.1-flash': [0.15, 0.6, 0.003],
    'mimo-v2.6-pro': [0.435, 0.87, 0.003625],
    'mimo-v2.6-flash': [0.14, 0.28, 0.0028],
    'qwen3.8-flash': [0.15, 0.47, 0.016],
    'muse-wonder-1.0': [4, 20, 0.2],
    'muse-spark-1.3': [1.25, 4.25, 0.15],
    'muse-spark-1.3-contributor': [0.1, 0.2, 0.002],
    'muse-ember-1.0': [0.1, 0.5, 0.004],
  };
  for (const [model, [i, o, c]] of Object.entries(expected))
    close(
      costUsd(model, { input: 1000, cached: 200, output: 300, cacheWrite: 0 }, at),
      (800 * i! + 200 * c! + 300 * o!) / 1e6,
    );
});
test('tier boundaries use exact provider-specific inequalities and whole-request rates', () => {
  close(costUsd('claude-haiku-5-5', { ...zero, input: 100000 }, at), 0.01);
  close(costUsd('claude-haiku-5-5', { ...zero, input: 100001 }, at), 0.0500005);
  close(costUsd('grok-4.7', { ...zero, input: 199999 }, at), 0.399998);
  close(costUsd('grok-4.7', { ...zero, input: 200000 }, at), 0.8);
  close(costUsd('grok-4.3', { ...zero, input: 200000 }, at), 0.5);
  close(costUsd('muse-ember-1.0', { ...zero, input: 200000 }, at), 0.02);
  close(costUsd('muse-ember-1.0', { ...zero, input: 200001 }, at), 0.0600003);
});
test('Go DeepSeek weekday UTC peak windows include cached and output rates', () => {
  const u = { input: 1000, cached: 200, output: 300, cacheWrite: 0 };
  const base = costUsd('deepseek-v4-pro', u, at);
  for (const time of ['2026-11-20T01:00Z', '2026-11-20T03:59Z', '2026-11-20T06:00Z', '2026-11-20T09:59Z'])
    close(costUsd('deepseek-v4-pro', u, Date.parse(time)), base * 2);
  for (const time of [
    '2026-11-20T00:59Z',
    '2026-11-20T04:00Z',
    '2026-11-20T10:00Z',
    '2026-11-21T02:00Z',
    '2026-11-22T07:00Z',
  ])
    close(costUsd('deepseek-v4-pro', u, Date.parse(time)), base);
  close(costUsd('mimo-v2.6-pro', u, Date.parse('2026-11-20T02:00Z')), costUsd('mimo-v2.6-pro', u, at));
});
test('five-minute Anthropic cache writes have 1.25x input rate, and zeros are free', () => {
  close(
    costUsd('claude-sonnet-5-5', { input: 100, cached: 20, cacheWrite: 10, output: 5 }, at),
    (70 * 2 + 20 * 0.1 + 10 * 2 * 1.25 + 5 * 10) / 1e6,
  );
  for (const model of Object.keys(MODELS)) assert.equal(costUsd(model, zero, at), 0);
});
test('invalid token domains and cached totals are rejected', () => {
  for (const input of [-1, 0.5, NaN, Infinity]) assert.throws(() => costUsd('grok-4.3', { ...zero, input }, at));
  assert.throws(() => costUsd('grok-4.3', { ...zero, input: 1, cached: 2 }, at));
  assert.throws(() => costUsd('unknown', zero, at));
});
