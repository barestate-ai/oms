import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from './index.ts';
test('contract group 0', () => {
  {
    const input = JSON.parse('{"data":"e45632ea4f8d5ce500000000"}');
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"0b5ebe95a2e44c010000","size":10,"hash":"f18c1c6680def6ef9b388658fb0e3e4d57e08ec6072a682aa66d27d934d50b71","total":"0","order":[]}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 4', () => {
  {
    const input = JSON.parse(
      '{"data":"e45632ea4f8d5ce502000000010000007a0100000000000000000000000100000061010000000000000000000000"}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"0b5ebe95a2e44c0102000161010000000000000000000000000000000000017a010000000000000000000000000000000000","size":50,"hash":"5ce2dbf2f35819c4ef2f70118cfcf83ffd42632849572f683ae86bde7a5ed765","total":"2","order":["a","z"]}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
