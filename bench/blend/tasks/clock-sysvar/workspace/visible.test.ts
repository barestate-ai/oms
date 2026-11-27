import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const clock = () => ({ slot: 0n, epochStartTimestamp: 0n, epoch: 0n, leaderScheduleEpoch: 0n, unixTimestamp: 0n });

test('[visible] zero encoding', () => {
  assert.equal(hex(api.encodeClock(clock())), '00'.repeat(40));
});
test('[visible] zero decoding', () => {
  assert.deepEqual(api.decodeClock(Buffer.alloc(40)), clock());
});
