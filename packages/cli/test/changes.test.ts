import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { taskDiff } from '@oms/engine';
import {
  ChangesStore,
  lineMarks,
  parsePatch,
  reverseApply,
  revert,
  type ChangeReport,
  type FileChange,
} from '../src/tui/changes.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** A repository whose first commit holds `files`; `after` is what the working tree holds next. */
function repository(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'oms-changes-'));
  git(root, 'init', '-q');
  const put = (name: string, text: string) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  };
  for (const [name, text] of Object.entries(files)) put(name, text);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  return {
    root,
    put,
    read: (name: string) => readFileSync(join(root, name), 'utf8'),
    base: (name: string) => git(root, 'show', `HEAD:${name}`),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}
async function changesOf(root: string): Promise<FileChange[]> {
  const diff = await taskDiff(root, 'HEAD');
  return parsePatch(diff.patch, diff.untracked, diff.truncated);
}

test('a patch parses into files with status, counts, hunks and untracked files', async () => {
  const repo = repository({ 'a.rs': 'one\ntwo\nthree\n', 'gone.txt': 'bye\n', 'keep.txt': 'same\n' });
  try {
    repo.put('a.rs', 'one\nTWO\nthree\nfour\n');
    repo.put('new.txt', 'fresh\n');
    git(repo.root, 'add', 'new.txt');
    rmSync(join(repo.root, 'gone.txt'));
    repo.put('untracked.txt', 'not added\n');
    const changes = await changesOf(repo.root);
    const byPath = new Map(changes.map((change) => [change.path, change]));
    assert.equal(byPath.get('a.rs')!.status, 'M');
    assert.equal(byPath.get('a.rs')!.added, 2);
    assert.equal(byPath.get('a.rs')!.removed, 1);
    assert.equal(byPath.get('a.rs')!.hunks.length, 1);
    assert.equal(byPath.get('new.txt')!.status, 'A');
    assert.equal(byPath.get('gone.txt')!.status, 'D');
    assert.equal(byPath.get('untracked.txt')!.status, 'U');
    assert.equal(byPath.has('keep.txt'), false);
    assert.match(byPath.get('a.rs')!.patch, /^diff --git a\/a\.rs b\/a\.rs/);
  } finally {
    repo.done();
  }
});

