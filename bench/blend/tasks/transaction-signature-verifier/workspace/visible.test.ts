import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const pair = (n) => {
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, n)]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    privateKey,
    key: Uint8Array.from(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)),
  };
};
function signed(v0 = false, two = false) {
  const a = pair(1),
    b = pair(2);
  const keys = two ? [a.key, b.key] : [a.key];
  keys.push(new Uint8Array(32).fill(9));
  const message = Buffer.concat([
    ...(v0 ? [Buffer.from([128])] : []),
    Buffer.from([two ? 2 : 1, two ? 1 : 0, 1, keys.length]),
    ...keys.map(Buffer.from),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    ...(v0 ? [Buffer.from([0])] : []),
  ]);
  const signatures = [sign(null, message, a.privateKey), ...(two ? [sign(null, message, b.privateKey)] : [])];
  return { wire: Buffer.concat([Buffer.from([signatures.length]), ...signatures, message]), message };
}

test('[visible] valid legacy', () => {
  assert.equal(api.verifyTransaction(signed().wire).valid, true);
});
test('[visible] valid v0', () => {
  assert.equal(api.verifyTransaction(signed(true).wire).valid, true);
});
