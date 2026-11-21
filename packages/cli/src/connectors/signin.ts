import { spawn as nodeSpawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';

/** What a command-line tool's browser sign-in asks the person to do. Only values that pass the checks below are ever kept. */
export interface DeviceInfo {
  /** The https page to open. */
  url?: string;
  /** The one-time code to enter there, like ABCD-1234. */
  code?: string;
}

const CODE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const URL_TEXT = /https:\/\/[^\s'"<>)]+/g;

/** The code and the address from what the tool printed. The address must be https on the expected host; nothing else is kept. */
export function parseDeviceInfo(output: string, host: string): DeviceInfo {
  const info: DeviceInfo = {};
  const code = CODE.exec(output)?.[1];
  if (code) info.code = code;
  for (const candidate of output.match(URL_TEXT) ?? []) {
    try {
      const url = new URL(candidate);
      if (url.username || url.password) continue;
      if (url.hostname === host || url.hostname.endsWith(`.${host}`)) {
        info.url = url.href;
        break;
      }
    } catch {
      // Not an address.
    }
  }
  return info;
}

export interface ChildLike {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  stdin: { write(data: string): unknown; on(event: 'error', listener: () => void): unknown } | null;
  kill(signal?: NodeJS.Signals): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: () => void): unknown;
}
export type SpawnLike = (
  file: string,
  args: string[],
  options: { cwd?: string; stdio: ['pipe', 'pipe', 'pipe']; env?: NodeJS.ProcessEnv },
) => ChildLike;

/**
 * done: signed in. cancelled: the person stopped it. manual: it did not print a code or address in time, so the
 * person runs the command themselves. missing: the program is not installed. failed: it exited without signing in.
 */
export type SignInOutcome = 'done' | 'cancelled' | 'manual' | 'missing' | 'failed' | 'timeout';

const WAIT_FOR_CODE_MS = 20_000;
const WAIT_FOR_PERSON_MS = 5 * 60_000;

/**
 * Run `<program> auth login --web` on the host and hand its code and address to `show`. The tool opens the browser itself
 * once it is told to continue; its credentials go to its own store, never to OMS. Escape (the signal) stops it.
 */
export function signInWithCli(options: {
  program: string;
  args: string[];
  host: string;
  cwd: string;
  signal: AbortSignal;
  show(info: DeviceInfo): void;
  spawn?: SpawnLike;
  env?: NodeJS.ProcessEnv;
  waitForCodeMs?: number;
  waitForPersonMs?: number;
}): Promise<SignInOutcome> {
  return new Promise((resolve) => {
    if (options.signal.aborted) return resolve('cancelled');
    const child = (options.spawn ?? (nodeSpawn as unknown as SpawnLike))(options.program, options.args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(options.env ?? process.env), NO_COLOR: '1', GH_PROMPT_DISABLED: '' },
    });
    let seen = '';
    let last = '';
    let continued = false;
    let finished = false;
    const finish = (outcome: SignInOutcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(noCode);
      clearTimeout(overall);
      options.signal.removeEventListener('abort', onAbort);
      if (outcome !== 'done' && outcome !== 'failed') child.kill('SIGTERM');
      resolve(outcome);
    };
    const onAbort = () => finish('cancelled');
    const noCode = setTimeout(() => finish('manual'), options.waitForCodeMs ?? WAIT_FOR_CODE_MS);
    const overall = setTimeout(() => finish('timeout'), options.waitForPersonMs ?? WAIT_FOR_PERSON_MS);
    options.signal.addEventListener('abort', onAbort, { once: true });
    child.stdin?.on('error', () => {});
    const onData = (chunk: unknown) => {
      seen = (seen + String(chunk)).slice(-4000);
      const info = parseDeviceInfo(seen, options.host);
      if (!info.code && !info.url) return;
      clearTimeout(noCode);
      if (JSON.stringify(info) !== last) {
        last = JSON.stringify(info);
        options.show(info);
      }
      // gh waits for Enter before it opens the browser.
      if (info.code && !continued) {
        continued = true;
        child.stdin?.write('\n');
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', () => finish('missing'));
    child.on('close', (code) => finish(code === 0 ? 'done' : last ? 'failed' : 'manual'));
  });
}
