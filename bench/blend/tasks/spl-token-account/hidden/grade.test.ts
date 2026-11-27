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

test('[hidden] zero amount', () => {
  assert.equal(api.parseTokenAccount(account()).amount, 0n);
});
test('[hidden] initialized state', () => {
  assert.equal(api.parseTokenAccount(account()).state, 1);
});
test('[hidden] mint owner boundaries', () => {
  const b = account();
  b.fill(3, 0, 32);
  b.fill(7, 32, 64);
  const a = api.parseTokenAccount(b);
  assert.equal(hex(a.mint), '03'.repeat(32));
  assert.equal(hex(a.owner), '07'.repeat(32));
});
test('[hidden] u64 maximum', () => {
  const b = account();
  b.writeBigUInt64LE(18446744073709551615n, 64);
  assert.equal(api.parseTokenAccount(b).amount, 18446744073709551615n);
});
test('[hidden] delegate alignment', () => {
  const b = account();
  b.writeUInt32LE(1, 72);
  b.fill(8, 76, 108);
  b.writeBigUInt64LE(99n, 121);
  assert.equal(hex(api.parseTokenAccount(b).delegate), '08'.repeat(32));
  assert.equal(api.parseTokenAccount(b).delegatedAmount, 99n);
});
test('[hidden] native some zero', () => {
  const b = account();
  b.writeUInt32LE(1, 109);
  assert.equal(api.parseTokenAccount(b).nativeReserve, 0n);
});
test('[hidden] native reserve precision', () => {
  const b = account();
  b.writeUInt32LE(1, 109);
  b.writeBigUInt64LE(9007199254740993n, 113);
  assert.equal(api.parseTokenAccount(b).nativeReserve, 9007199254740993n);
});
test('[hidden] close authority', () => {
  const b = account();
  b.writeUInt32LE(1, 129);
  b.fill(9, 133, 165);
  assert.equal(hex(api.parseTokenAccount(b).closeAuthority), '09'.repeat(32));
});
test('[hidden] none garbage ignored', () => {
  const b = account();
  b.fill(255, 113, 121);
  assert.equal(api.parseTokenAccount(b).nativeReserve, null);
});
test('[hidden] states and tags', () => {
  for (const o of [72, 109, 129]) {
    const b = account();
    b.writeUInt32LE(2, o);
    assert.throws(() => api.parseTokenAccount(b));
  }
  const b = account();
  b[108] = 3;
  assert.throws(() => api.parseTokenAccount(b));
});
test('[hidden] strict length', () => {
  for (const n of [0, 164, 166]) assert.throws(() => api.parseTokenAccount(new Uint8Array(n)));
});
test('[hidden] no byte alias', () => {
  const b = account();
  const a = api.parseTokenAccount(b);
  b[0] = 9;
  assert.equal(a.mint[0], 0);
});
