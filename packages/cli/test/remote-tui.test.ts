import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatFixture, start } from '../test-support/fake-session.ts';

const SECRET = 'phone'.padEnd(40, 'x');
const AUTH = { authorization: `Bearer ${SECRET}` };
const json = { 'content-type': 'application/json' };

test('/remote opens the session to a device that pairs with the code and is allowed in the terminal', async () => {
  const f = chatFixture();
  f.messages.push({ role: 'user', content: 'earlier question' });
  const { terminal, close } = start(f.harness, 110, 44);
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('/remote local');
    terminal.send('\r');
    const shown = await terminal.until((s) => s.includes('Remote access is on') && /Code\s+\S{4}-\S{4}/.test(s));
    const base = /http:\/\/127\.0\.0\.1:\d+/.exec(shown)![0];
    const code = /Code\s+(\S{4}-\S{4})/.exec(shown)![1]!;
    assert.match(shown, /Only this computer can reach it/);
    assert.match(shown, /remote(?! ·)/, 'the status row says remote access is on');

    // Pairing waits for the person at the terminal.
    const hello = fetch(`${base}/api/hello`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ client: SECRET, code }),
    });
    await terminal.until((s) => s.includes('Let this device control the session?'));
    assert.equal((await fetch(`${base}/api/events`, { headers: AUTH })).status, 401, 'not before the answer');
    terminal.send('y');
    assert.equal((await hello).status, 200);

    const abort = new AbortController();
    const stream = await fetch(`${base}/api/events`, { headers: AUTH, signal: abort.signal });
    const reader = stream.body!.getReader();
    let seen = '';
    const read = async (wanted: RegExp) => {
      while (!wanted.test(seen)) seen += new TextDecoder().decode((await reader.read()).value);
    };
    await read(/event: state\n.*earlier question/);
    assert.equal(/Remote access is on|Code\s+\S{4}-\S{4}/.test(seen), false, 'the pairing code stays at the terminal');
    await terminal.until((s) => s.includes('remote · 1'));

    const send = (text: string) =>
      fetch(`${base}/api/send`, { method: 'POST', headers: { ...AUTH, ...json }, body: JSON.stringify({ text }) });
    assert.equal((await send('ship it')).status, 200);
    await terminal.until(() => f.prompts.length === 1);
    assert.deepEqual(f.prompts, ['ship it']);
    await read(/event: status\ndata: \{"busy":true/);
    const second = await send('and this');
    assert.deepEqual(
      [second.status, ((await second.json()) as { error: string }).error],
      [409, 'Still working. Wait for it to finish, or stop it.'],
    );
    assert.equal(
      (await fetch(`${base}/api/cancel`, { method: 'POST', headers: { ...AUTH, ...json }, body: '{}' })).status,
      200,
    );
    await terminal.until(() => f.abortRequested());
    f.abortGate.resolve();
    f.promptGate.resolve();
    await read(/event: status\ndata: \{"busy":false/);

    terminal.send('/remote stop');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Remote access is off'));
    await assert.rejects(fetch(`${base}/`), 'nothing listens once it is off');
    abort.abort();
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await close();
  }
});

test('/remote refuses an argument it does not know, and closing the interface closes the server', async () => {
  const f = chatFixture();
  const { terminal, close } = start(f.harness, 110, 44);
  let base = '';
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('/remote everywhere');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Usage: /remote [stop|local|tunnel|forget]'));
    terminal.send('/remote local');
    terminal.send('\r');
    base = /http:\/\/127\.0\.0\.1:\d+/.exec(await terminal.until((s) => s.includes('Remote access is on')))![0];
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally {
    await close();
  }
  await assert.rejects(fetch(`${base}/`));
});