test('gutter marks: added lines, modified lines and a removal on the line that follows it', async () => {
  const repo = repository({ 'a.txt': 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n' });
  try {
    repo.put('a.txt', 'l1\nCHANGED\nl3\nl4\nadded\nl5\nl7\nl8\nl9\nl10\n');
    const [change] = await changesOf(repo.root);
    const marks = lineMarks(change!);
    assert.equal(marks.get(1), 'mod');
    assert.equal(marks.get(4), 'add');
    assert.equal(marks.get(6), 'del');
    assert.equal(marks.size, 3);
  } finally {
    repo.done();
  }
});

test('reverting every hunk gives back exactly the committed file', async () => {
  const cases: Array<[string, string, string]> = [
    [
      'multi-hunk',
      Array.from({ length: 30 }, (_, n) => `line ${n}`).join('\n') + '\n',
      Array.from({ length: 30 }, (_, n) => (n === 2 || n === 25 ? `edited ${n}` : `line ${n}`)).join('\n') +
        '\nextra\n',
    ],
    ['crlf', 'a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\nd\r\n'],
    ['no newline at the end', 'a\nb\nc', 'a\nb\nc\nd'],
    ['newline added at the end', 'a\nb', 'a\nb\n'],
    ['newline removed at the end', 'a\nb\n', 'a\nb'],
    ['everything deleted', 'a\nb\n', ''],
    ['unicode', '界\n🌱 seed\n', '界!\n🌱 seed\nnew 世界\n'],
  ];
  for (const [name, before, after] of cases) {
    const repo = repository({ 'f.txt': before });
    try {
      repo.put('f.txt', after);
      const [change] = await changesOf(repo.root);
      const result = reverseApply(after, change!);
      assert.ok(result.ok, name);
      assert.equal(result.ok && result.text, before, name);
    } finally {
      repo.done();
    }
  }
});

test('one hunk can be reverted alone and a file that moved on is refused untouched', async () => {
  const lines = Array.from({ length: 40 }, (_, n) => `line ${n}`);
  const repo = repository({ 'f.txt': lines.join('\n') + '\n' });
  try {
    const edited = lines.map((line, n) => (n === 1 || n === 35 ? `${line} edited` : line)).join('\n') + '\n';
    repo.put('f.txt', edited);
    const [change] = await changesOf(repo.root);
    assert.equal(change!.hunks.length, 2);
    const first = reverseApply(edited, change!, [change!.hunks[0]!]);
    assert.ok(first.ok);
    assert.match(first.ok ? first.text : '', /^line 0\nline 1\nline 2/);
    assert.match(first.ok ? first.text : '', /line 35 edited/);
    const moved = edited.replace('line 1 edited', 'someone else wrote this');
    const refused = reverseApply(moved, change!);
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? '' : refused.reason, /changed since/);
  } finally {
    repo.done();
  }
});

test('revert writes through the task files with the revision it read, and refuses what it cannot', async () => {
  const repo = repository({ 'a.txt': 'one\ntwo\n', 'dir/b.txt': 'bee\n' });
  try {
    repo.put('a.txt', 'one\nTWO\n');
    rmSync(join(repo.root, 'dir/b.txt'));
    repo.put('untracked.txt', 'x\n');
    const changes = await changesOf(repo.root);
    const calls: string[] = [];
    let disk = 'one\nTWO\n';
    const files = {
      async read(path: string) {
        calls.push(`read ${path}`);
        return { bytes: Buffer.from(disk), revision: 'rev-1' };
      },
      async write(path: string, bytes: Uint8Array, revision?: string) {
        calls.push(`write ${path} ${revision}`);
        disk = Buffer.from(bytes).toString('utf8');
        return 'rev-2';
      },
      async create(path: string, bytes: Uint8Array) {
        calls.push(`create ${path} ${Buffer.from(bytes).toString('utf8').trim()}`);
        return 'rev-3';
      },
      async makeDirectory(path: string) {
        calls.push(`mkdir ${path}`);
      },
    };
    const byPath = new Map(changes.map((change) => [change.path, change]));
    assert.equal((await revert(byPath.get('a.txt')!, files)).ok, true);
    assert.equal(disk, 'one\ntwo\n');
    assert.equal((await revert(byPath.get('dir/b.txt')!, files)).ok, true);
    assert.deepEqual(calls, ['read a.txt', 'write a.txt rev-1', 'mkdir dir', 'create dir/b.txt bee']);
    const untracked = await revert(byPath.get('untracked.txt')!, files);
    assert.equal(untracked.ok, false);
    assert.match(untracked.ok ? '' : untracked.reason, /new file cannot be reverted/);
    assert.equal(calls.length, 4);
  } finally {
    repo.done();
  }
});

test('the store refreshes one at a time, shares markers and tracks reviewed files per patch', async () => {
  let report: ChangeReport = {
    changes: [
      {
        path: 'a.rs',
        status: 'M',
        added: 1,
        removed: 1,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }],
        patch: 'p1',
      },
      { path: 'n.rs', status: 'U', added: 0, removed: 0, hunks: [], patch: '' },
    ],
  };
  let running = 0;
  let overlap = 0;
  let reads = 0;
  let notified = 0;
  const store = new ChangesStore(
    async () => {
      reads++;
      overlap = Math.max(overlap, ++running);
      await new Promise((resolve) => setImmediate(resolve));
      running--;
      return report;
    },
    () => notified++,
  );
  await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
  assert.equal(overlap, 1);
  assert.equal(reads, 2, 'extra asks while one runs make it go round once more, not once each');
  assert.deepEqual(
    [...store.markers()],
    [
      ['a.rs', 'M'],
      ['n.rs', 'U'],
    ],
  );
  assert.equal(store.marksFor('a.rs')!.get(0), 'mod');
  assert.equal(store.marksFor('n.rs'), undefined);
  assert.equal(store.unreviewed, 2);
  store.toggleReviewed(store.files[0]!);
  assert.equal(store.unreviewed, 1);
  report = { changes: [{ ...report.changes[0]!, patch: 'p2' }, report.changes[1]!] };
  await store.refresh();
  assert.equal(store.unreviewed, 2, 'a new patch for the same file is new work to review');
  assert.ok(notified >= 3);
  const failing = new ChangesStore(
    async () => {
      throw new Error('git exploded\nstack line');
    },
    () => {},
  );
  await failing.refresh();
  assert.match(failing.note!, /Changes unavailable: git exploded$/);
  assert.equal(failing.ready, true);
});
