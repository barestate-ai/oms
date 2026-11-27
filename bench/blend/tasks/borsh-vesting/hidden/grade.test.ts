import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const empty = () => ({ owner: new Uint8Array(32), label: '', delegate: null, entries: [] });

test('[hidden] empty encoding', () => {
  assert.equal(
    hex(api.encodeVesting(empty())),
    '0000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  );
});
test('[hidden] empty decode', () => {
  assert.equal(
    api.decodeVesting(bytes('0000000000000000000000000000000000000000000000000000000000000000000000000000000000'))
      .delegate,
    null,
  );
});
test('[hidden] utf8 byte length', () => {
  const v = empty();
  v.label = '金';
  const b = api.encodeVesting(v);
  assert.equal(Buffer.from(b).readUInt32LE(32), 3);
  assert.equal(api.decodeVesting(b).label, '金');
});
test('[hidden] some zero delegate', () => {
  const v = empty();
  v.delegate = new Uint8Array(32);
  const b = api.encodeVesting(v);
  assert.equal(b[36], 1);
  assert.equal(api.decodeVesting(b).delegate.length, 32);
});
test('[hidden] exact entries', () => {
  const v = empty();
  v.entries = [{ unlockSlot: 9007199254740993n, amount: 18446744073709551615n }];
  const d = api.decodeVesting(api.encodeVesting(v));
  assert.deepEqual(d.entries, v.entries);
});
test('[hidden] label limit in bytes', () => {
  const v = empty();
  v.label = '金'.repeat(22);
  assert.throws(() => api.encodeVesting(v));
});
test('[hidden] invalid option', () => {
  const b = Buffer.from('0000000000000000000000000000000000000000000000000000000000000000000000000000000000', 'hex');
  b[36] = 2;
  assert.throws(() => api.decodeVesting(b));
});
test('[hidden] truncated', () => {
  assert.throws(() =>
    api.decodeVesting(
      bytes('0000000000000000000000000000000000000000000000000000000000000000000000000000000000').subarray(0, -1),
    ),
  );
});
test('[hidden] hostile length', () => {
  const b = Buffer.from('0000000000000000000000000000000000000000000000000000000000000000000000000000000000', 'hex');
  b.writeUInt32LE(0xffffffff, 37);
  assert.throws(() => api.decodeVesting(b));
});
test('[hidden] invalid utf8', () => {
  const b = Buffer.concat([Buffer.alloc(32), Buffer.from([1, 0, 0, 0, 255, 0, 0, 0, 0, 0])]);
  assert.throws(() => api.decodeVesting(b));
});
test('[hidden] suffix rejected', () => {
  assert.throws(() =>
    api.decodeVesting(bytes('000000000000000000000000000000000000000000000000000000000000000000000000000000000000')),
  );
});
test('[hidden] negative amount', () => {
  const v = empty();
  v.entries = [{ unlockSlot: 0n, amount: -1n }];
  assert.throws(() => api.encodeVesting(v));
});
test('[hidden] BOM label preserved', () => {
  const v = empty();
  v.label = '﻿x';
  assert.equal(api.decodeVesting(api.encodeVesting(v)).label, v.label);
});
test('[hidden] unpaired surrogate rejected', () => {
  const v = empty();
  v.label = '\ud800';
  assert.throws(() => api.encodeVesting(v));
});
test('[hidden] entry count bound', () => {
  const v = empty();
  v.entries = Array.from({ length: 17 }, () => ({ unlockSlot: 0n, amount: 0n }));
  assert.throws(() => api.encodeVesting(v));
});
