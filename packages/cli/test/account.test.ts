import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { AccountPane } from '../src/tui/account.ts';
import type { OmsAccountSnapshot } from '@oms/engine';
import { getTheme } from '../src/tui/theme.ts';
import { createOmsAccountControls } from '../../engine/src/runtime/oms-account.ts';
import { writeInferencePreferences } from '../../engine/src/runtime/inference-preferences.ts';

function storedAccount(t: TestContext, meStatus = 200) {
  const root = mkdtempSync(join(tmpdir(), 'oms-account-pane-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = 'http://127.0.0.1:8788/oms';
  writeInferencePreferences(join(root, 'inference.json'), {
    version: 1,
    gatewayOrigin: origin,
    mimoProvider: 'xiaomi-token-plan-sgp',
  });
  const accountPath = join(root, 'oms-account.json');
  writeFileSync(
    accountPath,
    JSON.stringify({ origin, token: 'stored-token', userId: 'user-1', expiresAt: Date.now() + 3600000 }),
    { mode: 0o600 },
  );
  const calls: string[] = [];
  const controls = createOmsAccountControls({
    agentRoot: root,
    signal: new AbortController().signal,
    withUserOperation: (action) => action(),
    async openBrowser() {},
    async fetch(input, init) {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      let data: unknown;
      let status = 200;
      if (path === '/oms/api/me') {
        assert.equal(
          new Headers(init?.headers).get('authorization'),
          calls.length === 1 ? 'Bearer stored-token' : 'Bearer new-token',
        );
        status = calls.length === 1 ? meStatus : 200;
        data = { user: { id: 'user-1', email: 'person@example.test' }, devices: [] };
      } else if (path === '/oms/api/auth/device/code') {
        data = {
          device_code: 'device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: origin + '/device',
          expires_in: 60,
          interval: 1,
        };
      } else if (path === '/oms/api/auth/device/token') {
        data = { access_token: 'new-token', token_type: 'Bearer', expires_in: 3600 };
      } else throw new Error(`Unexpected account request: ${path}`);
      return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(controls.snapshot().state, 'signed-in');
  assert.equal(controls.snapshot().email, undefined);
  async function open(mode: 'login' | 'account') {
    let pane: AccountPane;
    const settled = new Promise<void>((resolve) => {
      pane = new AccountPane(controls, {
        mode,
        theme: () => getTheme('gruvbox')!,
        render() {
          if (!pane.input.render(120).join('\n').includes('Waiting')) resolve();
        },
        close() {},
      });
    });
    t.after(() => pane.dispose());
    await settled;
    return pane!;
  }
  return { controls, calls, accountPath, open };
}

test('login verifies a stored credential without requesting a new device code', { timeout: 5000 }, async (t) => {
  const f = storedAccount(t);
  const before = readFileSync(f.accountPath, 'utf8');
  const pane = await f.open('login');
  assert.deepEqual(f.calls, ['/oms/api/me']);
  const screen = pane.body.render(120).join('\n');
  assert.match(screen, /already signed in/i);
  assert.match(screen, /\/logout to switch/i);
  assert.match(screen, /person@example\.test/);
  assert.doesNotMatch(screen, /Device code:/);
  assert.equal(readFileSync(f.accountPath, 'utf8'), before);
});

for (const status of [401, 403]) {
  test(
    `login starts the device flow when stored credential verification returns ${status}`,
    { timeout: 5000 },
    async (t) => {
      const f = storedAccount(t, status);
      const pane = await f.open('login');
      assert.deepEqual(f.calls, [
        '/oms/api/me',
        '/oms/api/auth/device/code',
        '/oms/api/auth/device/token',
        '/oms/api/me',
      ]);
      assert.equal(f.controls.snapshot().state, 'signed-in');
      assert.match(pane.body.render(120).join('\n'), /person@example\.test/);
      assert.doesNotMatch(pane.body.render(120).join('\n'), /already signed in/i);
      assert.equal(JSON.parse(readFileSync(f.accountPath, 'utf8')).token, 'new-token');
    },
  );
}

test('login does not replace a stored credential when verification is unavailable', { timeout: 5000 }, async (t) => {
  const f = storedAccount(t, 503);
  const before = readFileSync(f.accountPath, 'utf8');
  const pane = await f.open('login');
  assert.deepEqual(f.calls, ['/oms/api/me']);
  assert.match(pane.body.render(120).join('\n'), /Couldn't reach OMS/);
  assert.doesNotMatch(pane.body.render(120).join('\n'), /already signed in/i);
  assert.equal(readFileSync(f.accountPath, 'utf8'), before);
});

test('account refresh restores the email from a persisted credential after restart', { timeout: 5000 }, async (t) => {
  const f = storedAccount(t);
  const pane = await f.open('account');
  assert.deepEqual(f.calls, ['/oms/api/me']);
  assert.match(pane.body.render(120).join('\n'), /Signed in as person@example\.test/);
});

test('device login displays code/link and escape cancels its pending operation', async () => {
  let signal: AbortSignal | undefined;
  let closed = false;
  const pane = new AccountPane(
    {
      snapshot: () => ({ state: 'signed-out', origin: 'https://oms.barestate.xyz' }),
      async refresh() {},
      async logout() {
        return { serverRevoked: false };
      },
      async login(interaction, active) {
        signal = active;
        interaction.showDevice({
          verificationUri: 'https://oms.barestate.xyz/device',
          userCode: 'ABCD-EFGH',
          expiresAt: Date.now() + 60000,
        });
        await new Promise<void>((resolve) => active.addEventListener('abort', () => resolve(), { once: true }));
      },
    },
    {
      mode: 'login',
      theme: () => getTheme('gruvbox')!,
      render() {},
      close() {
        closed = true;
        pane.dispose();
      },
    },
  );
  await setImmediate();
  const screen = pane.body.render(100).join('\n');
  assert.match(screen, /ABCD-EFGH/);
  assert.match(screen, /https:\/\/oms.barestate.xyz\/device/);
  pane.handleInput('\x1b');
  await setImmediate();
  assert.equal(signal?.aborted, true);
  assert.equal(closed, true);
});

test('offline logout states revocation uncertainty instead of claiming server success', async () => {
  const pane = new AccountPane(
    {
      snapshot: () => ({ state: 'signed-out', transport: 'local', origin: 'https://oms.barestate.xyz' }),
      async refresh() {},
      async login() {},
      async logout() {
        return { serverRevoked: false };
      },
    },
    { mode: 'logout', theme: () => getTheme('gruvbox')!, render() {}, close() {} },
  );
  await setImmediate();
  assert.match(pane.body.render(100).join('\n'), /couldn't reach the server/i);
  pane.dispose();
});

test('account pane shows the signed-in email and origin and explains that sign-in only enables hosted search', async () => {
  const snapshot: OmsAccountSnapshot = {
    state: 'signed-in',
    origin: 'https://oms.barestate.xyz',
    email: 'person@example.test',
  };
  const pane = new AccountPane(
    {
      snapshot: () => snapshot,
      async refresh() {},
      async login() {},
      async logout() {
        return { serverRevoked: false };
      },
    },
    { mode: 'account', theme: () => getTheme('gruvbox')!, render() {}, close() {} },
  );
  await setImmediate();
  const screen = pane.body.render(120).join('\n');
  assert.match(screen, /Signed in as/);
  assert.match(screen, /person@example\.test/);
  assert.match(screen, /hosted web search only/);
  assert.doesNotMatch(screen, /credit|managed/i);
  pane.dispose();
});
