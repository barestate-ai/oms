import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const clock = () => ({ slot: 0n, epochStartTimestamp: 0n, epoch: 0n, leaderScheduleEpoch: 0n, unixTimestamp: 0n });

test('[hidden] zero encoding', () => {
  assert.equal(hex(api.encodeClock(clock())), '00'.repeat(40));
});
test('[hidden] zero decoding', () => {
  assert.deepEqual(api.decodeClock(Buffer.alloc(40)), clock());
});
test('[hidden] negative timestamp', () => {
  const c = clock();
  c.unixTimestamp = -1n;
  assert.equal(hex(api.encodeClock(c)).slice(64), 'ff'.repeat(8));
});
test('[hidden] i64 minimum', () => {
  const b = Buffer.alloc(40);
  b.writeBigInt64LE(-9223372036854775808n, 8);
  assert.equal(api.decodeClock(b).epochStartTimestamp, -9223372036854775808n);
});
test('[hidden] i64 maximum', () => {
  const c = clock();
  c.unixTimestamp = 9223372036854775807n;
  assert.equal(api.decodeClock(api.encodeClock(c)).unixTimestamp, c.unixTimestamp);
});
test('[hidden] u64 maximum slot', () => {
  const c = clock();
  c.slot = 18446744073709551615n;
  assert.equal(api.decodeClock(api.encodeClock(c)).slot, c.slot);
});
test('[hidden] layout independent vector', () => {
  const b = Buffer.alloc(40);
  [1n, -2n, 3n, 4n, -5n].forEach((n, i) => b.writeBigInt64LE(n, i * 8));
  assert.deepEqual(api.decodeClock(b), {
    slot: 1n,
    epochStartTimestamp: -2n,
    epoch: 3n,
    leaderScheduleEpoch: 4n,
    unixTimestamp: -5n,
  });
});
test('[hidden] negative epoch', () => {
  const c = clock();
  c.epoch = -1n;
  assert.throws(() => api.encodeClock(c));
});
test('[hidden] signed overflow', () => {
  const c = clock();
  c.unixTimestamp = 9223372036854775808n;
  assert.throws(() => api.encodeClock(c));
});
test('[hidden] unsigned overflow', () => {
  const c = clock();
  c.slot = 18446744073709551616n;
  assert.throws(() => api.encodeClock(c));
});
test('[hidden] strict size', () => {
  for (const n of [0, 39, 41]) assert.throws(() => api.decodeClock(Buffer.alloc(n)));
});
test('[hidden] no number coercion', () => {
  const c = clock();
  c.epoch = 1;
  assert.throws(() => api.encodeClock(c));
});
