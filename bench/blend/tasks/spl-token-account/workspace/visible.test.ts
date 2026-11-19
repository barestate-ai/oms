import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
function account() {
  const b = Buffer.alloc(165);
  b[108] = 1;
  return b;
}

test('[visible] zero amount', () => {
  assert.equal(api.parseTokenAccount(account()).amount, 0n);
});
test('[visible] initialized state', () => {
  assert.equal(api.parseTokenAccount(account()).state, 1);
});
