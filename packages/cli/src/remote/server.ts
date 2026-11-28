import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import { botFor, botPng, botSvg } from './bot.ts';

export type Role = 'owner' | 'guest';
/** Someone in the session: the terminal that hosts it, a paired device, or a guest. */
export interface Person {
  id: string;
  name: string;
  role: Role;
  /** `oms` is a teammate's own OMS holding a copy of the session; `browser` is a page showing this one live. */
  kind: 'terminal' | 'browser' | 'oms';
  live: boolean;
}
/** One message of a conversation, as one side tells the other in a sync. */
export interface SyncItem {
  who: 'user' | 'agent';
  text: string;
}
export type SyncAnswer = { ok: true; items: SyncItem[] } | { ok: false; reason: string };
/** One row of the conversation as a remote view draws it. Text is already masked and free of terminal sequences. */
export type WireEntry =
  | { key: string; kind: 'user'; text: string }
  | { key: string; kind: 'assistant'; text: string; streaming: boolean; ending?: string }
  | {
      key: string;
      kind: 'tool';
      state: 'pending' | 'running' | 'done' | 'error' | 'interrupted';
      title: string;
      target: string;
      summary: string;
      output: string;
    }
  | { key: string; kind: 'note'; label: string; text: string };
export interface WireApproval {
  id: number;
  title: string;
  reasons: string[];
  command: string;
  /** Whether "for this session" is offered beside "once". */
  session: boolean;
}
export interface WireStatus {
  busy: boolean;
  model: string;
  yolo: boolean;
  approval?: WireApproval;
}
export type ApprovalAnswer = 'once' | 'session' | 'deny';

/** What the session does for the server. Every call comes from a paired device or an admitted guest. */
export interface RemoteHooks {
  snapshot(): { entries: WireEntry[]; status: WireStatus };
  /** Ask at the terminal whether this new device or guest may connect. */
  admit(
    request: { role: Role; name: string; address: string; kind: 'browser' | 'oms' },
    signal: AbortSignal,
  ): Promise<boolean>;
  /** The person's next message to the agent. Returns why not, when it is refused. */
  send(from: Person, text: string): string | undefined;
  cancel(from: Person): void;
  /** False when that question is no longer the one on screen. */
  answer(from: Person, id: number, answer: ApprovalAnswer): boolean;
  /** Someone connected or left. */
  peopleChanged(): void;
  /** The conversation for a teammate's OMS to keep its own copy of. */
  export?(from: Person): unknown;
  /** A teammate's OMS asks to sync and sends what is new on its side. */
  sync?(from: Person, items: unknown): Promise<SyncAnswer>;
}

/** What is kept between runs, so a paired phone and its home-screen app keep working. Device secrets are stored hashed. */
export interface RemoteState {
  port?: number;
  devices: Record<string, { name: string; role: Role; kind?: 'oms' }>;
  /** For each teammate's OMS, the last entry here that it has been told about. */
  synced?: Record<string, string>;
}

export interface RemoteOptions {
  /** The session id: it picks the bot and the port. */
  sessionId: string;
  /** What the page and the home-screen app are called. */
  title: string;
  /** Who the terminal is, for the people list. */
  hostName: string;
  /** False keeps the server on this computer only. */
  network: boolean;
  state: RemoteState;
  save(state: RemoteState): void;
  hooks: RemoteHooks;
  /** Tests pin the port; 0 takes any free one. */
  port?: number;
}

