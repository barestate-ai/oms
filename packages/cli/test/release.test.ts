import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { changelogSection, releaseVersion } from '../../../scripts/release.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

const CHANGELOG = `# Changelog

## Unreleased

- Not shipped yet.

## 0.1.4

- Fourth.

### Detail

- Nested heading stays in the section.

## 0.1.3

- Third.
`;

test('the release version comes from one field and must be a plain x.y.z', () => {
  assert.equal(releaseVersion({ releaseVersion: '0.1.3' }), '0.1.3');
  for (const bad of [undefined, '', 'latest', '0.1', '0.1.3-beta.1', 'v0.1.3', 3]) {
    assert.throws(() => releaseVersion({ releaseVersion: bad }), /releaseVersion/);
  }
  assert.match(releaseVersion(JSON.parse(read('package.json'))), /^\d+\.\d+\.\d+$/);
});

test('release notes are exactly the changelog section of that version', () => {
  assert.equal(
    changelogSection(CHANGELOG, '0.1.4'),
    '- Fourth.\n\n### Detail\n\n- Nested heading stays in the section.',
  );
  assert.equal(changelogSection(CHANGELOG, '0.1.3'), '- Third.');
  assert.doesNotMatch(changelogSection(CHANGELOG, '0.1.4'), /Third|Not shipped/);
});

test('a version with no changelog section, or an empty one, cannot be released', () => {
  assert.throws(() => changelogSection(CHANGELOG, '0.2.0'), /CHANGELOG/);
  assert.throws(() => changelogSection('## 0.2.0\n\n## 0.1.3\n\n- x\n', '0.2.0'), /empty/);
  assert.throws(() => changelogSection(CHANGELOG, '0.1'), /version/);
});

test('the repository ships a changelog entry for the version it would release', () => {
  const version = releaseVersion(JSON.parse(read('package.json')));
  assert.ok(changelogSection(read('CHANGELOG.md'), version).length > 0);
});

test('the command line prints the version and the notes', () => {
  const script = new URL('scripts/release.ts', root).pathname;
  const version = execFileSync(process.execPath, [script, 'version'], { encoding: 'utf8' }).trim();
  assert.equal(version, releaseVersion(JSON.parse(read('package.json'))));
  const notes = execFileSync(process.execPath, [script, 'notes', version], { encoding: 'utf8' });
  assert.ok(notes.trim().length > 0);
  assert.throws(() => execFileSync(process.execPath, [script, 'notes', '9.9.9'], { stdio: 'pipe' }));
});

test('the packed package carries the one release version and the repository npm provenance needs', () => {
  const pack = read('scripts/pack-release.mjs');
  assert.match(pack, /releaseVersion\(/);
  assert.doesNotMatch(pack, /const version = '\d/);
  assert.match(pack, /git\+https:\/\/github\.com\/barestate-ai\/oms\.git/);
});

test('the release workflow only runs from main, publishes through a gated environment with OIDC, and holds no npm token', () => {
  const release = read('.github/workflows/release.yml');
  assert.match(release, /on:\s+push:\s+branches: \[main\]\s+workflow_dispatch:/);
  assert.match(release, /github\.repository == 'barestate-ai\/oms'/);
  assert.match(release, /github\.ref == 'refs\/heads\/main'/);
  assert.match(release, /environment: npm/);
  assert.match(release, /id-token: write/);
  assert.match(release, /npm publish "\.\/dist\/.*--provenance --access public/);
  assert.doesNotMatch(release, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  assert.doesNotMatch(release, /pull_request|master/);
  // Only the publish job may write; the build job stays read-only.
  const build = release.slice(release.indexOf('  build:'), release.indexOf('  publish:'));
  assert.doesNotMatch(build, /contents: write|id-token/);
});

test('CI runs on both branches so a release PR into main is checked too', () => {
  assert.match(read('.github/workflows/ci.yml'), /push:\s+branches: \[main, master\]/);
});
