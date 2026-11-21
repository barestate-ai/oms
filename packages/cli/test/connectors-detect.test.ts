import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyConfig, type ConnectorsConfig } from '../src/connectors/config.ts';
import { builtinRows, detectAll, parseAuthStatus, verifyAws, type DetectDeps } from '../src/connectors/detect.ts';
import type { HostResult, HostRun } from '../src/connectors/host.ts';
import type { OmsSession } from '@oms/engine';

type Reply = Partial<HostResult> | ((args: readonly string[]) => Partial<HostResult>);
function deps(
  replies: Record<string, Reply>,
  extra: Partial<DetectDeps> = {},
  config: ConnectorsConfig = emptyConfig(),
) {
  const calls: Array<{ file: string; args: readonly string[]; timeoutMs?: number }> = [];
  const run: HostRun = async (file, args, options) => {
    calls.push({ file, args, timeoutMs: options?.timeoutMs });
    const reply = replies[file];
    if (!reply) return { code: null, stdout: '', stderr: '', error: 'missing' };
    const result = typeof reply === 'function' ? reply(args) : reply;
    return { code: 0, stdout: '', stderr: '', ...result };
  };
  return { calls, deps: { run, env: {}, cwd: '/x', config, hasSignIn: () => false, ...extra } satisfies DetectDeps };
}

