import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from './index.ts';
test('independent vector 1', () => {
  const input = {
    epoch: 10,
    net: '1',
    first: {
      at: 10,
      old: { bps: 101, max: '19' },
      next: { bps: 2501, max: '2001' },
    },
    second: {
      at: 11,
      old: { bps: 3333, max: '1049' },
      next: { bps: 2501, max: '2001' },
    },
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    gross: '3',
    firstFee: '1',
    secondFee: '1',
    net: '1',
  });
  assert.deepEqual(input, original);
});
test('independent vector 5', () => {
  const input = {
    epoch: 10,
    net: '11',
    first: {
      at: 10,
      old: { bps: 101, max: '19' },
      next: { bps: 2501, max: '2001' },
    },
    second: {
      at: 11,
      old: { bps: 3333, max: '1049' },
      next: { bps: 2501, max: '2001' },
    },
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    gross: '23',
    firstFee: '6',
    secondFee: '6',
    net: '11',
  });
  assert.deepEqual(input, original);
});
