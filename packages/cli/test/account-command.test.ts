import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { OmsAccountControls, OmsAccountSnapshot } from '@oms/engine';
import { accountControls, runAccountCommand, type AccountDeps } from '../src/account-command.ts';

const origin = 'https://barestate.xyz/oms';
const signedOut: OmsAccountSnapshot = { origin, state: 'signed-out' };
const signedIn: OmsAccountSnapshot = { origin, state: 'signed-in', userId: 'u1', email: 'ada@example.com' };

function deps(start: OmsAccountSnapshot, over: Partial<OmsAccountControls> = {}) {
  let snapshot = start;
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const value: AccountDeps = {
    controls: {
      snapshot: () => snapshot,
      async login(interaction) {
        calls.push('login');
        interaction.showDevice({ verificationUri: `${origin}/device`, userCode: 'ABCD-1234', expiresAt: 0 });
        snapshot = signedIn;
      },
      async logout() {
        calls.push('logout');
        snapshot = signedOut;
        return { serverRevoked: true };
      },
      async refresh() {
        calls.push('refresh');
      },
      ...over,
    },
    signal: new AbortController().signal,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
  return { value, out, err, calls, set: (next: OmsAccountSnapshot) => (snapshot = next) };
}

test('login shows the address and code, then says who is signed in', async () => {
  const d = deps(signedOut);
  assert.equal(await runAccountCommand('login', [], d.value), 0);
  assert.match(d.out.join('\n'), /barestate\.xyz\/oms\/device/);
  assert.match(d.out.join('\n'), /ABCD-1234/);
  assert.match(d.out.join('\n'), /Signed in as ada@example\.com/);
});

test('login verifies a saved session before reporting that it is already signed in', async () => {
  const d = deps(signedIn);
  assert.equal(await runAccountCommand('login', [], d.value), 0);
  assert.deepEqual(d.calls, ['refresh']);
  assert.match(d.out.join('\n'), /Already signed in.*oms logout/);
});

test('login starts device authorization after the service rejects the saved session', async () => {
  const d = deps(signedIn);
  d.value.controls.refresh = async () => void d.set(signedOut);
  assert.equal(await runAccountCommand('login', [], d.value), 0);
  assert.deepEqual(d.calls, ['login']);
  assert.match(d.out.join('\n'), /ABCD-1234/);
});

test('login does not report success if the saved session cannot be verified', async () => {
  const d = deps(signedIn, {
    async refresh() {
      throw new Error('OMS account status unavailable.');
    },
  });
  assert.equal(await runAccountCommand('login', [], d.value), 1);
  assert.deepEqual(d.out, []);
  assert.match(d.err.join('\n'), /account status unavailable/);
});

test('a failed login exits nonzero and points at the shell command, not the chat one', async () => {
  const d = deps(signedOut, {
    async login() {
      throw new Error('Sign-in was declined in the browser. Run /login to try again.');
    },
  });
  assert.equal(await runAccountCommand('login', [], d.value), 1);
  assert.match(d.err.join('\n'), /Run oms login to try again/);
});

test('logout ends the session and admits when the server did not confirm it', async () => {
  const done = deps(signedIn);
  assert.equal(await runAccountCommand('logout', [], done.value), 0);
  assert.match(done.out.join('\n'), /^Signed out\.$/);
  const offline = deps(signedIn, { logout: async () => ({ serverRevoked: false }) });
  assert.equal(await runAccountCommand('logout', [], offline.value), 0);
  assert.match(offline.out.join('\n'), /this device.*server did not confirm/);
  const none = deps(signedOut);
  assert.equal(await runAccountCommand('logout', [], none.value), 0);
  assert.deepEqual(none.calls, []);
  assert.match(none.out.join('\n'), /Not signed in/);
});

test('whoami checks the session with the service and reflects a revoked one', async () => {
  const live = deps(signedIn);
  assert.equal(await runAccountCommand('whoami', [], live.value), 0);
  assert.deepEqual(live.calls, ['refresh']);
  assert.match(live.out.join('\n'), /ada@example\.com/);

  const revoked = deps(signedIn);
  revoked.value.controls.refresh = async () => void revoked.set(signedOut);
  assert.equal(await runAccountCommand('whoami', [], revoked.value), 1);
  assert.match(revoked.out.join('\n'), /Not signed in/);

  const offline = deps(signedIn, {
    async refresh() {
      throw new Error('OMS account status unavailable.');
    },
  });
  assert.equal(await runAccountCommand('whoami', [], offline.value), 0);
  assert.match(offline.out.join('\n'), /Signed in on this device.*could not be reached/);

  const none = deps(signedOut);
  assert.equal(await runAccountCommand('whoami', [], none.value), 1);
  assert.match(none.out.join('\n'), /Not signed in · oms login/);
});

test('account commands take no options, and server text cannot drive the terminal', async () => {
  const bad = deps(signedOut);
  assert.equal(await runAccountCommand('login', ['--token', 'x'], bad.value), 2);
  assert.deepEqual(bad.calls, []);
  const hostile = deps({ ...signedIn, email: 'a\u001b[2Jb@example.com' });
  await runAccountCommand('whoami', [], hostile.value);
  assert.equal(hostile.out.join('\n').includes('\u001b'), false);
});

test('the real account controls start signed out and prepare only a private folder', async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'oms-account-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateRoot = join(home, '.oms');
  const controls = accountControls(stateRoot, new AbortController().signal);
  assert.equal(controls.snapshot().state, 'signed-out');
  assert.ok(existsSync(join(stateRoot, 'agent')));
});
