import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from './index.ts';
test('contract group 0', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":1000,"events":[],"returnData":{"program":"","data":""}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 4', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[{"kind":"return","data":"aa"},{"kind":"invoke","program":"P","metas":[{"id":"a","signer":true,"writable":true},{"id":"b","signer":true,"writable":true}],"ops":[],"catch":true},{"kind":"readReturn","max":5}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":992,"events":[["invoke","P",true],["return","","",0]],"returnData":{"program":"","data":""}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
