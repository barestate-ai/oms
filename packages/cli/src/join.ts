import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { omsCommand, resolveChatFolder } from '@oms/engine';
import { writeJoinedSession, writeShare } from './remote/share.ts';

export interface JoinDeps {
  folder: string;
  stateRoot: string;
  /** Who you are to the host. */
  name: string;
  log(line: string): void;
  error(line: string): void;
  signal?: AbortSignal;
}

const USAGE = `Usage: ${omsCommand()} join <link> [--name <your name>]`;

/**
 * `oms join <link>`: asks the host for a copy of the session they shared and saves it as a new conversation of this
 * folder. Returns its id, or nothing after saying why not.
 */
export async function joinSession(args: string[], deps: JoinDeps): Promise<string | undefined> {
  const { log, error } = deps;
  let name = deps.name;
  const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--name') name = args[++index] ?? '';
    else words.push(args[index]!);
  }
  let link: URL | undefined;
  try {
    link = new URL(words[0] ?? '');
  } catch {
    // Reported below with the usage.
  }
  const code = link?.hash.slice(1);
  if (words.length !== 1 || !link || !/^https?:$/.test(link.protocol) || !code || !name.trim()) {
    error(`${omsCommand()} join: give the link from /share\n${USAGE}`);
    return undefined;
  }
  const base = link.origin;
  const secret = randomBytes(32).toString('base64url');
  const signal = deps.signal;
  let waiting = false;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${base}/api/hello`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client: secret, code, name, kind: 'oms' }),
        ...(signal ? { signal } : {}),
      });
    } catch {
      error(
        `oms: ${base} could not be reached. The host has to be running OMS with /share on, on a network you can reach.`,
      );
      return undefined;
    }
    if (response.status === 200) break;
    if (response.status === 202) {
      if (!waiting) log('Waiting for the host to allow it in their terminal…');
      waiting = true;
      continue;
    }
    error(
      response.status === 403
        ? 'oms: the host said no.'
        : response.status === 429
          ? 'oms: too many tries. Wait a minute and try again.'
          : 'oms: that link no longer works. Ask the host for a new one from /share.',
    );
    return undefined;
  }
  const exported = await fetch(`${base}/api/export`, {
    headers: { authorization: `Bearer ${secret}` },
    ...(signal ? { signal } : {}),
  });
  if (!exported.ok) {
    error('oms: the host did not send the session.');
    return undefined;
  }
  const shared = (await exported.json()) as { host?: unknown; cwd?: unknown; entries?: unknown };
  const host =
    typeof shared.host === 'string' ? shared.host.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 24) || 'host' : 'host';
  const folder = resolveChatFolder(deps.folder, { stateRoot: deps.stateRoot });
  const sessionsDir = join(deps.stateRoot, 'folders', folder.key, 'sessions');
  const { sessionId, leaf } = writeJoinedSession(sessionsDir, folder.path, {
    entries: shared.entries,
    host,
    cwd: shared.cwd,
  });
  writeShare(sessionsDir, sessionId, { url: base, secret, host, ...(leaf ? { synced: leaf } : {}) });
  log(`Joined ${host}'s session. /sync trades what is new while you are both open.`);
  return sessionId;
}
