import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const disc = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
  k = (n) => new Uint8Array(32).fill(n);
function rec(d, c, s = 0, w = 0) {
  const b = Buffer.alloc(35);
  b[0] = d;
  Buffer.from(c).copy(b, 1);
  b[33] = s;
  b[34] = w;
  return b;
}
function tlv(records) {
  const body = Buffer.concat([Buffer.alloc(4), ...records]);
  body.writeUInt32LE(records.length);
  const h = Buffer.alloc(12);
  Buffer.from(disc).copy(h);
  h.writeUInt32LE(body.length, 8);
  return Buffer.concat([h, body]);
}
const base = () => [
  { address: k(7), data: Uint8Array.of(10, 11, 12, 13) },
  { address: k(8), data: Uint8Array.of(20, 21, 22) },
];
const run = (records, derive = (seeds, program) => program) =>
  api.resolveExtraMetas(tlv(records), disc, Uint8Array.of(40, 41, 42), base(), k(9), derive);

test('[visible] literal meta', () => {
  const a = run([rec(0, k(3), 1, 0)]);
  assert.equal(a[0].address[0], 3);
  assert.equal(a[0].isSigner, true);
  assert.equal(a[0].isWritable, false);
});
test('[visible] hook PDA program', () => {
  assert.equal(run([rec(1, [0])])[0].address[0], 9);
});
