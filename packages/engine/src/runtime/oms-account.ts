import { execFile } from 'node:child_process';
import { lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { assertPrivate, isMissing, readPrivateJson, syncDirectory, writePrivateJson } from '../workspace/storage.ts';
import { readInferencePreferences } from './inference-preferences.ts';

export interface AccountInteraction {
  signal?: AbortSignal;
  showDevice(data: { verificationUri: string; userCode: string; expiresAt: number }): void;
  notice(message: string): void;
}
export interface OmsAccountSnapshot {
  state: 'signed-out' | 'signed-in' | 'unavailable';
  email?: string;
  userId?: string;
  expiresAt?: number;
  origin: string;
  message?: string;
}
/** A device session for authenticating requests to the OMS account gateway. */
export interface OmsAccountControls {
  snapshot(): OmsAccountSnapshot;
  login(interaction: AccountInteraction, signal: AbortSignal): Promise<void>;
  logout(signal: AbortSignal): Promise<{ serverRevoked: boolean }>;
  refresh(signal?: AbortSignal): Promise<void>;
  /** Gateway origin and device token, only while signed in. */
  searchCredential(): { origin: string; token: string } | undefined;
}
export interface OmsAccountOptions {
  agentRoot: string;
  signal: AbortSignal;
  withUserOperation: <T>(action: () => Promise<T>) => Promise<T>;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
}
interface AccountCredential {
  origin: string;
  token: string;
  expiresAt: number;
  userId: string;
}
type JsonObject = Record<string, unknown>;
interface AccountResponse {
  ok: boolean;
  status: number;
  data: JsonObject;
}
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid OMS account response.');
  return value as JsonObject;
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}
function positiveInteger(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
}
function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('OMS account operation cancelled.');
}
function readCredential(path: string, origin: string): AccountCredential | undefined {
  try {
    if (lstatSync(path).size > 16 * 1024) throw new Error('Account file too large');
    const data = object(readPrivateJson(path));
    if (
      data.origin !== origin ||
      !text(data.token, 4096) ||
      !/^[\x21-\x7e]+$/.test(data.token) ||
      !text(data.userId, 256) ||
      !positiveInteger(data.expiresAt, Number.MAX_SAFE_INTEGER)
    )
      throw new Error('Invalid credential');
    return { origin, token: data.token, userId: data.userId, expiresAt: data.expiresAt };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error('Cannot read private OMS account credentials.');
  }
}
async function responseJson(response: Response): Promise<JsonObject> {
  if (!response.body) throw new Error('Invalid OMS account response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('OMS account response exceeded its limit.');
      chunks.push(next.value);
    }
    return object(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function openDefaultBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  await promisify(execFile)(command, [url], { timeout: 10_000, maxBuffer: 16 * 1024 });
}
function accountDetails(data: JsonObject): { userId: string; email: string } {
  const user = object(data.user);
  if (!text(user.id, 256) || !text(user.email, 320)) throw new Error('Invalid OMS account response.');
  return { userId: user.id, email: user.email };
}

/** Account credentials stay outside provider auth.json and never select a model or dispatch inference. */
export function createOmsAccountControls(options: OmsAccountOptions): OmsAccountControls {
  try {
    assertPrivate(options.agentRoot, true);
  } catch {
    throw new Error('Cannot access private OMS account directory.');
  }
  const accountPath = join(options.agentRoot, 'oms-account.json');
  const origin = readInferencePreferences(join(options.agentRoot, 'inference.json')).gatewayOrigin;
  let credential = readCredential(accountPath, origin);
  let email: string | undefined;
  let unavailable: string | undefined;
  let loginAbort: AbortController | undefined;
  let loginTask: Promise<void> | undefined;
  let loggingOut = false;
  const transport = options.fetch ?? globalThis.fetch;

  function combined(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([options.signal, signal]) : options.signal;
  }
  async function request(
    path: string,
    signal: AbortSignal,
    body?: JsonObject,
    token?: string,
  ): Promise<AccountResponse> {
    cancelled(signal);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    try {
      const response = await transport(origin + path, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        credentials: 'omit',
        signal: requestSignal,
        headers: {
          accept: 'application/json',
          'cache-control': 'no-store',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400) ||
        (response.url && response.url !== origin + path)
      ) {
        await response.body?.cancel();
        throw new Error('Unexpected account redirect');
      }
      const data = await responseJson(response);
      cancelled(signal);
      return { ok: response.ok, status: response.status, data };
    } catch {
      cancelled(signal);
      throw new Error('OMS account service unavailable.');
    }
  }
  function removeLocalCredential(): void {
    credential = undefined;
    email = undefined;
    unavailable = undefined;
    try {
      assertPrivate(options.agentRoot, true);
      try {
        assertPrivate(accountPath, false);
        unlinkSync(accountPath);
        syncDirectory(options.agentRoot);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    } catch {
      unavailable =
        'Local OMS credential cleanup could not be confirmed. Restart after securing the private account file.';
      throw new Error(unavailable);
    }
  }
  async function performLogin(interaction: AccountInteraction, signal: AbortSignal): Promise<void> {
    cancelled(signal);
    const started = Date.now();
    const grant = await request('/api/auth/device/code', signal, { client_id: 'oms-cli' });
    const data = grant.data;
    if (
      !grant.ok ||
      data.verification_uri !== origin + '/device' ||
      !text(data.device_code, 4096) ||
      !text(data.user_code, 64) ||
      !/^[A-Za-z0-9-]+$/.test(data.user_code) ||
      !positiveInteger(data.expires_in, 600) ||
      !positiveInteger(data.interval, 600)
    )
      throw new Error('Invalid OMS device authorization. Start login again.');
    const expiresAt = started + data.expires_in * 1000;
    let interval = data.interval * 1000;
    const deviceCode = data.device_code;
    interaction.showDevice({ verificationUri: origin + '/device', userCode: data.user_code, expiresAt });
    cancelled(signal);
    try {
      await (options.openBrowser ?? openDefaultBrowser)(origin + '/device');
    } catch {
      interaction.notice('Could not open the browser. Open the displayed verification URL and enter the device code.');
    }
    while (true) {
      cancelled(signal);
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) throw new Error('OMS device authorization expired. Start login again.');
      // When the next poll would be at or past expiry, wait out the grant and stop: a timer that fires a millisecond
      // early must not turn that wait into one more poll.
      const lastWait = interval >= remaining;
      try {
        await delay(lastWait ? remaining : interval, undefined, { signal });
      } catch {
        cancelled(signal);
        throw new Error('OMS device authorization interrupted.');
      }
      cancelled(signal);
      if (lastWait || Date.now() >= expiresAt) throw new Error('OMS device authorization expired. Start login again.');
      const exchangedAt = Date.now();
      let reply: AccountResponse;
      try {
        reply = await request('/api/auth/device/token', signal, {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: 'oms-cli',
        });
      } catch {
        cancelled(signal);
        // The successful exchange consumes the grant; transport failure is never replay-safe.
        throw new Error(
          'OMS device exchange was interrupted. Start a new login; the previous exchange will not be retried.',
        );
      }
      if (!reply.ok) {
        if (reply.data.error === 'authorization_pending') continue;
        if (reply.data.error === 'slow_down') {
          interval += 5000;
          continue;
        }
        if (reply.data.error === 'access_denied') {
          // error_description is untrusted server text: compared with one fixed value, never printed.
          throw new Error(
            reply.data.error_description === 'waitlisted'
              ? `You're on the OMS waitlist. We'll email you as soon as you're in. Have an invite code? Enter it at ${origin}/device, then run /login again.`
              : 'Sign-in was declined in the browser. Run /login to try again.',
          );
        }
        if (reply.data.error === 'expired_token')
          throw new Error('OMS device authorization expired. Start login again.');
        throw new Error('OMS device authorization failed. Start a new login.');
      }
      const token = reply.data.access_token;
      if (
        reply.data.token_type !== 'Bearer' ||
        !text(token, 4096) ||
        !/^[\x21-\x7e]+$/.test(token) ||
        !positiveInteger(reply.data.expires_in, MAX_SESSION_SECONDS)
      )
        throw new Error('Invalid OMS device exchange response. Start a new login.');
      const me = await request('/api/me', signal, undefined, token);
      if (!me.ok) throw new Error('OMS account verification failed. Start a new login.');
      const verified = accountDetails(me.data);
      cancelled(signal);
      const next = { origin, token, expiresAt: exchangedAt + reply.data.expires_in * 1000, userId: verified.userId };
      if (next.expiresAt <= Date.now()) throw new Error('OMS account session expired. Start login again.');
      try {
        writePrivateJson(accountPath, next);
      } catch {
        throw new Error('Cannot save private OMS account credentials.');
      }
      credential = next;
      email = verified.email;
      unavailable = undefined;
      return;
    }
  }

  if (credential && credential.expiresAt <= Date.now()) {
    try {
      removeLocalCredential();
    } catch {
      /* snapshot() reports it */
    }
  }

  return {
    searchCredential() {
      return !unavailable && credential && credential.expiresAt > Date.now()
        ? { origin, token: credential.token }
        : undefined;
    },
    snapshot() {
      if (unavailable) return { origin, state: 'unavailable', message: unavailable };
      if (!credential || credential.expiresAt <= Date.now()) return { origin, state: 'signed-out' };
      return {
        origin,
        state: 'signed-in',
        userId: credential.userId,
        expiresAt: credential.expiresAt,
        ...(email ? { email } : {}),
      };
    },
    login(interaction, signal) {
      if (loginTask || loggingOut) return Promise.reject(new Error('An OMS account operation is already active.'));
      loginAbort = new AbortController();
      const loginSignal = AbortSignal.any([
        combined(signal),
        loginAbort.signal,
        ...(interaction.signal ? [interaction.signal] : []),
      ]);
      loginTask = options
        .withUserOperation(() => performLogin(interaction, loginSignal))
        .finally(() => {
          loginTask = undefined;
          loginAbort = undefined;
        });
      return loginTask;
    },
    async logout(signal) {
      if (loggingOut) throw new Error('An OMS logout is already active.');
      loggingOut = true;
      try {
        loginAbort?.abort();
        await loginTask?.catch(() => {});
        const current = credential;
        let serverRevoked = false;
        try {
          if (current) {
            const result = await request('/api/account/logout', combined(signal), {}, current.token);
            serverRevoked = result.ok && result.data.serverRevoked === true;
          }
        } catch {
          /* Offline logout still clears local access, without claiming server revocation. */
        }
        removeLocalCredential();
        return { serverRevoked };
      } finally {
        loggingOut = false;
      }
    },
    async refresh(signal) {
      const current = credential;
      if (!current) return;
      if (current.expiresAt <= Date.now()) {
        removeLocalCredential();
        return;
      }
      try {
        const reply = await request('/api/me', combined(signal), undefined, current.token);
        if (credential !== current || loggingOut) return;
        if (reply.status === 401 || reply.status === 403) {
          removeLocalCredential();
          return;
        }
        if (!reply.ok) throw new Error('OMS account service unavailable.');
        const verified = accountDetails(reply.data);
        if (verified.userId !== current.userId) throw new Error('OMS account identity did not match.');
        email = verified.email;
        unavailable = undefined;
      } catch {
        if (credential === current && !loggingOut) unavailable = 'OMS account status unavailable.';
        throw new Error('OMS account status unavailable.');
      }
    },
  };
}
