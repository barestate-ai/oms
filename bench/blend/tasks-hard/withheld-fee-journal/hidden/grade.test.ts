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
test('independent vector 2', () => {
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
        amount: '102',
        expectedFee: '26',
      },
      { kind: 'harvest', ids: ['b', 'c'] },
      { kind: 'withdraw', to: 'a', authority: true },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', balance: '9932', withheld: '0', frozen: false },
      { id: 'b', balance: '76', withheld: '0', frozen: false },
      { id: 'c', balance: '500', withheld: '0', frozen: true },
    ],
    mintWithheld: '0',
    fees: ['26'],
  });
  assert.deepEqual(input, original);
});
test('independent vector 3', () => {
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
        amount: '103',
        expectedFee: '26',
      },
      {
        kind: 'transfer',
        from: 'a',
        to: 'b',
        amount: '20000',
        expectedFee: '2001',
      },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: false,
    accounts: [
      { id: 'a', balance: '10000', withheld: '0', frozen: false },
      { id: 'b', balance: '0', withheld: '2', frozen: false },
      { id: 'c', balance: '500', withheld: '3', frozen: true },
    ],
    mintWithheld: '3',
    fees: [],
  });
  assert.deepEqual(input, original);
});
test('independent vector 4', () => {
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
        amount: '104',
        expectedFee: '27',
      },
      { kind: 'harvest', ids: ['b'] },
      { kind: 'harvest', ids: ['b'] },
      { kind: 'withdraw', to: 'a', authority: true },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', balance: '9928', withheld: '0', frozen: false },
      { id: 'b', balance: '77', withheld: '0', frozen: false },
      { id: 'c', balance: '500', withheld: '3', frozen: true },
    ],
    mintWithheld: '0',
    fees: ['27'],
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
test('independent vector 6', () => {
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
        amount: '106',
        expectedFee: '27',
      },
      { kind: 'harvest', ids: ['b', 'c'] },
      { kind: 'withdraw', to: 'a', authority: true },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', balance: '9929', withheld: '0', frozen: false },
      { id: 'b', balance: '79', withheld: '0', frozen: false },
      { id: 'c', balance: '500', withheld: '0', frozen: true },
    ],
    mintWithheld: '0',
    fees: ['27'],
  });
  assert.deepEqual(input, original);
});
test('independent vector 7', () => {
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
        amount: '107',
        expectedFee: '27',
      },
      {
        kind: 'transfer',
        from: 'a',
        to: 'b',
        amount: '20000',
        expectedFee: '2001',
      },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: false,
    accounts: [
      { id: 'a', balance: '10000', withheld: '0', frozen: false },
      { id: 'b', balance: '0', withheld: '2', frozen: false },
      { id: 'c', balance: '500', withheld: '3', frozen: true },
    ],
    mintWithheld: '3',
    fees: [],
  });
  assert.deepEqual(input, original);
});
test('independent vector 8', () => {
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
        amount: '108',
        expectedFee: '28',
      },
      { kind: 'harvest', ids: ['b'] },
      { kind: 'harvest', ids: ['b'] },
      { kind: 'withdraw', to: 'a', authority: true },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', balance: '9925', withheld: '0', frozen: false },
      { id: 'b', balance: '80', withheld: '0', frozen: false },
      { id: 'c', balance: '500', withheld: '3', frozen: true },
    ],
    mintWithheld: '0',
    fees: ['28'],
  });
  assert.deepEqual(input, original);
});
test('independent vector 9', () => {
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
        amount: '109',
        expectedFee: '28',
      },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', balance: '9891', withheld: '0', frozen: false },
      { id: 'b', balance: '81', withheld: '30', frozen: false },
      { id: 'c', balance: '500', withheld: '3', frozen: true },
    ],
    mintWithheld: '3',
    fees: ['28'],
  });
  assert.deepEqual(input, original);
});
test('independent vector 10', () => {
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
        amount: '110',
        expectedFee: '28',
      },
      { kind: 'harvest', ids: ['b', 'c'] },
      { kind: 'withdraw', to: 'a', authority: true },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', balance: '9926', withheld: '0', frozen: false },
      { id: 'b', balance: '82', withheld: '0', frozen: false },
      { id: 'c', balance: '500', withheld: '0', frozen: true },
    ],
    mintWithheld: '0',
    fees: ['28'],
  });
  assert.deepEqual(input, original);
});
test('independent vector 11', () => {
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
        amount: '111',
        expectedFee: '28',
      },
      {
        kind: 'transfer',
        from: 'a',
        to: 'b',
        amount: '20000',
        expectedFee: '2001',
      },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: false,
    accounts: [
      { id: 'a', balance: '10000', withheld: '0', frozen: false },
      { id: 'b', balance: '0', withheld: '2', frozen: false },
      { id: 'c', balance: '500', withheld: '3', frozen: true },
    ],
    mintWithheld: '3',
    fees: [],
  });
  assert.deepEqual(input, original);
});
test('independent vector 12', () => {
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
    ops: [],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', balance: '10000', withheld: '0', frozen: false },
      { id: 'b', balance: '0', withheld: '2', frozen: false },
      { id: 'c', balance: '500', withheld: '3', frozen: true },
    ],
    mintWithheld: '3',
    fees: [],
  });
  assert.deepEqual(input, original);
});
test('independent vector 13', () => {
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
      { id: 'a', balance: '10000', withheld: '0', frozen: false },
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
  assert.deepEqual(solve(input), { error: 'invalid' });
  assert.deepEqual(input, original);
});
test('independent vector 14', () => {
  const input = {
    epoch: 10,
    schedule: {
      at: 10,
      old: { bps: 101, max: '19' },
      next: { bps: 2501, max: '2001' },
    },
    mintWithheld: '3',
    accounts: [
      { id: 'a', balance: '-1', withheld: '0', frozen: false },
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
  assert.deepEqual(solve(input), { error: 'invalid' });
  assert.deepEqual(input, original);
});
test('independent vector 15', () => {
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
    ops: [{ kind: 'unknown', from: 'a', to: 'b', amount: '101', expectedFee: '26' }],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), { error: 'invalid' });
  assert.deepEqual(input, original);
});
test('independent vector 16', () => {
  const input = {
    epoch: 10,
    schedule: {
      at: 10,
      old: { bps: 101, max: '19' },
      next: { bps: 2501, max: '2001' },
    },
    mintWithheld: '3',
    accounts: [
      { id: 'a', balance: '10000', withheld: '0', frozen: 1 },
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
  assert.deepEqual(solve(input), { error: 'invalid' });
  assert.deepEqual(input, original);
});
