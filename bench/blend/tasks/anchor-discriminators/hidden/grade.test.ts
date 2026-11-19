import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

test('[hidden] initialize instruction', () => {
  assert.equal(hex(api.instructionDiscriminator('initialize')), 'afaf6d1f0d989bed');
});
test('[hidden] User account', () => {
  assert.equal(hex(api.accountDiscriminator('User')), '9f755fe3ef973aec');
});
test('[hidden] namespaces differ', () => {
  assert.notDeepEqual(api.instructionDiscriminator('State'), api.accountDiscriminator('State'));
});
test('[hidden] case preserved', () => {
  assert.equal(hex(api.accountDiscriminator('user')), 'f06d8ea96bbc4726');
});
test('[hidden] snake case unchanged', () => {
  assert.equal(hex(api.instructionDiscriminator('set_authority')), '85fa25156ea31a79');
});
test('[hidden] utf8', () => {
  assert.equal(hex(api.accountDiscriminator('金庫')), '14cdd48cb9fe0aa1');
});
test('[hidden] prefix match allows suffix', () => {
  assert.equal(api.hasAccountDiscriminator(bytes('d308e82b02987577ff'), 'Vault'), true);
});
test('[hidden] short data', () => {
  assert.equal(api.hasAccountDiscriminator(new Uint8Array(7), 'Vault'), false);
});
test('[hidden] wrong prefix', () => {
  assert.equal(api.hasAccountDiscriminator(new Uint8Array(16), 'Vault'), false);
});
test('[hidden] reject empty names', () => {
  assert.throws(() => api.instructionDiscriminator(''));
  assert.throws(() => api.accountDiscriminator(''));
});
