import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { interfacePreferences, readTuiPreferences, saveTuiPreferences } from '../src/tui/preferences.ts';

function stateRoot(t: TestContext): string {
  const base = mkdtempSync(join(tmpdir(), 'oms-tui-prefs-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return join(base, 'state');
}

const DEFAULTS = { theme: 'oms-ember', background: 'theme' };

test('a missing file gives the defaults and reading never creates anything', (t) => {
  const root = stateRoot(t);
  assert.deepEqual(readTuiPreferences(root), DEFAULTS);
  assert.throws(() => statSync(root));
});

test('saved choices are merged, written privately and read back on the next launch', (t) => {
  const root = stateRoot(t);
  assert.equal(saveTuiPreferences(root, { theme: 'nord' }), true);
  assert.equal(saveTuiPreferences(root, { startupArt: 'off' }), true);
  assert.equal(saveTuiPreferences(root, { background: 'terminal' }), true);
  assert.deepEqual(readTuiPreferences(root), { theme: 'nord', background: 'terminal', startupArt: 'off' });
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'tui.json'), 'utf8')), {
    theme: 'nord',
    background: 'terminal',
    startupArt: 'off',
  });
  assert.equal(statSync(join(root, 'tui.json')).mode & 0o777, 0o600);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(root), ['tui.json'], 'no temporary files are left behind');
});

test('malformed files, wrong types and unknown values fall back to defaults without throwing', (t) => {
  const root = stateRoot(t);
  mkdirSync(root, { recursive: true });
  const file = join(root, 'tui.json');
  for (const content of [
    '',
    '{',
    'null',
    '[]',
    '"nord"',
    '{"theme":"Nord"}',
    '{"theme":"__proto__","background":"transparent","startupArt":"sometimes"}',
    '{"theme":7,"background":null,"startupArt":["off"]}',
    '{"__proto__":{"theme":"nord"}}',
  ]) {
    writeFileSync(file, content);
    assert.deepEqual(readTuiPreferences(root), DEFAULTS, content);
  }
  writeFileSync(file, '{"theme":"dracula","background":"bogus","startupArt":"256","token":"secret"}');
  assert.deepEqual(readTuiPreferences(root), { theme: 'dracula', background: 'theme', startupArt: '256' });
  saveTuiPreferences(root, { theme: 'nord' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { theme: 'nord', background: 'theme', startupArt: '256' });
});

test('a failed write reports false and leaves the previous file intact', (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  const root = stateRoot(t);
  saveTuiPreferences(root, { theme: 'nord' });
  chmodSync(root, 0o500);
  try {
    assert.equal(saveTuiPreferences(root, { theme: 'dracula' }), false);
  } finally {
    chmodSync(root, 0o700);
  }
  assert.equal(readTuiPreferences(root).theme, 'nord');
  assert.deepEqual(readdirSync(root), ['tui.json']);
});

test('interface options start from the saved choices and save every change', (t) => {
  const root = stateRoot(t);
  const first = interfacePreferences(root);
  assert.equal(first.theme, 'oms-ember');
  assert.equal(first.background, 'theme');
  assert.equal('startupArt' in first, false, 'an unsaved art mode keeps the interface default');
  first.onThemeChange('rose-pine');
  first.onStartupArtChange('off');
  const second = interfacePreferences(root);
  assert.equal(second.theme, 'rose-pine');
  assert.equal(second.startupArt, 'off');
});

test('an unreadable file is left alone instead of being replaced with defaults', (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads any file');
  const root = stateRoot(t);
  mkdirSync(root, { recursive: true });
  const file = join(root, 'tui.json');
  writeFileSync(file, '{"theme":"nord","background":"terminal","startupArt":"off"}');
  chmodSync(file, 0o000);
  assert.equal(saveTuiPreferences(root, { theme: 'dracula' }), false);
  chmodSync(file, 0o600);
  assert.deepEqual(readTuiPreferences(root), { theme: 'nord', background: 'terminal', startupArt: 'off' });
});

test('the startup art is for the first launch only: it is marked shown once and never again', (t) => {
  const root = stateRoot(t);
  const first = interfacePreferences(root);
  assert.equal(first.firstRun, true);
  first.onFirstRunShown();
  assert.deepEqual(readTuiPreferences(root), { ...DEFAULTS, welcomed: true });
  assert.equal(interfacePreferences(root).firstRun, false);
  assert.equal(saveTuiPreferences(root, { theme: 'nord' }), true);
  assert.equal(interfacePreferences(root).firstRun, false, 'other choices keep the mark');
  writeFileSync(join(root, 'tui.json'), '{"welcomed":"yes"}');
  assert.equal(interfacePreferences(root).firstRun, true, 'only true counts');
});
