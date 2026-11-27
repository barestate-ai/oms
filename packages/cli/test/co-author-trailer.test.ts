import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { coAuthorTrailerSetting } from '../src/interactive.ts';

test('config coAuthorTrailer: on|off in <state root>/config.json; missing means on; anything else is an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-trailer-config-'));
  try {
    assert.equal(coAuthorTrailerSetting(root), 'on');
    writeFileSync(join(root, 'config.json'), '{"coAuthorTrailer":"off"}');
    assert.equal(coAuthorTrailerSetting(root), 'off');
    writeFileSync(join(root, 'config.json'), '{}');
    assert.equal(coAuthorTrailerSetting(root), 'on');
    writeFileSync(join(root, 'config.json'), '{"coAuthorTrailer":false}');
    assert.throws(() => coAuthorTrailerSetting(root), /coAuthorTrailer must be "on" or "off"/);
    writeFileSync(join(root, 'config.json'), '{coAuthorTrailer');
    assert.throws(() => coAuthorTrailerSetting(root), /not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
