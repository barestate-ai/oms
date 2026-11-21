import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chipsText, createConnectors, statusChips } from '../src/connectors/runtime.ts';
import { explorerSection } from '../src/tui/connectors.ts';
import { readConnectorsConfig } from '../src/connectors/config.ts';
import type { HostRun } from '../src/connectors/host.ts';

const root = () => mkdtempSync(join(tmpdir(), 'oms-runtime-'));
const ok: HostRun = async (file, args) => {
  if (file === 'gh') return { code: 0, stdout: '', stderr: 'Logged in to github.com account vivek (keyring)' };
  if (file === 'git') return { code: 0, stdout: 'git@github.com:x/y.git\n', stderr: '' };
  if (file === 'docker') return { code: 0, stdout: '26.1.4\n', stderr: '' };
  void args;
  return { code: null, stdout: '', stderr: '', error: 'missing' };
};
const make = (dir: string, extra: Partial<Parameters<typeof createConnectors>[0]> = {}) =>
  createConnectors({ stateRoot: dir, folder: '/work', env: {}, run: ok, ...extra });

test('a fresh state has every connector off, only the connector extension, and a row per catalog entry', () => {
  const dir = root();
  const connectors = make(dir);
  assert.equal(connectors.extensions.length, 1);
  assert.equal(connectors.anyEnabled(), false);
  assert.deepEqual(connectors.chips(), []);
  assert.deepEqual(
    connectors.rows().map((row) => row.spec.id),
    ['github', 'gitlab', 'gitlab-remote', 'linear', 'slack', 'docker', 'aws', 'solana-rpc'],
  );
  assert.ok(connectors.rows().every((row) => !row.enabled && row.access === 'off' && !row.detection));
  rmSync(dir, { recursive: true });
});

test('enabling saves the file, takes the default access, and tells hosted connectors they need a restart', () => {
  const dir = root();
  const connectors = make(dir);
  let changes = 0;
  connectors.onChange(() => changes++);
  assert.deepEqual(connectors.setEnabled('github', true), { saved: true, restart: false });
  assert.equal(connectors.access('github'), 'ask');
  assert.deepEqual(connectors.setEnabled('docker', true), { saved: true, restart: false });
  assert.equal(connectors.access('docker'), 'read');
  assert.deepEqual(connectors.setEnabled('linear', true), { saved: true, restart: true });
  assert.equal(changes, 3);
  const saved = readConnectorsConfig(dir).config;
  assert.deepEqual(saved.connectors.github, { enabled: true, access: 'ask' });
  assert.equal(connectors.anyEnabled(), true);
  assert.equal(connectors.setEnabled('github', false).saved, true);
  assert.equal(connectors.access('github'), 'off');
  // A later launch starts with hosted connectors already on, and loads their extension.
  const next = make(dir);
  assert.equal(next.access('linear'), 'ask');
  assert.equal(next.extensions.length, 2);
  assert.equal(next.setEnabled('slack', true).restart, false);
  rmSync(dir, { recursive: true });
});

test('A steps through only the levels a connector offers and remembers the choice', () => {
  const dir = root();
  const connectors = make(dir);
  connectors.setEnabled('github', true);
  assert.deepEqual(
    ['ask', 'allow', 'read', 'ask'].map(() => connectors.cycleAccess('github').access),
    ['allow', 'read', 'ask', 'allow'],
  );
  connectors.setEnabled('docker', true);
  assert.deepEqual(
    [1, 2, 3].map(() => connectors.cycleAccess('docker').access),
    ['ask', 'read', 'ask'],
  );
  connectors.setEnabled('aws', true);
  assert.equal(connectors.access('aws'), 'ask');
  assert.equal(connectors.cycleAccess('aws').access, 'read');
  assert.equal(connectors.cycleAccess('aws').access, 'ask');
  connectors.setEnabled('solana-rpc', true);
  assert.equal(connectors.cycleAccess('solana-rpc').access, 'read');
  assert.equal(readConnectorsConfig(dir).config.connectors.docker?.access, 'ask');
  rmSync(dir, { recursive: true });
});

test('a malformed file turns everything off with a notice, and changes then live only in memory', () => {
  const dir = root();
  writeFileSync(join(dir, 'connectors.json'), '{oops');
  const connectors = make(dir);
  assert.equal(connectors.problems.length, 1);
  assert.equal(connectors.anyEnabled(), false);
  assert.deepEqual(connectors.setEnabled('github', true), { saved: false, restart: false });
  assert.equal(connectors.access('github'), 'ask');
  assert.equal(readFileSync(join(dir, 'connectors.json'), 'utf8'), '{oops');
  rmSync(dir, { recursive: true });
});

