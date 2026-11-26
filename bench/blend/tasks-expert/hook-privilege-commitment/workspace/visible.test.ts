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
