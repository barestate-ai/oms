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
  assert.match(help.stdout, /run --provider claude-code --model sonnet/);
});

test('the native Claude help command accepts its provider and model options', () => {
  const help = spawnSync(process.execPath, [bin, 'help', 'advanced'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  const command = /To use native Claude chat, run `oms ([^`]+)`/.exec(help.stdout);
  assert.ok(command);
  const result = spawnSync(process.execPath, [bin, ...command[1]!.split(' ')], {
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Unknown option --provider/);
  assert.equal(result.stderr.trim(), 'oms: Run OMS in an interactive terminal');
});

test('the short help says oms works in any folder', () => {
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Start in the current folder \(any folder works\)/);
});

test('the short help lists the flags plain oms accepts, never the one it refuses, and ends no row with a period', () => {
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' }).stdout;
  for (const flag of ['--spend-usd <n>', '--yolo', '--no-web']) assert.ok(help.includes(flag), flag);
  assert.doesNotMatch(help, /--sandbox/);
  assert.match(help, /\/connect +Sign in: ChatGPT, Claude, Grok or an API key/);
  assert.doesNotMatch(help, /\.$/m);
  const advanced = spawnSync(process.execPath, [bin, 'help', 'advanced'], { encoding: 'utf8' }).stdout;
  assert.match(advanced, /--sandbox docker +Run task commands in Docker \(oms run only\)/);
  assert.doesNotMatch(advanced, /unknown usage are retained|Signing and workspace-secret/);
});

test('npx launches print runnable npx commands in help and recovery hints', () => {
  for (const [args, command] of [
    [['--help'], 'help advanced'],
    [['help', 'advanced'], 'doctor'],
    [['review', '--help'], 'review'],
    [['review', '--unknown'], 'review --help'],
    [['workspace', 'init'], 'workspace init'],
    [['task'], 'task create'],
    [['toolchain'], 'toolchain'],
    [['not-a-command'], '--help'],
    [[], ''],
  ] as const) {
    const result = spawnSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      env: { ...process.env, npm_command: 'exec' },
    });
    assert.ifError(result.error);
    assert.ok(
      (result.stdout + result.stderr).includes(`npx @barestate/oms${command ? ` ${command}` : ''}`),
      args.join(' '),
    );
  }
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
  await assert.rejects(startLocal(['--sandbox', 'docker']), (error: Error) => {
    assert.equal(error.message, DOCKER_CHAT_REFUSAL);
    const command = /Run `(?:oms|npx @barestate\/oms) ([^`]+)`/.exec(error.message);
    assert.ok(command, 'Docker refusal must provide an exact recovery command');
    const recovery = spawnSync(process.execPath, [bin, ...command[1]!.split(' ')], { encoding: 'utf8' });
    assert.ifError(recovery.error);
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.match(recovery.stdout, /workspace init/);
    assert.match(recovery.stdout, /task create/);
    assert.match(recovery.stdout, /--sandbox host\|docker/);
    return true;
  });
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
