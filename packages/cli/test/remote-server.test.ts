import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { botFor, botPng, botSvg } from '../src/remote/bot.ts';
import {
  startRemoteServer,
  type Person,
  type RemoteHooks,
  type RemoteState,
  type WireEntry,
  type WireStatus,
} from '../src/remote/server.ts';

const SECRET = (name: string) => name.padEnd(40, 'x');

async function setup(t: TestContext, overrides: Partial<RemoteHooks> = {}) {
  const sent: [Person, string][] = [];
  const asked: { role: string; name: string }[] = [];
  const saved: RemoteState[] = [];
  let status: WireStatus = { busy: false, model: 'test-model', yolo: false };
  const entries: WireEntry[] = [{ key: 'a', kind: 'user', text: 'hello' }];
  const answers: [number, string][] = [];
  let cancels = 0;
  const server = await startRemoteServer({
    sessionId: 'session-under-test',
    title: 'rental <ledger>',
    hostName: 'vivek',
    network: false,
    port: 0,
    state: { devices: {} },
    save: (state) => saved.push(structuredClone(state)),
    hooks: {
      snapshot: () => ({ entries, status }),
      async admit(request) {
        asked.push(request);
        return true;
      },
      send(from, text) {
        sent.push([from, text]);
        return text === 'busy' ? 'Still working.' : undefined;
      },
      cancel: () => void cancels++,
      answer(_from, id, answer) {
        answers.push([id, answer]);
        return id === 7;
      },
      peopleChanged() {},
      ...overrides,
    },
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown, secret?: string, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const pair = (name: string, code = server.pairingCode()) => post('/api/hello', { client: SECRET(name), code, name });
  /** Opens the event stream and returns a reader of its events, in order. */
  async function listen(name: string) {
    const abort = new AbortController();
    t.after(() => abort.abort());
    const response = await fetch(base + '/api/events', {
      headers: { authorization: `Bearer ${SECRET(name)}` },
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return {
      close: () => abort.abort(),
      async next(): Promise<{ event: string; data: any }> {
        for (;;) {
          const cut = buffer.indexOf('\n\n');
          if (cut >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            if (event) return { event, data: JSON.parse(/^data: (.*)$/m.exec(block)![1]!) };
            continue;
          }
          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended');
          buffer += decoder.decode(value, { stream: true });
        }
      },
      async until(event: string) {
        for (;;) {
          const found = await this.next();
          if (found.event === event) return found.data;
        }
      },
    };
  }
  return {
    server,
    base,
    post,
    pair,
    listen,
    sent,
    asked,
    saved,
    answers,
    entries,
    cancels: () => cancels,
    setStatus: (next: WireStatus) => (status = next),
  };
}

test('the pages are public and say nothing but the name; everything else needs a paired device', async (t) => {
  const f = await setup(t);
  const page = await fetch(f.base + '/');
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<title>rental &lt;ledger&gt; · OMS<\/title>/);
  assert.doesNotMatch(html, /hello|\{\{/);
  assert.match(page.headers.get('content-security-policy')!, /default-src 'none'; script-src 'self'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const manifest = (await (await fetch(f.base + '/manifest.webmanifest')).json()) as Record<string, unknown>;
  assert.equal(manifest.name, 'rental <ledger> · OMS');
  assert.equal(manifest.display, 'standalone');
  const png = Buffer.from(await (await fetch(f.base + '/icon-180.png')).arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 180);
  assert.match(await (await fetch(f.base + '/icon.svg')).text(), /^<svg /);
  for (const asset of ['/app.js', '/app.css', '/sw.js']) assert.equal((await fetch(f.base + asset)).status, 200, asset);

  assert.equal((await fetch(f.base + '/api/events')).status, 401);
  assert.equal((await f.post('/api/send', { text: 'hi' })).status, 401);
  assert.equal((await f.post('/api/send', { text: 'hi' }, SECRET('stranger'))).status, 401);
  assert.equal((await fetch(f.base + '/nope')).status, 404);
  assert.equal(f.sent.length, 0);
});

test('a device pairs with the code once the terminal allows it, and the code is then spent', async (t) => {
  const f = await setup(t);
  assert.equal((await f.post('/api/hello', { client: SECRET('phone') })).status, 401, 'no code');
  assert.equal((await f.pair('phone', 'AAAA-AAAA')).status, 401, 'wrong code');
  assert.equal(f.asked.length, 0, 'a wrong code never reaches the terminal');
  const code = f.server.pairingCode();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const paired = await f.pair('phone', code.toLowerCase().replace('-', ' '));
  assert.equal(paired.status, 200);
  assert.equal(((await paired.json()) as { role: string }).role, 'owner');
  assert.deepEqual(
    f.asked.map(({ role }) => role),
    ['owner'],
  );
  assert.notEqual(f.server.pairingCode(), code);
  assert.equal((await f.pair('tablet', code)).status, 401, 'the used code pairs nothing else');
  // The stored state holds a hash, never the device's secret.
  const stored = JSON.stringify(f.saved.at(-1));
  assert.match(stored, /"role":"owner"/);
  assert.equal(stored.includes(SECRET('phone')), false);
  assert.equal((await f.post('/api/hello', { client: SECRET('phone') })).status, 200, 'paired devices need no code');
});

test('a device the terminal refuses stays out', async (t) => {
  const f = await setup(t, { admit: async () => false });
  assert.equal((await f.pair('phone')).status, 403);
  assert.equal(
    (await fetch(f.base + '/api/events', { headers: { authorization: `Bearer ${SECRET('phone')}` } })).status,
    401,
  );
});

test('guessing codes is cut off', async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.pair(`guess${i}`, 'ZZZZ-ZZZ' + ((i % 8) + 2))).status, 401);
  assert.equal((await f.pair('late')).status, 429, 'even the right code waits out the minute');
  assert.equal(f.asked.length, 0);
});

test('a paired device sees the conversation live, sends messages, stops work and answers approvals', async (t) => {
  const f = await setup(t);
  await f.pair('phone');
  const stream = await f.listen('phone');
  const state = await stream.until('state');
  assert.deepEqual(state.entries, [{ key: 'a', kind: 'user', text: 'hello' }]);
  assert.equal(state.me.role, 'owner');
  assert.deepEqual(
    (await stream.until('people')).map((person: Person) => [person.name, person.kind, person.live]),
    [
      ['vivek', 'terminal', true],
      ['Device', 'browser', true],
    ],
  );
  f.server.entry({ key: 'b', kind: 'assistant', text: 'Hi', streaming: true });
  f.server.entry({ key: 'b', kind: 'assistant', text: 'Hi there', streaming: false });
  assert.deepEqual(await stream.until('entry'), { key: 'b', kind: 'assistant', text: 'Hi there', streaming: false });
  f.server.status({
    busy: true,
    model: 'm',
    yolo: false,
    approval: { id: 7, title: 'Allow host command?', reasons: ['network'], command: 'curl x', session: true },
  });
  assert.equal((await stream.until('status')).approval.command, 'curl x');
  f.server.cleared();
  await stream.until('clear');

  assert.equal((await f.post('/api/send', { text: ' fix it ' }, SECRET('phone'))).status, 200);
  assert.equal(f.sent[0]![1], 'fix it');
  assert.equal(f.sent[0]![0].role, 'owner');
  const refused = await f.post('/api/send', { text: 'busy' }, SECRET('phone'));
  assert.deepEqual([refused.status, ((await refused.json()) as { error: string }).error], [409, 'Still working.']);
  assert.equal((await f.post('/api/send', { text: '  ' }, SECRET('phone'))).status, 400);
  assert.equal((await f.post('/api/cancel', {}, SECRET('phone'))).status, 200);
  assert.equal(f.cancels(), 1);
  assert.equal((await f.post('/api/approval', { id: 7, answer: 'once' }, SECRET('phone'))).status, 200);
  assert.equal((await f.post('/api/approval', { id: 8, answer: 'deny' }, SECRET('phone'))).status, 409, 'a stale card');
  assert.equal((await f.post('/api/approval', { id: 7, answer: 'yes' }, SECRET('phone'))).status, 400);
  assert.deepEqual(f.answers, [
    [7, 'once'],
    [8, 'deny'],
  ]);
});

test('a page on another site cannot post here', async (t) => {
  const f = await setup(t);
  await f.pair('phone');
  const crossSite = await f.post('/api/send', { text: 'hi' }, SECRET('phone'), { origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
  const plain = await fetch(f.base + '/api/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET('phone')}`, 'content-type': 'text/plain' },
    body: '{"text":"hi"}',
  });
  assert.equal(plain.status, 400);
  assert.equal(f.sent.length, 0);
});

test('a guest joins by invitation, can talk, and can neither stop work nor see or answer approvals', async (t) => {
  const f = await setup(t);
  assert.equal(f.server.inviteCode(), undefined);
  f.server.setSharing(true);
  const invite = f.server.inviteCode()!;
  assert.equal(invite.length, 20);
  const joined = await f.post('/api/hello', { client: SECRET('akshat'), code: invite, name: 'akshat <b>' });
  assert.deepEqual([joined.status, await joined.json()], [200, { role: 'guest', name: 'akshat b' }]);
  assert.equal(f.server.inviteCode(), invite, 'an invitation is for more than one guest');
  f.setStatus({
    busy: false,
    model: 'm',
    yolo: false,
    approval: { id: 7, title: 'Allow host command?', reasons: [], command: 'rm -rf build', session: false },
  });
  const stream = await f.listen('akshat');
  const state = await stream.until('state');
  assert.deepEqual(state.status, { busy: false, model: 'm', yolo: false, waiting: true });
  assert.equal(JSON.stringify(state).includes('rm -rf'), false);
  assert.equal((await f.post('/api/send', { text: 'try the other parser' }, SECRET('akshat'))).status, 200);
  assert.deepEqual([f.sent[0]![0].name, f.sent[0]![0].role], ['akshat b', 'guest']);
  assert.equal((await f.post('/api/cancel', {}, SECRET('akshat'))).status, 403);
  assert.equal((await f.post('/api/approval', { id: 7, answer: 'once' }, SECRET('akshat'))).status, 403);
  assert.equal(f.answers.length, 0);

  f.server.setSharing(false);
  await assert.rejects(stream.until('never'), 'the guest is disconnected');
  assert.equal((await f.post('/api/send', { text: 'still here?' }, SECRET('akshat'))).status, 401);
  assert.equal((await f.post('/api/hello', { client: SECRET('late'), code: invite, name: 'x' })).status, 401);
});

test('a guest from an earlier run waits until the host shares again', async (t) => {
  const f = await setup(t);
  f.server.setSharing(true);
  await f.post('/api/hello', { client: SECRET('akshat'), code: f.server.inviteCode(), name: 'akshat' });
  // What a restart leaves behind: the guest is known, and sharing is off until the host turns it on.
  const state = f.saved.at(-1)!;
  const later = await startRemoteServer({
    sessionId: 'session-under-test',
    title: 't',
    hostName: 'vivek',
    network: false,
    port: 0,
    state,
    save() {},
    hooks: {
      snapshot: () => ({ entries: f.entries, status: { busy: false, model: '', yolo: false } }),
      admit: async () => false,
      send: () => undefined,
      cancel() {},
      answer: () => false,
      peopleChanged() {},
    },
  });
  t.after(() => later.close());
  const events = () =>
    fetch(`http://127.0.0.1:${later.port}/api/events`, { headers: { authorization: `Bearer ${SECRET('akshat')}` } });
  assert.equal((await events()).status, 403);
  later.setSharing(true);
  const open = await events();
  assert.equal(open.status, 200);
  await open.body!.cancel();
});

test('forgetting unpairs every device at once', async (t) => {
  const f = await setup(t);
  await f.pair('phone');
  const stream = await f.listen('phone');
  await stream.until('state');
  f.server.forget();
  await assert.rejects(stream.until('never'));
  assert.equal((await f.post('/api/hello', { client: SECRET('phone') })).status, 401);
});

test('a session always gets the same bot, and different sessions get different ones', () => {
  assert.deepEqual(botFor('one'), botFor('one'));
  const looks = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(botFor(`session-${i}`))));
  assert.ok(looks.size > 25, `${looks.size} distinct bots in 40`);
  const bot = botFor('one');
  assert.match(botSvg(bot), /class="bot"[\s\S]*class="whole"[\s\S]*class="eyes"[\s\S]*class="lids"/);
  const png = botPng(bot, 64);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [64, 64]);
});
