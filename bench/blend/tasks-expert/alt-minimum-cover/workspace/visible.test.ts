import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from './index.ts';
test('contract group 0', () => {
  {
    const input = JSON.parse(
      '{"payer":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","blockhash":"f23c793156690d6221fb12aaffec1da34afbeed74b6734545028bd29d48addca","instructions":[{"program":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","accounts":[{"key":"f7a39719e9ae263cd06dabea8803664695fd021d4ccc55e0897a359584274cd9","signer":false,"writable":true},{"key":"0beef5150524a74e3fb5c7dac3677bb275bd17bdb71a67d769bdf883b38ce3cb","signer":false,"writable":false}],"data":"01"}],"tables":[{"key":"16eef953e7114600428be81d81ff13a1f787557bad4c747f97916eb68938c33a","addresses":["f7a39719e9ae263cd06dabea8803664695fd021d4ccc55e0897a359584274cd9","0beef5150524a74e3fb5c7dac3677bb275bd17bdb71a67d769bdf883b38ce3cb"],"lastExtendedSlot":8,"lastStartIndex":0,"deactivationSlot":"18446744073709551615"}],"slot":10,"recentSlots":[9,8,7],"limit":1232}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"message":"80010001027eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046bf23c793156690d6221fb12aaffec1da34afbeed74b6734545028bd29d48addca010102020301010116eef953e7114600428be81d81ff13a1f787557bad4c747f97916eb68938c33a01000101","size":210,"signers":["7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9"],"tables":["16eef953e7114600428be81d81ff13a1f787557bad4c747f97916eb68938c33a"],"loaded":["f7a39719e9ae263cd06dabea8803664695fd021d4ccc55e0897a359584274cd9","0beef5150524a74e3fb5c7dac3677bb275bd17bdb71a67d769bdf883b38ce3cb"],"order":["7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","f7a39719e9ae263cd06dabea8803664695fd021d4ccc55e0897a359584274cd9","0beef5150524a74e3fb5c7dac3677bb275bd17bdb71a67d769bdf883b38ce3cb"]}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 4', () => {
  {
    const input = JSON.parse(
      '{"payer":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","blockhash":"f23c793156690d6221fb12aaffec1da34afbeed74b6734545028bd29d48addca","instructions":[{"program":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","accounts":[{"key":"f7a39719e9ae263cd06dabea8803664695fd021d4ccc55e0897a359584274cd9","signer":false,"writable":true},{"key":"0beef5150524a74e3fb5c7dac3677bb275bd17bdb71a67d769bdf883b38ce3cb","signer":false,"writable":false}],"data":"01"}],"tables":[{"key":"16eef953e7114600428be81d81ff13a1f787557bad4c747f97916eb68938c33a","addresses":["f7a39719e9ae263cd06dabea8803664695fd021d4ccc55e0897a359584274cd9","0beef5150524a74e3fb5c7dac3677bb275bd17bdb71a67d769bdf883b38ce3cb"],"lastExtendedSlot":10,"lastStartIndex":2,"deactivationSlot":"18446744073709551615"}],"slot":10,"recentSlots":[9,8,7],"limit":1232}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '{"message":"80010001027eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046bf23c793156690d6221fb12aaffec1da34afbeed74b6734545028bd29d48addca010102020301010116eef953e7114600428be81d81ff13a1f787557bad4c747f97916eb68938c33a01000101","size":210,"signers":["7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9"],"tables":["16eef953e7114600428be81d81ff13a1f787557bad4c747f97916eb68938c33a"],"loaded":["f7a39719e9ae263cd06dabea8803664695fd021d4ccc55e0897a359584274cd9","0beef5150524a74e3fb5c7dac3677bb275bd17bdb71a67d769bdf883b38ce3cb"],"order":["7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","f7a39719e9ae263cd06dabea8803664695fd021d4ccc55e0897a359584274cd9","0beef5150524a74e3fb5c7dac3677bb275bd17bdb71a67d769bdf883b38ce3cb"]}',
      ),
    );
    assert.deepEqual(input, before);
  }
});
