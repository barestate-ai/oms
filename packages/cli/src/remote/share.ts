import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';
import { commandNamesEnvFile, isEnvFile, maskEnvFile, maskSecrets } from '../tui/secret-mask.ts';
import { displayText } from '../tui/transcript.ts';
import type { Person, SyncAnswer, SyncItem } from './server.ts';

type Manager = Pick<SessionManager, 'getBranch' | 'getCwd'>;
type Block = { type?: string; text?: unknown; name?: unknown; id?: unknown; arguments?: unknown };

const ITEM_CHARS = 4000;
const MAX_ITEMS = 80;
const NOTE_CHARS = 24_000;
const MAX_ENTRIES = 50_000;

const deep = (value: unknown, mask: (text: string) => string, depth = 0): unknown =>
  typeof value === 'string'
    ? mask(value)
    : depth > 8 || !value || typeof value !== 'object'
      ? value
      : Array.isArray(value)
        ? value.map((item) => deep(item, mask, depth + 1))
        : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item, mask, depth + 1)]));

/** Text and tool arguments masked. Thinking and provider signatures stay as they are: a provider refuses a changed one. */
function maskContent(content: unknown, mask: (text: string) => string): unknown {
  if (typeof content === 'string') return mask(content);
  if (!Array.isArray(content)) return content;
  return (content as Block[]).map((block) => {
    if (!block || typeof block !== 'object') return block;
    if (block.type === 'text' && typeof block.text === 'string') return { ...block, text: mask(block.text) };
    if (block.type === 'toolCall') return { ...block, arguments: deep(block.arguments, mask) };
    return block;
  });
}

/**
 * The conversation as a teammate's OMS receives it: the current branch, with secrets masked the way the screen masks
 * them. A call that touched an env file has every value hidden, in its arguments and in its result.
 */
export function exportEntries(manager: Manager): SessionEntry[] {
  const envCalls = new Set<string>();
  return manager.getBranch().map((entry) => {
    if (entry.type === 'custom_message') return { ...entry, content: maskContent(entry.content, maskSecrets) };
    if (entry.type === 'custom') return { ...entry, data: deep(entry.data, maskSecrets) };
    if (entry.type === 'compaction' || entry.type === 'branch_summary')
      return { ...entry, summary: maskSecrets(entry.summary) };
    if (entry.type !== 'message') return entry;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role === 'assistant' && Array.isArray(message.content))
      for (const block of message.content as Block[]) {
        const args = (block?.type === 'toolCall' ? block.arguments : undefined) as Record<string, unknown> | undefined;
        if (args && (isEnvFile(args.path) || isEnvFile(args.file_path) || commandNamesEnvFile(args.command)))
          envCalls.add(String(block.id));
      }
    const env = message.role === 'toolResult' && envCalls.has(String(message.toolCallId));
    const mask = env || commandNamesEnvFile(message.command) ? maskEnvFile : maskSecrets;
    return {
      ...entry,
      message: {
        ...message,
        content: maskContent(message.content, mask),
        ...(message.details === undefined ? {} : { details: deep(message.details, mask) }),
        ...(typeof message.command === 'string' ? { command: maskSecrets(message.command) } : {}),
        ...(typeof message.output === 'string' ? { output: mask(message.output) } : {}),
      },
    };
  }) as SessionEntry[];
}

/** What a session's `<id>.share.json` holds on the side that joined. The secret is this copy's own, kept private on disk. */
export interface ShareLink {
  url: string;
  secret: string;
  /** Who shared it. */
  host: string;
  /** The last entry here that the host has been told about. */
  synced?: string;
}
export const shareFile = (sessionsDir: string, sessionId: string): string =>
  join(sessionsDir, `${sessionId}.share.json`);
export function readShare(sessionsDir: string, sessionId: string): ShareLink | undefined {
  try {
    const saved = JSON.parse(readFileSync(shareFile(sessionsDir, sessionId), 'utf8')) as Partial<ShareLink>;
    return typeof saved.url === 'string' && typeof saved.secret === 'string' && typeof saved.host === 'string'
      ? (saved as ShareLink)
      : undefined;
  } catch {
    return undefined;
  }
}
export const writeShare = (sessionsDir: string, sessionId: string, link: ShareLink): void =>
  writeFileSync(shareFile(sessionsDir, sessionId), `${JSON.stringify(link)}\n`, { mode: 0o600 });

/**
 * Saves a shared conversation as a new session of this folder and returns its id. The entries keep their ids, so the
 * two copies can later tell what the other has not seen. What arrives is checked for shape, not trusted.
 */
export function writeJoinedSession(
  sessionsDir: string,
  cwd: string,
  shared: { entries: unknown; host: string; cwd?: unknown },
): { sessionId: string; leaf: string | undefined } {
  if (!Array.isArray(shared.entries) || shared.entries.length > MAX_ENTRIES)
    throw new Error('The shared session could not be read.');
  const entries = shared.entries as SessionEntry[];
  for (const entry of entries) {
    const parent = (entry as { parentId?: unknown } | null)?.parentId;
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.type !== 'string' ||
      (entry.type as string) === 'session' ||
      typeof entry.id !== 'string' ||
      (parent !== null && typeof parent !== 'string')
    )
      throw new Error('The shared session could not be read.');
  }
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const leaf = entries.at(-1)?.id;
  const there = typeof shared.cwd === 'string' ? displayText(shared.cwd, 300) : 'their folder';
  const seam = {
    type: 'custom_message',
    customType: 'oms.share',
    id: randomUUID().slice(0, 8),
    parentId: leaf ?? null,
    timestamp,
    display: true,
    content: `This conversation was shared by ${shared.host}. Everything above happened on their computer, in ${there}. You are now working in ${cwd}, a different copy of the project: paths and file contents in earlier messages may not match what is here, so check before relying on them.`,
  };
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(sessionsDir, `${timestamp.replace(/[:.]/g, '-')}_${sessionId}.jsonl`),
    [{ type: 'session', version: 3, id: sessionId, timestamp, cwd }, ...entries, seam]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  return { sessionId, leaf };
}

