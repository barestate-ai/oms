import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRetryableAssistantError, type AssistantMessage } from '@earendil-works/pi-ai';
import {
  describeClaudeCodeAuth,
  describeClaudeCodeLimit,
  describeClaudeCodeSignIn,
  describeFailure,
  describeRejection,
  providerName,
} from '../src/runtime/provider-rejection.ts';

const retryable = (text: string) =>
  isRetryableAssistantError({ stopReason: 'error', errorMessage: text } as AssistantMessage);

test('a request that broke off names the provider, hides its raw text and does not read as retryable', () => {
  const text = describeFailure('xai');
  assert.equal(
    text,
    "xAI's answer broke off before it finished. It is counted at its maximum cost. Send your message again to continue.",
  );
  assert.equal(retryable(text), false);
});

test('a rejected request quotes the provider message from its JSON body', () => {
  assert.equal(
    describeRejection('xai', 400, '{"error":"Argument not supported: background"}'),
    'xAI rejected the request: Argument not supported: background',
  );
});

test('every shipped provider id has a readable name', () => {
  for (const [provider, name] of [
    ['claude-code', 'Claude Code'],
    ['openai-codex', 'Codex'],
    ['opencode', 'OpenCode Zen'],
    ['xiaomi', 'Xiaomi'],
    ['xiaomi-token-plan-cn', 'Xiaomi Token Plan CN'],
    ['xiaomi-token-plan-sgp', 'Xiaomi Token Plan SGP'],
    ['xiaomi-token-plan-ams', 'Xiaomi Token Plan AMS'],
  ] as const)
    assert.equal(providerName(provider), name);
});

test('key-based providers keep the API-key message on 401 and 403', () => {
  for (const status of [401, 403])
    assert.equal(describeRejection('xai', status, ''), 'xAI says the API key is invalid. /connect to fix it.');
});

test('sign-in providers get sign-in guidance, never API-key advice, on 401 and 403', () => {
  for (const status of [401, 403]) {
    const codex = describeRejection('openai-codex', status, '');
    assert.equal(codex, 'Codex says the sign-in is invalid or expired. Sign in again in /connect to fix it.');
    const claude = describeRejection('claude-code', status, '');
    assert.equal(
      claude,
      'Claude Code says the sign-in is invalid or expired. Run claude auth login, then check the connection in /connect.',
    );
    assert.ok(!/API key/i.test(codex + claude));
  }
});

test('a Claude Code sign-in refusal is named, asks for re-authentication and is not retryable', () => {
  const text = describeClaudeCodeSignIn('claude-code');
  assert.equal(
    text,
    'Claude Code needs its Claude subscription sign-in before it can answer. Run claude auth login in a terminal, then check the connection in /connect and send your message again. No provider request was sent.',
  );
  assert.match(text, /auth login/);
  assert.ok(!/broke off/.test(text));
  assert.equal(retryable(text), false);
});

test('an in-flight Claude Code auth refusal is named, keeps the bound charge and is not retryable', () => {
  const text = describeClaudeCodeAuth('claude-code');
  assert.equal(
    text,
    "Claude Code's Claude subscription sign-in is no longer valid. Run claude auth login in a terminal and check the connection in /connect before sending your message again. It is counted at its maximum cost.",
  );
  assert.equal(retryable(text), false);
});

test('a Claude Code usage-limit refusal names the limit, quotes its reset hint and is not retryable', () => {
  assert.equal(
    describeClaudeCodeLimit('claude-code'),
    "Claude Code's usage limit was reached. It is counted at its maximum cost. Send your message again after the limit resets.",
  );
  const text = describeClaudeCodeLimit('claude-code', 'at 3:00 PM (UTC)');
  assert.equal(
    text,
    "Claude Code's usage limit was reached. It resets at 3:00 PM (UTC). It is counted at its maximum cost. Send your message again after the limit resets.",
  );
  assert.ok(!/API key/i.test(text));
  assert.equal(retryable(text), false);
});
