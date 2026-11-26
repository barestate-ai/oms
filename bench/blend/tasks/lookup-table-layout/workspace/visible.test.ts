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

test('[visible] empty table', () => {
  assert.equal(api.parseLookupTable(table(0)).addresses.length, 0);
});
test('[visible] active sentinel', () => {
  assert.equal(api.parseLookupTable(table()).deactivationSlot, 18446744073709551615n);
});
