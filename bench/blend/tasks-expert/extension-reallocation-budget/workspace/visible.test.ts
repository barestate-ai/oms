import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from './index.ts';
test('contract group 0', () => {
  {
    const input = JSON.parse(
      '{"kind":"account","tlv":"","updates":[],"lamports":"1","withheld":"1","rent":{"base":"1","perByte":"1","numerator":"1","denominator":"3"},"funders":[{"id":"payer","balance":"100000"}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse('{"tlv":"","size":165,"requiredRent":"56","topup":"56","funders":[{"id":"payer","balance":"99944"}]}'),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 4', () => {
  {
    const input = JSON.parse(
      '{"kind":"account","tlv":"","updates":[{"tag":7,"data":"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"}],"lamports":"1","withheld":"1","rent":{"base":"1","perByte":"1","numerator":"1","denominator":"3"},"funders":[{"id":"payer","balance":"100000"}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"tlv":"07007f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000","size":304,"requiredRent":"102","topup":"102","funders":[{"id":"payer","balance":"99898"}]}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
