import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  existsSync,
  chmodSync,
  symlinkSync,
  linkSync,
  readlinkSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installSurfpool } from '../src/doctor/install.ts';

const dir = mkdtempSync(join(tmpdir(), 'oms-install-test-'));
mkdirSync(join(dir, 'pack'));
writeFileSync(join(dir, 'pack', 'surfpool'), '#!/bin/sh\necho surfpool 1.7.0\n');
execFileSync('tar', ['-czf', join(dir, 'surfpool.tar.gz'), '-C', join(dir, 'pack'), 'surfpool']);
const archive = readFileSync(join(dir, 'surfpool.tar.gz'));
const sha256 = createHash('sha256').update(archive).digest('hex');

async function withServer(run: (url: string) => Promise<void>) {
  const server = createServer((request, response) => {
    if (request.url === '/surfpool.tar.gz') {
      response.end(archive);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('installs the executable when the SHA-256 matches', async () => {
  await withServer(async (base) => {
    const target = join(dir, 'good', 'tools', 'surfpool');
    await installSurfpool({ url: `${base}/surfpool.tar.gz`, sha256 }, target);
    assert.equal(readFileSync(target, 'utf8').includes('surfpool 1.7.0'), true);
    assert.ok(statSync(target).mode & 0o100);
  });
});

test('replaces the pinned executable without changing the previous inode', async () => {
  await withServer(async (base) => {
    const target = join(dir, 'upgrade', 'surfpool');
    const previous = join(dir, 'upgrade', 'previous');
    mkdirSync(join(dir, 'upgrade'));
    writeFileSync(target, 'previous executable', { mode: 0o755 });
    linkSync(target, previous);
    await installSurfpool({ url: `${base}/surfpool.tar.gz`, sha256 }, target);
    assert.equal(readFileSync(previous, 'utf8'), 'previous executable');
    assert.match(readFileSync(target, 'utf8'), /surfpool 1\.7\.0/);
    assert.equal(statSync(target).mode & 0o777, 0o755);
  });
});

test('follows a custom install symlink whether or not its executable already exists', async () => {
  await withServer(async (base) => {
    const target = join(dir, 'surfpool-link');
    const other = join(dir, 'linked-surfpool');
    const executable = join(dir, 'real', 'linked-surfpool');
    const link = 'shortcut/../linked-surfpool';
    mkdirSync(join(dir, 'real', 'nested'), { recursive: true });
    writeFileSync(other, 'unrelated file');
    symlinkSync('real/nested', join(dir, 'shortcut'));
    symlinkSync(link, target);
    for (const existing of [false, true]) {
      if (existing) writeFileSync(executable, 'previous executable');
      await installSurfpool({ url: `${base}/surfpool.tar.gz`, sha256 }, target);
      assert.equal(readlinkSync(target), link);
      assert.match(readFileSync(executable, 'utf8'), /surfpool 1\.7\.0/);
      assert.equal(readFileSync(other, 'utf8'), 'unrelated file');
    }
  });
});

test('refuses a wrong checksum and installs nothing', async () => {
  await withServer(async (base) => {
    const target = join(dir, 'bad', 'surfpool');
    await assert.rejects(
      installSurfpool({ url: `${base}/surfpool.tar.gz`, sha256: '0'.repeat(64) }, target),
      /SHA-256 mismatch/,
    );
    assert.equal(existsSync(target), false);
  });
});

test('reports a failed download', async () => {
  await withServer(async (base) => {
    await assert.rejects(
      installSurfpool({ url: `${base}/missing`, sha256 }, join(dir, 'x', 'surfpool')),
      /Could not download .*HTTP 404/,
    );
  });
});

function prepareDefaultInstall(home: string, custom = false) {
  const installer = new URL('../src/doctor/install.ts', import.meta.url).href;
  const manifest = JSON.parse(readFileSync(new URL('../../engine/runtime-manifest.json', import.meta.url), 'utf8'));
  const target = custom
    ? join(home, 'custom', 'surfpool')
    : join(home, '.oms', 'tools', `surfpool-${manifest.surfpoolVersion}`, 'surfpool');
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { installPinnedSurfpool } from ${JSON.stringify(installer)};
       process.umask(0o022);
       await installPinnedSurfpool(${JSON.stringify(target)}, async () => { throw new Error('Offline fixture'); });`,
    ],
    { encoding: 'utf8', env: { ...process.env, HOME: home } },
  );
}

test('a default install creates a private OMS root before downloading under umask 0022', () => {
  const home = mkdtempSync(join(dir, 'fresh-home-'));
  const result = prepareDefaultInstall(home);
  assert.match(result.stderr, /Offline fixture/);
  assert.equal(statSync(join(home, '.oms')).mode & 0o777, 0o700);
  assert.equal(statSync(home).mode & 0o777, 0o700);
});

test('an older public OMS root is not changed and doctor and launch explain how to repair it', () => {
  const home = mkdtempSync(join(dir, "old-home's-"));
  const root = join(home, '.oms');
  mkdirSync(root);
  chmodSync(root, 0o755);
  const repair = `The folder is not private. Run \`chmod 700 '${root.replaceAll("'", "'\\''")}'\` and try again.`;
  const doctor = prepareDefaultInstall(home);
  assert.ok(doctor.stderr.includes(repair), doctor.stderr);
  assert.doesNotMatch(doctor.stderr, /Offline fixture/);
  const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
  const launch = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `process.stdin.isTTY = process.stdout.isTTY = true; await import(${JSON.stringify(bin)});`,
    ],
    { encoding: 'utf8', cwd: home, env: { ...process.env, HOME: home } },
  );
  assert.ok(launch.stderr.includes(repair), launch.stderr);
  assert.equal(statSync(root).mode & 0o777, 0o755);
});

test('a custom install target does not prepare or change its home directory', () => {
  const home = mkdtempSync(join(dir, 'custom-home-'));
  chmodSync(home, 0o755);
  const result = prepareDefaultInstall(home, true);
  assert.match(result.stderr, /Offline fixture/);
  assert.equal(existsSync(join(home, '.oms')), false);
  assert.equal(statSync(home).mode & 0o777, 0o755);
});

test('a symlink at the default OMS root is refused without suggesting chmod', () => {
  const home = mkdtempSync(join(dir, 'linked-home-'));
  const other = mkdtempSync(join(dir, 'linked-target-'));
  symlinkSync(other, join(home, '.oms'));
  const result = prepareDefaultInstall(home);
  assert.match(result.stderr, /Expected an owned private directory/);
  assert.doesNotMatch(result.stderr, /chmod|Offline fixture/);
  assert.equal(statSync(other).mode & 0o777, 0o700);
});
