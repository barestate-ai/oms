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
  type WireEntry,
  type WireStatus,
} from '../remote/server.ts';
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
  if (entry.kind === 'note') return { key, kind: 'note', label: entry.label, text: entry.text };
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
}

export interface RemoteHost {
  /** /remote [stop|local|tunnel|forget]: what to show for it. */
  command(argument: string): Promise<string>;
  chip(): StatusChip | undefined;
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

  let server: RemoteServer | undefined;
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
      return { ...(typeof saved.port === 'number' ? { port: saved.port } : {}), devices: saved.devices ?? {} };
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
  const entries = (): WireEntry[] =>
    conversation.entries().flatMap((entry) => {
      const wire = wireEntry(entry, cwd);
      return wire ? [wire] : [];
    });

  async function start(overNetwork: boolean): Promise<RemoteServer> {
    if (server && network === overNetwork) return server;
    await stop();
    network = overNetwork;
    const started = await startRemoteServer({
      sessionId,
      title,
      hostName: userInfo().username,
      network,
      state: loadState(),
      save: saveState,
      hooks: {
        snapshot: () => ({ entries: entries(), status: status() }),
        admit: ({ role, name, address }, signal) =>
          deps.ask(
            role === 'owner'
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
        peopleChanged() {
          const now = new Map(
            started
              .people()
              .filter((person) => person.kind === 'browser' && person.live)
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

  return {
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
    chip() {
      if (!server) return undefined;
      return here.size ? { text: `remote · ${here.size}`, dot: 'success' } : { text: 'remote', dot: 'info' };
    },
    sync() {
      if (!server) return;
      const next = status();
      const encoded = JSON.stringify(next);
      if (encoded === lastStatus) return;
      lastStatus = encoded;
      server.status(next);
    },
    close: stop,
  };
}

/** /remote [stop|local|tunnel|forget] */
export function remoteCommand(ctx: CommandContext, argument: string): Prepared {
  const remote = ctx.remote;
  if (!remote) return refuse('Remote access is not available here');
  return {
    ok: true,
    async run() {
      try {
        return { title: 'remote', text: await remote.command(argument.trim()) };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Remote access could not start';
        return { title: 'remote', text: message, failure: message, failureShown: true };
      }
    },
  };
}
