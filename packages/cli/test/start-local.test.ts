import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultHarnessEnvironment, DOCKER_CHAT_REFUSAL } from '@oms/engine';
import { checkLocalPrerequisites, startLocal } from '../../../scripts/start-local.ts';

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

test('run rejects presentation flags, and the advanced help documents in-app switching', () => {
  for (const flag of ['--view', '--theme']) {
    const result = spawnSync(process.execPath, [bin, 'run', flag, flag === '--view' ? 'workbench' : 'gruvbox'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Unknown option ${flag}`));
  }
  const help = spawnSync(process.execPath, [bin, 'help', 'advanced'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /--view|--theme/);
  assert.match(help.stdout, /Harness/);
  assert.match(help.stdout, /\/workbench/);
  assert.match(help.stdout, /--bounded/);
  assert.match(help.stdout, /idle time does not expire/);
});

test('the short help says oms works in any folder', () => {
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Start in the current folder \(any folder works\)/);
  assert.match(help.stdout, /\/blend.*auto\|pro\|flash\|off/);
  assert.match(help.stdout, /invited OMS account, \/login/);
});

test('bare CLI follows local launch and refuses noninteractive use before preparing state', () => {
  const result = spawnSync(process.execPath, [bin], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive terminal/i);
});

test('a chat refuses Docker before it checks Docker or installs anything', async (t) => {
  const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  t.after(() => {
    process.stdin.isTTY = tty.stdin;
    process.stdout.isTTY = tty.stdout;
  });
  await assert.rejects(startLocal(['--sandbox', 'docker']), (error: Error) => error.message === DOCKER_CHAT_REFUSAL);
});

test('prerequisites pass without output when Surfpool is already installed', async (t) => {
  const written: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => (
    written.push(String(chunk)),
    true
  )) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = write;
  });
  await checkLocalPrerequisites({ ...defaultHarnessEnvironment(), binary: process.execPath });
  assert.deepEqual(written, []);
});
