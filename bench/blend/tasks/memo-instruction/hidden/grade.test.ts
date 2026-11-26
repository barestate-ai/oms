import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const A = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  B = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',
  C = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8',
  D = 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq';
const meta = (address, isSigner = false, isWritable = false) => ({ address, isSigner, isWritable });
const ix = (accounts = [], programId = D) => ({ programId, accounts, data: Uint8Array.of(9) });

test('[hidden] empty memo', () => {
  assert.equal(api.buildMemo('', []).data.length, 0);
});
test('[hidden] program address', () => {
  assert.equal(api.buildMemo('hi', []).programId, 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
});
test('[hidden] first encounter ordering', () => {
  assert.deepEqual(
    api.buildMemo('hi', [B, A, B]).accounts.map((a) => a.address),
    [B, A],
  );
});
test('[hidden] readonly signers', () => {
  assert.deepEqual(api.buildMemo('x', [A]).accounts, [{ address: A, isSigner: true, isWritable: false }]);
});
test('[hidden] utf8 exact', () => {
  assert.equal(hex(api.buildMemo(' 金 ', []).data), '20e9879120');
});
test('[hidden] byte limit', () => {
  assert.throws(() => api.buildMemo('金'.repeat(171), []));
});
test('[hidden] invalid address', () => {
  assert.throws(() => api.buildMemo('x', ['111']));
});
test('[hidden] fatal utf8', () => {
  assert.throws(() => api.decodeMemo(Uint8Array.of(0xc0, 0xaf)));
});
test('[hidden] BOM preserved', () => {
  assert.equal(api.decodeMemo(Uint8Array.of(239, 187, 191, 65)), '\uFEFFA');
});
test('[hidden] NUL preserved', () => {
  assert.equal(api.decodeMemo(api.buildMemo('a\0b', []).data), 'a\0b');
});
test('[hidden] decode byte cap', () => {
  assert.throws(() => api.decodeMemo(new Uint8Array(513)));
});
test('[hidden] do not mutate signers', () => {
  const a = [B, A, B];
  api.buildMemo('x', a);
  assert.deepEqual(a, [B, A, B]);
});
