import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { McpClient, StreamableHttpTransport, type McpTransport } from '@earendil-works/pi-mcp';
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthProvider,
  OAuthCallbackServer,
  type McpOAuthState,
  type McpOAuthStateStore,
} from '@earendil-works/pi-mcp/oauth';
import type { McpExposure, McpServerConfig } from '@earendil-works/pi-coding-agent';
import type { McpPreset } from './catalog.ts';
import type { Access } from './config.ts';

// ---------------------------------------------------------------- what the agent is offered

/** `mcp__linear__` for the server `linear`; the tool names pi gives a server's tools start with it. */
export const mcpToolPrefix = (server: string): string => `mcp__${server.replace(/[^A-Za-z0-9_]/g, '_')}__`;

const glob = (pattern: string): RegExp =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const matches = (patterns: readonly string[], name: string): boolean =>
  patterns.some((pattern) => glob(pattern).test(name));

/** Which tools of a server pi declares to the model: the reads, plus the curated writes at ask and allow. Nothing else. */
export function toolExposure(preset: McpPreset, access: Access): Record<string, McpExposure> {
  const out: Record<string, McpExposure> = {};
  for (const name of preset.read) out[name] = 'direct';
  if (access === 'ask' || access === 'allow') for (const name of preset.write) out[name] = 'direct';
  return out;
}

/** The server entry pi connects: everything hidden except the curated tools. */
export function mcpServerConfig(preset: McpPreset, access: Access): McpServerConfig {
  return {
    type: 'http',
    url: preset.url,
    description: preset.description,
    exposure: 'hidden',
    toolExposure: toolExposure(preset, access),
  };
}

/** A tool of a connector's server is a read only when the preset names it so (or the server says it is); anything unknown is a write. */
export function classifyMcpTool(
  preset: McpPreset,
  tool: string,
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean },
): 'read' | 'write' {
  if (matches(preset.write, tool) || annotations?.destructiveHint === true) return 'write';
  if (matches(preset.read, tool)) return annotations?.readOnlyHint === false ? 'write' : 'read';
  return annotations?.readOnlyHint === true ? 'read' : 'write';
}

// ---------------------------------------------------------------- where sign-ins are kept

/**
 * Sign-ins for hosted connectors, in one private file under the agent folder (`~/.oms/agent/mcp-auth.json`), keyed by
 * server and address. The agent's own commands cannot see that folder. Nothing here is ever shown or logged.
 */
export class McpCredentials {
  readonly path: string;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(path: string) {
    this.path = path;
  }
  private read(): Record<string, McpOAuthState> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, McpOAuthState>)
        : {};
    } catch {
      return {};
    }
  }
  private write(states: Record<string, McpOAuthState>): void {
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify(states, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Nothing was written there.
      }
      throw error;
    }
  }
  private key(name: string, url: string): string {
    return `${name}|${new URL(url).href}`;
  }
  /** Presence only: whether a sign-in is stored. The token is never read out. */
  has(name: string, url: string): boolean {
    return !!this.read()[this.key(name, url)]?.tokens?.access_token;
  }
  tokens(name: string, url: string): McpOAuthState['tokens'] {
    return this.read()[this.key(name, url)]?.tokens;
  }
  remove(name: string, url: string): boolean {
    const states = this.read();
    const key = this.key(name, url);
    if (!(key in states)) return false;
    delete states[key];
    this.write(states);
    return true;
  }
  /** The store pi's OAuth code reads and writes for one server. */
  forServer(
    name: string,
    url: string,
  ): McpOAuthStateStore & { withRefreshLock<T>(work: () => Promise<T>): Promise<T> } {
    const key = this.key(name, url);
    return {
      load: () => this.read()[key],
      save: (state) => {
        const states = this.read();
        states[key] = state;
        this.write(states);
      },
      // ponytail: one process at a time per file; a second OMS refreshing the same server at once could rotate the token twice.
      withRefreshLock: <T>(work: () => Promise<T>): Promise<T> => {
        const run = this.chain.then(work, work);
        this.chain = run.catch(() => undefined);
        return run;
      },
    };
  }
}

/** The file inside the agent folder of a state root. */
export const credentialsFile = (stateRoot: string): string => join(stateRoot, 'agent', 'mcp-auth.json');

// ---------------------------------------------------------------- signing in

