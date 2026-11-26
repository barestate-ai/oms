import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';

test('[hidden] one sol', () => {
  assert.equal(api.parseSol('1'), 1000000000n);
});
test('[hidden] zero display', () => {
  assert.equal(api.formatSol(0n), '0');
});
test('[hidden] single lamport', () => {
  assert.equal(api.parseSol('0.000000001'), 1n);
});
test('[hidden] strip zeros', () => {
  assert.equal(api.formatSol(1234500000n), '1.2345');
});
test('[hidden] full u64', () => {
  assert.equal(api.parseSol('18446744073.709551615'), 18446744073709551615n);
});
test('[hidden] reject ambiguous decimals', () => {
  for (const x of ['01', '+1', '-0', ' 1', '1.', '1e3', '.5', '0.0000000000']) assert.throws(() => api.parseSol(x));
});
test('[hidden] decimal overflow', () => {
  assert.throws(() => api.parseSol('18446744073.709551616'));
});
test('[hidden] add overflow', () => {
  assert.throws(() => api.checkedAdd(18446744073709551615n, 1n));
});
test('[hidden] sub underflow', () => {
  assert.throws(() => api.checkedSub(0n, 1n));
});
test('[hidden] operands validated independently', () => {
  assert.throws(() => api.checkedAdd(-1n, 2n));
  assert.throws(() => api.checkedSub(18446744073709551616n, 1n));
});
