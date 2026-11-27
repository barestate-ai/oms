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

test('[hidden] valid legacy', () => {
  assert.equal(api.verifyTransaction(signed().wire).valid, true);
});
test('[hidden] valid v0', () => {
  assert.equal(api.verifyTransaction(signed(true).wire).valid, true);
});
test('[hidden] two signers', () => {
  assert.deepEqual(api.verifyTransaction(signed(false, true).wire).invalidSignerIndices, []);
});
test('[hidden] zero signature', () => {
  const { wire } = signed();
  wire.fill(0, 1, 65);
  assert.deepEqual(api.verifyTransaction(wire).invalidSignerIndices, [0]);
});
test('[hidden] only second bad', () => {
  const { wire } = signed(false, true);
  wire[65] ^= 1;
  assert.deepEqual(api.verifyTransaction(wire).invalidSignerIndices, [1]);
});
test('[hidden] signature slot swap', () => {
  const { wire } = signed(false, true);
  const a = Buffer.from(wire.subarray(1, 65));
  wire.copy(wire, 1, 65, 129);
  a.copy(wire, 65);
  assert.deepEqual(api.verifyTransaction(wire).invalidSignerIndices, [0, 1]);
});
test('[hidden] changed signed blockhash', () => {
  const { wire } = signed(false, true);
  wire[wire.length - 2] ^= 1;
  assert.deepEqual(api.verifyTransaction(wire).invalidSignerIndices, [0, 1]);
});
test('[hidden] signature count mismatch', () => {
  const { wire } = signed(false, true);
  const b = Buffer.concat([Buffer.from([1]), wire.subarray(1, 65), wire.subarray(129)]);
  assert.throws(() => api.verifyTransaction(b));
});
test('[hidden] noncanonical signature count', () => {
  const { wire } = signed();
  assert.throws(() => api.verifyTransaction(Buffer.concat([Buffer.from([129, 0]), wire.subarray(1)])));
});
test('[hidden] truncated signature', () => {
  assert.throws(() => api.verifyTransaction(signed().wire.subarray(0, 40)));
});
test('[hidden] no signatures', () => {
  const { message } = signed();
  assert.throws(() => api.verifyTransaction(Buffer.concat([Buffer.from([0]), message])));
});
test('[hidden] message suffix', () => {
  assert.throws(() => api.verifyTransaction(Buffer.concat([signed().wire, Buffer.from([0])])));
});
test('[hidden] future message version', () => {
  const { wire } = signed(true);
  wire[65] = 129;
  assert.throws(() => api.verifyTransaction(wire));
});
test('[hidden] duplicate static keys', () => {
  const { wire } = signed(false, true);
  wire.copy(wire, 165, 133, 165);
  assert.throws(() => api.verifyTransaction(wire));
});
test('[hidden] packet cap', () => {
  assert.throws(() => api.verifyTransaction(Buffer.alloc(1233)));
});
test('[hidden] signer key isolation', () => {
  const { wire } = signed();
  const r = api.verifyTransaction(wire);
  r.signerKeys[0][0] ^= 1;
  assert.equal(api.verifyTransaction(wire).valid, true);
});
