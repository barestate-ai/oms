import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';

test('[visible] zero', () => {
  assert.deepEqual([...api.encodeShortU16(0)], [0]);
});
test('[visible] single-byte boundary', () => {
  assert.deepEqual(api.decodeShortU16(Uint8Array.of(127)), { value: 127, offset: 1 });
});