export interface RemoteServer {
  readonly port: number;
  /** Where to open it, best first: this network, other interfaces, this computer. */
  addresses(): { label: string; url: string }[];
  /** The code a new device of the owner types. It changes every time one is used. */
  pairingCode(): string;
  /** The code in a guest's link; undefined until sharing is turned on. */
  inviteCode(): string | undefined;
  setSharing(on: boolean): void;
  people(): Person[];
  entry(entry: WireEntry): void;
  cleared(): void;
  status(status: WireStatus): void;
  /** Ask a live teammate's OMS to sync, handing it what is new here. Resolves once it has answered. */
  requestSync(personId: string, from: string, items: SyncItem[]): Promise<SyncAnswer>;
  /** Forget every paired device and guest, and disconnect them. */
  forget(): void;
  close(): Promise<void>;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const newCode = (length: number): string =>
  Array.from({ length }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const normalizeCode = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 64)
    : '';
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const sameCode = (given: string, expected: string | undefined): boolean =>
  !!expected && !!given && timingSafeEqual(digest(given), digest(expected));

const BODY_LIMIT = 64 * 1024;
const SYNC_BODY_LIMIT = 1024 * 1024;
const SYNC_WAIT_MS = 120_000;
const MESSAGE_LIMIT = 32_000;
/** Wrong codes allowed per minute, over every address together: a short code cannot be guessed at this pace. */
const WRONG_CODES_PER_MINUTE = 10;
const HELLO_WAIT_MS = 25_000;
const ENTRY_FLUSH_MS = 100;
/** A view this far behind is dropped; it reconnects and gets a fresh snapshot. */
const STREAM_BACKLOG = 4 * 1024 * 1024;

const WEB = (name: string): Buffer => readFileSync(new URL(`./web/${name}`, import.meta.url));

function deviceLabel(agent: string | undefined): string {
  const text = agent ?? '';
  const device = /iPhone/.test(text)
    ? 'iPhone'
    : /iPad/.test(text)
      ? 'iPad'
      : /Android/.test(text)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(text)
          ? 'Mac'
          : /Windows/.test(text)
            ? 'Windows'
            : /Linux/.test(text)
              ? 'Linux'
              : 'Device';
  const browser = /Edg\//.test(text)
    ? 'Edge'
    : /Firefox\//.test(text)
      ? 'Firefox'
      : /Chrome\/|CriOS\//.test(text)
        ? 'Chrome'
        : /Safari\//.test(text)
          ? 'Safari'
          : '';
  return browser ? `${device} · ${browser}` : device;
}

/** A name someone typed, as one short printable line. */
const cleanName = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .replace(/[^\p{L}\p{N} ._-]/gu, '')
        .trim()
        .slice(0, 24)
    : '';

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A port that stays the same for a session, so the installed home-screen app still finds it after a restart. */
const preferredPort = (sessionId: string): number => 47000 + (digest(sessionId).readUInt16BE(0) % 1000);

function listen(server: Server, host: string, ports: number[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (index: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && index + 1 < ports.length) attempt(index + 1);
        else reject(error);
      };
      server.once('error', onError);
      server.listen(ports[index]!, host, () => {
        server.off('error', onError);
        resolve((server.address() as { port: number }).port);
      });
    };
    attempt(0);
  });
}

/**
 * The remote view of one session: a small web app, an event stream for it, and the few things it may ask for. The pages are
 * public and say nothing but the session's name; everything else needs a device that was paired with a code and allowed at
 * the terminal.
 */