/** What was said on this side after `since`: the user's messages and the agent's replies, as text. */
export function collectItems(
  manager: Manager,
  since: string | undefined,
): { items: SyncItem[]; leaf: string | undefined } {
  const branch = manager.getBranch();
  // An entry that is not on this branch any more (after /clear) means the other side has seen none of it.
  const start = since ? branch.findIndex((entry) => entry.id === since) + 1 : 0;
  const items: SyncItem[] = [];
  for (const entry of branch.slice(start)) {
    if (entry.type !== 'message') continue;
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const blocks: Block[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : [];
    const text = blocks
      .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
      .join('\n')
      .trim();
    if (text) items.push({ who: message.role === 'user' ? 'user' : 'agent', text: displayText(text, ITEM_CHARS) });
  }
  return { items: items.slice(-MAX_ITEMS), leaf: branch.at(-1)?.id };
}

/** Items from the other side, checked and cleaned: they are someone else's text and are shown and sent to the model. */
export function cleanItems(value: unknown): SyncItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_ITEMS)
    .flatMap((item: Partial<SyncItem> | null) =>
      item && (item.who === 'user' || item.who === 'agent') && typeof item.text === 'string' && item.text.trim()
        ? [{ who: item.who, text: displayText(item.text, ITEM_CHARS) }]
        : [],
    );
}

/** The one note the other side's work arrives as. */
export function syncNote(from: string, items: readonly SyncItem[]): string {
  let body = items.map((item) => `${item.who === 'user' ? from : `${from}'s agent`}: ${item.text}`).join('\n\n');
  if (body.length > NOTE_CHARS) body = `[earlier messages left out]\n\n${body.slice(-NOTE_CHARS)}`;
  return `Session sync: what ${from} and their agent did in their copy of this session since the last sync. It happened on their computer, so check the files here before relying on it.\n\n${body}`;
}

export interface PeerLink {
  /** Whether the host is reachable right now. */
  live(): boolean;
  people(): readonly Person[];
  /** Ask the host to sync, handing over what is new here. */
  sync(items: SyncItem[]): Promise<SyncAnswer>;
  close(): void;
}

/**
 * The joined side's line to the host: it stays connected while both are open, so each sees whether the other is live,
 * and carries sync requests both ways. It keeps trying quietly while the host is away.
 */
export function createPeerLink(options: {
  link: ShareLink;
  /** The host asks to sync. */
  onSync(request: { from: string; items: SyncItem[] }): Promise<SyncAnswer>;
  changed(): void;
  /** The host has ended the sharing. */
  ended(): void;
}): PeerLink {
  const { link } = options;
  const headers = { authorization: `Bearer ${link.secret}` };
  const post = (path: string, body: unknown) =>
    fetch(link.url + path, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
    });
  const stop = new AbortController();
  let live = false;
  let people: Person[] = [];

  async function handle(event: string, data: unknown): Promise<void> {
    if (event === 'people') {
      people = data as Person[];
      options.changed();
    } else if (event === 'sync') {
      const request = data as { id: number; from: string; items: unknown };
      const answer = await options
        .onSync({ from: displayText(String(request.from), 40), items: cleanItems(request.items) })
        .catch((): SyncAnswer => ({ ok: false, reason: 'failed' }));
      await post('/api/sync-reply', { id: request.id, ...answer }).catch(() => {});
    }
  }

  void (async () => {
    let delay = 2000;
    while (!stop.signal.aborted) {
      try {
        const response = await fetch(`${link.url}/api/events`, { headers, signal: stop.signal });
        if (response.status === 401) return options.ended();
        if (!response.ok || !response.body) throw new Error('unavailable');
        live = true;
        delay = 2000;
        options.changed();
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            // A sync waits for a person; the stream is read on meanwhile.
            if (event && data) void handle(event, JSON.parse(data)).catch(() => {});
          }
        }
      } catch {
        // The host is away or the network dropped: try again in a while.
      }
      if (live) {
        live = false;
        people = [];
        options.changed();
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref();
        stop.signal.addEventListener('abort', resolve, { once: true });
      });
      delay = Math.min(delay * 2, 30_000);
    }
  })();

  return {
    live: () => live,
    people: () => people,
    async sync(items) {
      if (!live) return { ok: false, reason: `${link.host} is not live right now.` };
      try {
        const response = await post('/api/sync', { items });
        if (!response.ok) return { ok: false, reason: 'The sync could not be sent.' };
        const answer = (await response.json()) as SyncAnswer;
        return answer.ok ? { ok: true, items: cleanItems(answer.items) } : { ok: false, reason: String(answer.reason) };
      } catch {
        return { ok: false, reason: `${link.host} could not be reached.` };
      }
    },
    close: () => stop.abort(),
  };
}

export const SHARE_NOTE_TYPE = 'oms.sync';
