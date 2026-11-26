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
test('independent vector 2', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [
      { kind: 'read', id: 'a' },
      { kind: 'set', id: 'a', lamports: '98' },
      { kind: 'set', id: 'b', lamports: '52' },
      {
        kind: 'invoke',
        program: 'q',
        catch: true,
        ops: [{ kind: 'set', id: 'b', lamports: '53' }],
      },
      { kind: 'read', id: 'b' },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '98', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '52', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [
      ['read', 'a', '100', 'aa'],
      ['set', 'a', '98'],
      ['set', 'b', '52'],
      ['read', 'b', '52', 'bb'],
    ],
  });
  assert.deepEqual(input, original);
});
test('independent vector 3', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [
      { kind: 'read', id: 'a' },
      { kind: 'set', id: 'a', lamports: '97' },
      { kind: 'set', id: 'b', lamports: '53' },
      {
        kind: 'invoke',
        program: 'q',
        catch: true,
        ops: [{ kind: 'write', id: 'b', data: '02ff' }, { kind: 'fail' }],
      },
      { kind: 'read', id: 'b' },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '97', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '53', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [
      ['read', 'a', '100', 'aa'],
      ['set', 'a', '97'],
      ['set', 'b', '53'],
      ['read', 'b', '53', 'bb'],
    ],
  });
  assert.deepEqual(input, original);
});
test('independent vector 4', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [
      { kind: 'read', id: 'a' },
      { kind: 'set', id: 'a', lamports: '96' },
      { kind: 'set', id: 'b', lamports: '54' },
      {
        kind: 'invoke',
        program: 'q',
        catch: true,
        ops: [{ kind: 'set', id: 'b', lamports: '55' }],
      },
      { kind: 'read', id: 'b' },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '96', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '54', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [
      ['read', 'a', '100', 'aa'],
      ['set', 'a', '96'],
      ['set', 'b', '54'],
      ['read', 'b', '54', 'bb'],
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
test('independent vector 6', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [
      { kind: 'read', id: 'a' },
      { kind: 'set', id: 'a', lamports: '94' },
      { kind: 'set', id: 'b', lamports: '56' },
      {
        kind: 'invoke',
        program: 'q',
        catch: true,
        ops: [{ kind: 'set', id: 'b', lamports: '57' }],
      },
      { kind: 'read', id: 'b' },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '94', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '56', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [
      ['read', 'a', '100', 'aa'],
      ['set', 'a', '94'],
      ['set', 'b', '56'],
      ['read', 'b', '56', 'bb'],
    ],
  });
  assert.deepEqual(input, original);
});
test('independent vector 7', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [
      { kind: 'read', id: 'a' },
      { kind: 'set', id: 'a', lamports: '93' },
      { kind: 'set', id: 'b', lamports: '57' },
      {
        kind: 'invoke',
        program: 'q',
        catch: true,
        ops: [{ kind: 'write', id: 'b', data: '06ff' }, { kind: 'fail' }],
      },
      { kind: 'read', id: 'b' },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '93', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '57', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [
      ['read', 'a', '100', 'aa'],
      ['set', 'a', '93'],
      ['set', 'b', '57'],
      ['read', 'b', '57', 'bb'],
    ],
  });
  assert.deepEqual(input, original);
});
test('independent vector 8', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [
      { kind: 'read', id: 'a' },
      { kind: 'set', id: 'a', lamports: '92' },
      { kind: 'set', id: 'b', lamports: '58' },
      {
        kind: 'invoke',
        program: 'q',
        catch: true,
        ops: [{ kind: 'set', id: 'b', lamports: '59' }],
      },
      { kind: 'read', id: 'b' },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '92', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '58', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [
      ['read', 'a', '100', 'aa'],
      ['set', 'a', '92'],
      ['set', 'b', '58'],
      ['read', 'b', '58', 'bb'],
    ],
  });
  assert.deepEqual(input, original);
});
test('independent vector 9', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [
      { kind: 'read', id: 'a' },
      { kind: 'set', id: 'a', lamports: '91' },
      { kind: 'set', id: 'b', lamports: '59' },
      {
        kind: 'invoke',
        program: 'q',
        catch: true,
        ops: [{ kind: 'write', id: 'b', data: '08ff' }, { kind: 'fail' }],
      },
      { kind: 'read', id: 'b' },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '91', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '59', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [
      ['read', 'a', '100', 'aa'],
      ['set', 'a', '91'],
      ['set', 'b', '59'],
      ['read', 'b', '59', 'bb'],
    ],
  });
  assert.deepEqual(input, original);
});
test('independent vector 10', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [
      { kind: 'read', id: 'a' },
      { kind: 'set', id: 'a', lamports: '90' },
      { kind: 'set', id: 'b', lamports: '60' },
      {
        kind: 'invoke',
        program: 'q',
        catch: true,
        ops: [{ kind: 'set', id: 'b', lamports: '61' }],
      },
      { kind: 'read', id: 'b' },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '90', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '60', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [
      ['read', 'a', '100', 'aa'],
      ['set', 'a', '90'],
      ['set', 'b', '60'],
      ['read', 'b', '60', 'bb'],
    ],
  });
  assert.deepEqual(input, original);
});
test('independent vector 11', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [
      { kind: 'read', id: 'a' },
      { kind: 'set', id: 'a', lamports: '89' },
      { kind: 'set', id: 'b', lamports: '61' },
      {
        kind: 'invoke',
        program: 'q',
        catch: true,
        ops: [{ kind: 'write', id: 'b', data: '0aff' }, { kind: 'fail' }],
      },
      { kind: 'read', id: 'b' },
    ],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '89', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '61', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [
      ['read', 'a', '100', 'aa'],
      ['set', 'a', '89'],
      ['set', 'b', '61'],
      ['read', 'b', '61', 'bb'],
    ],
  });
  assert.deepEqual(input, original);
});
test('independent vector 12', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: true,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [],
  });
  assert.deepEqual(input, original);
});
test('independent vector 13', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
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
  assert.deepEqual(solve(input), { error: 'invalid' });
  assert.deepEqual(input, original);
});
test('independent vector 14', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [{ kind: 'write', id: 'c', data: '00' }],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: false,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [],
  });
  assert.deepEqual(input, original);
});
test('independent vector 15', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [{ kind: 'set', id: 'a', lamports: '18446744073709551615' }],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: false,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [],
  });
  assert.deepEqual(input, original);
});
test('independent vector 16', () => {
  const input = {
    program: 'p',
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    ops: [{ kind: 'set', id: 'a', lamports: '01' }],
  };
  const original = structuredClone(input);
  assert.deepEqual(solve(input), {
    committed: false,
    accounts: [
      { id: 'a', owner: 'p', writable: true, lamports: '100', data: 'aa' },
      { id: 'b', owner: 'q', writable: true, lamports: '50', data: 'bb' },
      { id: 'c', owner: 'r', writable: false, lamports: '7', data: 'cc' },
    ],
    events: [],
  });
  assert.deepEqual(input, original);
});
