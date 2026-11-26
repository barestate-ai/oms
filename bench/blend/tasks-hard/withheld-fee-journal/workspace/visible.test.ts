import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from './index.ts';
test('independent vector 1', () => {
  const input = {
    epoch: 10,
    schedule: {
      at: 10,
      old: { bps: 101, max: '19' },
      next: { bps: 2501, max: '2001' },
    },
    mintWithheld: '3',
    accounts: [
      { id: 'a', balance: '10000', withheld: '0', frozen: false },
      { id: 'b', balance: '0', withheld: '2', frozen: false },
      { id: 'c', balance: '500', withheld: '3', frozen: true },
    ],
    ops: [
      {
        kind: 'transfer',
        from: 'a',
        to: 'b',
        amount: '101',
        expectedFee: '26',
      },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', balance: '9899', withheld: '0', frozen: false },
      { id: 'b', balance: '75', withheld: '28', frozen: false },
      { id: 'c', balance: '500', withheld: '3', frozen: true },
    ],
    mintWithheld: '3',
    fees: ['26'],
  });
  assert.deepEqual(input, original);
});
test('independent vector 5', () => {
  const input = {
    epoch: 10,
    schedule: {
      at: 10,
      old: { bps: 101, max: '19' },
      next: { bps: 2501, max: '2001' },
    },
    mintWithheld: '3',
    accounts: [
      { id: 'a', balance: '10000', withheld: '0', frozen: false },
      { id: 'b', balance: '0', withheld: '2', frozen: false },
      { id: 'c', balance: '500', withheld: '3', frozen: true },
    ],
    ops: [
      {
        kind: 'transfer',
        from: 'a',
        to: 'b',
        amount: '105',
        expectedFee: '27',
      },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', balance: '9895', withheld: '0', frozen: false },
      { id: 'b', balance: '78', withheld: '29', frozen: false },
      { id: 'c', balance: '500', withheld: '3', frozen: true },
    ],
    mintWithheld: '3',
    fees: ['27'],
  });
  assert.deepEqual(input, original);
});
