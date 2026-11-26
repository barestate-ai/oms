import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from './index.ts';
test('contract group 0', () => {
  {
    const input = JSON.parse(
      '{"root":"root","accounts":[{"key":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","signer":false,"writable":false},{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true}],"nodes":[{"id":"root","program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","metas":[{"key":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","signer":false,"writable":false},{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true}],"derived":[],"children":[]}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '[{"id":"root","program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","metas":[{"key":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","signer":false,"writable":false},{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true}],"hash":"712feb61f7b2d44786bb7f6b89bacf9ebb687bacfad14a97f89c4318eab74c48"}]',
      ),
    );
    assert.deepEqual(input, before);
  }
});
test('contract group 4', () => {
  {
    const input = JSON.parse(
      '{"root":"n0","accounts":[{"key":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","signer":false,"writable":false},{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true}],"nodes":[{"id":"n0","program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","metas":[{"key":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","signer":false,"writable":false},{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true}],"derived":[],"children":["n1"]},{"id":"n1","program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","metas":[{"key":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","signer":false,"writable":false},{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true}],"derived":[],"children":["n2"]},{"id":"n2","program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","metas":[{"key":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","signer":false,"writable":false},{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true}],"derived":[],"children":["n3"]},{"id":"n3","program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","metas":[{"key":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","signer":false,"writable":false},{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true}],"derived":[],"children":[]}]}',
    );
    const before = structuredClone(input);
    assert.deepEqual(
      solve(input),
      JSON.parse(
        '[{"id":"n0","program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","metas":[{"key":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","signer":false,"writable":false},{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true}],"hash":"df161a967a9ebca636239e1ff3609f1a1a8a2306261db3eeccfc4a65c129ac14"},{"id":"n1","program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","metas":[{"key":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","signer":false,"writable":false},{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true}],"hash":"3c54fdc70aa1e7a013f279f3ecdc1402d5fcdbedc4296e9036e72438d2249250"},{"id":"n2","program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","metas":[{"key":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","signer":false,"writable":false},{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true}],"hash":"aa369d2a9d04af9845627cc1b5e642b7052bd381594c8aca8bb70ea691b2a50d"},{"id":"n3","program":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","metas":[{"key":"7eb2bc4028d585eab3e9cf719673d300231e8120031b28ffca0d55f2ca7fbef9","signer":false,"writable":false},{"key":"639685d61ae30301e3b4f0fdd8ad789d8ad0de0bdc7ab0fa8f514f63a5dc046b","signer":false,"writable":true}],"hash":"7ec08676da36bbea38b049bb741c8842aa011b4c06cd905032c848539a842815"}]',
      ),
    );
    assert.deepEqual(input, before);
  }
});
