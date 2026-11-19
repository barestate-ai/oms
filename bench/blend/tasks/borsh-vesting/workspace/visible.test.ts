import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const empty = () => ({ owner: new Uint8Array(32), label: '', delegate: null, entries: [] });

test('[visible] empty encoding', () => {
  assert.equal(
    hex(api.encodeVesting(empty())),
    '0000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  );
});
test('[visible] empty decode', () => {
  assert.equal(
    api.decodeVesting(bytes('0000000000000000000000000000000000000000000000000000000000000000000000000000000000'))
      .delegate,
    null,
  );
});
