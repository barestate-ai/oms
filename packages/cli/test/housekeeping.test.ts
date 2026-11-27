import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { acquireMutationLease } from '@oms/engine';
import { completionScript } from '../src/completion.ts';
import { COMMANDS } from '../src/help.ts';
import { runSessionsCommand } from '../src/sessions.ts';
import { runUninstall, type UninstallDeps } from '../src/uninstall.ts';

const bin = new URL('../src/bin.ts', import.meta.url).pathname;

function sandbox(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'oms-house-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateRoot = join(home, '.oms');
  const oms = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd: home,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, ...env },
    });
  return { home, stateRoot, oms };
}

function saveFolder(stateRoot: string, key: string, path: string): string {
  const dir = join(stateRoot, 'folders', key);
  mkdirSync(join(dir, 'sessions'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'folder.json'), JSON.stringify({ path, scratch: false }));
  writeFileSync(join(dir, 'sessions', '2026-11-20T06-57-29-272Z_one.jsonl'), '{}\n');
  return dir;
}

function io(answer: boolean | 'no terminal' = true) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  return {
    out,
    err,
    asked,
    log: (line: string) => void out.push(line),
    error: (line: string) => void err.push(line),
    confirm:
      answer === 'no terminal'
        ? undefined
        : async (question: string) => {
            asked.push(question);
            return answer;
          },
  };
}

test('sessions --prune removes state only for deleted folders, after asking', async (t) => {
  const { home, stateRoot } = sandbox(t);
  mkdirSync(join(home, 'alive'));
  const kept = saveFolder(stateRoot, 'a'.repeat(40), join(home, 'alive'));
  const gone = saveFolder(stateRoot, 'b'.repeat(40), join(home, 'gone'));

  const declined = io(false);
  assert.equal(await runSessionsCommand(['--prune'], stateRoot, declined), 1);
  assert.match(declined.out.join('\n'), /~?.*gone/);
  assert.equal(declined.asked.length, 1);
  assert.ok(existsSync(gone));

  const unattended = io('no terminal');
  assert.equal(await runSessionsCommand(['--prune'], stateRoot, unattended), 1);
  assert.match(unattended.err.join('\n'), /--yes/);
  assert.ok(existsSync(gone));

  const accepted = io(true);
  assert.equal(await runSessionsCommand(['--prune'], stateRoot, accepted), 0);
  assert.equal(existsSync(gone), false);
  assert.ok(existsSync(kept));

  const again = io('no terminal');
  assert.equal(await runSessionsCommand(['--prune', '--yes'], stateRoot, again), 0);
  assert.match(again.out.join('\n'), /Nothing to remove/);
});

test('sessions --prune leaves state that a running oms still holds', async (t) => {
  const { home, stateRoot } = sandbox(t);
  const held = saveFolder(stateRoot, 'c'.repeat(40), join(home, 'gone'));
  const lease = acquireMutationLease(join(held, 'session.lease'));
  const run = io();
  assert.equal(await runSessionsCommand(['--prune', '--yes'], stateRoot, run), 0);
  assert.ok(existsSync(held));
  assert.match(run.out.join('\n'), /still held/);
  lease.release();
});

function installed(t: TestContext) {
  const { home, stateRoot } = sandbox(t);
  const prefix = join(stateRoot, 'cli');
  for (const dir of [prefix, join(stateRoot, 'bin'), join(stateRoot, 'node', 'bin'), join(stateRoot, 'agent')])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateRoot, 'bin', 'oms'), `exec node '${prefix}/bin/oms' "$@"\n`);
  writeFileSync(join(stateRoot, 'node', 'bin', 'node'), '');
  writeFileSync(join(home, '.zshrc'), `export PATH='${stateRoot}/bin':"$PATH"\n`);
  const run = io();
  const ran: string[][] = [];
  const deps: UninstallDeps = {
    install: { kind: 'installer', prefix },
    npm: 'npm',
    home,
    stateRoot,
    exec: async (file, args) => {
      ran.push([file, ...args]);
      return 0;
    },
    ...run,
  };
  return { home, stateRoot, prefix, deps, run, ran };
}

test('uninstall removes an installer copy but keeps your data and shell files', async (t) => {
  const f = installed(t);
  assert.equal(await runUninstall([], f.deps), 0);
  for (const gone of ['cli', 'node', 'bin/oms']) assert.equal(existsSync(join(f.stateRoot, gone)), false, gone);
  assert.ok(existsSync(join(f.stateRoot, 'agent')));
  assert.match(readFileSync(join(f.home, '.zshrc'), 'utf8'), /export PATH/);
  assert.match(f.run.out.join('\n'), /\.zshrc/);
  assert.equal(f.run.asked.length, 1);
});

