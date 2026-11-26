import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { grade, VISIBLE_TEST_COMMAND } from './grade.ts';
import {
  createManifest,
  createHardManifest,
  createExpertManifest,
  EXPERT_SEED,
  HARD_SEED,
  HARD_THEMES,
  FIXED_SEED,
  hashTaskDirectory,
} from './split.ts';

test('expert split is deterministic, d5-only, disjoint and two per theme', async () => {
  await fixture(async (root) => {
    for (const [i, theme] of HARD_THEMES.entries())
      for (let n = 0; n < 4; n++) {
        const id = `expert-${i}-${n}`,
          path = join(root, id);
        await mkdir(path);
        await writeFile(join(path, 'meta.json'), JSON.stringify({ id, theme, difficulty: 5 }));
      }
    const a = await createExpertManifest(root);
    assert.equal(a.seed, EXPERT_SEED);
    assert.deepEqual(a, await createExpertManifest(root));
    assert.equal(new Set([...a.dev, ...a.heldout].map((e) => e.id)).size, 16);
    for (const split of [a.dev, a.heldout])
      for (let i = 0; i < 4; i++) assert.equal(split.filter((e) => e.id.startsWith(`expert-${i}-`)).length, 2);
    await writeFile(
      join(root, 'expert-0-0/meta.json'),
      JSON.stringify({ id: 'expert-0-0', theme: HARD_THEMES[0], difficulty: 4 }),
    );
    await assert.rejects(createExpertManifest(root), /metadata/);
    await rm(join(root, 'expert-0-0'), { recursive: true });
    await assert.rejects(createExpertManifest(root), /four tasks/);
  });
});

test('hard split uses fixed seeded shuffle, two per theme on each side, and rejects invalid strata', async () => {
  await fixture(async (root) => {
    for (const [themeIndex, theme] of HARD_THEMES.entries()) {
      for (let n = 0; n < 4; n++) {
        const id = `t-${themeIndex}-${n}`,
          path = join(root, id);
        await mkdir(path);
        await writeFile(join(path, 'meta.json'), JSON.stringify({ id, theme, difficulty: 4 }));
      }
    }
    const first = await createHardManifest(root);
    assert.equal(first.seed, HARD_SEED);
    assert.equal(first.dev.length, 8);
    assert.equal(first.heldout.length, 8);
    assert.deepEqual(first, await createHardManifest(root));
    for (const themeIndex of HARD_THEMES.keys())
      for (const split of [first.dev, first.heldout])
        assert.equal(split.filter((entry) => entry.id.startsWith(`t-${themeIndex}-`)).length, 2);
    assert.equal(new Set([...first.dev, ...first.heldout].map((entry) => entry.id)).size, 16);
    await writeFile(
      join(root, 't-0-0', 'meta.json'),
      JSON.stringify({ id: 't-0-0', theme: HARD_THEMES[0], difficulty: 3 }),
    );
    await assert.rejects(createHardManifest(root), /metadata/);
    await rm(join(root, 't-0-0'), { recursive: true });
    await assert.rejects(createHardManifest(root), /four tasks/);
  });
});

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'blend-tools-test-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function graderFixture(root: string, implementation: string) {
  const task = join(root, 'task');
  const workspace = join(root, 'workspace');
  await mkdir(join(task, 'hidden'), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(workspace, 'package.json'), '{"type":"module"}');
  await writeFile(join(workspace, 'index.ts'), implementation);
  await writeFile(
    join(task, 'hidden', 'grade.test.ts'),
    `import test from 'node:test';
import assert from 'node:assert/strict';
import { value } from './index.ts';
${Array.from({ length: 8 }, (_, n) => `test('case ${n}',()=>assert.ok(value>${n}));`).join('\n')}`,
  );
  return { task, workspace };
}

test('grader counts hidden passes and does not execute agent-added tests', async () => {
  await fixture(async (root) => {
    const { task, workspace } = await graderFixture(root, 'export const value=8;');
    await writeFile(join(workspace, 'bonus.test.ts'), 'throw Error("must not run")');
    await writeFile(join(workspace, 'grade.test.ts'), 'throw Error("replaced in copy")');
    assert.deepEqual(await grade(task, workspace), { passed: 8, total: 8, score: 1 });
    assert.equal(await readFile(join(workspace, 'grade.test.ts'), 'utf8'), 'throw Error("replaced in copy")');
  });
});

test('grader returns partial score', async () => {
  await fixture(async (root) => {
    const { task, workspace } = await graderFixture(root, 'export const value=3;');
    assert.deepEqual(await grade(task, workspace), { passed: 3, total: 8, score: 3 / 8 });
  });
});

test('hidden grader and visible gate transform enums and parameter properties', async () => {
  await fixture(async (root) => {
    const implementation = (value: number) =>
      `enum Count { Eight = ${value} }\nclass Counter { constructor(public value: number) {} }\nexport const value = new Counter(Count.Eight).value;`;
    const { task, workspace } = await graderFixture(root, implementation(8));
    await writeFile(
      join(workspace, 'visible.test.ts'),
      "import assert from 'node:assert/strict'; import { value } from './index.ts'; assert.equal(value, 8);",
    );
    const environment = { ...process.env, NODE_OPTIONS: '' };
    delete environment.NODE_TEST_CONTEXT;
    const visible = () =>
      spawnSync(process.execPath, VISIBLE_TEST_COMMAND.slice(1), { cwd: workspace, env: environment }).status;
    assert.deepEqual(await grade(task, workspace), { passed: 8, total: 8, score: 1 });
    assert.equal(visible(), 0);
    await writeFile(join(workspace, 'index.ts'), implementation(3));
    assert.deepEqual(await grade(task, workspace), { passed: 3, total: 8, score: 3 / 8 });
    assert.notEqual(visible(), 0);
    await rm(join(workspace, 'index.ts'));
    assert.deepEqual(await grade(task, workspace), { passed: 0, total: 8, score: 0 });
    assert.notEqual(visible(), 0);
  });
});

