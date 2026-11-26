import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from './index.ts';
test('contract group 0', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0000000000000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true},{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","signer":false,"writable":false}],"positions":[0,1],"commitment":"891deb7d89ef3b2e1430ea0f05ec87b4f1789c198d60b735718af40001c3e94a"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 1', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0200020000000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true},{"key":"d6d8c229a90bdb818da3735a12e4ae772d2460531943d26b80422be3cabc67b9","signer":false,"writable":false}],"positions":[0,1],"commitment":"041731695119cf01a7100487025b8af7e585e1bf135d52753bc13f1bd178eed1"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 2', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0202000000000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true},{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","signer":false,"writable":false}],"positions":[0,1],"commitment":"891deb7d89ef3b2e1430ea0f05ec87b4f1789c198d60b735718af40001c3e94a"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 3', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0400000200000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true},{"key":"82dc51a5bc2e9d6f3908ee6497d4b6c7c8515ff9e02368918857dddc42b9ef6f","signer":false,"writable":false}],"positions":[0,1],"commitment":"7db026771d6e177bc4d984fbe342f8f90b0708c4957404a047b777dc2ebe6fdb"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 4', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0400020000000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true},{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","signer":false,"writable":false}],"positions":[0,1],"commitment":"891deb7d89ef3b2e1430ea0f05ec87b4f1789c198d60b735718af40001c3e94a"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 5', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0300000000000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true},{"key":"dd8f37eb4ef08426ca2ade92e1f0e3b892efe4676b86e9b1c729deb981e592b6","signer":false,"writable":false}],"positions":[0,1],"commitment":"16d71daaa7c2c988f4da3f0067a7bc95b92fa78189711fa188da68f0905a02ec"}',
      ),
    );
    assert.deepEqual(input, before);
  }
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[],"extras":[]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[],"positions":[],"commitment":"0db8f747b941cdb0f3c800cc6125138d64dc7ca8cdc2ea591c4fa4e0493736e8"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 6', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0100000000000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true},{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","signer":false,"writable":false}],"positions":[0,1],"commitment":"891deb7d89ef3b2e1430ea0f05ec87b4f1789c198d60b735718af40001c3e94a"}',
      ),
    );
    assert.deepEqual(input, before);
  }
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"1111111111111111111111111111111111111111111111111111111111111111","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0200200000000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true},{"key":"84657e41666b817814a4c53fe5be09051794f39327d66bde6cb002790ee96ea0","signer":false,"writable":false}],"positions":[0,1],"commitment":"6184cd6ee93b5e23292694bc5270ab35c209abd75ae83e767187efc222c3946c"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 7', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0103010203000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true},{"key":"18d3db5927d13c45a25a24c9e36018bfbc6eb2a2c44993c5c85954b526df3e39","signer":false,"writable":false}],"positions":[0,1],"commitment":"33f93329235c6d765612e3e852bbf21a5e23a907189b6f62ae6cf0888326acbc"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 8', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"011e070707070707070707070707070707070707070707070707070707070707","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true},{"key":"18b0b7f3a0abc8712c5b7cc4c8f0c6e58bc1b226746ba938561915b3d981ddba","signer":false,"writable":false}],"positions":[0,1],"commitment":"cfc7a76598cbca22a9f43a16e05c4a3f03e9dd2b040f88981694697c4a3447cc"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 9', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0100010001000100010001000100010001000100010001000100010001000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true},{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","signer":false,"writable":false}],"positions":[0,1],"commitment":"891deb7d89ef3b2e1430ea0f05ec87b4f1789c198d60b735718af40001c3e94a"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 10', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0100010001000100010001000100010001000100010001000100010001000100","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(solve(input), JSON.parse('{"error":"invalid"}'));
    assert.deepEqual(input, before);
  }
});
test('contract group 11', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0000000000000000000000000000000000000000000000000000000000000000","signer":false,"writable":false},{"programIndex":1,"config":"0301000000000000000000000000000000000000000000000000000000000000","signer":true,"writable":true}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true},{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","signer":false,"writable":false},{"key":"2e6c2a3f1e8cd7c609916cee48a0cbb3463c23b116d53287b3b7a22350f43a18","signer":true,"writable":true}],"positions":[0,1,2],"commitment":"072c141ff04c027dad4dc5d8f3b2cc8cb4d2f333ce64b235d433fa40911b19ff"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 12', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0000000000000000000000000000000000000000000000000000000000000000","signer":false,"writable":false},{"programIndex":null,"config":"0401000000000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(solve(input), JSON.parse('{"error":"invalid"}'));
    assert.deepEqual(input, before);
  }
});
test('contract group 13', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","data":"","signer":false,"writable":false}],"extras":[{"programIndex":null,"config":"0000000000000000000000000000000000000000000000000000000000000000","signer":true,"writable":true}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","signer":false,"writable":false}],"positions":[0,0],"commitment":"06c970529652376d973b38bb0712ec720560862545f130234b41fdea6c327a68"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 14', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","data":"","signer":false,"writable":false},{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","data":"","signer":true,"writable":true}],"extras":[{"programIndex":null,"config":"0000000000000000000000000000000000000000000000000000000000000000","signer":true,"writable":true}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","signer":true,"writable":true}],"positions":[0,0,0],"commitment":"ed169da422a87dbb432f773592cb48e6e19e7fa0c06b25888669d6a022f8dc6b"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 15', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","data":"","signer":true,"writable":false},{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","data":"","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0000000000000000000000000000000000000000000000000000000000000000","signer":true,"writable":true}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"accounts":[{"key":"40a701342a8f83dd7171015df0d27c11495eabfd711652804d5e35eb87ce6c83","signer":true,"writable":true}],"positions":[0,0,0],"commitment":"ed169da422a87dbb432f773592cb48e6e19e7fa0c06b25888669d6a022f8dc6b"}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 16', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0201020000000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(solve(input), JSON.parse('{"error":"invalid"}'));
    assert.deepEqual(input, before);
  }
});
test('contract group 17', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0400010200000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(solve(input), JSON.parse('{"error":"invalid"}'));
    assert.deepEqual(input, before);
  }
});
test('contract group 18', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0700000000000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(solve(input), JSON.parse('{"error":"invalid"}'));
    assert.deepEqual(input, before);
  }
});
test('contract group 19', () => {
  {
    const input = JSON.parse(
      '{"program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","instruction":"00ff","base":[{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","data":"aabb","signer":false,"writable":true}],"extras":[{"programIndex":null,"config":"0001000000000000000000000000000000000000000000000000000000000000","signer":false,"writable":false}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(solve(input), JSON.parse('{"error":"invalid"}'));
    assert.deepEqual(input, before);
  }
});
