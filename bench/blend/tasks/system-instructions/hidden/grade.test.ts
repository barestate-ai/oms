import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

test('[hidden] transfer one', () => {
  assert.equal(hex(api.transferData(1n)), '020000000100000000000000');
});
test('[hidden] allocate zero', () => {
  assert.equal(hex(api.allocateData(0n)), '080000000000000000000000');
});
test('[hidden] assign owner width', () => {
  assert.equal(hex(api.assignData(new Uint8Array(32).fill(7))), '01000000' + '07'.repeat(32));
});
test('[hidden] large transfer', () => {
  assert.equal(hex(api.transferData(9007199254740993n)), '020000000100000000002000');
});
test('[hidden] max transfer', () => {
  assert.equal(hex(api.transferData(18446744073709551615n)), '02000000' + 'ff'.repeat(8));
});
test('[hidden] max allocate', () => {
  assert.equal(hex(api.allocateData(18446744073709551615n)), '08000000' + 'ff'.repeat(8));
});
test('[hidden] negative transfer', () => {
  assert.throws(() => api.transferData(-1n));
});
test('[hidden] overflow allocate', () => {
  assert.throws(() => api.allocateData(18446744073709551616n));
});
test('[hidden] bad owner', () => {
  for (const n of [0, 31, 33]) assert.throws(() => api.assignData(new Uint8Array(n)));
});
test('[hidden] fresh assign output', () => {
  const b = new Uint8Array(32);
  const out = api.assignData(b);
  b[0] = 99;
  assert.equal(out[4], 0);
});
