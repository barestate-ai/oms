import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { COMMANDS, suggestCommand } from '../src/help.ts';

const bin = new URL('../src/bin.ts', import.meta.url).pathname;

function sandbox(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'oms-cmd-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const oms = (args: string[], cwd = home) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home },
    });
  return { home, oms };
}

test('every command prints its own help for --help and -h without doing anything else', (t) => {
  const { home, oms } = sandbox(t);
  for (const name of Object.keys(COMMANDS)) {
    const result = oms([name, '--help']);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`oms ${name}|oms review`), name);
    assert.doesNotMatch(result.stdout, /^(Ready|Warnings|Blocked)/m, name);
  }
  assert.equal(oms(['doctor', '--install', '-h']).status, 0);
  assert.deepEqual(readdirSync(home), [], 'asking for help writes nothing');
});

test('oms help <command> and launch flags with --help show help', (t) => {
  const { oms } = sandbox(t);
  assert.match(oms(['help', 'update']).stdout, /--check/);
  const launch = oms(['--yolo', '--help']);
  assert.equal(launch.status, 0, launch.stderr);
  assert.match(launch.stdout, /Solana coding agent/);
});

test('a mistyped command names the closest one', (t) => {
  assert.equal(suggestCommand('updat'), 'update');
  assert.equal(suggestCommand('docter'), 'doctor');
  assert.equal(suggestCommand('sesions'), 'sessions');
  assert.equal(suggestCommand('deploy'), undefined);
  assert.equal(suggestCommand('x'), undefined);
  const { oms } = sandbox(t);
  const result = oms(['updat']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command "updat".*did you mean "oms update"/);
});

test('oms error decodes a built-in code in decimal, hex or the log line form', (t) => {
  const { oms } = sandbox(t);
  for (const args of [['0xbc4'], ['3012'], ['custom', 'program', 'error:', '0xbc4'], ['custom program error: 0xbc4']]) {
    const result = oms(['error', ...args]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Custom error 3012 \(0xbc4\)/);
    assert.match(result.stdout, /AccountNotInitialized/);
  }
});

test('oms error reads the IDL of the current project and never prints its control characters', (t) => {
  const { home, oms } = sandbox(t);
  const project = join(home, 'project');
  mkdirSync(join(project, 'target', 'idl'), { recursive: true });
  writeFileSync(
    join(project, 'target', 'idl', 'vault.json'),
    JSON.stringify({ metadata: { name: 'vault' }, errors: [{ code: 6000, name: 'Locked', msg: 'no\u001b[2Jway' }] }),
  );
  const result = oms(['error', '6000', 'vault'], project);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /vault: Locked/);
  assert.equal(result.stdout.includes('\u001b'), false);
});

test('oms error fails clearly on an unknown code and on bad input', (t) => {
  const { oms } = sandbox(t);
  const unknown = oms(['error', '6999']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /Unknown code/);
  for (const args of [[], ['banana'], ['1', 'token', 'extra']]) {
    const result = oms(['error', ...args]);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /Usage: oms error/);
  }
});

function saveFolder(home: string, key: string, path: string, chats: string[], when: Date): string {
  const dir = join(home, '.oms', 'folders', key);
  mkdirSync(join(dir, 'sessions'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'folder.json'), JSON.stringify({ path, scratch: false }));
  for (const id of chats) {
    for (const name of [`2026-11-20T06-57-29-272Z_${id}.jsonl`, `${id}.budget.jsonl`, `${id}.trace.jsonl`]) {
      writeFileSync(join(dir, 'sessions', name), '{}\n');
      utimesSync(join(dir, 'sessions', name), when, when);
    }
  }
  return dir;
}

test('oms sessions lists the folders with saved chats, newest first, and flags deleted ones', (t) => {
  const { home, oms } = sandbox(t);
  const alive = join(home, 'alive');
  mkdirSync(alive);
  saveFolder(home, 'a'.repeat(40), alive, ['one', 'two'], new Date('2026-11-01T10:00:00Z'));
  saveFolder(home, 'b'.repeat(40), join(home, 'gone'), ['three'], new Date('2026-11-10T10:00:00Z'));
  saveFolder(home, 'c'.repeat(40), join(home, 'never-chatted'), [], new Date('2026-11-11T10:00:00Z'));
  mkdirSync(join(home, '.oms', 'folders', 'd'.repeat(40)));
  writeFileSync(join(home, '.oms', 'folders', 'd'.repeat(40), 'folder.json'), 'not json');

  const listed = oms(['sessions']);
  assert.equal(listed.status, 0, listed.stderr);
  const rows = listed.stdout.split('\n').filter((line) => line.startsWith('2026-'));
  assert.equal(rows.length, 2);
  assert.match(rows[0]!, /2026-11-10 +1 +~\/gone +\(folder deleted\)/);
  assert.match(rows[1]!, /2026-11-01 +2 +~\/alive$/);

  const json = JSON.parse(oms(['sessions', '--json']).stdout) as { path: string; chats: number; missing: boolean }[];
  assert.deepEqual(
    json.map((row) => [row.path, row.chats, row.missing]),
    [
      [join(home, 'gone'), 1, true],
      [alive, 2, false],
    ],
  );
});

test('oms sessions with nothing saved says how to start, and rejects unknown options', (t) => {
  const { home, oms } = sandbox(t);
  const empty = oms(['sessions']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No saved conversations/);
  assert.deepEqual(readdirSync(home), []);
  assert.equal(oms(['sessions', '--bogus']).status, 2);
});
