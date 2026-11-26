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
test('contract group 1', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[{"kind":"return","data":"aabb"},{"kind":"readReturn","max":1}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":997,"events":[["return","P","aa",2]],"returnData":{"program":"P","data":"aabb"}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 2', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[{"kind":"return","data":"aabb"},{"kind":"readReturn","max":0},{"kind":"readReturn","max":2},{"kind":"readReturn","max":5}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":995,"events":[["return","P","",2],["return","P","aabb",2],["return","P","aabb",2]],"returnData":{"program":"P","data":"aabb"}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 3', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[{"kind":"return","data":"aa"},{"kind":"invoke","program":"P","metas":[{"id":"a","signer":true,"writable":true},{"id":"b","signer":true,"writable":true}],"ops":[{"kind":"return","data":"bb"},{"kind":"fail"}],"catch":true},{"kind":"readReturn","max":5}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":989,"events":[["invoke","P",false],["return","P","bb",1]],"returnData":{"program":"P","data":"bb"}}',
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
test('contract group 5', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[{"kind":"read","id":"a","token":"r"},{"kind":"invoke","program":"P","metas":[{"id":"a","signer":true,"writable":true},{"id":"b","signer":true,"writable":true}],"ops":[{"kind":"read","id":"a","token":"r"},{"kind":"fail"}],"catch":true},{"kind":"read","id":"a","token":"r"}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":991,"events":[["read","a","100","aabb"],["invoke","P",false],["read","a","100","aabb"]],"returnData":{"program":"","data":""}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 6', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[{"kind":"invoke","program":"P","metas":[{"id":"a","signer":true,"writable":true},{"id":"b","signer":true,"writable":true}],"ops":[{"kind":"set","id":"a","lamports":"0"}],"catch":true},{"kind":"read","id":"a","token":"r"}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":991,"events":[["invoke","P",false],["read","a","100","aabb"]],"returnData":{"program":"","data":""}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 7', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[{"kind":"return","data":"aa"},{"kind":"invoke","program":"P","metas":[{"id":"missing","signer":true,"writable":true}],"ops":[],"catch":true},{"kind":"readReturn","max":5}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":992,"events":[["invoke","P",false],["return","","",0]],"returnData":{"program":"","data":""}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 8', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[{"kind":"invoke","program":"Q","metas":[{"id":"a","signer":true,"writable":true},{"id":"b","signer":true,"writable":true}],"ops":[{"kind":"return","data":"cc"}],"catch":true},{"kind":"readReturn","max":1}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":992,"events":[["invoke","Q",true],["return","Q","cc",1]],"returnData":{"program":"Q","data":"cc"}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 9', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[{"kind":"return","data":"dd"},{"kind":"fail"}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":false,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":997,"events":[],"returnData":{"program":"P","data":"dd"}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 10', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":false},{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[{"kind":"write","id":"a","data":"ff"}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"ff","signer":true,"writable":true}],"remaining":997,"events":[],"returnData":{"program":"","data":""}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 11', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":false,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[{"kind":"invoke","program":"P","metas":[{"id":"a","signer":true,"writable":true}],"ops":[],"catch":true}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":false,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":995,"events":[["invoke","P",false]],"returnData":{"program":"","data":""}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 12', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":0,"ops":[{"kind":"return","data":"aa"},{"kind":"readReturn","max":0}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":false,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":0,"events":[],"returnData":{"program":"","data":""}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 13', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1,"ops":[{"kind":"return","data":"aa"},{"kind":"readReturn","max":0}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":false,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":0,"events":[],"returnData":{"program":"","data":""}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 14', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":2,"ops":[{"kind":"return","data":"aa"},{"kind":"readReturn","max":0}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":false,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":0,"events":[],"returnData":{"program":"P","data":"aa"}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 15', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":4,"ops":[{"kind":"return","data":"aa"},{"kind":"readReturn","max":0}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":1,"events":[["return","P","",1]],"returnData":{"program":"P","data":"aa"}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 16', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":5,"ops":[{"kind":"return","data":"aa"},{"kind":"readReturn","max":0}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":2,"events":[["return","P","",1]],"returnData":{"program":"P","data":"aa"}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 17', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":6,"ops":[{"kind":"return","data":"aa"},{"kind":"readReturn","max":0}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":3,"events":[["return","P","",1]],"returnData":{"program":"P","data":"aa"}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 18', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[{"kind":"return","data":"abababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab"},{"kind":"readReturn","max":1024}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":true,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":997,"events":[["return","P","abababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab",1024]],"returnData":{"program":"P","data":"abababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab"}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 19', () => {
  {
    const input = JSON.parse(
      '{"program":"P","accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"units":1000,"ops":[{"kind":"return","data":"ababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab"}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"committed":false,"accounts":[{"id":"a","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true},{"id":"b","owner":"P","lamports":"100","data":"aabb","signer":true,"writable":true}],"remaining":998,"events":[],"returnData":{"program":"","data":""}}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
