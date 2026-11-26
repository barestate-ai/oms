import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

test('[visible] initialize instruction', () => {
  assert.equal(hex(api.instructionDiscriminator('initialize')), 'afaf6d1f0d989bed');
});
test('[visible] User account', () => {
  assert.equal(hex(api.accountDiscriminator('User')), '9f755fe3ef973aec');
});
