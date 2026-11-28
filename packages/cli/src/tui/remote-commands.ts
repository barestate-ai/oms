import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { OmsSession } from '@oms/engine';
import { APPROVAL_TEXT_LIMIT, type ShownApproval } from '../connectors/approvals.ts';
import {
  startRemoteServer,
  type Person,
  type RemoteServer,
  type RemoteState,
  type SyncAnswer,
  type SyncItem,
  type WireEntry,
  type WireStatus,
} from '../remote/server.ts';
import {
  cleanItems,
  collectItems,
  createPeerLink,
  exportEntries,
  readShare,
  SHARE_NOTE_TYPE,
  syncNote,
  writeShare,
  type PeerLink,
} from '../remote/share.ts';
import type { SyncTool } from '../remote/sync-tool.ts';
import { describe, outcome } from './display-tools.ts';
import { sessionLabel } from './inspect-commands.ts';
import { refuse, type Prepared } from './prepared.ts';
import { shortModelName, type StatusChip } from './status-row.ts';
import { displayText, type Conversation, type ConversationEntry } from './transcript.ts';
import type { CommandContext } from './commands.ts';

/** The most of one tool's output a remote view is sent. */
const OUTPUT_CHARS = 4000;

/** A conversation entry as the remote page draws it. The terminal's own rows (turn footers, receipts) are not sent. */
export function wireEntry(entry: ConversationEntry, cwd?: string): WireEntry | undefined {
  const { key } = entry;
  if (entry.kind === 'user') return { key, kind: 'user', text: entry.text };
  // What /remote and /share print carries the pairing code and the invitation: it stays at the terminal.
  if (entry.kind === 'note')
    return entry.label === 'remote' || entry.label === 'share'
      ? undefined
      : { key, kind: 'note', label: entry.label, text: entry.text };
  if (entry.kind === 'assistant') {
    const text = entry.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n');
    const ending = entry.ending ? [entry.ending.label, entry.ending.text].filter(Boolean).join(': ') : '';
    if (!text && !ending) return undefined;
    return { key, kind: 'assistant', text, streaming: entry.streaming, ...(ending ? { ending } : {}) };
  }
  if (entry.kind !== 'tool') return undefined;
  const { call } = entry;
  const described = describe(call, cwd);
  const settled = call.state === 'done' || call.state === 'error';
  return {
    key,
    kind: 'tool',
    state: call.state,
    title: settled ? described.did : described.doing,
    target: described.target,
    summary:
      call.state === 'done'
        ? outcome(call, described)
        : call.state === 'error'
          ? 'failed'
          : call.state === 'interrupted'
            ? 'stopped'
            : '',
    output: call.text.slice(0, OUTPUT_CHARS),
  };
}

/** What the remote host needs from the interface that owns the session. */
export interface RemoteHostDeps {
  harness: OmsSession;
  conversation: Conversation;
  busy(): boolean;
  /** Send a message to the agent as the person at the keyboard would. Returns why not, when it cannot be sent now. */
  send(text: string): string | undefined;
  cancel(): void;
  /** The approval on screen, if any. */
  approval(): ShownApproval | undefined;
  /** Ask a yes/no question on the approval card. */
  ask(question: { title: string; detail: string; subject: string }, signal: AbortSignal): Promise<boolean>;
  toast(text: string): void;
  render(): void;
  /** The agent's sync tool, offered while the session is shared. */
  syncTool?: SyncTool | undefined;
}

export interface RemoteHost {
  /** /remote [stop|local|tunnel|forget]: what to show for it. */
  command(argument: string): Promise<string>;
  /** /share [stop]: invite a teammate into this session, or end that. */
  share(argument: string): Promise<string>;
  /** /sync, and the agent's sync tool: trade what is new with whoever holds a copy and is live. */
  syncNow(): Promise<string>;
  chips(): StatusChip[];
  /** Called on every frame: remote views hear of a change in what is running or being asked. */
  sync(): void;
  close(): Promise<void>;
}