export async function startRemoteServer(options: RemoteOptions): Promise<RemoteServer> {
  const { hooks, state } = options;
  const bot = botFor(options.sessionId);
  const icons = new Map<number, Buffer>();
  const icon = (size: number): Buffer => icons.get(size) ?? icons.set(size, botPng(bot, size)).get(size)!;
  const title = escapeHtml(options.title);
  const shell = WEB('index.html').toString('utf8').replaceAll('{{title}}', title).replaceAll('{{bot}}', botSvg(bot));
  const manifest = JSON.stringify({
    name: `${options.title} · OMS`,
    short_name: options.title.slice(0, 12),
    id: `/?session=${options.sessionId}`,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#15120F',
    theme_color: '#15120F',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
  const assets: Record<string, () => [type: string, body: Buffer | string]> = {
    '/': () => ['text/html; charset=utf-8', shell],
    '/app.js': () => ['text/javascript; charset=utf-8', WEB('app.js')],
    '/app.css': () => ['text/css; charset=utf-8', WEB('app.css')],
    '/sw.js': () => ['text/javascript; charset=utf-8', 'self.addEventListener("fetch", () => {});\n'],
    '/manifest.webmanifest': () => ['application/manifest+json', manifest],
    '/icon.svg': () => ['image/svg+xml', botSvg(bot, true)],
    '/icon-180.png': () => ['image/png', icon(180)],
    '/icon-192.png': () => ['image/png', icon(192)],
    '/icon-512.png': () => ['image/png', icon(512)],
  };

  let pairing = newCode(8);
  let invite: string | undefined;
  let wrongCodes: number[] = [];
  let closed = false;
  let lastStatus = hooks.snapshot().status;
  const closing = new AbortController();
  const admissions = new Map<string, Promise<boolean>>();
  const streams = new Set<{ id: string; role: Role; oms: boolean; res: ServerResponse }>();
  const syncs = new Map<number, { id: string; settle(answer: SyncAnswer): void }>();
  let nextSync = 1;
  const pending = new Map<string, WireEntry>();
  let flushTimer: NodeJS.Timeout | undefined;

  const terminal: Person = { id: 'terminal', name: options.hostName, role: 'owner', kind: 'terminal', live: true };
  const person = (id: string): Person => ({
    id: id.slice(0, 12),
    name: state.devices[id]!.name,
    role: state.devices[id]!.role,
    kind: state.devices[id]!.kind ?? 'browser',
    live: [...streams].some((stream) => stream.id === id),
  });
  const people = (): Person[] => [terminal, ...Object.keys(state.devices).map(person)];
  const statusFor = (role: Role, status: WireStatus) =>
    role === 'owner'
      ? status
      : { busy: status.busy, model: status.model, yolo: status.yolo, waiting: !!status.approval };

  function write(stream: { res: ServerResponse }, event: string, data: unknown): void {
    if (stream.res.writableLength > STREAM_BACKLOG) return void stream.res.destroy();
    stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  /** A teammate's OMS has its own copy of the conversation: it hears who is here, not every row. */
  const broadcast = (event: string, data: (role: Role) => unknown, toOms = false): void => {
    for (const stream of streams) if (toOms || !stream.oms) write(stream, event, data(stream.role));
  };
  const announcePeople = (): void => {
    const list = people();
    broadcast('people', () => list, true);
    hooks.peopleChanged();
  };

  function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': type,
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(payload);
  }

  async function body(req: IncomingMessage, limit = BODY_LIMIT): Promise<Record<string, unknown>> {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new Error('json');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) throw new Error('large');
      chunks.push(chunk);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('json');
    return value as Record<string, unknown>;
  }

  /** The paired device behind a request, from its secret. */
  function caller(req: IncomingMessage): string | undefined {
    const secret = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(req.headers.authorization ?? '')?.[1];
    const id = secret && digest(secret).toString('hex');
    return id && state.devices[id] ? id : undefined;
  }

  async function hello(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const input = await body(req);
    const secret = typeof input.client === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(input.client) ? input.client : '';
    if (!secret) return send(res, 400, { error: 'client' });
    const id = digest(secret).toString('hex');
    const welcome = () => send(res, 200, { role: state.devices[id]!.role, name: state.devices[id]!.name });
    if (state.devices[id]) return welcome();
    let admission = admissions.get(id);
    if (!admission) {
      const now = Date.now();
      wrongCodes = wrongCodes.filter((at) => now - at < 60_000);
      if (wrongCodes.length >= WRONG_CODES_PER_MINUTE) return send(res, 429, { error: 'slow' });
      const code = normalizeCode(input.code);
      const role: Role | undefined = sameCode(code, pairing) ? 'owner' : sameCode(code, invite) ? 'guest' : undefined;
      if (!role) {
        if (code) wrongCodes.push(now);
        return send(res, 401, { error: 'code' });
      }
      if (admissions.size >= 3) return send(res, 429, { error: 'slow' });
      const kind = input.kind === 'oms' ? 'oms' : 'browser';
      const name =
        role === 'owner' && kind === 'browser'
          ? deviceLabel(req.headers['user-agent'])
          : cleanName(input.name) || 'guest';
      const address = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
      admission = hooks
        .admit({ role, name, address, kind }, closing.signal)
        .catch(() => false)
        .then((allowed) => {
          admissions.delete(id);
          if (!allowed || closed) return false;
          state.devices[id] = { name, role, ...(kind === 'oms' ? { kind } : {}) };
          // A used code is spent: a photo of the screen does not pair a second device.
          if (role === 'owner') pairing = newCode(8);
          options.save(state);
          return true;
        });
      admissions.set(id, admission);
    }
    const allowed = await Promise.race([
      admission,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), HELLO_WAIT_MS).unref()),
    ]);
    if (allowed === undefined) return send(res, 202, { pending: true });
    if (allowed) return welcome();
    send(res, 403, { error: 'denied' });
  }

  function events(req: IncomingMessage, res: ServerResponse, id: string): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    const role = state.devices[id]!.role;
    const stream = { id, role, oms: state.devices[id]!.kind === 'oms', res };
    const { entries, status } = hooks.snapshot();
    lastStatus = status;
    write(stream, 'state', {
      session: { title: options.title },
      me: { id: id.slice(0, 12), ...state.devices[id]! },
      entries: stream.oms ? [] : entries,
      status: statusFor(role, status),
    });
    streams.add(stream);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    ping.unref();
    req.on('close', () => {
      clearInterval(ping);
      streams.delete(stream);
      // A sync it was asked for can no longer be answered.
      if (stream.oms && ![...streams].some((other) => other.id === id))
        for (const [key, waiting] of syncs)
          if (waiting.id === id) {
            syncs.delete(key);
            waiting.settle({ ok: false, reason: 'They went offline before answering.' });
          }
      if (!closed) announcePeople();
    });
    announcePeople();
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://oms.local').pathname;
    // A page on another site may not post here, whatever it knows.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'origin' });
    if (req.method === 'GET' && assets[path]) {
      const [type, content] = assets[path]();
      return send(res, 200, content, type);
    }
    if (req.method === 'POST' && path === '/api/hello') return hello(req, res);
    if (!path.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    const id = caller(req);
    if (!id) return send(res, 401, { error: 'pair' });
    const from = person(id);
    // A guest is let in only while the host is sharing; one from an earlier run waits until /share is on again.
    if (from.role === 'guest' && !invite) return send(res, 403, { error: 'This session is not shared right now.' });
    if (req.method === 'GET' && path === '/api/events') return events(req, res, id);
    if (from.kind === 'oms') {
      if (req.method === 'GET' && path === '/api/export' && hooks.export) return send(res, 200, hooks.export(from));
      if (req.method === 'POST' && path === '/api/sync' && hooks.sync)
        return send(res, 200, await hooks.sync(from, (await body(req, SYNC_BODY_LIMIT)).items));
      if (req.method === 'POST' && path === '/api/sync-reply') {
        const reply = await body(req, SYNC_BODY_LIMIT);
        const waiting = typeof reply.id === 'number' ? syncs.get(reply.id) : undefined;
        if (!waiting || waiting.id !== id) return send(res, 409, { error: 'That sync is over.' });
        syncs.delete(reply.id as number);
        waiting.settle(
          reply.ok === true && Array.isArray(reply.items)
            ? { ok: true, items: reply.items as SyncItem[] }
            : { ok: false, reason: 'They said no.' },
        );
        return send(res, 200, { ok: true });
      }
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const input = await body(req);
    if (path === '/api/send') {
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > MESSAGE_LIMIT) return send(res, 400, { error: 'Write a message first.' });
      const refused = hooks.send(from, text);
      return refused ? send(res, 409, { error: refused }) : send(res, 200, { ok: true });
    }
    // Stopping work and answering approvals stay with the owner's own devices.
    if (from.role !== 'owner') return send(res, 403, { error: 'Only the host can do that.' });
    if (path === '/api/cancel') {
      hooks.cancel(from);
      return send(res, 200, { ok: true });
    }
    if (path === '/api/approval') {
      const answer = input.answer;
      if (typeof input.id !== 'number' || (answer !== 'once' && answer !== 'session' && answer !== 'deny'))
        return send(res, 400, { error: 'answer' });
      return send(res, hooks.answer(from, input.id, answer) ? 200 : 409, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else send(res, 400, { error: 'bad request' });
    });
  });
  const wanted = options.port ?? state.port ?? preferredPort(options.sessionId);
  const port = await listen(
    server,
    options.network ? '0.0.0.0' : '127.0.0.1',
    wanted === 0 ? [0] : [wanted, ...Array.from({ length: 10 }, (_, index) => wanted + index + 1), 0],
  );
  if (state.port !== port) {
    state.port = port;
    options.save(state);
  }

  function disconnect(keep: (id: string) => boolean): void {
    for (const stream of [...streams]) if (!keep(stream.id)) stream.res.destroy();
  }

  return {
    port,
    addresses() {
      const local = { label: 'This computer', url: `http://127.0.0.1:${port}` };
      if (!options.network) return [local];
      const found: { label: string; url: string }[] = [];
      for (const list of Object.values(networkInterfaces()))
        for (const net of list ?? []) {
          if (net.family !== 'IPv4' || net.internal) continue;
          // 100.64.0.0/10 is what Tailscale hands out.
          const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(net.address);
          found.push({ label: tailscale ? 'Tailscale' : 'This network', url: `http://${net.address}:${port}` });
        }
      found.sort((a, b) => Number(a.label === 'Tailscale') - Number(b.label === 'Tailscale'));
      const name = hostname();
      if (name.endsWith('.local')) found.push({ label: 'By name', url: `http://${name.toLowerCase()}:${port}` });
      return [...found, local];
    },
    pairingCode: () => `${pairing.slice(0, 4)}-${pairing.slice(4)}`,
    inviteCode: () => invite,
    setSharing(on) {
      invite = on ? (invite ?? newCode(20)) : undefined;
      if (on) return;
      // Guests leave with the invitation.
      for (const [id, device] of Object.entries(state.devices)) if (device.role === 'guest') delete state.devices[id];
      options.save(state);
      disconnect((id) => !!state.devices[id]);
      announcePeople();
    },
    people,
    entry(entry) {
      pending.set(entry.key, entry);
      // ponytail: a streaming reply is sent whole on every flush; send only its new text if long replies get heavy.
      flushTimer ??= setTimeout(() => {
        flushTimer = undefined;
        for (const item of pending.values()) broadcast('entry', () => item);
        pending.clear();
      }, ENTRY_FLUSH_MS);
    },
    cleared() {
      pending.clear();
      broadcast('clear', () => ({}));
    },
    status(status) {
      lastStatus = status;
      broadcast('status', (role) => statusFor(role, lastStatus));
    },
    requestSync(personId, from, items) {
      const target = [...streams].find((stream) => stream.oms && stream.id.startsWith(personId));
      if (!target) return Promise.resolve({ ok: false, reason: 'They went offline.' });
      return new Promise<SyncAnswer>((resolve) => {
        const key = nextSync++;
        const timer = setTimeout(() => {
          syncs.delete(key);
          resolve({ ok: false, reason: 'They did not answer in time.' });
        }, SYNC_WAIT_MS);
        timer.unref();
        syncs.set(key, {
          id: target.id,
          settle(answer) {
            clearTimeout(timer);
            resolve(answer);
          },
        });
        write(target, 'sync', { id: key, from, items });
      });
    },
    forget() {
      state.devices = {};
      delete state.synced;
      options.save(state);
      pairing = newCode(8);
      disconnect(() => false);
      announcePeople();
    },
    async close() {
      if (closed) return;
      closed = true;
      closing.abort();
      clearTimeout(flushTimer);
      for (const waiting of syncs.values()) waiting.settle({ ok: false, reason: 'Sharing was turned off.' });
      syncs.clear();
      disconnect(() => false);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
