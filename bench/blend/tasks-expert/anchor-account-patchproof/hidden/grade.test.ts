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
test('contract group 1', () => {
  {
    const input = JSON.parse(
      '{"data":"750421c1ee886e2000000600000000000000616263646566f57f7f575e81e09ac5c096b493f6895ddc22b913f65d70f629dae19d8ff5cec3","patches":[],"targetVersion":1}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"95fa9bc66575014606000000616263646566","payload":"616263646566","spans":[],"size":18,"commitment":"f36a0e3cdbcdc5197d166d22a88c00b09842356940a5f6a5abedfe9d900a0d37"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 2', () => {
  {
    const input = JSON.parse('{"data":"95fa9bc66575014600000000","patches":[],"targetVersion":2}');
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e20000000000000000000002d4747cd04076a10c7edf8479c9519137317a068a398673cc8aacebb1613914c","payload":"","spans":[],"size":50,"commitment":"19a5efdf9e13c26c41f0ed1c24b3c7abbfef0704f0540bdc90f7228ab5c12490"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 3', () => {
  {
    const input = JSON.parse(
      '{"data":"95fa9bc66575014606000000616263646566","patches":[{"offset":1,"delete":2,"data":"ff"}],"targetVersion":2}',
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
test('contract group 5', () => {
  {
    const input = JSON.parse(
      '{"data":"95fa9bc66575014606000000616263646566","patches":[{"offset":1,"delete":0,"data":"11"},{"offset":1,"delete":0,"data":"22"}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e20000008000000000000006111226263646566854eca558ea284182a68aa3d102b0c404b695d2d2860572ddc5fb26888a78b52","payload":"6111226263646566","spans":[{"index":0,"start":1,"end":2},{"index":1,"start":2,"end":3}],"size":58,"commitment":"22421f5b001f032813b6d0ea177c61b6a275b986c0a9a7817dd31baae0e41fb9"}',
      ),
    );
    assert.deepEqual(input, before);
  }
  {
    const input = JSON.parse(
      '{"data":"95fa9bc66575014606000000616263646566","patches":[{"offset":1,"delete":2,"data":""},{"offset":2,"delete":2,"data":""}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(solve(input), JSON.parse('{"error":"invalid"}'));
    assert.deepEqual(input, before);
  }
});
test('contract group 6', () => {
  {
    const input = JSON.parse(
      '{"data":"750421c1ee886e2000000600000000000000616263646566f57f7f575e81e09ac5c096b493f6895ddc22b913f65d70f629dae19d8ff5cec3","patches":[{"offset":1,"delete":0,"data":"11"},{"offset":1,"delete":0,"data":"22"}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e20000008000000000000006111226263646566854eca558ea284182a68aa3d102b0c404b695d2d2860572ddc5fb26888a78b52","payload":"6111226263646566","spans":[{"index":0,"start":1,"end":2},{"index":1,"start":2,"end":3}],"size":58,"commitment":"22421f5b001f032813b6d0ea177c61b6a275b986c0a9a7817dd31baae0e41fb9"}',
      ),
    );
    assert.deepEqual(input, before);
  }
  {
    const input = JSON.parse(
      '{"data":"750421c1ee886e2000000600000000000000616263646566f57f7f575e81e09ac5c096b493f6895ddc22b913f65d70f629dae19d8ff5ceff","patches":[],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(solve(input), JSON.parse('{"error":"invalid"}'));
    assert.deepEqual(input, before);
  }
});
test('contract group 7', () => {
  {
    const input = JSON.parse(
      '{"data":"95fa9bc66575014606000000616263646566","patches":[{"offset":1,"delete":2,"data":"aa"},{"offset":1,"delete":2,"data":"aa"}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e200000050000000000000061aa6465664ec396013a732c3c9b19db076697e6737e5943cd3027ac50f6606bddc72525ad","payload":"61aa646566","spans":[{"index":0,"start":1,"end":2},{"index":1,"start":1,"end":2}],"size":55,"commitment":"e6751fe60ba2c5bda475f5e23705bb449c3b18b8015f2a5b6661845ce95c8c20"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 8', () => {
  {
    const input = JSON.parse(
      '{"data":"750421c1ee886e2000000600000000000000616263646566f57f7f575e81e09ac5c096b493f6895ddc22b913f65d70f629dae19d8ff5cec3","patches":[{"offset":1,"delete":2,"data":"aa"},{"offset":1,"delete":2,"data":"aa"}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e200000050000000000000061aa6465664ec396013a732c3c9b19db076697e6737e5943cd3027ac50f6606bddc72525ad","payload":"61aa646566","spans":[{"index":0,"start":1,"end":2},{"index":1,"start":1,"end":2}],"size":55,"commitment":"e6751fe60ba2c5bda475f5e23705bb449c3b18b8015f2a5b6661845ce95c8c20"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 9', () => {
  {
    const input = JSON.parse(
      '{"data":"95fa9bc66575014606000000616263646566","patches":[{"offset":1,"delete":2,"data":"aa"},{"offset":1,"delete":0,"data":"bb"},{"offset":3,"delete":0,"data":"cc"}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e200000070000000000000061bbaacc646566e1957dbc387c374d72268f0780365e36b73f4da6736feb262399786af1f8b672","payload":"61bbaacc646566","spans":[{"index":0,"start":2,"end":3},{"index":1,"start":1,"end":2},{"index":2,"start":3,"end":4}],"size":57,"commitment":"9b01c7cdf4ad0aa0a62c36e2f9fd09370336a0e832aa6fbad66a6d3d014bd7b1"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 10', () => {
  {
    const input = JSON.parse(
      '{"data":"750421c1ee886e2000000600000000000000616263646566f57f7f575e81e09ac5c096b493f6895ddc22b913f65d70f629dae19d8ff5cec3","patches":[{"offset":1,"delete":2,"data":"aa"},{"offset":1,"delete":0,"data":"bb"},{"offset":3,"delete":0,"data":"cc"}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e200000070000000000000061bbaacc646566e1957dbc387c374d72268f0780365e36b73f4da6736feb262399786af1f8b672","payload":"61bbaacc646566","spans":[{"index":0,"start":2,"end":3},{"index":1,"start":1,"end":2},{"index":2,"start":3,"end":4}],"size":57,"commitment":"9b01c7cdf4ad0aa0a62c36e2f9fd09370336a0e832aa6fbad66a6d3d014bd7b1"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 11', () => {
  {
    const input = JSON.parse(
      '{"data":"95fa9bc66575014606000000616263646566","patches":[{"offset":0,"delete":1,"data":"00"},{"offset":1,"delete":1,"data":"11"}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e20000006000000000000000011636465668ea9422cf6ca13573b5d2ccbf1e309338e7190fb4e33630cd3cf2a2f187abbd5","payload":"001163646566","spans":[{"index":0,"start":0,"end":1},{"index":1,"start":1,"end":2}],"size":56,"commitment":"897032460c3f8ab1465b53bef1f9aab628bb636d53960e14adbc54dcdf02999c"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 12', () => {
  {
    const input = JSON.parse(
      '{"data":"750421c1ee886e2000000600000000000000616263646566f57f7f575e81e09ac5c096b493f6895ddc22b913f65d70f629dae19d8ff5cec3","patches":[{"offset":0,"delete":1,"data":"00"},{"offset":1,"delete":1,"data":"11"}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e20000006000000000000000011636465668ea9422cf6ca13573b5d2ccbf1e309338e7190fb4e33630cd3cf2a2f187abbd5","payload":"001163646566","spans":[{"index":0,"start":0,"end":1},{"index":1,"start":1,"end":2}],"size":56,"commitment":"897032460c3f8ab1465b53bef1f9aab628bb636d53960e14adbc54dcdf02999c"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 13', () => {
  {
    const input = JSON.parse(
      '{"data":"95fa9bc66575014606000000616263646566","patches":[{"offset":6,"delete":0,"data":"ff"}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e2000000700000000000000616263646566ff046256a1233eae39a54be9653c6479cd7b45b49a1cda477509623c71ce6203a1","payload":"616263646566ff","spans":[{"index":0,"start":6,"end":7}],"size":57,"commitment":"5c0031a61e262a09a77c7ffa9c5a71b9d7fab394c68d6e6f739338104bab6dbf"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 14', () => {
  {
    const input = JSON.parse(
      '{"data":"750421c1ee886e2000000600000000000000616263646566f57f7f575e81e09ac5c096b493f6895ddc22b913f65d70f629dae19d8ff5cec3","patches":[{"offset":6,"delete":0,"data":"ff"}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e2000000700000000000000616263646566ff046256a1233eae39a54be9653c6479cd7b45b49a1cda477509623c71ce6203a1","payload":"616263646566ff","spans":[{"index":0,"start":6,"end":7}],"size":57,"commitment":"5c0031a61e262a09a77c7ffa9c5a71b9d7fab394c68d6e6f739338104bab6dbf"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 15', () => {
  {
    const input = JSON.parse(
      '{"data":"95fa9bc66575014606000000616263646566","patches":[{"offset":0,"delete":6,"data":""}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e20000000000000000000002d4747cd04076a10c7edf8479c9519137317a068a398673cc8aacebb1613914c","payload":"","spans":[{"index":0,"start":0,"end":0}],"size":50,"commitment":"19a5efdf9e13c26c41f0ed1c24b3c7abbfef0704f0540bdc90f7228ab5c12490"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 16', () => {
  {
    const input = JSON.parse(
      '{"data":"750421c1ee886e2000000600000000000000616263646566f57f7f575e81e09ac5c096b493f6895ddc22b913f65d70f629dae19d8ff5cec3","patches":[{"offset":0,"delete":6,"data":""}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e20000000000000000000002d4747cd04076a10c7edf8479c9519137317a068a398673cc8aacebb1613914c","payload":"","spans":[{"index":0,"start":0,"end":0}],"size":50,"commitment":"19a5efdf9e13c26c41f0ed1c24b3c7abbfef0704f0540bdc90f7228ab5c12490"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 17', () => {
  {
    const input = JSON.parse(
      '{"data":"95fa9bc66575014606000000616263646566","patches":[{"offset":2,"delete":0,"data":""}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e2000000600000000000000616263646566f57f7f575e81e09ac5c096b493f6895ddc22b913f65d70f629dae19d8ff5cec3","payload":"616263646566","spans":[{"index":0,"start":2,"end":2}],"size":56,"commitment":"ac41e6159b33df0db1d56ef303b09b0e70425328cb6ab9159e51458a886a2873"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 18', () => {
  {
    const input = JSON.parse(
      '{"data":"750421c1ee886e2000000600000000000000616263646566f57f7f575e81e09ac5c096b493f6895ddc22b913f65d70f629dae19d8ff5cec3","patches":[{"offset":2,"delete":0,"data":""}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"data":"750421c1ee886e2000000600000000000000616263646566f57f7f575e81e09ac5c096b493f6895ddc22b913f65d70f629dae19d8ff5cec3","payload":"616263646566","spans":[{"index":0,"start":2,"end":2}],"size":56,"commitment":"ac41e6159b33df0db1d56ef303b09b0e70425328cb6ab9159e51458a886a2873"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 19', () => {
  {
    const input = JSON.parse(
      '{"data":"95fa9bc66575014606000000616263646566","patches":[{"offset":1,"delete":3,"data":""},{"offset":2,"delete":0,"data":""}],"targetVersion":2}',
    );
    const before = structuredClone(input);
    assert.deepEqual(solve(input), JSON.parse('{"error":"invalid"}'));
    assert.deepEqual(input, before);
  }
});
