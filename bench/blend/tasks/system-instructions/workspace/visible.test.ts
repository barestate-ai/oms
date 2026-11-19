import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

test('[visible] transfer one', () => {
  assert.equal(hex(api.transferData(1n)), '020000000100000000000000');
});
test('[visible] allocate zero', () => {
  assert.equal(hex(api.allocateData(0n)), '080000000000000000000000');
});
