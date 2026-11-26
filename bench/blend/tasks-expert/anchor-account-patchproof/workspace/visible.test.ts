import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from './index.ts';
test('contract group 0', () => {
  {
    const input = JSON.parse('{"data":"95fa9bc66575014606000000616263646566","patches":[],"targetVersion":2}');
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e2000000600000000000000616263646566f57f7f575e81e09ac5c096b493f6895ddc22b913f65d70f629dae19d8ff5cec3","payload":"616263646566","spans":[],"size":56,"commitment":"ac41e6159b33df0db1d56ef303b09b0e70425328cb6ab9159e51458a886a2873"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 4', () => {
  {
    const input = JSON.parse(
      '{"data":"750421c1ee886e2000000600000000000000616263646566f57f7f575e81e09ac5c096b493f6895ddc22b913f65d70f629dae19d8ff5cec3","patches":[{"offset":1,"delete":2,"data":"ff"}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e200000050000000000000061ff646566c7d335be6377b820a2a038f43392218ef437748e6ba2bd46ca85ad0117363b49","payload":"61ff646566","spans":[{"index":0,"start":1,"end":2}],"size":55,"commitment":"dfe394fb47404302f4154bee182dfddd12d8e966c3ec8f50b8336b8d684de03a"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