const INSTALL_TUNNEL =
  'cloudflared is not installed. Install it (brew install cloudflared), or use Tailscale: /remote lists its address.';

/** A Cloudflare quick tunnel to the local port: an https address that works from anywhere, for as long as it runs. */
function openTunnel(port: number): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let seen = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The tunnel did not start in time. Check your connection and try again.'));
    }, 30_000);
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(error.code === 'ENOENT' ? INSTALL_TUNNEL : `The tunnel could not start: ${error.message}`));
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('The tunnel stopped before it gave an address.'));
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      seen = (seen + chunk.toString('utf8')).slice(-8000);
      const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(seen)?.[0];
      if (!url) return;
      clearTimeout(timer);
      child.stderr!.removeAllListeners('data');
      child.stderr!.resume();
      resolve({ url, child });
    });
  });
}

export function createRemoteHost(deps: RemoteHostDeps): RemoteHost {
  const { harness, conversation } = deps;
  const manager = harness.session.sessionManager;
  const sessionId = String(manager.getSessionId());
  // Beside the session's own files. A session with no folder on disk keeps its pairings only while it runs.
  const stateFile = manager.getSessionDir?.() ? join(manager.getSessionDir(), `${sessionId}.remote.json`) : undefined;
  const title = sessionLabel(harness);
  const cwd = harness.root;
  const me = userInfo().username;
  const sessionsDir: string | undefined = manager.getSessionDir?.();
  /** Set when this session is a copy of one a teammate shared. */
  const joined = sessionsDir ? readShare(sessionsDir, sessionId) : undefined;
  const never = new AbortController().signal;

  let server: RemoteServer | undefined;
  let state: RemoteState = { devices: {} };
  let peer: PeerLink | undefined;
  let peerLive = false;
  let network = true;
  let tunnel: { url: string; child: ChildProcess } | undefined;
  let unwatch: (() => void) | undefined;
  let lastStatus = '';
  let here = new Set<string>();
  const approvalIds = new WeakMap<ShownApproval, number>();
  let nextApprovalId = 1;

  function loadState(): RemoteState {
    try {
      const saved = JSON.parse(readFileSync(stateFile!, 'utf8')) as Partial<RemoteState>;
      return {
        ...(typeof saved.port === 'number' ? { port: saved.port } : {}),
        devices: saved.devices ?? {},
        ...(saved.synced ? { synced: saved.synced } : {}),
      };
    } catch {
      return { devices: {} };
    }
  }
  const saveState = (state: RemoteState): void => {
    if (stateFile) writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  };

  function status(): WireStatus {
    const model = harness.session.model;
    const shown = deps.approval();
    if (shown && !approvalIds.has(shown)) approvalIds.set(shown, nextApprovalId++);
    return {
      busy: deps.busy(),
      model: model ? shortModelName(model.id) : '',
      yolo: harness.kind === 'chat' && harness.yolo.enabled(),
      ...(shown
        ? {
            approval: {
              id: approvalIds.get(shown)!,
              title: shown.card?.title ?? 'Allow host command?',
              reasons: [...(shown.card?.reasons ?? [])],
              command: displayText(shown.card?.command ?? shown.text, APPROVAL_TEXT_LIMIT),
              session: shown.session,
            },
          }
        : {}),
    };
  }
  // ---------------------------------------------------------------- syncing two copies

  const plural = (count: number): string => `${count} new message${count === 1 ? '' : 's'}`;
  const consent = (from: string, theirs: number, signal: AbortSignal): Promise<boolean> =>
    deps.ask(
      {
        title: `Sync this session with ${from}?`,
        detail: `${from} has ${plural(theirs)} for you and gets what is new here.\nEach side receives the other's messages as one note in the conversation.`,
        subject: `sync with ${from}`,
      },
      signal,
    );
  /** The other side's messages arrive as one note the agent can read. */
  function ingest(from: string, items: readonly SyncItem[]): void {
    if (!items.length) return;
    void harness.session
      .sendCustomMessage(
        { customType: SHARE_NOTE_TYPE, content: syncNote(from, items), display: true, details: undefined },
        { triggerTurn: false },
      )
      .catch(() => deps.toast('The synced messages could not be added'));
  }
  const outcome = (who: string, sent: number, received: number): string =>
    sent || received
      ? `Synced with ${who} · sent ${plural(sent)}, received ${plural(received)}.`
      : `Already in sync with ${who}.`;
  // ponytail: a reply lost on the way leaves one side thinking the other has its messages; resend from /sync if that happens.
  function mark(personId: string, leaf: string | undefined): void {
    if (!leaf) return;
    state.synced = { ...state.synced, [personId]: leaf };
    saveState(state);
  }
  function markJoined(leaf: string | undefined): void {
    if (!joined || !sessionsDir || !leaf) return;
    joined.synced = leaf;
    writeShare(sessionsDir, sessionId, joined);
  }
  if (joined) {
    deps.syncTool?.setActive(true);
    peer = createPeerLink({
      link: joined,
      async onSync({ items }): Promise<SyncAnswer> {
        if (!(await consent(joined.host, items.length, never))) return { ok: false, reason: `${me} said no.` };
        const mine = collectItems(manager, joined.synced);
        ingest(joined.host, items);
        markJoined(mine.leaf);
        return { ok: true, items: mine.items };
      },
      changed() {
        const live = !!peer?.live();
        if (live !== peerLive) deps.toast(live ? `${joined.host} is live` : `${joined.host} went away`);
        peerLive = live;
        deps.render();
      },
      ended() {
        deps.toast(`${joined.host} ended the sharing`);
        peer = undefined;
        peerLive = false;
        deps.render();
      },
    });
  }
  async function syncNow(): Promise<string> {
    if (joined && peer) {
      const mine = collectItems(manager, joined.synced);
      const answer = await peer.sync(mine.items);
      if (!answer.ok) return answer.reason;
      ingest(joined.host, answer.items);
      markJoined(mine.leaf);
      return outcome(joined.host, mine.items.length, answer.items.length);
    }
    const running = server;
    const live = running?.people().filter((person) => person.kind === 'oms' && person.live) ?? [];
    if (!running || !live.length)
      return running?.inviteCode()
        ? 'Nobody with their own copy of this session is live right now.'
        : 'This session is not shared. /share invites a teammate.';
    const results: string[] = [];
    for (const person of live) {
      const mine = collectItems(manager, state.synced?.[person.id]);
      const answer = await running.requestSync(person.id, me, mine.items);
      if (!answer.ok) {
        results.push(answer.reason.replace(/^They\b/, person.name));
        continue;
      }
      const theirs = cleanItems(answer.items);
      ingest(person.name, theirs);
      mark(person.id, mine.leaf);
      results.push(outcome(person.name, mine.items.length, theirs.length));
    }
    return results.join('\n');
  }
  deps.syncTool?.bind(syncNow);

  const entries = (): WireEntry[] =>
    conversation.entries().flatMap((entry) => {
      const wire = wireEntry(entry, cwd);
      return wire ? [wire] : [];
    });

  async function start(overNetwork: boolean): Promise<RemoteServer> {
    if (server && network === overNetwork) return server;
    await stop();
    network = overNetwork;
    state = loadState();
    const started = await startRemoteServer({
      sessionId,
      title,
      hostName: me,
      network,
      state,
      save: saveState,
      hooks: {
        snapshot: () => ({ entries: entries(), status: status() }),
        admit: ({ role, name, address, kind }, signal) =>
          deps.ask(
            kind === 'oms'
              ? {
                  title: `Give ${name} a copy of this session?`,
                  detail: `${name} at ${address}, from their own OMS\nThey receive this conversation, with secrets masked, and continue it in their folder. You can sync with them while both are open.`,
                  subject: `${name} joining with a copy (${address})`,
                }
              : role === 'owner'
                ? {
                    title: 'Let this device control the session?',
                    detail: `${name} at ${address}\nIt can read the conversation, send messages, stop work and answer approvals.`,
                    subject: `remote access for ${name} (${address})`,
                  }
                : {
                    title: `Let ${name} join this session?`,
                    detail: `${name} at ${address}\nThey can read the conversation and send messages to the agent. Approvals stay with you.`,
                    subject: `${name} joining (${address})`,
                  },
            signal,
          ),
        send(from: Person, text: string) {
          if (from.role !== 'guest') return deps.send(text);
          // With approvals off, a guest's message could run anything here unseen.
          if (harness.kind === 'chat' && harness.yolo.enabled())
            return 'The host has approvals off, so guests can only watch.';
          return deps.send(`[${from.name}] ${text}`);
        },
        cancel: () => deps.cancel(),
        answer(_from, id, answer) {
          const shown = deps.approval();
          if (!shown || approvalIds.get(shown) !== id) return false;
          shown.answer(answer === 'deny' ? false : answer === 'session' ? 'session' : true);
          return true;
        },
        export(from) {
          const shared = exportEntries(manager);
          mark(from.id, shared.at(-1)?.id);
          return { host: me, cwd: manager.getCwd(), entries: shared };
        },
        async sync(from, raw): Promise<SyncAnswer> {
          const theirs = cleanItems(raw);
          if (!(await consent(from.name, theirs.length, never))) return { ok: false, reason: `${me} said no.` };
          const mine = collectItems(manager, state.synced?.[from.id]);
          ingest(from.name, theirs);
          mark(from.id, mine.leaf);
          return { ok: true, items: mine.items };
        },
        peopleChanged() {
          const now = new Map(
            started
              .people()
              .filter((person) => person.kind !== 'terminal' && person.live)
              .map((person) => [person.id, person.name]),
          );
          for (const [id, name] of now) if (!here.has(id)) deps.toast(`${name} connected`);
          here = new Set(now.keys());
          deps.render();
        },
      },
    });
    server = started;
    unwatch = conversation.watch((entry) => {
      if (!entry) return started.cleared();
      const wire = wireEntry(entry, cwd);
      if (wire) started.entry(wire);
    });
    return started;
  }

  async function stop(): Promise<void> {
    if (!joined) deps.syncTool?.setActive(false);
    tunnel?.child.kill();
    tunnel = undefined;
    unwatch?.();
    unwatch = undefined;
    here = new Set();
    lastStatus = '';
    const closing = server;
    server = undefined;
    await closing?.close();
  }

  function describeAccess(running: RemoteServer): string {
    const addresses = running.addresses();
    const width = Math.max(...addresses.map(({ label }) => label.length), 'Tunnel'.length) + 2;
    const paired = running.people().filter((person) => person.kind === 'browser').length;
    return [
      'Remote access is on for this session.',
      '',
      ...(tunnel ? [`  ${'Tunnel'.padEnd(width)}${tunnel.url}`] : []),
      ...addresses.map(({ label, url }) => `  ${label.padEnd(width)}${url}`),
      `  ${'Code'.padEnd(width)}${running.pairingCode()}`,
      '',
      'Open an address on your phone or another computer and type the code. OMS then asks here before the device',
      'may connect. On a phone, add the page to the home screen to install it as an app.',
      network
        ? 'On a network you do not trust, use /remote tunnel (https) or Tailscale: plain http can be read by others on it.'
        : 'Only this computer can reach it. /remote opens it to your network.',
      ...(tunnel ? ['The tunnel is run by Cloudflare and stays up until /remote stop.'] : []),
      '',
      `${paired === 0 ? 'No devices paired yet' : `${paired} paired device${paired === 1 ? '' : 's'}`} · /remote stop turns it off · /remote forget unpairs every device`,
    ].join('\n');
  }

  function describeShare(running: RemoteServer): string {
    const base = tunnel?.url ?? running.addresses()[0]!.url;
    const link = `${base}/#${running.inviteCode()}`;
    const others = running.people().filter((person) => person.role === 'guest');
    const here = others.filter((person) => person.live).map((person) => person.name);
    const away = others.filter((person) => !person.live).map((person) => person.name);
    return [
      'This session is shared.',
      '',
      `  In a browser   ${link}`,
      `  With OMS       oms join '${link}'`,
      '',
      'Send it to a teammate on the same network (or use /remote tunnel first for a link that works from anywhere).',
      'In a browser they see this session live and can send messages. With oms join they get their own copy of the',
      'conversation to continue in their folder; /sync then trades what is new while both of you are open.',
      'You are asked here before anyone gets in. Approvals stay with you, and secrets are masked in what they get.',
      '',
      `${here.length ? `Live now: ${here.join(', ')}` : 'Nobody has joined yet'}${away.length ? ` · away: ${away.join(', ')}` : ''} · /share stop ends it`,
    ].join('\n');
  }

  return {
    async share(argument) {
      if (argument === 'stop') {
        if (!server?.inviteCode()) return 'This session is not shared.';
        server.setSharing(false);
        deps.syncTool?.setActive(!!joined);
        return 'Sharing is off and guests were removed. Your own devices stay connected until /remote stop.';
      }
      const running = await start(true);
      running.setSharing(true);
      deps.syncTool?.setActive(true);
      return describeShare(running);
    },
    syncNow,
    async command(argument) {
      if (argument === 'stop') {
        if (!server) return 'Remote access is already off.';
        await stop();
        return 'Remote access is off. Paired devices stay paired for next time.';
      }
      if (argument === 'forget') {
        if (server) server.forget();
        else if (stateFile) rmSync(stateFile, { force: true });
        return 'Every paired device is forgotten. Each one needs a new code to connect again.';
      }
      const running = await start(argument === 'local' ? false : argument === '' && server ? network : true);
      if (argument === 'tunnel' && !tunnel) {
        const opened = await openTunnel(running.port);
        // Remote access may have been stopped while the tunnel was starting.
        if (server !== running) opened.child.kill();
        else tunnel = opened;
      }
      return describeAccess(running);
    },
    chips() {
      const chips: StatusChip[] = [];
      if (joined && peer)
        chips.push(peerLive ? { text: joined.host, dot: 'success' } : { text: `${joined.host} away` });
      if (server) {
        const label = server.inviteCode() ? 'shared' : 'remote';
        chips.push(here.size ? { text: `${label} · ${here.size}`, dot: 'success' } : { text: label, dot: 'info' });
      }
      return chips;
    },
    sync() {
      if (!server) return;
      const next = status();
      const encoded = JSON.stringify(next);
      if (encoded === lastStatus) return;
      lastStatus = encoded;
      server.status(next);
    },
    async close() {
      peer?.close();
      peer = undefined;
      deps.syncTool?.bind(undefined);
      await stop();
    },
  };
}

const remoteAction =
  (title: string, act: (remote: NonNullable<CommandContext['remote']>, argument: string) => Promise<string>) =>
  (ctx: CommandContext, argument: string): Prepared => {
    const remote = ctx.remote;
    if (!remote) return refuse('Remote access is not available here');
    return {
      ok: true,
      async run() {
        try {
          return { title, text: await act(remote, argument.trim()) };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'That did not work';
          return { title, text: message, failure: message, failureShown: true };
        }
      },
    };
  };

/** /remote [stop|local|tunnel|forget] */
export const remoteCommand = remoteAction('remote', (remote, argument) => remote.command(argument));
/** /share [stop] */
export const shareCommand = remoteAction('share', (remote, argument) => remote.share(argument));
/** /sync */
export const syncCommand = remoteAction('sync', (remote) => remote.syncNow());
