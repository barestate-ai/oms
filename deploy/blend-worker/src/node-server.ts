import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handle } from './core/handle.ts';
import { validateProfiles } from './core/policies.ts';
import { MemorySessions } from './core/sessions.ts';
import type { Dependencies, RequestLog } from './core/types.ts';

export function costLogger(file: string): (line: RequestLog) => Promise<void> {
  let tail = Promise.resolve();
  return (line) => {
    const next = tail.then(() => appendFile(file, JSON.stringify(line) + '\n', { mode: 0o600 }));
    tail = next.catch(() => {});
    return next;
  };
}

export function createNodeServer(deps: Dependencies): Server {
  return createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    outgoing.on('close', () => {
      if (!outgoing.writableEnded) abort.abort();
    });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > 4 * 1024 * 1024) {
          await deps.log({ ts: new Date().toISOString(), profile: null, calls: [], total_usd: 0, status: 413 });
          outgoing.writeHead(413, { 'content-type': 'application/json' });
          outgoing.end(
            JSON.stringify({ error: { message: 'Request body too large.', type: 'invalid_request_error', code: 413 } }),
          );
          return;
        }
        chunks.push(bytes);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers))
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const body = Buffer.concat(chunks);
      const request = new Request(new URL(incoming.url ?? '/', 'http://127.0.0.1'), {
        method: incoming.method ?? 'GET',
        headers,
        signal: abort.signal,
        ...(body.length ? { body: new Uint8Array(body).buffer } : {}),
      });
      const response = await handle(request, deps);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' });
      outgoing.end(
        JSON.stringify({ error: { message: 'Local Blend server failed.', type: 'server_error', code: 500 } }),
      );
    }
  });
}

export async function startNodeServer(): Promise<Server> {
  const port = Number(process.env.BLEND_PORT ?? process.env.PORT ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BLEND_PORT');
  if (!process.env.BLEND_LOG) throw new Error('BLEND_LOG is required');
  const profiles = validateProfiles(
    JSON.parse(
      await readFile(process.env.BLEND_PROFILES ?? fileURLToPath(new URL('../profiles.json', import.meta.url)), 'utf8'),
    ),
  );
  const file = resolve(process.env.BLEND_LOG);
  await mkdir(dirname(file), { recursive: true });
  const server = createNodeServer({
    fetch,
    profiles,
    sessions: new MemorySessions(),
    log: costLogger(file),
    keys: {
      anthropic: process.env.ANTHROPIC_API_KEY,
      xai: process.env.XAI_API_KEY,
      'opencode-go': process.env.OPENCODE_API_KEY,
      muse: process.env.MUSE_API_KEY,
    },
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', accept);
  });
  console.log(`Blend listening on http://127.0.0.1:${port}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await startNodeServer();
  } catch {
    console.error('Unable to start Blend: check configuration and log path.');
    process.exitCode = 1;
  }
}
