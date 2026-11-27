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

test('[hidden] basepoint on curve', () => {
  assert.equal(api.isOnCurve(bytes('58' + '66'.repeat(31))), true);
});
test('[hidden] identity on curve', () => {
  assert.equal(api.isOnCurve(bytes('01' + '00'.repeat(31))), true);
});
test('[hidden] negative zero sign rejected', () => {
  assert.equal(api.isOnCurve(bytes('01' + '00'.repeat(30) + '80')), false);
});
test('[hidden] noncanonical y reduces modulo p', () => {
  assert.equal(api.isOnCurve(bytes('ee' + 'ff'.repeat(30) + '7f')), true);
});
test('[hidden] wrong width not on curve', () => {
  assert.equal(api.isOnCurve(new Uint8Array(31)), false);
});
test('[hidden] independent PDA vector 1', () => {
  const v = vectors[0];
  const r = api.findProgramAddress(v.seeds.map(bytes), bytes(v.program));
  assert.equal(hex(r.address), v.address);
  assert.equal(r.bump, v.bump);
  assert.equal(
    hex(api.createProgramAddress([...v.seeds.map(bytes), Uint8Array.of(v.bump)], bytes(v.program))),
    v.address,
  );
});
test('[hidden] independent PDA vector 2', () => {
  const v = vectors[1];
  const r = api.findProgramAddress(v.seeds.map(bytes), bytes(v.program));
  assert.equal(hex(r.address), v.address);
  assert.equal(r.bump, v.bump);
  assert.equal(
    hex(api.createProgramAddress([...v.seeds.map(bytes), Uint8Array.of(v.bump)], bytes(v.program))),
    v.address,
  );
});
test('[hidden] independent PDA vector 3', () => {
  const v = vectors[2];
  const r = api.findProgramAddress(v.seeds.map(bytes), bytes(v.program));
  assert.equal(hex(r.address), v.address);
  assert.equal(r.bump, v.bump);
  assert.equal(
    hex(api.createProgramAddress([...v.seeds.map(bytes), Uint8Array.of(v.bump)], bytes(v.program))),
    v.address,
  );
});
test('[hidden] independent PDA vector 4', () => {
  const v = vectors[3];
  const r = api.findProgramAddress(v.seeds.map(bytes), bytes(v.program));
  assert.equal(hex(r.address), v.address);
  assert.equal(r.bump, v.bump);
  assert.equal(
    hex(api.createProgramAddress([...v.seeds.map(bytes), Uint8Array.of(v.bump)], bytes(v.program))),
    v.address,
  );
});
test('[hidden] independent PDA vector 5', () => {
  const v = vectors[4];
  const r = api.findProgramAddress(v.seeds.map(bytes), bytes(v.program));
  assert.equal(hex(r.address), v.address);
  assert.equal(r.bump, v.bump);
  assert.equal(
    hex(api.createProgramAddress([...v.seeds.map(bytes), Uint8Array.of(v.bump)], bytes(v.program))),
    v.address,
  );
});
test('[hidden] on-curve hash rejected', () => {
  assert.throws(() => api.createProgramAddress([Uint8Array.of(0)], new Uint8Array(32)));
});
test('[hidden] seed-length limit', () => {
  assert.throws(() => api.findProgramAddress([new Uint8Array(33)], new Uint8Array(32)));
});
test('[hidden] find reserves bump seed slot', () => {
  assert.throws(() =>
    api.findProgramAddress(
      Array.from({ length: 16 }, () => new Uint8Array()),
      new Uint8Array(32),
    ),
  );
});
test('[hidden] create accepts 16 seeds', () => {
  const s = Array.from({ length: 15 }, () => new Uint8Array());
  const v = vectors[0];
  assert.equal(hex(api.createProgramAddress([...s, Uint8Array.of(v.bump)], new Uint8Array(32))), v.address);
});
test('[hidden] bad program width', () => {
  assert.throws(() => api.findProgramAddress([], new Uint8Array(31)));
});
test('[hidden] ATA token program in seeds', () => {
  const r = api.deriveAta(
    bytes('5866666666666666666666666666666666666666666666666666666666666666'),
    bytes('0909090909090909090909090909090909090909090909090909090909090909'),
    bytes('06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9'),
  );
  assert.equal(hex(r.address), '837c1dc3413ac719d52391720b8a0397a0786e7f180d3ae60a0f41900304da2f');
  assert.equal(r.bump, 253);
});
test('[hidden] ATA rejects offcurve owner by default', () => {
  assert.throws(() =>
    api.deriveAta(
      bytes('b0c9f865f667ac83cd9baae9172d7aa225bf874697ef8a4f5bef48191773f6fe'),
      bytes('0909090909090909090909090909090909090909090909090909090909090909'),
      bytes('06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9'),
    ),
  );
});
test('[hidden] ATA opt-in offcurve owner', () => {
  assert.equal(
    hex(
      api.deriveAta(
        bytes('b0c9f865f667ac83cd9baae9172d7aa225bf874697ef8a4f5bef48191773f6fe'),
        bytes('0909090909090909090909090909090909090909090909090909090909090909'),
        bytes('06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9'),
        true,
      ).address,
    ),
    'ba9937531a4eb663648bb1f4b987ac9de48713d7faed7cfdf043c38d6a8ad7c4',
  );
});