test('grader handles all failures and an empty finished workspace', async () => {
  await fixture(async (root) => {
    const { task, workspace } = await graderFixture(root, 'export const value=0;');
    assert.deepEqual(await grade(task, workspace), { passed: 0, total: 8, score: 0 });
    await rm(join(workspace, 'index.ts'));
    assert.deepEqual(await grade(task, workspace), { passed: 0, total: 8, score: 0 });
  });
});

test('grader kills a hung workspace and preserves the denominator', async () => {
  await fixture(async (root) => {
    const { task, workspace } = await graderFixture(root, 'export const value=0; while(true){}');
    assert.deepEqual(await grade(task, workspace, { timeoutMs: 200 }), { passed: 0, total: 8, score: 0 });
  });
});

test('grader rejects symlinks, invalid deadlines, and missing grader inputs', async () => {
  await fixture(async (root) => {
    const { task, workspace } = await graderFixture(root, 'export const value=8;');
    await symlink(join(root, 'task'), join(workspace, 'outside'));
    await assert.rejects(grade(task, workspace), /symlink/);
    await assert.rejects(grade(task, workspace, { timeoutMs: 60_001 }), /Timeout/);
    await assert.rejects(grade(join(root, 'absent'), workspace), /ENOENT/);
    await rm(join(workspace, 'outside'));
    await writeFile(join(task, 'hidden', 'grade.test.ts'), '');
    await assert.rejects(grade(task, workspace), /8–20/);
  });
});

async function splitFixture(root: string) {
  const tasks = join(root, 'tasks');
  await mkdir(tasks);
  for (let n = 0; n < 32; n++) {
    const id = `task-${String(n).padStart(2, '0')}`;
    const directory = join(tasks, id);
    await mkdir(directory);
    await writeFile(join(directory, 'meta.json'), JSON.stringify({ id, difficulty: n < 10 ? 1 : n < 22 ? 2 : 3 }));
    await writeFile(join(directory, 'PROMPT.md'), `Task ${n}`);
  }
  return tasks;
}

test('split is deterministic, disjoint, exhaustive, and difficulty-stratified', async () => {
  await fixture(async (root) => {
    const tasks = await splitFixture(root);
    const manifest = await createManifest(tasks);
    assert.equal(manifest.seed, FIXED_SEED);
    assert.deepEqual(await createManifest(tasks), manifest);
    assert.equal(manifest.dev.length, 16);
    assert.equal(manifest.heldout.length, 16);
    assert.equal(new Set([...manifest.dev, ...manifest.heldout].map((entry) => entry.id)).size, 32);
    for (const entries of [manifest.dev, manifest.heldout]) {
      const counts = [0, 0, 0];
      for (const entry of entries) {
        const meta = JSON.parse(await readFile(join(tasks, entry.id, 'meta.json'), 'utf8'));
        counts[meta.difficulty - 1]++;
        assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      }
      assert.deepEqual(counts, [5, 6, 5]);
    }
    assert.notDeepEqual((await createManifest(tasks, 'another-seed')).dev, manifest.dev);
  });
});

test('tree hash uses sorted relative paths, lengths, and complete bytes', async () => {
  await fixture(async (root) => {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'z'), Buffer.from([0, 255]));
    await writeFile(join(root, 'nested', 'a'), 'a\0b');
    const expected = createHash('sha256')
      .update('nested/a\0' + '3\0' + 'a\0b')
      .update('z\0' + '2\0')
      .update(Buffer.from([0, 255]))
      .digest('hex');
    const original = await hashTaskDirectory(root);
    assert.equal(original, expected);
    await writeFile(join(root, 'nested', 'a'), 'changed');
    assert.notEqual(await hashTaskDirectory(root), original);
    await writeFile(join(root, 'nested', 'a'), 'a\0b');
    await rename(join(root, 'z'), join(root, 'x'));
    assert.notEqual(await hashTaskDirectory(root), original);
  });
});

test('split rejects empty/incomplete strata, invalid metadata, and task symlinks', async () => {
  await fixture(async (root) => {
    const tasks = await splitFixture(root);
    await assert.rejects(createManifest(tasks, ''), /Seed/);
    await writeFile(join(tasks, 'task-00', 'meta.json'), '{"id":"wrong","difficulty":1}');
    await assert.rejects(createManifest(tasks), /metadata/);
    await rm(join(tasks, 'task-00'), { recursive: true });
    await assert.rejects(createManifest(tasks), /32 unsealed/);
    await symlink(join(tasks, 'task-01'), join(tasks, 'linked'));
    await assert.rejects(createManifest(tasks), /directory/);
    await assert.rejects(hashTaskDirectory(tasks), /symlink/);
  });
});
