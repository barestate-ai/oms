import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ProjectIndex, isPrivatePath, parseGitGrep, parseRipgrepJson } from '../src/tui/search.ts';

function project(files: Record<string, string>, repository = true) {
  const root = mkdtempSync(join(tmpdir(), 'oms-search-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  if (repository) execFileSync('git', ['init', '-q'], { cwd: root });
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}
const noFiles = { list: async () => [] };

test('private folders are never listed or searched, whatever a tool returns', () => {
  assert.equal(isPrivatePath('.git/config'), true);
  assert.equal(isPrivatePath('a/.keys/id.json'), true);
  assert.equal(isPrivatePath('.env.agent'), true);
  assert.equal(isPrivatePath('src/.environment.rs'), false);
  const rg = [
    '{"type":"begin","data":{"path":{"text":"./a.rs"}}}',
    '{"type":"match","data":{"path":{"text":"./a.rs"},"lines":{"text":"  let x = 1;\\n"},"line_number":7,"submatches":[{"start":6}]}}',
    '{"type":"match","data":{"path":{"text":".oms/secret"},"lines":{"text":"x"},"line_number":1,"submatches":[{"start":0}]}}',
    'not json',
  ].join('\n');
  assert.deepEqual(parseRipgrepJson(rg), [{ path: 'a.rs', line: 7, column: 7, text: 'let x = 1;' }]);
  assert.deepEqual(parseGitGrep('b.rs:3:  Hello World\n.git/x:1:Hello', 'world'), [
    { path: 'b.rs', line: 3, column: 9, text: 'Hello World' },
  ]);
});

test('listing uses git: tracked and untracked files, ignored files left out, private folders hidden', async () => {
  const p = project({
    '.gitignore': 'target/\n',
    'src/lib.rs': 'x',
    'src/new.rs': 'y',
    'target/out.o': 'z',
    '.oms/state': 's',
  });
  try {
    execFileSync('git', ['add', 'src/lib.rs'], { cwd: p.root });
    const index = new ProjectIndex({ root: p.root, files: noFiles });
    const files = await index.list();
    assert.deepEqual(files, ['.gitignore', 'src/lib.rs', 'src/new.rs']);
    assert.strictEqual(await index.list(), files, 'cached until invalidated');
    writeFileSync(join(p.root, 'src/later.rs'), 'q');
    assert.equal((await index.list()).includes('src/later.rs'), false);
    index.invalidate();
    assert.equal((await index.list()).includes('src/later.rs'), true);
    assert.deepEqual(await index.named('lib.rs'), ['src/lib.rs']);
  } finally {
    p.done();
  }
});

test('without git or ripgrep listing, the guarded task files are walked and bounded', async () => {
  const p = project({ 'only.txt': 'x' }, false);
  try {
    const tree: Record<string, Array<{ path: string; kind: 'file' | 'directory' }>> = {
      '.': [
        { path: 'a.ts', kind: 'file' },
        { path: 'src', kind: 'directory' },
        { path: 'node_modules', kind: 'directory' },
      ],
      src: [{ path: 'src/b.ts', kind: 'file' }],
      node_modules: [{ path: 'node_modules/x.js', kind: 'file' }],
    };
    const listed: string[] = [];
    // A folder that is not a repository and an empty PATH leave only the task files.
    const index = new ProjectIndex({
      root: join(p.root, 'missing'),
      files: {
        async list(path = '.') {
          listed.push(path);
          return tree[path] ?? [];
        },
      },
    });
    const original = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      assert.deepEqual(await index.list(), ['a.ts', 'src/b.ts']);
    } finally {
      process.env.PATH = original;
    }
    assert.deepEqual(listed, ['.', 'src']);
  } finally {
    p.done();
  }
});

test('text search is literal: metacharacters, a leading dash and case rules behave', async () => {
  const p = project({
    'a.rs': 'let total = (a + b) * 2;\nlet Total = 1;\n-x flag\n',
    'b.rs': 'nothing here\n',
    '.env.agent': 'SECRET=(a + b)\n',
  });
  try {
    execFileSync('git', ['add', '-A'], { cwd: p.root });
    const index = new ProjectIndex({ root: p.root, files: noFiles });
    const regex = await index.search('(a + b) * 2');
    assert.deepEqual(
      regex.matches.map((match) => [match.path, match.line, match.column]),
      [['a.rs', 1, 13]],
    );
    const option = await index.search('-x flag');
    assert.deepEqual(
      option.matches.map((match) => match.line),
      [3],
    );
    assert.equal((await index.search('total')).matches.length, 2, 'lowercase query ignores case');
    assert.equal((await index.search('Total')).matches.length, 1, 'a capital makes it match case');
    assert.deepEqual((await index.search('SECRET')).matches, [], 'private files are never searched');
    assert.deepEqual((await index.search('')).matches, []);
    assert.deepEqual((await index.search('no such text anywhere')).matches, []);
  } finally {
    p.done();
  }
});

test('a search that is aborted returns nothing instead of failing', async () => {
  const p = project({ 'a.rs': 'needle\n' });
  try {
    const index = new ProjectIndex({ root: p.root, files: noFiles });
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await index.search('needle', controller.signal), { matches: [] });
  } finally {
    p.done();
  }
});

test('without ripgrep, git grep follows the same smart-case rule', async () => {
  const p = project({ 'a.rs': 'let total = 1;\nlet Total = 2;\n' });
  const bin = mkdtempSync(join(tmpdir(), 'oms-no-rg-'));
  const path = process.env.PATH;
  try {
    execFileSync('git', ['add', '-A'], { cwd: p.root });
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
    process.env.PATH = bin;
    const index = new ProjectIndex({ root: p.root, files: noFiles });
    assert.equal((await index.search('total')).matches.length, 2, 'lowercase query ignores case');
    const exact = await index.search('Total');
    assert.deepEqual(
      exact.matches.map((match) => [match.line, match.column]),
      [[2, 5]],
      'a capital makes it match case',
    );
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
    p.done();
  }
});
