import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { detectInstall, installCommand, isNewer, runUpdate, updateNotice, type UpdateDeps } from '../src/update.ts';

const run = promisify(execFile);
const HOME = '/home/ada';

test('detects how this copy of oms was installed from where it lives', () => {
  assert.deepEqual(detectInstall('/home/ada/.oms/cli/lib/node_modules/@barestate/oms', HOME), {
    kind: 'installer',
    prefix: '/home/ada/.oms/cli',
  });
  assert.deepEqual(detectInstall('/home/ada/custom/cli/lib/node_modules/@barestate/oms', HOME, '/home/ada/custom'), {
    kind: 'installer',
    prefix: '/home/ada/custom/cli',
  });
  assert.deepEqual(detectInstall('/opt/homebrew/lib/node_modules/@barestate/oms', HOME), {
    kind: 'npm',
    prefix: '/opt/homebrew',
  });
  assert.deepEqual(detectInstall('/opt/homebrew/Cellar/oms/0.1.3/libexec/lib/node_modules/@barestate/oms', HOME), {
    kind: 'brew',
  });
  assert.deepEqual(detectInstall('/home/ada/.npm/_npx/ab12/node_modules/@barestate/oms', HOME), { kind: 'npx' });
  assert.deepEqual(detectInstall('/work/app/node_modules/@barestate/oms', HOME), { kind: 'project', dir: '/work/app' });
  assert.deepEqual(detectInstall('/home/ada/src/oms', HOME), { kind: 'source' });
});

test('versions compare as numbers, and anything that is not a plain release never counts as newer', () => {
  assert.equal(isNewer('0.1.10', '0.1.9'), true);
  assert.equal(isNewer('0.2.0', '0.1.99'), true);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
  assert.equal(isNewer('0.1.3', '0.1.3'), false);
  assert.equal(isNewer('0.1.2', '0.1.3'), false);
  assert.equal(isNewer('0.1.4-beta.1', '0.1.3'), false);
  assert.equal(isNewer('latest', '0.1.3'), false);
});

test('builds an install command that pins the exact version, skips install scripts and stays in the same prefix', () => {
  assert.deepEqual(installCommand({ kind: 'npm', prefix: '/opt/homebrew' }, '0.1.4', '/usr/bin/npm'), {
    file: '/usr/bin/npm',
    args: [
      'install',
      '-g',
      '--prefix',
      '/opt/homebrew',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '@barestate/oms@0.1.4',
    ],
  });
  assert.deepEqual(installCommand({ kind: 'brew' }, '0.1.4', 'npm'), {
    file: 'brew',
    args: ['upgrade', 'barestate-ai/tap/oms'],
  });
  for (const install of [{ kind: 'npx' }, { kind: 'project', dir: '/work/app' }, { kind: 'source' }] as const) {
    assert.equal(installCommand(install, '0.1.4', 'npm'), undefined);
  }
});

function deps(over: Partial<UpdateDeps> = {}): UpdateDeps & { out: string[]; err: string[]; ran: string[][] } {
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[][] = [];
  return {
    current: '0.1.2',
    install: { kind: 'npm', prefix: '/opt/homebrew' },
    npm: 'npm',
    latest: async () => '0.1.3',
    exec: async (file, args) => {
      ran.push([file, ...args]);
      return 0;
    },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    out,
    err,
    ran,
    ...over,
  };
}

test('update installs the newest release and says what changed', async () => {
  const d = deps();
  assert.equal(await runUpdate([], d), 0);
  assert.equal(d.ran.length, 1);
  assert.equal(d.ran[0]!.at(-1), '@barestate/oms@0.1.3');
  assert.match(d.out.join('\n'), /0\.1\.2 → 0\.1\.3/);
  assert.match(d.out.join('\n'), /oms doctor/);
});

test('update does nothing when already on the newest release', async () => {
  for (const latest of ['0.1.2', '0.1.1']) {
    const d = deps({ latest: async () => latest });
    assert.equal(await runUpdate([], d), 0);
    assert.equal(d.ran.length, 0);
    assert.match(d.out.join('\n'), /up to date/i);
  }
});

test('--check reports a newer release and the command to run, and installs nothing', async () => {
  const d = deps();
  assert.equal(await runUpdate(['--check'], d), 0);
  assert.equal(d.ran.length, 0);
  assert.match(d.out.join('\n'), /0\.1\.3 is available/);
  assert.match(d.out.join('\n'), /oms update/);
});

