import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoAnthropicCredential, omsCellArgs, omsWebArgs, onlineStamp } from '../src/oms-run.ts';
import { lostSubscriptionAuth, stageSubscriptionLogin } from '../src/external.ts';
import { parseContender, SUBSCRIPTION_MODELS } from '../src/matrix.ts';

const OMS = 'oms3-web:gpt-sol';

test('the OMS cell needs the oms-search stack and refuses bring-your-own search keys', () => {
  assert.throws(() => omsWebArgs(OMS, {}), /OMS_SEARCH_TOKEN/);
  assert.throws(
    () => omsWebArgs(OMS, { OMS_SEARCH_TOKEN: 't', OMS_SEARCH_URL: 'http://search.example.com' }),
    /OMS_SEARCH_URL/,
  );
  assert.throws(
    () => omsWebArgs(OMS, { OMS_SEARCH_TOKEN: 't', OMS_SEARCH_URL: 'https://search.example.com', EXA_API_KEY: 'k' }),
    /EXA_API_KEY/,
  );
  assert.throws(
    () =>
      omsWebArgs(OMS, {
        OMS_SEARCH_TOKEN: 't',
        OMS_SEARCH_URL: 'https://search.example.com',
        OMS_SEARCH_PROVIDER: 'tinyfish',
      }),
    /OMS_SEARCH_PROVIDER/,
  );
  assert.deepEqual(omsWebArgs(OMS, { OMS_SEARCH_TOKEN: 't', OMS_SEARCH_URL: 'https://search.example.com' }), ['--web']);
  assert.deepEqual(omsWebArgs('codex:gpt-sol', {}), []);
});

test('the online label follows --web and a mismatch refuses before the run', () => {
  assert.deepEqual(onlineStamp(OMS, ['--web']), { online: 'web + Solana MCP' });
  assert.throws(() => onlineStamp(OMS, []), /needs --web/);
});

test('Claude Code losing its staged login mid-run is auth loss, read from its own error result only', () => {
  const lost = JSON.stringify({ type: 'result', is_error: true, result: 'OAuth token has expired. Please run /login' });
  assert.equal(lostSubscriptionAuth(lost), true);
  assert.equal(
    lostSubscriptionAuth(JSON.stringify({ type: 'result', is_error: false, result: 'OAuth token has expired' })),
    false,
  );
  assert.equal(lostSubscriptionAuth('tool output mentioning Not logged in'), false);
});

const CLAUDE_CELL = 'oms3-web:opus-sub';
const search = { OMS_SEARCH_TOKEN: 't', OMS_SEARCH_URL: 'https://search.example.com' };
const cellInput = (cell: string, model: (typeof SUBSCRIPTION_MODELS)['oms3'][string]) => ({
  cell,
  model,
  repo: '/r',
  stateRoot: '/s',
  taskId: 'solbench-harness',
  surfpoolWrapper: '/w',
  wallMinutes: 30,
  outputTokens: 32_768,
  inputTokens: 1_000_000,
});

test('the OMS Claude Code cell parses as OMS on claude-code/opus, online', () => {
  assert.deepEqual(parseContender(CLAUDE_CELL), { harness: 'oms3', modelKey: 'opus-sub', online: 'web + Solana MCP' });
  const model = SUBSCRIPTION_MODELS.oms3!['opus-sub']!;
  assert.equal(model.provider, 'claude-code');
  assert.equal(model.id, 'opus');
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('the Claude Code cell launches with web on, no input cap and no key; the Codex cell keeps its input cap', () => {
  const claude = omsCellArgs(cellInput(CLAUDE_CELL, SUBSCRIPTION_MODELS.oms3!['opus-sub']!), search);
  assert.ok(claude.includes('--web'));
  assert.ok(!claude.includes('--input-tokens'));
  assert.equal(claude[claude.indexOf('--output-tokens') + 1], '32768');
  assert.equal(claude[claude.indexOf('--sandbox') + 1], 'docker');
  assert.ok(!claude.some((arg) => /api|key|token$/i.test(arg) && arg !== '--output-tokens' && arg !== '--tokens'));
  const codex = omsCellArgs(cellInput('oms3-web:gpt-sol', SUBSCRIPTION_MODELS.oms3!['gpt-sol']!), search);
  assert.equal(codex[codex.indexOf('--input-tokens') + 1], '1000000');
});

test('the Claude Code cell refuses any Anthropic credential in the environment', () => {
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK'])
    assert.throws(
      () => omsCellArgs(cellInput(CLAUDE_CELL, SUBSCRIPTION_MODELS.oms3!['opus-sub']!), { ...search, [key]: 'x' }),
      new RegExp(key),
    );
  assert.doesNotThrow(() => assertNoAnthropicCredential({ PATH: '/usr/bin', ANTHROPIC_API_KEY: '' }));
});

test('the staged Claude login for the OMS cell has no refresh token and no API key', (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'oms-claude-login-'));
  const staged = mkdtempSync(join(tmpdir(), 'oms-claude-home-'));
  t.after(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  });
  mkdirSync(join(fakeHome, '.claude'));
  writeFileSync(
    join(fakeHome, '.claude/.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: 1, expiresAt: 2 },
    }),
  );
  const previous = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    stageSubscriptionLogin('claude-code', staged);
  } finally {
    process.env.HOME = previous;
  }
  const login = JSON.parse(readFileSync(join(staged, '.claude/.credentials.json'), 'utf8'));
  assert.equal(login.claudeAiOauth.accessToken, 'a');
  assert.equal(login.claudeAiOauth.refreshToken, undefined);
  assert.equal(login.claudeAiOauth.refreshTokenExpiresAt, undefined);
});
