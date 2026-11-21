import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyConfig, type ConnectorsConfig } from '../src/connectors/config.ts';
import type { HostResult } from '../src/connectors/host.ts';
import { afterShown, remoteKind, shouldShowTip, tipLine } from '../src/connectors/tips.ts';

const base = { chat: true, modelConfigured: true, rows: 24 };
const at = (
  launches: number,
  shown = 0,
  lastShown = 0,
  extra: Partial<Parameters<typeof shouldShowTip>[0]> = {},
  dismissed = false,
  config: ConnectorsConfig = emptyConfig(),
) => shouldShowTip({ ...base, tips: { launches, shown, lastShown, dismissed }, config, ...extra });

test('the tip never shows on the first or second launch, then at launches 3, 10 and 30 only', () => {
  assert.equal(at(1), false);
  assert.equal(at(2), false);
  assert.equal(at(3), true);
  let tips = { launches: 0, shown: 0, lastShown: 0, dismissed: false };
  const shows: number[] = [];
  for (let launch = 1; launch <= 80; launch++) {
    tips = { ...tips, launches: launch };
    if (shouldShowTip({ ...base, tips, config: emptyConfig() })) {
      shows.push(launch);
      tips = afterShown(tips);
    }
  }
  assert.deepEqual(shows, [3, 10, 30]);
});

test('a show that was skipped is made up at the next eligible launch, still at most three in all', () => {
  assert.equal(at(4, 0, 0), true);
  assert.equal(at(11, 1, 3), true);
  assert.equal(at(12, 1, 10), false);
  assert.equal(at(9, 1, 3), false);
  assert.equal(at(29, 2, 10), false);
  assert.equal(at(30, 2, 10), true);
  assert.equal(at(500, 3, 30), false);
});

test('dismissed, connected, wrong place and wrong state all stop it', () => {
  assert.equal(at(3, 0, 0, {}, true), false);
  for (const id of ['github', 'gitlab', 'linear', 'slack', 'gitlab-remote'] as const) {
    const config = emptyConfig();
    config.connectors[id] = { enabled: true, access: 'read' };
    assert.equal(at(3, 0, 0, {}, false, config), false, id);
  }
  // A connector that exists but is switched off does not count as connected; neither do Docker and AWS.
  const off = emptyConfig();
  off.connectors.github = { enabled: false, access: 'ask' };
  off.connectors.docker = { enabled: true, access: 'read' };
  assert.equal(at(3, 0, 0, {}, false, off), true);
  assert.equal(at(3, 0, 0, { chat: false }), false);
  assert.equal(at(3, 0, 0, { modelConfigured: false }), false);
  assert.equal(at(3, 0, 0, { rows: 17 }), false);
  assert.equal(at(3, 0, 0, { rows: 18 }), true);
});

const git =
  (stdout: string, code = 0): ((file: string, args: readonly string[]) => Promise<HostResult>) =>
  async () => ({
    code,
    stdout,
    stderr: '',
  });

test('the folder name picks the wording from the origin remote', async () => {
  for (const [url, kind] of [
    ['git@github.com:barestate-ai/oms.git', 'github'],
    ['https://github.com/barestate-ai/oms.git', 'github'],
    ['https://user@github.com/x/y', 'github'],
    ['ssh://git@gitlab.com/x/y.git', 'gitlab'],
    ['git@gitlab.example.com:x/y.git', 'gitlab'],
    ['https://example.com/github.com/x', 'other'],
    ['https://bitbucket.org/x/y', 'other'],
    ['', 'other'],
  ] as const) {
    assert.equal(await remoteKind(git(url + '\n'), '/x'), kind, url);
  }
  assert.equal(await remoteKind(git('', 128), '/x'), 'other');
  assert.match(tipLine('github'), /GitHub/);
  assert.match(tipLine('gitlab'), /GitLab/);
  assert.match(tipLine('other'), /GitHub, GitLab, Linear or Slack/);
  for (const kind of ['github', 'gitlab', 'other'] as const) assert.match(tipLine(kind), /\/connectors/);
});