test('--version installs that exact release, even an older one, without asking the registry', async () => {
  const d = deps({
    latest: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(await runUpdate(['--version', '0.1.1'], d), 0);
  assert.equal(d.ran[0]!.at(-1), '@barestate/oms@0.1.1');
});

test('rejects anything that is not a plain release number or a known flag', async () => {
  for (const args of [
    ['--version'],
    ['--version', 'latest'],
    ['--version', '0.1'],
    ['--version', '1.0.0; rm -rf ~'],
    ['--bogus'],
    ['now'],
  ]) {
    const d = deps();
    assert.equal(await runUpdate(args, d), 2, args.join(' '));
    assert.equal(d.ran.length, 0);
    assert.ok(d.err.length > 0);
  }
});

test('a failed registry lookup or install is an error, never a silent success', async () => {
  const offline = deps({
    latest: async () => {
      throw new Error('fetch failed');
    },
  });
  assert.equal(await runUpdate([], offline), 1);
  assert.match(offline.err.join('\n'), /could not check/i);
  const broken = deps({ exec: async () => 243 });
  assert.equal(await runUpdate([], broken), 1);
  assert.match(broken.err.join('\n'), /failed/i);
  assert.doesNotMatch(broken.out.join('\n'), /→/);
});

test('installs that oms cannot update itself tell you what to run instead', async () => {
  const cases = [
    [{ kind: 'npx' }, /npx @barestate\/oms@latest/],
    [{ kind: 'project', dir: '/work/app' }, /npm install @barestate\/oms@0\.1\.3.*\/work\/app/s],
    [{ kind: 'source' }, /git pull/],
  ] as const;
  for (const [install, advice] of cases) {
    const d = deps({ install });
    assert.equal(await runUpdate([], d), 1);
    assert.equal(d.ran.length, 0);
    assert.match(d.err.join('\n'), advice);
    const check = deps({ install });
    assert.equal(await runUpdate(['--check'], check), 0);
  }
});

test('Homebrew installs upgrade through brew, which cannot pin a version', async () => {
  const d = deps({ install: { kind: 'brew' } });
  assert.equal(await runUpdate([], d), 0);
  assert.deepEqual(d.ran[0], ['brew', 'upgrade', 'barestate-ai/tap/oms']);
  const pinned = deps({ install: { kind: 'brew' } });
  assert.equal(await runUpdate(['--version', '0.1.1'], pinned), 2);
  assert.match(pinned.err.join('\n'), /brew/);
});

test('the command is wired into the launcher and the help', async () => {
  const bin = new URL('../src/bin.ts', import.meta.url).pathname;
  const help = await run(process.execPath, [bin, '--help']);
  assert.match(help.stdout, /oms update/);
  await assert.rejects(
    run(process.execPath, [bin, 'update', '--bogus']),
    (error: { code?: number; stderr?: string }) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr ?? '', /update/);
      return true;
    },
  );
  const version = await run(process.execPath, [bin, 'version']);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('OMS looks for a release only when OMS_UPDATE_CHECK=1', async () => {
  for (const env of [{}, { OMS_UPDATE_CHECK: '0' }, { OMS_UPDATE_CHECK: 'yes' }]) {
    const notice = updateNotice('0.1.3', env, async () => assert.fail('no lookup'));
    assert.equal(notice(), undefined);
  }
});

test('the opt-in notice names a newer release, and stays silent otherwise or when the answer is late', async () => {
  const on = { OMS_UPDATE_CHECK: '1' };
  const settled = async (latest: () => Promise<string>) => {
    const notice = updateNotice('0.1.3', on, latest);
    await new Promise((resolve) => setImmediate(resolve));
    return notice();
  };
  assert.match((await settled(async () => '0.1.4'))!, /0\.1\.4 is available.*oms update/);
  assert.equal(await settled(async () => '0.1.3'), undefined);
  assert.equal(
    await settled(async () => {
      throw new Error('offline');
    }),
    undefined,
  );
  let cancelled: AbortSignal | undefined;
  const late = updateNotice('0.1.3', on, (signal) => {
    cancelled = signal;
    return new Promise<string>(() => {});
  });
  assert.equal(late(), undefined);
  assert.equal(cancelled!.aborted, true);
});

test('a failed start cancels its in-flight opt-in release lookup', async () => {
  const main = new URL('../src/main.ts', import.meta.url).href;
  await assert.rejects(
    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `process.argv = [process.execPath, 'oms', 'start'];
         globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
           signal.addEventListener('abort', () => {
             process.stderr.write('release lookup aborted\\n');
             reject(signal.reason);
           }, { once: true });
         });
         await import(${JSON.stringify(main)});`,
      ],
      { env: { PATH: process.env.PATH, OMS_UPDATE_CHECK: '1' }, timeout: 15_000 },
    ),
    (error: { code?: number; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? '', /release lookup aborted/);
      assert.match(error.stderr ?? '', /Needs an interactive terminal/);
      return true;
    },
  );
});
