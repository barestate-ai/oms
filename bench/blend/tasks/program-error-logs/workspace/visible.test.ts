import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const P = '11111111111111111111111111111111';
const line = (n) => `Program ${P} failed: custom program error: ${n}`;

test('[visible] no errors', () => {
  assert.deepEqual(api.customErrors([]), []);
});
test('[visible] hex code', () => {
  assert.deepEqual(api.customErrors([line('0x1770')]), [{ programId: P, code: 6000, line: 0 }]);
});
