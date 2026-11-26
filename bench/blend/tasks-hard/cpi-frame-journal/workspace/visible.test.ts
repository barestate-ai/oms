import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from './index.ts';
test('independent vector 1', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [
      { kind: 'read', id: 'a' },
      { kind: 'set', id: 'a', lamports: '99' },
      { kind: 'set', id: 'b', lamports: '51' },
      {
        kind: 'invoke',
        program: 'q',
        catch: true,
        ops: [{ kind: 'write', id: 'b', data: '00ff' }, { kind: 'fail' }],
      },
      { kind: 'read', id: 'b' },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '99', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '51', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [
      ['read', 'a', '100', 'aa'],
      ['set', 'a', '99'],
      ['set', 'b', '51'],
      ['read', 'b', '51', 'bb'],
    ],
  });
  assert.deepEqual(input, original);
});
test('independent vector 5', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [
      { kind: 'read', id: 'a' },
      { kind: 'set', id: 'a', lamports: '95' },
      { kind: 'set', id: 'b', lamports: '55' },
      {
        kind: 'invoke',
        program: 'q',
        catch: true,
        ops: [{ kind: 'write', id: 'b', data: '04ff' }, { kind: 'fail' }],
      },
      { kind: 'read', id: 'b' },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '95', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '55', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [
      ['read', 'a', '100', 'aa'],
      ['set', 'a', '95'],
      ['set', 'b', '55'],
      ['read', 'b', '55', 'bb'],
    ],
  });
  assert.deepEqual(input, original);
});
