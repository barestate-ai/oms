import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
function table(n = 2) {
  const b = Buffer.alloc(56 + 32 * n);
  b.writeUInt32LE(1);
  b.writeBigUInt64LE(18446744073709551615n, 4);
  return b;
}

test('[hidden] empty table', () => {
  assert.equal(api.parseLookupTable(table(0)).addresses.length, 0);
});
test('[hidden] active sentinel', () => {
  assert.equal(api.parseLookupTable(table()).deactivationSlot, 18446744073709551615n);
});
test('[hidden] authority Some', () => {
  const b = table();
  b[21] = 1;
  b.fill(3, 22, 54);
  assert.equal(hex(api.parseLookupTable(b).authority), '03'.repeat(32));
});
test('[hidden] authority None ignores payload', () => {
  const b = table();
  b.fill(255, 22, 54);
  assert.equal(api.parseLookupTable(b).authority, null);
});
test('[hidden] address boundaries', () => {
  const b = table();
  b.fill(7, 56, 88);
  b.fill(8, 88, 120);
  const t = api.parseLookupTable(b);
  assert.equal(hex(t.addresses[1]), '08'.repeat(32));
});
test('[hidden] exact slot', () => {
  const b = table();
  b.writeBigUInt64LE(9007199254740993n, 12);
  assert.equal(api.parseLookupTable(b).lastExtendedSlot, 9007199254740993n);
});
test('[hidden] wrong discriminant', () => {
  const b = table();
  b[0] = 0;
  assert.throws(() => api.parseLookupTable(b));
});
test('[hidden] invalid tag', () => {
  const b = table();
  b[21] = 2;
  assert.throws(() => api.parseLookupTable(b));
});
test('[hidden] partial address', () => {
  assert.throws(() => api.parseLookupTable(table().subarray(0, -1)));
});
test('[hidden] too many addresses', () => {
  assert.throws(() => api.parseLookupTable(table(257)));
});
test('[hidden] bad start index', () => {
  const b = table();
  b[20] = 3;
  assert.throws(() => api.parseLookupTable(b));
});
test('[hidden] reserved bytes do not shift keys', () => {
  const b = table();
  b[54] = 255;
  b[55] = 255;
  const t = api.parseLookupTable(b);
  assert.equal(t.addresses[0][0], 0);
  b[56] = 2;
  assert.equal(t.addresses[0][0], 0);
});