test('detection fills in each row and chips follow it', async () => {
  const dir = root();
  const connectors = make(dir);
  connectors.setEnabled('github', true);
  connectors.setEnabled('docker', true);
  assert.deepEqual(
    connectors.chips().map((chip) => [chip.short, chip.state]),
    [
      ['gh', 'unknown'],
      ['docker', 'unknown'],
    ],
  );
  await connectors.detect();
  const rows = Object.fromEntries(connectors.rows().map((row) => [row.spec.id, row.detection]));
  assert.deepEqual(rows.github, { state: 'ready', account: 'vivek' });
  assert.equal(rows.gitlab!.state, 'missing');
  assert.equal(rows.linear!.state, 'signin');
  assert.deepEqual(
    connectors.chips().map((chip) => [chip.short, chip.state]),
    [
      ['gh', 'ok'],
      ['docker', 'ok'],
    ],
  );
  rmSync(dir, { recursive: true });
});

test('the tip is counted, shown on schedule, never twice for one place, and stopped by dismissal or a connection', async () => {
  const dir = root();
  const context = { chat: true, modelConfigured: true, rows: 30 };
  let connectors = make(dir);
  for (let launch = 1; launch <= 2; launch++) {
    connectors = make(dir);
    connectors.recordLaunch();
    assert.equal(connectors.tip('empty', context), undefined, `launch ${launch}`);
  }
  connectors = make(dir);
  connectors.recordLaunch();
  await connectors.prime();
  assert.equal(connectors.remote(), 'github');
  assert.match(connectors.tip('empty', context)!, /connect GitHub so the agent can read issues/);
  assert.equal(connectors.tip('login', context), undefined, 'one show per launch window');
  assert.deepEqual(readConnectorsConfig(dir).config.tips, { launches: 3, shown: 1, lastShown: 3, dismissed: false });
  connectors = make(dir);
  for (let i = 0; i < 7; i++) connectors.recordLaunch();
  assert.equal(connectors.tip('login', context), 'Optional: connect GitHub, GitLab, Linear or Slack in /connectors.');
  connectors.dismissTip();
  assert.equal(readConnectorsConfig(dir).config.tips.dismissed, true);
  assert.equal(make(dir).tip('empty', context), undefined);
  rmSync(dir, { recursive: true });
});

test('signing out of a hosted connector removes its sign-in and turns it off', () => {
  const dir = root();
  const connectors = make(dir);
  const linear = connectors.rows().find((row) => row.spec.id === 'linear')!.spec.mcp!;
  connectors.credentials
    .forServer(linear.server, linear.url)
    .save({ serverUrl: linear.url, tokens: { access_token: 't', token_type: 'Bearer' } });
  connectors.setEnabled('linear', true);
  connectors.signOut('linear');
  assert.equal(connectors.credentials.has(linear.server, linear.url), false);
  assert.equal(connectors.access('linear'), 'off');
  rmSync(dir, { recursive: true });
});

test('signing in to a command-line connector runs its own login on the host and reports plainly', async () => {
  const dir = root();
  const events: Array<[string, readonly string[]]> = [];
  const connectors = make(dir, {
    spawn: ((file: string, args: string[]) => {
      events.push([file, args]);
      throw new Error('no spawn in this test');
    }) as never,
  });
  const result = await connectors.signIn('docker', { signal: new AbortController().signal, show: () => {} });
  assert.equal(result.outcome, 'manual');
  const aws = await connectors.signIn('aws', { signal: new AbortController().signal, show: () => {} });
  assert.match(aws.message, /aws configure sso/);
  assert.equal(events.length, 0);
  rmSync(dir, { recursive: true });
});

test('status chips and the explorer section are plain data for the status row and the workbench', async () => {
  const dir = root();
  const connectors = make(dir);
  assert.deepEqual(statusChips(connectors), []);
  assert.deepEqual(statusChips(undefined), []);
  assert.equal(chipsText([]), '');
  connectors.setEnabled('github', true);
  connectors.setEnabled('docker', true);
  await connectors.detect();
  assert.equal(chipsText(statusChips(connectors)), 'gh ● docker ●');
  assert.equal(
    chipsText([
      { id: 'linear', short: 'linear', state: 'signin' },
      { id: 'aws', short: 'aws', state: 'error' },
    ]),
    'linear ◐ aws ✕',
  );
  const section = explorerSection(connectors);
  assert.equal(section.title, 'connectors');
  assert.equal(section.rows.length, 8);
  const github = section.rows.find((row) => row.id === 'github')!;
  assert.deepEqual([github.glyph, github.role, github.detail], ['●', 'success', 'vivek · asks before changes']);
  assert.deepEqual(explorerSection(undefined).rows, []);
  rmSync(dir, { recursive: true });
});
