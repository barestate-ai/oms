import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  explorerUrl,
  idlPrograms,
  idlSnippet,
  remoteRpc,
  rpcAddress,
  splitCluster,
  REMOTE_METHODS,
} from '../src/connectors/solana.ts';

const ADDRESS = '11111111111111111111111111111111';
const SIGNATURE = '5'.repeat(88);

test('explorer links: mainnet is plain, devnet names its cluster, the local chain names its own RPC', () => {
  assert.equal(explorerUrl('address', ADDRESS, 'mainnet'), `https://explorer.solana.com/address/${ADDRESS}`);
  assert.equal(explorerUrl('tx', SIGNATURE, 'devnet'), `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`);
  assert.equal(
    explorerUrl('address', ADDRESS, 'local', 'http://127.0.0.1:8899'),
    `https://explorer.solana.com/address/${ADDRESS}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`,
  );
  assert.throws(() => explorerUrl('address', ADDRESS, 'local'), /no address/);
  for (const bad of ['', 'abc', `${ADDRESS}/../x`, `${ADDRESS}?x=1`, `${ADDRESS}#y`, 'O'.repeat(40), `${ADDRESS}\n`]) {
    assert.throws(() => explorerUrl('address', bad, 'mainnet'), /Not a Solana/, JSON.stringify(bad));
  }
});

test('--cluster is read from the end of the argument', () => {
  assert.deepEqual(splitCluster(ADDRESS), { rest: ADDRESS });
  assert.deepEqual(splitCluster(`${ADDRESS} --cluster devnet`), { rest: ADDRESS, cluster: 'devnet' });
  assert.deepEqual(splitCluster(`${ADDRESS} --cluster=mainnet `), { rest: ADDRESS, cluster: 'mainnet' });
  assert.deepEqual(splitCluster('--cluster devnet'), { rest: '', cluster: 'devnet' });
  assert.deepEqual(splitCluster(`${ADDRESS} --cluster testnet`), { rest: ADDRESS, invalid: true });
});

test('the RPC address: saved for mainnet with its variables filled now, else Helius, else public', () => {
  assert.equal(rpcAddress('mainnet', undefined, {}), 'https://api.mainnet-beta.solana.com');
  assert.equal(rpcAddress('devnet', undefined, {}), 'https://api.devnet.solana.com');
  assert.equal(
    rpcAddress('devnet', undefined, { HELIUS_API_KEY: 'k&1' }),
    'https://devnet.helius-rpc.com/?api-key=k%261',
  );
  assert.equal(
    rpcAddress('mainnet', 'https://rpc.example/?api-key=${MY_KEY}', { MY_KEY: 'abc' }),
    'https://rpc.example/?api-key=abc',
  );
  // A saved address is for mainnet; devnet never receives its key.
  assert.equal(
    rpcAddress('devnet', 'https://rpc.example/?api-key=${MY_KEY}', { MY_KEY: 'abc' }),
    'https://api.devnet.solana.com',
  );
  assert.throws(() => rpcAddress('mainnet', 'https://rpc.example/?api-key=${MY_KEY}', {}), /Set MY_KEY/);
});

test('remote lookups are read-only, use fetch with the address, and never repeat the key in an error', async () => {
  assert.ok(!REMOTE_METHODS.has('sendTransaction') && !REMOTE_METHODS.has('requestAirdrop'));
  await assert.rejects(remoteRpc('mainnet', 'sendTransaction', []), /read-only/);
  await assert.rejects(remoteRpc('devnet', 'requestAirdrop', [ADDRESS, 1]), /read-only/);
  const seen: Array<{ url: string; method: string; redirect: string | undefined }> = [];
  const reply = (status: number, body: unknown) =>
    (async (url: unknown, init: { body: string; redirect?: string }) => {
      seen.push({ url: String(url), method: JSON.parse(init.body).method, redirect: init.redirect });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  const env = { HELIUS_API_KEY: 'topsecretkey' };
  assert.deepEqual(
    await remoteRpc('mainnet', 'getBalance', [ADDRESS], { env, fetch: reply(200, { result: { value: 5 } }) }),
    { value: 5 },
  );
  assert.equal(seen[0]!.method, 'getBalance');
  assert.equal(seen[0]!.redirect, 'error');
  for (const [status, body, pattern] of [
    [401, {}, /refused the key/],
    [500, {}, /HTTP 500/],
    [200, { error: { message: 'bad topsecretkey' } }, /reported an error/],
  ] as const) {
    await assert.rejects(
      remoteRpc('mainnet', 'getSlot', [], { env, fetch: reply(status, body) }),
      (error: Error) => pattern.test(error.message) && !/topsecretkey/.test(error.message),
    );
  }
  const failing = (async () => {
    throw new Error('connect ECONNREFUSED https://mainnet.helius-rpc.com/?api-key=topsecretkey');
  }) as unknown as typeof fetch;
  await assert.rejects(
    remoteRpc('mainnet', 'getSlot', [], { env, fetch: failing }),
    (error: Error) => !/topsecretkey/.test(error.message) && /did not answer/.test(error.message),
  );
});

test('IDLs in target/idl list as programs with their instructions, and nothing breaks without them', () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-idl-'));
  assert.deepEqual(idlPrograms(root), []);
  mkdirSync(join(root, 'target', 'idl'), { recursive: true });
  writeFileSync(
    join(root, 'target', 'idl', 'vault.json'),
    JSON.stringify({
      address: ADDRESS,
      metadata: { name: 'vault' },
      instructions: [{ name: 'deposit' }, { name: 'withdraw' }],
      errors: [{ code: 6000, name: 'Nope' }],
    }),
  );
  writeFileSync(join(root, 'target', 'idl', 'broken.json'), '{nope');
  assert.deepEqual(idlPrograms(root), [
    { name: 'vault', address: ADDRESS, instructions: ['deposit', 'withdraw'], errors: 1 },
  ]);
  assert.match(idlSnippet('vault', 'withdraw'), /withdraw instruction of vault/);
  assert.match(idlSnippet('vault'), /vault program/);
  rmSync(root, { recursive: true });
});