test('uninstall --purge also deletes the data, and says so before asking', async (t) => {
  const f = installed(t);
  assert.equal(await runUninstall(['--purge'], f.deps), 0);
  assert.equal(existsSync(f.stateRoot), false);
  assert.match(f.run.out.join('\n'), /conversations.*sign-ins/i);
});

test('uninstall does nothing when declined, unattended without --yes, or given a bad option', async (t) => {
  for (const [args, answer, code] of [
    [['--purge'], false, 1],
    [['--purge'], 'no terminal', 1],
    [['--force'], true, 2],
  ] as const) {
    const f = installed(t);
    const run = io(answer);
    assert.equal(await runUninstall([...args], { ...f.deps, confirm: run.confirm, error: run.error }), code);
    assert.ok(existsSync(join(f.stateRoot, 'cli')));
  }
});

test('uninstall --purge refuses while oms is open in a folder', async (t) => {
  const f = installed(t);
  const held = saveFolder(f.stateRoot, 'd'.repeat(40), f.home);
  const lease = acquireMutationLease(join(held, 'session.lease'));
  assert.equal(await runUninstall(['--purge', '--yes'], f.deps), 1);
  assert.ok(existsSync(join(f.stateRoot, 'cli')));
  assert.match(f.run.err.join('\n'), /open in/);
  lease.release();
});

test('uninstall --purge checks live leases even when chat metadata is corrupt', async (t) => {
  const f = installed(t);
  const held = saveFolder(f.stateRoot, 'd'.repeat(40), f.home);
  writeFileSync(join(held, 'folder.json'), 'broken');
  const lease = acquireMutationLease(join(held, 'session.lease'));
  try {
    assert.equal(await runUninstall(['--purge', '--yes'], f.deps), 1);
    assert.ok(existsSync(join(held, 'session.lease')));
    assert.ok(existsSync(f.prefix));
  } finally {
    lease.release();
  }
});

test('uninstall --purge refuses live registry, workspace and managed task leases', async (t) => {
  for (const parts of [
    ['registry.lease'],
    ['workspaces', 'workspace', 'mutation.lease'],
    ['workspaces', 'workspace', 'tasks', 'task', 'mutation.lease'],
  ]) {
    const f = installed(t);
    const file = join(f.stateRoot, ...parts);
    mkdirSync(join(f.stateRoot, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
    const lease = acquireMutationLease(file);
    try {
      assert.equal(await runUninstall(['--purge', '--yes'], f.deps), 1);
      assert.ok(existsSync(file));
      assert.ok(existsSync(f.prefix));
    } finally {
      lease.release();
    }
  }
});

test('uninstall --purge refuses malformed ownership records', async (t) => {
  const f = installed(t);
  writeFileSync(join(f.stateRoot, 'registry.lease'), 'broken', { mode: 0o600 });
  assert.equal(await runUninstall(['--purge', '--yes'], f.deps), 1);
  assert.match(f.run.err.join('\n'), /Cannot verify ownership/);
  assert.ok(existsSync(f.prefix));
});

test('uninstall --purge rechecks ownership after confirmation and after package-manager uninstall', async (t) => {
  for (const during of ['confirmation', 'uninstall']) {
    const f = installed(t);
    const file = join(f.stateRoot, 'registry.lease');
    let lease: ReturnType<typeof acquireMutationLease> | undefined;
    const confirm = async () => {
      if (during === 'confirmation') lease = acquireMutationLease(file);
      return true;
    };
    const exec = async () => {
      lease = acquireMutationLease(file);
      return 0;
    };
    const install = during === 'confirmation' ? f.deps.install : { kind: 'brew' as const };
    try {
      assert.equal(await runUninstall(['--purge'], { ...f.deps, install, confirm, exec }), 1);
      assert.ok(existsSync(file));
      assert.ok(existsSync(f.prefix));
    } finally {
      lease?.release();
    }
  }
});

test('uninstall hands npm and Homebrew copies to their own tool and keeps data if that fails', async (t) => {
  const npm = installed(t);
  npm.deps.install = { kind: 'npm', prefix: '/opt/homebrew' };
  assert.equal(await runUninstall(['--yes'], npm.deps), 0);
  assert.deepEqual(npm.ran, [['npm', 'uninstall', '-g', '--prefix', '/opt/homebrew', '@barestate/oms']]);
  assert.ok(existsSync(join(npm.stateRoot, 'cli')));

  const brew = installed(t);
  brew.deps.install = { kind: 'brew' };
  assert.equal(await runUninstall(['--yes', '--purge'], { ...brew.deps, exec: async () => 1 }), 1);
  assert.ok(existsSync(brew.stateRoot));
});

test('an installer copy under a custom OMS_HOME is recognised by its launcher', async (t) => {
  const f = installed(t);
  f.deps.install = { kind: 'npm', prefix: f.prefix };
  assert.equal(await runUninstall(['--yes'], f.deps), 0);
  assert.deepEqual(f.ran, []);
  assert.equal(existsSync(f.prefix), false);
});

test('uninstall recognises an installer launcher with a shell-quoted apostrophe in its prefix', async (t) => {
  const f = installed(t);
  const root = join(f.home, "custom's state");
  const prefix = join(root, 'cli');
  const launcher = join(root, 'bin', 'oms');
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'bin'), { mode: 0o700 });
  writeFileSync(launcher, `exec '/usr/bin/node' '${f.home}/custom'\\''s state/cli/bin/oms' "$@"\n`);
  assert.equal(await runUninstall(['--yes'], { ...f.deps, install: { kind: 'npm', prefix } }), 0);
  assert.deepEqual(f.ran, []);
  assert.equal(existsSync(launcher), false);
  assert.equal(existsSync(prefix), false);
  assert.ok(existsSync(f.stateRoot));
});

