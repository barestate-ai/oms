import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';

test('[visible] one sol', () => {
  assert.equal(api.parseSol('1'), 1000000000n);
});
test('[visible] zero display', () => {
  assert.equal(api.formatSol(0n), '0');
});
