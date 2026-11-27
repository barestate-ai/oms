import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const P = '11111111111111111111111111111111';
const line = (n) => `Program ${P} failed: custom program error: ${n}`;

test('[hidden] no errors', () => {
  assert.deepEqual(api.customErrors([]), []);
});
test('[hidden] hex code', () => {
  assert.deepEqual(api.customErrors([line('0x1770')]), [{ programId: P, code: 6000, line: 0 }]);
});
test('[hidden] decimal', () => {
  assert.equal(api.lastCustomError([line('42')]).code, 42);
});
test('[hidden] uppercase hex digits', () => {
  assert.equal(api.lastCustomError([line('0xFFFFffff')]).code, 4294967295);
});
test('[hidden] last and indices', () => {
  assert.equal(api.lastCustomError(['noise', line('1'), line('2')]).line, 2);
});
test('[hidden] spoofed program text', () => {
  assert.deepEqual(api.customErrors(['Program log: ' + line('0x1')]), []);
});
test('[hidden] reject suffix and whitespace', () => {
  assert.deepEqual(api.customErrors([line('1') + ' ignored', ' ' + line('1'), line('1') + ' ']), []);
});
test('[hidden] overflow', () => {
  assert.equal(api.lastCustomError([line('4294967296')]), null);
});
test('[hidden] bad numbers', () => {
  for (const n of ['0x', '-1', '0x-1', '1.0']) assert.equal(api.lastCustomError([line(n)]), null);
});
test('[hidden] bad address', () => {
  assert.equal(api.lastCustomError(['Program 111 failed: custom program error: 1']), null);
});