test('uninstall only advises for npx, project and source copies', async (t) => {
  const f = installed(t);
  f.deps.install = { kind: 'source' };
  assert.equal(await runUninstall(['--yes'], f.deps), 1);
  assert.match(f.run.err.join('\n'), /source checkout/);
  assert.ok(existsSync(f.prefix));
});

test('config shows where things are and never what the secrets say', (t) => {
  const { stateRoot, oms } = sandbox(t);
  mkdirSync(join(stateRoot, 'agent'), { recursive: true, mode: 0o700 });
  writeFileSync(join(stateRoot, 'agent', 'auth.json'), '{"openai":{"key":"sk-SECRET-VALUE"}}', { mode: 0o600 });
  writeFileSync(join(stateRoot, 'config.json'), '{"web":"off"}');
  const text = oms(['config']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /State folder +~\/\.oms/);
  assert.match(text.stdout, /Web search +off/);
  assert.match(text.stdout, /Update check +off/);
  assert.match(oms(['config'], { OMS_UPDATE_CHECK: '1' }).stdout, /Update check +on/);
  assert.match(text.stdout, /Model sign-ins +saved/);
  assert.doesNotMatch(text.stdout, /SECRET/);
  const json = oms(['config', '--json']);
  assert.doesNotMatch(json.stdout, /SECRET/);
  assert.equal(JSON.parse(json.stdout).webSearch, 'off');
  writeFileSync(join(stateRoot, 'config.json'), 'nope');
  assert.match(oms(['config']).stdout, /Web search +invalid/);
});

test('completion covers every command and its flags, in shells that parse it', (t) => {
  const { home, oms } = sandbox(t);
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    const script = completionScript(shell);
    for (const name of Object.keys(COMMANDS)) assert.ok(script.includes(name), `${shell} ${name}`);
    assert.match(script, shell === 'fish' ? /-l purge/ : /--purge/);
    const file = join(home, `completion.${shell}`);
    writeFileSync(file, script);
    const check = spawnSync(shell, ['-n', file], { encoding: 'utf8' });
    if ((check.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT')
      assert.equal(check.status, 0, `${shell}: ${check.stderr}`);
    assert.equal(oms(['completion', shell]).stdout.trim(), script.trim());
  }
  assert.equal(oms(['completion', 'tcsh']).status, 2);
  assert.equal(oms(['completion']).status, 2);
});

test("bash completion offers commands first and then that command's flags", (t) => {
  const { home } = sandbox(t);
  const file = join(home, 'completion.bash');
  writeFileSync(file, completionScript('bash'));
  const complete = (...words: string[]) =>
    spawnSync(
      'bash',
      [
        '-c',
        `source "$1"; shift; COMP_WORDS=("$@"); COMP_CWORD=$((\${#COMP_WORDS[@]}-1)); _oms; printf '%s\\n' "\${COMPREPLY[@]}"`,
        '_',
        file,
        ...words,
      ],
      { encoding: 'utf8' },
    )
      .stdout.split('\n')
      .filter(Boolean);
  assert.deepEqual(complete('oms', 'upd'), ['update']);
  assert.deepEqual(complete('oms', 'uninstall', '--p'), ['--purge']);
  assert.deepEqual(complete('oms', 'toolchain', 'ch'), ['check']);
});