export interface SignInDeps {
  authorize: typeof authorizeMcp;
  listen: typeof OAuthCallbackServer.listen;
  fetch: typeof fetch;
}
const timedFetch =
  (base: typeof fetch): typeof fetch =>
  (input, init) => {
    const timeout = AbortSignal.timeout(15_000);
    return base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };

/** The address the person opens must be https, or it is not shown. */
export function safeAuthorizationUrl(url: URL): URL {
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('The sign-in address is not a safe https address.');
  return url;
}

/**
 * Sign in to a hosted connector in the browser: a loopback address receives the answer, `show` gets the address to open.
 * Tokens go to the credentials store only. Aborting the signal stops it.
 */
export async function signInMcp(
  options: { name: string; url: string; credentials: McpCredentials; signal: AbortSignal; show(url: URL): void },
  deps: Partial<SignInDeps> = {},
): Promise<void> {
  const authorize = deps.authorize ?? authorizeMcp;
  const fetchImpl = timedFetch(deps.fetch ?? fetch);
  const store = options.credentials.forServer(options.name, options.url);
  if (options.signal.aborted) throw new Error('Sign-in cancelled.');
  const callback = await (deps.listen ?? OAuthCallbackServer.listen)({ host: '127.0.0.1', port: 0 });
  const stop = () => void callback.close().catch(() => undefined);
  options.signal.addEventListener('abort', stop, { once: true });
  try {
    // Every sign-in starts with a fresh `state`.
    const stored = await store.load();
    if (stored) {
      const { oauthState: _unused, ...rest } = stored;
      await store.save(rest);
    }
    let authorizationUrl: URL | undefined;
    const provider = new McpOAuthProvider({
      serverUrl: options.url,
      redirectUrl: callback.redirectUrl,
      clientMetadata: { client_name: 'OMS' },
      store,
      onRedirect: (url) => {
        authorizationUrl = url;
      },
    });
    const flow = { serverUrl: options.url, fetch: fetchImpl, signal: options.signal };
    if ((await authorize(provider, flow)) === 'AUTHORIZED') return;
    if (!authorizationUrl) throw new Error('The service did not give a sign-in address.');
    const state = await provider.state();
    options.show(safeAuthorizationUrl(authorizationUrl));
    const { code, iss } = await callback.waitForCallback(state);
    await authorize(provider, { ...flow, authorizationCode: code, iss });
  } catch (error) {
    if (options.signal.aborted) throw new Error('Sign-in cancelled.');
    throw error;
  } finally {
    options.signal.removeEventListener('abort', stop);
    await callback.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- one call from the host

export interface HostedCallDeps {
  /** Tests pass a transport wired to a fake server. */
  transport?: (url: string, auth: ReturnType<typeof adaptOAuthProvider>) => McpTransport;
}

/** The text of one tool call on a hosted connector, made by OMS itself with the stored sign-in. Throws a plain sentence on failure. */
export async function callHostedTool(
  options: {
    name: string;
    url: string;
    credentials: McpCredentials;
    tool: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  },
  deps: HostedCallDeps = {},
): Promise<string> {
  const store = options.credentials.forServer(options.name, options.url);
  const stored = await store.load();
  const registered =
    stored?.clientInformation && 'redirect_uris' in stored.clientInformation
      ? stored.clientInformation.redirect_uris[0]
      : undefined;
  const provider = new McpOAuthProvider({
    serverUrl: options.url,
    redirectUrl: registered ?? 'http://127.0.0.1/callback',
    clientMetadata: { client_name: 'OMS' },
    store,
    onRedirect: () => {},
  });
  const auth = adaptOAuthProvider(provider);
  const transport =
    deps.transport?.(options.url, auth) ??
    new StreamableHttpTransport({ url: options.url, authProvider: auth, openGetStream: false });
  const client = new McpClient({ name: 'oms', version: '1', requestTimeoutMs: 20_000 });
  try {
    await client.connect(transport);
    const result = await client.callTool(options.tool, options.args, { signal: options.signal, timeoutMs: 20_000 });
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('\n');
    if (result.isError) throw new Error('The service answered with an error.');
    return text;
  } catch (error) {
    if (options.signal?.aborted) throw new Error('Cancelled.');
    const name = error instanceof Error ? error.name : '';
    if (/Auth/i.test(name) || /\b40[13]\b/.test(error instanceof Error ? error.message : ''))
      throw new Error('Sign in again in /connectors.');
    throw new Error(
      error instanceof Error && error.message === 'The service answered with an error.'
        ? error.message
        : 'The service did not answer.',
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}
