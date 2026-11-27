import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const vectors = [
  {
    seeds: [],
    program: '0000000000000000000000000000000000000000000000000000000000000000',
    address: 'b0c9f865f667ac83cd9baae9172d7aa225bf874697ef8a4f5bef48191773f6fe',
    bump: 255,
  },
  {
    seeds: ['7661756c74'],
    program: '0101010101010101010101010101010101010101010101010101010101010101',
    address: '5fd58b29e4b4a377caffd9401e7ceb81e5077580cda9587d24d911e521f596c6',
    bump: 252,
  },
  {
    seeds: ['7661756c74', '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'],
    program: '0202020202020202020202020202020202020202020202020202020202020202',
    address: 'bd1a03b4489043f884f726718a6d9064f97f70eb347d75a776541b371897f5c3',
    bump: 255,
  },
  {
    seeds: ['00ff'],
    program: '0303030303030303030303030303030303030303030303030303030303030303',
    address: 'f2a701729b2a5792a3254e6638dbbcaebe3ba5f57bcb66d99bce86da3586f098',
    bump: 252,
  },
  {
    seeds: ['6161616161616161616161616161616161616161616161616161616161616161'],
    program: '0404040404040404040404040404040404040404040404040404040404040404',
    address: '83a613a7d578a04c0f86054b12936f092e038c903aba7a0629f4ee9adbf59161',
    bump: 255,
  },
];

test('[visible] basepoint on curve', () => {
  assert.equal(api.isOnCurve(bytes('58' + '66'.repeat(31))), true);
});
test('[visible] identity on curve', () => {
  assert.equal(api.isOnCurve(bytes('01' + '00'.repeat(31))), true);
});
