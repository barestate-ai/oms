import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseLaunchOptions } from '../src/harness.ts';
import { webSetting } from '../src/interactive.ts';
import { OMS_COMMANDS } from '../src/tui/commands.ts';

test('config web: on|off in <state root>/config.json; missing means on; anything else is an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-web-config-'));
  try {
    assert.equal(webSetting(root), 'on');
    writeFileSync(join(root, 'config.json'), '{"web":"off"}');
    assert.equal(webSetting(root), 'off');
    writeFileSync(join(root, 'config.json'), '{}');
    assert.equal(webSetting(root), 'on');
    writeFileSync(join(root, 'config.json'), '{"web":false}');
    assert.throws(() => webSetting(root), /web must be "on" or "off"/);
    writeFileSync(join(root, 'config.json'), '{web');
    assert.throws(() => webSetting(root), /not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--no-web is a launch switch for oms run and npm start; /web is a listed command', () => {
  assert.equal(parseLaunchOptions(['--no-web']).values.has('--no-web'), true);
  assert.equal(parseLaunchOptions([]).values.has('--no-web'), false);
  assert.throws(() => parseLaunchOptions(['--web']), /Unknown option --web/, '--web exists only for headless oms run');
  assert.ok(OMS_COMMANDS.some((command) => command.name === 'web' && command.argument === '[on|off|provider]'));
});
