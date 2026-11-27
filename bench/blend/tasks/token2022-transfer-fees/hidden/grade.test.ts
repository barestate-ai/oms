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

test('[hidden] packed payload authorities', () => {
  const c = api.parseFeeConfig(raw());
  assert.equal(c.configAuthority[0], 7);
  assert.equal(c.withdrawAuthority, null);
});
test('[hidden] withheld precision', () => {
  assert.equal(api.parseFeeConfig(raw()).withheldAmount, 9007199254740993n);
});
test('[hidden] epoch boundary', () => {
  const c = config();
  assert.equal(api.feeForEpoch(c, 9n, 100n), 1n);
  assert.equal(api.feeForEpoch(c, 10n, 100n), 9n);
});
test('[hidden] round fee upward', () => {
  assert.equal(api.feeForEpoch(config(1), 0n, 1n), 1n);
});
test('[hidden] cap fee', () => {
  assert.equal(api.feeForEpoch(config(5000, 3n), 5n, 1000n), 3n);
});
test('[hidden] inverse rounding', () => {
  assert.deepEqual(api.grossForNet(config(25), 5n, 400n), { gross: 402n, fee: 2n });
});
test('[hidden] inverse capped', () => {
  assert.deepEqual(api.grossForNet(config(5000, 3n), 5n, 100n), { gross: 103n, fee: 3n });
});
test('[hidden] zero net at 100 percent', () => {
  assert.deepEqual(api.grossForNet(config(), 10n, 0n), { gross: 0n, fee: 0n });
});
test('[hidden] 100 percent capped inverse', () => {
  assert.deepEqual(api.grossForNet(config(), 10n, 1n), { gross: 10n, fee: 9n });
});
test('[hidden] 100 percent uncapped unreachable', () => {
  const c = config(10000, (1n << 64n) - 1n);
  assert.throws(() => api.grossForNet(c, 5n, 1n));
});
test('[hidden] zero fee u64 maximum', () => {
  const max = (1n << 64n) - 1n;
  assert.deepEqual(api.grossForNet(config(0), 5n, max), { gross: max, fee: 0n });
});
test('[hidden] inverse u64 overflow', () => {
  assert.throws(() => api.grossForNet(config(1), 5n, (1n << 64n) - 1n));
});
test('[hidden] product beyond u64', () => {
  assert.equal(api.feeForEpoch(config(9999, (1n << 64n) - 1n), 5n, (1n << 64n) - 1n), 18444899399302180660n);
});
test('[hidden] bad packed basis points', () => {
  const b = raw();
  b.writeUInt16LE(10001, 88);
  assert.throws(() => api.parseFeeConfig(b));
});
test('[hidden] bad epoch order and length', () => {
  const b = raw();
  b.writeBigUInt64LE(2n, 90);
  assert.throws(() => api.parseFeeConfig(b));
  assert.throws(() => api.parseFeeConfig(raw().subarray(0, 107)));
});
test('[hidden] manual config fields validated', () => {
  for (const bp of [-1, 10001, 0.5]) assert.throws(() => api.feeForEpoch(config(bp), 5n, 2n));
  assert.throws(() => api.feeForEpoch(config(), -1n, 1n));
});
test('[hidden] independent inverse formula grid', () => {
  for (const bp of [0, 1, 25, 9999, 10000])
    for (const cap of [0n, 1n, 50n])
      for (const net of [0n, 1n, 99n, 10000n]) {
        const c = config(bp, cap);
        const capped = net + cap;
        const uncapped = bp === 10000 ? null : (net * 10000n + BigInt(9999 - bp)) / BigInt(10000 - bp);
        const expected = net === 0n ? 0n : uncapped === null ? capped : uncapped < capped ? uncapped : capped;
        assert.equal(api.grossForNet(c, 5n, net).gross, expected);
      }
});