test('gh and glab: the exit code decides, only the account name is read, and a missing program says so', async () => {
  const { deps: d, calls } = deps({
    gh: {
      code: 0,
      stderr:
        'github.com\n  ✓ Logged in to github.com account vivek (keyring)\n  - Active account: true\n  - Token: gho_************',
    },
    glab: { code: null, error: 'missing' },
  });
  const found = await detectAll(d);
  assert.deepEqual(found.github, { state: 'ready', account: 'vivek' });
  assert.equal(found.gitlab!.state, 'missing');
  assert.deepEqual(calls.find((call) => call.file === 'gh')!.args, ['auth', 'status', '--hostname', 'github.com']);
  assert.doesNotMatch(JSON.stringify(found), /gho_|Token/);
  const signedOut = await detectAll(
    deps({ gh: { code: 1, stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' } }).deps,
  );
  assert.equal(signedOut.github!.state, 'signin');
  assert.equal(signedOut.github!.account, undefined);
  const slow = await detectAll(deps({ gh: { code: null, error: 'timeout' } }).deps);
  assert.equal(slow.github!.state, 'error');
});

test('an account name that is not one plain word is not shown', () => {
  assert.equal(parseAuthStatus('Logged in to github.com account octo-cat (keyring)'), 'octo-cat');
  assert.equal(parseAuthStatus('Logged in to gitlab.com as vivek (/home/x/.config/glab-cli/config.yml)'), 'vivek');
  assert.equal(parseAuthStatus('Logged in to github.com account \u001b[31mevil\u001b[0m'), undefined);
  assert.equal(parseAuthStatus('nothing useful'), undefined);
});

test('a saved GitLab host is the one asked about', async () => {
  const config = emptyConfig();
  config.connectors.gitlab = { enabled: true, access: 'read', options: { host: 'gitlab.example.com' } };
  const { deps: d, calls } = deps({ glab: { code: 0, stdout: 'Logged in to gitlab.example.com as sam' } }, {}, config);
  const found = await detectAll(d);
  assert.deepEqual(calls.find((call) => call.file === 'glab')!.args, [
    'auth',
    'status',
    '--hostname',
    'gitlab.example.com',
  ]);
  assert.equal(found.gitlab!.account, 'sam');
});

test('docker: ready with a version, an error when installed but not running, missing otherwise', async () => {
  assert.deepEqual((await detectAll(deps({ docker: { stdout: '26.1.4\n' } }).deps)).docker, {
    state: 'ready',
    account: '26.1.4',
  });
  const stopped = (await detectAll(deps({ docker: { code: 1, stderr: 'Cannot connect to the Docker daemon' } }).deps))
    .docker!;
  assert.equal(stopped.state, 'error');
  assert.match(stopped.detail!, /not running/);
  assert.equal((await detectAll(deps({}).deps)).docker!.state, 'missing');
});

test('aws: profiles and environment keys decide, no network call is made, and verify is separate', async () => {
  const { deps: d, calls } = deps({ aws: { stdout: 'default\ndev\n' } });
  const found = await detectAll(d);
  assert.deepEqual(found.aws, { state: 'ready', account: 'default' });
  assert.deepEqual(
    calls.filter((call) => call.file === 'aws').map((call) => call.args),
    [['configure', 'list-profiles']],
  );
  assert.equal((await detectAll(deps({ aws: { stdout: '' } }).deps)).aws!.state, 'signin');
  assert.equal(
    (
      await detectAll(
        deps({ aws: { stdout: '' } }, { env: { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' } }).deps,
      )
    ).aws!.account,
    'environment keys',
  );
  assert.equal(
    (await detectAll(deps({ aws: { stdout: 'default\n' } }, { env: { AWS_PROFILE: 'nope' } }).deps)).aws!.state,
    'signin',
  );
  const config = emptyConfig();
  config.connectors.aws = { enabled: true, access: 'ask', options: { profile: 'dev' } };
  assert.equal((await detectAll(deps({ aws: { stdout: 'default\ndev\n' } }, {}, config).deps)).aws!.account, 'dev');
  const verify = deps({ aws: { stdout: '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/x"}' } });
  assert.deepEqual(await verifyAws(verify.deps), { state: 'ready', account: 'account 123456789012' });
  assert.deepEqual(verify.calls[0]!.args.slice(0, 2), ['sts', 'get-caller-identity']);
  assert.equal((await verifyAws(deps({ aws: { code: 255, stderr: 'expired' } }).deps)).state, 'signin');
});

test('hosted connectors: only the presence of a stored sign-in is checked', async () => {
  const seen: string[] = [];
  const { deps: d } = deps({}, { hasSignIn: (server) => (seen.push(server), server === 'linear') });
  const found = await detectAll(d);
  assert.equal(found.linear!.state, 'ready');
  assert.equal(found.slack!.state, 'signin');
  assert.equal(found['gitlab-remote']!.state, 'signin');
  assert.deepEqual(seen.sort(), ['gitlab-remote', 'linear', 'slack']);
});

test('solana rpc: Helius when its key is set, a saved address needs its variable, else the public endpoint', async () => {
  assert.deepEqual((await detectAll(deps({}).deps))['solana-rpc'], { state: 'ready', account: 'public RPC' });
  assert.equal((await detectAll(deps({}, { env: { HELIUS_API_KEY: 'k' } }).deps))['solana-rpc']!.account, 'Helius');
  const config = emptyConfig();
  config.connectors['solana-rpc'] = {
    enabled: true,
    access: 'read',
    options: { rpc: 'https://x.example/?api-key=${MY_KEY}' },
  };
  const missing = (await detectAll(deps({}, {}, config).deps))['solana-rpc']!;
  assert.equal(missing.state, 'signin');
  assert.match(missing.detail!, /MY_KEY/);
  assert.equal((await detectAll(deps({}, { env: { MY_KEY: 'k' } }, config).deps))['solana-rpc']!.state, 'ready');
});

test('a check that throws becomes an error row, not an exception', async () => {
  const d = deps({}).deps;
  d.run = async () => {
    throw new Error('boom');
  };
  const found = await detectAll(d);
  assert.equal(found.github!.state, 'error');
  assert.equal(found.docker!.state, 'error');
});

test('built-in rows read the live session', async () => {
  const harness = {
    web: { enabled: () => true },
    knowledge: { config: () => undefined },
    chain: { health: async () => ({ ok: true }) },
  } as unknown as OmsSession;
  const rows = await builtinRows(harness);
  assert.deepEqual(
    rows.map((row) => [row.id, row.state]),
    [
      ['web', 'ready'],
      ['solana-docs', 'ready'],
      ['knowledge', 'off'],
      ['chain', 'ready'],
      ['program-reference', 'ready'],
    ],
  );
  const bare = await builtinRows({ knowledge: { config: () => ({}) } } as unknown as OmsSession);
  assert.deepEqual(
    bare.map((row) => row.id),
    ['web', 'solana-docs', 'knowledge', 'program-reference'],
  );
  assert.equal(bare[0]!.state, 'off');
  assert.equal(bare[2]!.state, 'ready');
});
