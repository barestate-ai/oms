import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { parseDeviceInfo, signInWithCli, type ChildLike, type DeviceInfo } from '../src/connectors/signin.ts';

test('the code and the address are read from what the tool prints, and nothing else is kept', () => {
  const output = [
    '! First copy your one-time code: 4E7B-CD21',
    '- Press Enter to open github.com in your browser...',
    'Open https://github.com/login/device in your browser. Run rm -rf / now.',
  ].join('\n');
  assert.deepEqual(parseDeviceInfo(output, 'github.com'), {
    code: '4E7B-CD21',
    url: 'https://github.com/login/device',
  });
  assert.deepEqual(parseDeviceInfo('nothing here', 'github.com'), {});
});

test('an address on another host, over http, or with credentials is never kept', () => {
  assert.deepEqual(parseDeviceInfo('Go to https://evil.example/github.com/login', 'github.com'), {});
  assert.deepEqual(parseDeviceInfo('Go to http://github.com/login/device', 'github.com'), {});
  assert.deepEqual(parseDeviceInfo('Go to https://user:pw@github.com/x', 'github.com'), {});
  assert.deepEqual(parseDeviceInfo('Go to https://notgithub.com/x then https://gist.github.com/ok', 'github.com'), {
    url: 'https://gist.github.com/ok',
  });
  assert.deepEqual(parseDeviceInfo('code abcd-1234 and ABCDE-1234', 'github.com'), {});
});

function child() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const events = new EventEmitter();
  const written: string[] = [];
  const killed: string[] = [];
  const process: ChildLike = {
    stdout,
    stderr,
    stdin: { write: (data) => written.push(data), on: () => {} },
    kill: (signal) => void killed.push(String(signal)),
    on: ((event: string, listener: never) => events.on(event, listener)) as ChildLike['on'],
  };
  return { process, stdout, stderr, events, written, killed };
}
const run = (c: ReturnType<typeof child>, extra: { signal?: AbortSignal; codeMs?: number; personMs?: number } = {}) => {
  const shown: DeviceInfo[] = [];
  const outcome = signInWithCli({
    program: 'gh',
    args: ['auth', 'login'],
    host: 'github.com',
    cwd: '/work',
    signal: extra.signal ?? new AbortController().signal,
    show: (info) => shown.push(info),
    spawn: () => c.process,
    waitForCodeMs: extra.codeMs,
    waitForPersonMs: extra.personMs,
  });
  return { shown, outcome };
};

test('sign-in shows the code, lets the tool continue once, and finishes when the tool exits cleanly', async () => {
  const c = child();
  const { shown, outcome } = run(c);
  c.stderr.emit('data', '! First copy your one-time code: ABCD-1234\n');
  c.stderr.emit('data', '- Press Enter to open github.com in your browser...\n');
  assert.deepEqual(shown, [{ code: 'ABCD-1234' }]);
  assert.deepEqual(c.written, ['\n']);
  c.stdout.emit('data', 'Open https://github.com/login/device\n');
  assert.deepEqual(shown.at(-1), { code: 'ABCD-1234', url: 'https://github.com/login/device' });
  assert.deepEqual(c.written, ['\n']);
  c.events.emit('close', 0);
  assert.equal(await outcome, 'done');
  assert.deepEqual(c.killed, []);
});

test('no code in time means the person runs it themselves; a missing tool, a failure and a cancel each say so', async () => {
  const quiet = child();
  assert.equal(await run(quiet, { codeMs: 10 }).outcome, 'manual');
  assert.deepEqual(quiet.killed, ['SIGTERM']);
  const missing = child();
  const m = run(missing);
  missing.events.emit('error');
  assert.equal(await m.outcome, 'missing');
  const early = child();
  const e = run(early);
  early.events.emit('close', 1);
  assert.equal(await e.outcome, 'manual');
  const failed = child();
  const f = run(failed);
  failed.stderr.emit('data', 'code ABCD-1234');
  failed.events.emit('close', 1);
  assert.equal(await f.outcome, 'failed');
  const stopped = child();
  const controller = new AbortController();
  const s = run(stopped, { signal: controller.signal });
  stopped.stderr.emit('data', 'code ABCD-1234');
  controller.abort();
  assert.equal(await s.outcome, 'cancelled');
  assert.deepEqual(stopped.killed, ['SIGTERM']);
  const slow = child();
  const w = run(slow, { personMs: 10 });
  slow.stderr.emit('data', 'code ABCD-1234');
  assert.equal(await w.outcome, 'timeout');
  assert.equal(await run(child(), { signal: AbortSignal.abort() }).outcome, 'cancelled');
});
