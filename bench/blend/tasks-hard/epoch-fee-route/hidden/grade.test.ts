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
test('independent vector 2', () => {
  const input = {
    epoch: 10,
    net: '2',
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
    gross: '5',
    firstFee: '2',
    secondFee: '1',
    net: '2',
  });
  assert.deepEqual(input, original);
});
test('independent vector 3', () => {
  const input = {
    epoch: 10,
    net: '3',
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
    gross: '7',
    firstFee: '2',
    secondFee: '2',
    net: '3',
  });
  assert.deepEqual(input, original);
});
test('independent vector 4', () => {
  const input = {
    epoch: 10,
    net: '7',
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
    gross: '15',
    firstFee: '4',
    secondFee: '4',
    net: '7',
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
test('independent vector 6', () => {
  const input = {
    epoch: 10,
    net: '19',
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
    gross: '39',
    firstFee: '10',
    secondFee: '10',
    net: '19',
  });
  assert.deepEqual(input, original);
});
test('independent vector 7', () => {
  const input = {
    epoch: 10,
    net: '103',
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
    gross: '207',
    firstFee: '52',
    secondFee: '52',
    net: '103',
  });
  assert.deepEqual(input, original);
});
test('independent vector 8', () => {
  const input = {
    epoch: 10,
    net: '1001',
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
    gross: '2003',
    firstFee: '501',
    secondFee: '501',
    net: '1001',
  });
  assert.deepEqual(input, original);
});
test('independent vector 9', () => {
  const input = {
    epoch: 10,
    net: '99999',
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
    gross: '103049',
    firstFee: '2001',
    secondFee: '1049',
    net: '99999',
  });
  assert.deepEqual(input, original);
});
test('independent vector 10', () => {
  const input = {
    epoch: 10,
    net: '9007199254741009',
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
    gross: '9007199254744059',
    firstFee: '2001',
    secondFee: '1049',
    net: '9007199254741009',
  });
  assert.deepEqual(input, original);
});
test('independent vector 11', () => {
  const input = {
    epoch: 10,
    net: '6148914691236517205',
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
    gross: '6148914691236520255',
    firstFee: '2001',
    secondFee: '1049',
    net: '6148914691236517205',
  });
  assert.deepEqual(input, original);
});
test('independent vector 12', () => {
  const input = {
    epoch: 10,
    net: '0',
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
    gross: '0',
    firstFee: '0',
    secondFee: '0',
    net: '0',
  });
  assert.deepEqual(input, original);
});
test('inactive schedule validation', () => {
  const input = {
    epoch: 10,
    net: '1',
    first: {
      at: 10,
      old: { bps: 10001, max: '19' },
      next: { bps: 2501, max: '2001' },
    },
    second: {
      at: 11,
      old: { bps: 3333, max: '1049' },
      next: { bps: 2501, max: '2001' },
    },
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), { error: 'invalid' });
  assert.deepEqual(input, original);
});
test('canonical amount', () => {
  const input = {
    epoch: 10,
    net: '01',
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
  assert.deepEqual(solve(input), { error: 'invalid' });
  assert.deepEqual(input, original);
});
test('unreachable u64 net', () => {
  const input = {
    epoch: 10,
    net: '18446744073709551615',
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
  assert.deepEqual(solve(input), { error: 'invalid' });
  assert.deepEqual(input, original);
});
test('negative epoch', () => {
  const input = {
    epoch: -1,
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
  assert.deepEqual(solve(input), { error: 'invalid' });
  assert.deepEqual(input, original);
});
