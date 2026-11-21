import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { defaultHarnessEnvironment } from '../src/runtime/environment.ts';

const moduleUrl = new URL('../src/runtime/environment.ts', import.meta.url).href;
const image = `sha256:${'a'.repeat(64)}`;
test('implicit Linux x64 dependencies are Docker-only while explicit dependencies apply to both backends', () => {
  const previous = process.env.OMS_BENCH_DEPENDENCIES;
  try {
    delete process.env.OMS_BENCH_DEPENDENCIES;
    assert.equal(defaultHarnessEnvironment(undefined, 'host').dependencies, undefined);
    assert.equal(
      defaultHarnessEnvironment(undefined, 'docker').dependencies,
      process.platform === 'linux' && process.arch === 'x64'
        ? new URL('../../../', import.meta.url).pathname
        : undefined,
    );
    process.env.OMS_BENCH_DEPENDENCIES = '/explicit/locked-dependencies';
    for (const backend of ['host', 'docker'] as const)
      assert.equal(defaultHarnessEnvironment(undefined, backend).dependencies, '/explicit/locked-dependencies');
  } finally {
    if (previous === undefined) delete process.env.OMS_BENCH_DEPENDENCIES;
    else process.env.OMS_BENCH_DEPENDENCIES = previous;
  }
});

function environmentFor(configuredImage: string, programs: boolean) {
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { defaultHarnessEnvironment } from ${JSON.stringify(moduleUrl)}; process.stdout.write(defaultHarnessEnvironment(undefined, "docker", ${programs}).image);`,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, OMS_TOOLCHAIN_IMAGE: configuredImage },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

test('host toolchain image override selects an immutable image without changing the Node runtime', () => {
  assert.equal(environmentFor(image, true), image);
  assert.match(environmentFor(image, false), /^node@sha256:/);
});

test('host toolchain image override rejects mutable tags', () => {
  assert.throws(() => environmentFor('oms-toolchain:local', true), /pinned|sha256|digest/i);
});

test('committed runtime manifest contains no machine-local toolchain image IDs', () => {
  const manifest = JSON.parse(readFileSync(new URL('../runtime-manifest.json', import.meta.url), 'utf8'));
  assert.ok(Object.values(manifest.toolchainImages ?? {}).every((value) => value === null));
});

test('missing optional toolchain skips, while OMS_REQUIRE_TOOLCHAIN fails without a green skip', () => {
  const helper = new URL('../../sandbox/test-support/infrastructure.ts', import.meta.url).href;
  const script = `import { test } from 'node:test'; import { skipUnavailableToolchain } from ${JSON.stringify(helper)}; test('missing toolchain', t => { skipUnavailableToolchain(t, undefined); });`;
  const run = (required: string) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, OMS_REQUIRE_TOOLCHAIN: required },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const optional = run('0');
  assert.equal(optional.status, 0);
  assert.match(optional.stdout, /SKIP|skipped/i);
  const required = run('1');
  assert.equal(required.status, 1);
  assert.match(required.stdout + required.stderr, /OMS_REQUIRE_TOOLCHAIN=1/);
});

test('verification reports unavailable host image configuration without claiming a working repair', () => {
  const verifier = new URL('../src/toolchain/verify.ts', import.meta.url).href;
  const project = new URL('../test-support/fixtures/anchor-counter', import.meta.url).pathname;
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { verifyToolchainProject } from ${JSON.stringify(verifier)}; process.stdout.write(JSON.stringify(await verifyToolchainProject(${JSON.stringify(project)})));`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, OMS_TOOLCHAIN_IMAGE: 'mutable:tag' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
  );
  assert.equal(result.status, 'proposed, not verified');
  assert.equal(result.image, '');
  assert.match(result.error, /pinned|sha256|digest/i);
  assert.equal(result.buildExitCode, undefined);
});
