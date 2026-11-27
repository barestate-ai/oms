import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';

test('[hidden] zero', () => {
  assert.deepEqual([...api.encodeShortU16(0)], [0]);
});
test('[hidden] single-byte boundary', () => {
  assert.deepEqual(api.decodeShortU16(Uint8Array.of(127)), { value: 127, offset: 1 });
});
test('[hidden] two-byte lower boundary', () => {
  assert.deepEqual([...api.encodeShortU16(128)], [128, 1]);
});
test('[hidden] two-byte upper boundary', () => {
  assert.deepEqual([...api.encodeShortU16(16383)], [255, 127]);
});
test('[hidden] three-byte boundary', () => {
  assert.deepEqual([...api.encodeShortU16(16384)], [128, 128, 1]);
});
test('[hidden] u16 maximum', () => {
  assert.deepEqual(api.decodeShortU16(Uint8Array.of(255, 255, 3)), { value: 65535, offset: 3 });
});
test('[hidden] offset and suffix', () => {
  assert.deepEqual(api.decodeShortU16(Uint8Array.of(99, 128, 1, 77), 1), { value: 128, offset: 3 });
});
test('[hidden] reject nonminimal', () => {
  for (const b of [
    [128, 0],
    [129, 0],
    [128, 128, 0],
  ])
    assert.throws(() => api.decodeShortU16(Uint8Array.from(b)));
});
test('[hidden] reject truncation overflow', () => {
  for (const b of [[], [128], [128, 128], [255, 255, 4], [128, 128, 128, 0]])
    assert.throws(() => api.decodeShortU16(Uint8Array.from(b)));
});
test('[hidden] integer domains', () => {
  for (const n of [-1, 65536, 1.5, NaN, Infinity]) assert.throws(() => api.encodeShortU16(n));
  for (const o of [-1, 1.5, 4]) assert.throws(() => api.decodeShortU16(Uint8Array.of(0), o));
});
