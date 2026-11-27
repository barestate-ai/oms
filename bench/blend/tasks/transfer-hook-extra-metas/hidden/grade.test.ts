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

test('[hidden] literal meta', () => {
  const a = run([rec(0, k(3), 1, 0)]);
  assert.equal(a[0].address[0], 3);
  assert.equal(a[0].isSigner, true);
  assert.equal(a[0].isWritable, false);
});
test('[hidden] hook PDA program', () => {
  assert.equal(run([rec(1, [0])])[0].address[0], 9);
});
test('[hidden] all packed seed sources', () => {
  const a = run([rec(1, [1, 2, 99, 98, 2, 1, 2, 3, 0, 4, 1, 0, 2, 0])], (s, p) => {
    assert.deepEqual(
      s.map((x) => [...x]),
      [[99, 98], [41, 42], Array(32).fill(7), [20, 21]],
    );
    assert.equal(p[0], 9);
    return k(6);
  });
  assert.equal(a[0].address[0], 6);
});
test('[hidden] external program index', () => {
  assert.equal(run([rec(128, [0])])[0].address[0], 7);
});
test('[hidden] sequential extra account reference', () => {
  const a = run([rec(0, k(3)), rec(130, [3, 2, 0])], (s, p) => {
    assert.equal(s[0][0], 3);
    return p;
  });
  assert.equal(a[1].address[0], 3);
});
test('[hidden] forward index rejected', () => {
  assert.throws(() => run([rec(130, [0])]));
});
test('[hidden] extra account data unavailable', () => {
  assert.throws(() => run([rec(0, k(3)), rec(1, [4, 2, 0, 0, 0])]));
});
test('[hidden] instruction-data slice bounds', () => {
  assert.throws(() => run([rec(1, [2, 2, 2, 0])]));
});
test('[hidden] truncated literal config', () => {
  assert.throws(() => run([rec(1, [1, 31])]));
});
test('[hidden] nonzero terminator padding', () => {
  assert.throws(() => run([rec(1, [0, 1])]));
});
test('[hidden] unknown discriminator and tag', () => {
  assert.throws(() => run([rec(2, [0])]));
  assert.throws(() => run([rec(1, [5, 0])]));
});
test('[hidden] invalid boolean flags', () => {
  assert.throws(() => run([rec(0, k(3), 2, 0)]));
});
test('[hidden] duplicate matching TLV', () => {
  const b = tlv([]);
  assert.throws(() => api.resolveExtraMetas(Buffer.concat([b, b]), disc, new Uint8Array(), base(), k(9), () => k(1)));
});
test('[hidden] payload count length disagreement', () => {
  const b = tlv([]);
  b.writeUInt32LE(1, 12);
  assert.throws(() => api.resolveExtraMetas(b, disc, new Uint8Array(), base(), k(9), () => k(1)));
});
test('[hidden] missing or truncated TLV', () => {
  for (const b of [Buffer.alloc(0), tlv([]).subarray(0, 11)])
    assert.throws(() => api.resolveExtraMetas(b, disc, new Uint8Array(), base(), k(9), () => k(1)));
});
test('[hidden] callback isolation and result width', () => {
  const b = base(),
    program = k(9);
  api.resolveExtraMetas(tlv([rec(1, [3, 0, 0])]), disc, new Uint8Array(), b, program, (s, p) => {
    s[0][0] = 0;
    p[0] = 0;
    return k(1);
  });
  assert.equal(b[0].address[0], 7);
  assert.equal(program[0], 9);
  assert.throws(() => run([rec(1, [0])], () => new Uint8Array(31)));
});
test('[hidden] unknown entry and zero suffix', () => {
  const unknown = Buffer.alloc(12);
  unknown[0] = 99;
  const b = Buffer.concat([unknown, tlv([]), Buffer.alloc(3)]);
  assert.deepEqual(
    api.resolveExtraMetas(b, disc, new Uint8Array(), base(), k(9), () => k(1)),
    [],
  );
});
test('[hidden] exactly full seed config', () => {
  const a = run([rec(1, [1, 30, ...Array(30).fill(6)])], (s) => {
    assert.deepEqual([...s[0]], Array(30).fill(6));
    return k(1);
  });
  assert.equal(a[0].address[0], 1);
});
test('[hidden] too many PDA seeds', () => {
  assert.throws(() => run([rec(1, Array.from({ length: 16 }, () => [1, 0]).flat())]));
});
test('[hidden] truncated declared TLV payload', () => {
  const b = tlv([]);
  assert.throws(() => api.resolveExtraMetas(b.subarray(0, -1), disc, new Uint8Array(), base(), k(9), () => k(1)));
});
