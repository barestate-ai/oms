import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
function raw() {
  const b = Buffer.alloc(108);
  b.fill(7, 0, 32);
  b.writeBigUInt64LE(9007199254740993n, 64);
  b.writeBigUInt64LE(3n, 72);
  b.writeBigUInt64LE(100n, 80);
  b.writeUInt16LE(25, 88);
  b.writeBigUInt64LE(10n, 90);
  b.writeBigUInt64LE(9n, 98);
  b.writeUInt16LE(10000, 106);
  return b;
}
function config(bp = 25, cap = 100n) {
  return {
    configAuthority: null,
    withdrawAuthority: null,
    withheldAmount: 0n,
    older: { epoch: 3n, maximumFee: cap, basisPoints: bp },
    newer: { epoch: 10n, maximumFee: 9n, basisPoints: 10000 },
  };
}

test('[visible] packed payload authorities', () => {
  const c = api.parseFeeConfig(raw());
  assert.equal(c.configAuthority[0], 7);
  assert.equal(c.withdrawAuthority, null);
});
test('[visible] withheld precision', () => {
  assert.equal(api.parseFeeConfig(raw()).withheldAmount, 9007199254740993n);
});
