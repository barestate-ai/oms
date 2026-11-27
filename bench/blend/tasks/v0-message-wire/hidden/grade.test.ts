import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const empty = () =>
  bytes(
    '80010001020101010101010101010101010101010101010101010101010101010101010101020202020202020202020202020202020202020202020202020202020202020209090909090909090909090909090909090909090909090909090909090909090000',
  );
const loaded = () =>
  bytes(
    '8001000102010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020909090909090909090909090909090909090909090909090909090909090909010303000204010b0103030303030303030303030303030303030303030303030303030303030303030207010104',
  );

test('[hidden] v0 no lookups', () => {
  assert.equal(api.parseV0(empty()).version, 0);
});
test('[hidden] loaded roundtrip', () => {
  assert.equal(hex(api.serializeV0(api.parseV0(loaded()))), hex(loaded()));
});
test('[hidden] combined index space', () => {
  assert.equal(api.parseV0(loaded()).instructions[0].programIdIndex, 3);
});
test('[hidden] lookup indexes preserve order', () => {
  assert.deepEqual(api.parseV0(loaded()).addressTableLookups[0].writableIndexes, [7, 1]);
});
test('[hidden] readonly lookup indexes', () => {
  assert.deepEqual(api.parseV0(loaded()).addressTableLookups[0].readonlyIndexes, [4]);
});
test('[hidden] legacy rejected', () => {
  assert.throws(() => api.parseV0(empty().subarray(1)));
});
test('[hidden] future version rejected', () => {
  const b = empty();
  b[0] = 129;
  assert.throws(() => api.parseV0(b));
});
test('[hidden] header uses static count', () => {
  const b = loaded();
  b[1] = 3;
  assert.throws(() => api.parseV0(b));
});
test('[hidden] key limit includes loaded', () => {
  const m = api.parseV0(empty());
  m.addressTableLookups = [
    { accountKey: m.accountKeys[0], writableIndexes: new Array(255).fill(0), readonlyIndexes: [] },
  ];
  assert.throws(() => api.serializeV0(m));
});
test('[hidden] out of bounds compiled index', () => {
  const m = api.parseV0(loaded());
  m.instructions[0].accountIndices = [5];
  assert.throws(() => api.serializeV0(m));
});
test('[hidden] lookup index u8 range', () => {
  const m = api.parseV0(loaded());
  m.addressTableLookups[0].writableIndexes = [256];
  assert.throws(() => api.serializeV0(m));
});
test('[hidden] truncated table address', () => {
  assert.throws(() => api.parseV0(loaded().subarray(0, -20)));
});
test('[hidden] missing lookup count', () => {
  assert.throws(() => api.parseV0(empty().subarray(0, -1)));
});
test('[hidden] overlong lookup count', () => {
  const b = empty();
  assert.throws(() => api.parseV0(Buffer.concat([b.subarray(0, -1), Buffer.from([128, 0])])));
});
test('[hidden] suffix', () => {
  assert.throws(() => api.parseV0(Buffer.concat([empty(), Buffer.from([0])])));
});
test('[hidden] no data alias', () => {
  const b = loaded();
  const m = api.parseV0(b);
  m.instructions[0].data[0] = 0;
  assert.equal(hex(b), hex(loaded()));
});
test('[hidden] 128 v0 signers not legacy discriminator', () => {
  const m = api.parseV0(empty());
  m.accountKeys = Array(128).fill(m.accountKeys[0]);
  m.header = { numRequiredSignatures: 128, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 };
  assert.equal(api.parseV0(api.serializeV0(m)).header.numRequiredSignatures, 128);
});
test('[hidden] 256 combined entries accepted', () => {
  const m = api.parseV0(empty());
  m.addressTableLookups = [{ accountKey: m.accountKeys[0], writableIndexes: Array(254).fill(0), readonlyIndexes: [] }];
  assert.equal(api.parseV0(api.serializeV0(m)).addressTableLookups[0].writableIndexes.length, 254);
});
test('[hidden] serialize unknown version rejected', () => {
  const m = api.parseV0(empty());
  m.version = 1;
  assert.throws(() => api.serializeV0(m));
});
