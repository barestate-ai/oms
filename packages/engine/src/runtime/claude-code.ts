import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { accessSync, constants, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { isMissing, privateDirectory, readPrivateJson, writePrivateJson } from '../workspace/storage.ts';
import { fileURLToPath } from 'node:url';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type Model,
  type Provider,
  type StreamOptions,
  type TranscriptContext,
  type ToolCall,
} from '@earendil-works/pi-ai';

export const CLAUDE_CODE_PROVIDER = 'claude-code';
export const CLAUDE_CODE_EMPTY_RESPONSE = 'claude-code-empty-response';
export const CLAUDE_CODE_SIGNIN = 'claude-code-signin';
export const CLAUDE_CODE_AUTH = 'claude-code-auth';
export const CLAUDE_CODE_LIMIT = 'claude-code-limit';
export const CLAUDE_CODE_RATE_LIMIT = 'claude-code-rate-limit';
export const CLAUDE_CODE_NOT_DISPATCHED = 'claude-code-not-dispatched';
export const CLAUDE_CODE_EMPTY_CONTINUATION =
  'Your previous reply came back empty. Continue the task from where you stopped; the earlier tool results are already in this conversation.';
const CLAUDE_CODE_BASE_URL = 'claude-code://local';
class NativeEmptyResponseError extends Error {}
/** A provider or local sign-in refusal, not a protocol breach: the native session stays usable once the cause is fixed. */
class NativeRefusalError extends Error {}
/** The local Claude sign-in check failed before any native process started, so no model request exists. */
class ClaudeCodeSignInError extends NativeRefusalError {}
/** An in-flight native turn was refused as unauthorized: the Claude subscription sign-in lapsed. */
class NativeAuthError extends NativeRefusalError {}
/** The Claude plan usage limit refused a native turn; carries the provider's own reset hint when it gives one. */
class NativeLimitError extends NativeRefusalError {
  readonly reset?: string;
  constructor(message: string, reset?: string) {
    super(message);
    this.reset = reset;
  }
}
/** A bare throttle (429) refused a native turn without quota evidence: back-pressure, not plan exhaustion. */
class NativeRateLimitError extends NativeRefusalError {}
/** Native receipts that report the Claude plan's usage limit rather than a transport failure. */
const NATIVE_LIMIT_REASON =
  /usage.?limit|hit (?:the |your )?limit|limit reached|quota|billing|payment|credit|insufficient/i;
/** Native receipts carrying a real sign-in signal: a status code, an auth word or a login phrase — not prose like "account". */
const NATIVE_AUTH_REASON =
  /auth|log(?:ged)?.?in|sign.?in|api.?key|subscription|\b(?:401|403|unauthorized|forbidden)\b/i;
/** Native receipts reporting request throttling without a quota reason; a bare 429 says nothing about plan state. */
const NATIVE_RATE_LIMIT_REASON = /rate.?limit|too many requests|\b429\b/i;
/** Every sign-in or limit-shaped reason: the union of the classifiers plus the broad terms the empty-retry gate already excluded. */
const NATIVE_ACCOUNT_REASON = new RegExp(
  `${NATIVE_LIMIT_REASON.source}|${NATIVE_AUTH_REASON.source}|${NATIVE_RATE_LIMIT_REASON.source}|limit|account|credential`,
  'i',
);
export interface ClaudeCodeStatus {
  installed: boolean;
  configured: boolean;
  detail: string;
}
let status: ClaudeCodeStatus = {
  installed: false,
  configured: false,
  detail: 'Run claude auth login, then check the local Claude Code connection in /connect.',
};
export function getClaudeCodeStatus(): ClaudeCodeStatus {
  return { ...status };
}

/** Never forward provider keys, NODE_OPTIONS, executable hooks, endpoint overrides
 * or third-party provider switches to the native subscription process. */
export function claudeCodeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SystemRoot',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'all_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
  ]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  // A benchmark cell stages its own login in a private home; the user's own ~/.claude is then never read.
  if (source.OMS_CLAUDE_CODE_HOME) environment.HOME = source.OMS_CLAUDE_CODE_HOME;
  return {
    ...environment,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
    DISABLE_COMPACT: '1',
    CLAUDE_CODE_MAX_RETRIES: '0',
  };
}

interface ProcessResult {
  code: number | null;
  stdout: string;
}
function executable(): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory) || directory.replaceAll('\\', '/').includes('/node_modules/')) continue;
    try {
      const candidate = join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude');
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      /* continue through trusted absolute PATH entries */
    }
  }
  throw Object.assign(new Error('Claude Code executable is unavailable'), { code: 'ENOENT' });
}
/** Own the process group, including the descriptor MCP child. No stderr or native
 * diagnostics are projected into model history or the UI. */
function runClaudeCode(
  args: readonly string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
    input?: string;
    maxBytes?: number;
    timeoutMs?: number;
    outputTokenLimit?: number;
    onLine?(value: unknown): void;
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const environment = claudeCodeEnvironment();
    if (options.outputTokenLimit !== undefined)
      environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(options.outputTokenLimit);
    const child = spawn(executable(), [...args], {
      cwd: options.cwd,
      env: environment,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      pending = '',
      failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* already stopped */
      }
    };
    const abort = () => {
      failure ??= new Error('Claude Code request cancelled');
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 500);
    };
    const deadline = setTimeout(abort, options.timeoutMs ?? 120_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (part: string) => {
      if (failure) return;
      stdout += part;
      if (Buffer.byteLength(stdout) > (options.maxBytes ?? 8_388_608)) {
        failure = new Error('Claude Code response exceeded its bounded transport size');
        abort();
        return;
      }
      if (options.onLine) {
        pending += part;
        for (;;) {
          const newline = pending.indexOf('\n');
          if (newline < 0) break;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            options.onLine(JSON.parse(line));
          } catch {
            failure = new Error('Claude Code returned an unsupported native response');
            abort();
            break;
          }
        }
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (code) => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      // Native CLI may finish before its MCP transport; reap the complete group.
      kill('SIGKILL');
      if (failure) reject(failure);
      else resolve({ code, stdout });
    });
  });
}

/** Checks native auth without reading, importing or storing native credentials. */
export async function inspectClaudeCode(signal?: AbortSignal): Promise<ClaudeCodeStatus> {
  try {
    const result = await runClaudeCode(['auth', 'status'], {
      cwd: tmpdir(),
      signal,
      maxBytes: 65_536,
      timeoutMs: 15_000,
    });
    const auth = JSON.parse(result.stdout) as Record<string, unknown>;
    const configured =
      result.code === 0 &&
      auth.loggedIn === true &&
      auth.authMethod === 'claude.ai' &&
      auth.apiProvider === 'firstParty';
    status = {
      installed: true,
      configured,
      detail: configured
        ? 'Local Claude Code subscription is connected; Claude plan limits apply.'
        : 'Sign in to Claude Code with your Claude subscription using claude auth login. API-key and third-party Claude Code accounts are not used by this connector.',
    };
  } catch (error) {
    const missing = !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    status = {
      installed: !missing,
      configured: false,
      detail: missing
        ? 'Install Claude Code, run claude auth login, then check the connection again.'
        : 'Claude Code login could not be checked. Run claude auth status in a terminal, then check the connection again.',
    };
  }
  return getClaudeCodeStatus();
}

const NATIVE_MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' } as const;
type NativeAlias = keyof typeof NATIVE_MODELS;
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected native object');
  return value as Record<string, unknown>;
};

export interface NativeChatStatus {
  sessionId?: string;
  state: 'new' | 'ready' | 'disconnected';
  detail?: string;
}
export interface NativeChatControls {
  status(): NativeChatStatus;
  reconnect(): Promise<void>;
  reset(): Promise<void>;
}
interface NativeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}
const emptyUsage = (): NativeUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
function nativeUsage(value: unknown): NativeUsage {
  const usage = object(value);
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (!isCount(usage[key])) throw new Error('Missing native assistant usage');
  }
  const cache = usage.cache_creation ? object(usage.cache_creation) : {};
  const long = cache.ephemeral_1h_input_tokens ?? 0;
  if (!isCount(long) || long > (usage.cache_creation_input_tokens as number))
    throw new Error('Invalid native cache usage');
  return {
    input: usage.input_tokens as number,
    output: usage.output_tokens as number,
    cacheRead: usage.cache_read_input_tokens as number,
    cacheWrite: usage.cache_creation_input_tokens as number,
    cacheWrite1h: long,
  };
}
const usageKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'] as const;
/** A failed native receipt names the refusal when the provider reported a sign-in or limit cause we understand. */
function classifyNativeReceipt(event: Record<string, unknown>): Error {
  if (event.is_error === true) {
    const reason = JSON.stringify([event.errors, event.error, event.result]);
    if (NATIVE_LIMIT_REASON.test(reason))
      return new NativeLimitError('Claude plan usage limit reached', nativeResetHint(reason));
    if (NATIVE_AUTH_REASON.test(reason)) return new NativeAuthError('Claude subscription sign-in was rejected');
    if (NATIVE_RATE_LIMIT_REASON.test(reason)) return new NativeRateLimitError('Claude rate limited the request');
  }
  return new Error('Unexpected or failed native receipt');
}
/** The reset hint a native limit message gives, e.g. "at 3:00 PM (UTC)": short, single-line and provider-owned. */
function nativeResetHint(reason: string): string | undefined {
  // The reason arrives JSON-escaped: \n inside a string is a literal backslash-n, not a line break.
  const text = reason.replace(/\\[nrt]/g, ' ');
  const hint = /\bresets?\s+((?:at|in|on|by|after)\s+[^.,;|\n"'\]}\[{\\]{1,48})/i.exec(text)?.[1];
  return hint?.replace(/\s+/g, ' ').trim() || undefined;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
interface NativeState {
  version: 1;
  binding?: string;
  sessionId: string;
  started: boolean;
  lastUser?: string;
  pending: ToolCall[];
  emitted: NativeUsage;
  blocked?: string;
}
export type ClaudeCodeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export function claudeCodeEffort(value = process.env.OMS_CLAUDE_EFFORT ?? 'high'): ClaudeCodeEffort {
  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value;
    default:
      throw new Error('OMS_CLAUDE_EFFORT must be low, medium, high, xhigh or max');
  }
}

export interface ClaudeCodeSessionOptions {
  /** Private OMS state, outside the model's task mounts; never native credentials. */
  statePath?: string;
  signal?: AbortSignal;
  /** Native CLI effort, defaulting to OMS_CLAUDE_EFFORT or high. */
  effort?: ClaudeCodeEffort;
  onSpawn?(pid: number, cwd: string): void;
}
interface Completion {
  model: Model<Api>;
  message: AssistantMessage;
  output: ReturnType<typeof createAssistantMessageEventStream>;
  resolve(): void;
  reject(error: Error): void;
  onEvent(): void;
  nativeId?: string;
  rawUsage?: Record<string, unknown>;
  stop?: string;
  stopped: boolean;
  settled: boolean;
  finishing: boolean;
  failed: boolean;
  blocks: Map<number, { index: number; json: string; stopped: boolean }>;
}

/** One native conversation, with Pi retaining admission and guarded tool execution.
 * A tool response is an assistant-usage checkpoint, NOT a native final receipt.
 * No result is returned to native MCP until the next Pi stream has been admitted.
 */
export class ClaudeCodeSession implements NativeChatControls {
  private state: NativeState;
  private child?: ChildProcessWithoutNullStreams;
  private disconnection?: Promise<void>;
  private handshake?: { id: string; resolve(): void; reject(error: Error): void };
  private exited?: Promise<void>;
  private server?: Server;
  private sockets = new Set<Socket>();
  private transportDirectory?: string;
  private temporaryWork?: string;
  private initialized = false;
  private transportReady = false;
  private configuration?: {
    model: Model<Api>;
    context: TranscriptContext;
    maxTokens: number;
    effort: ClaudeCodeEffort;
  };
  private configurationKey?: string;
  private active?: Completion;
  private failure?: string;
  private retryUser?: string;
  private toolResultDelivered = false;
  private waiting: { socket: Socket; name: string; args: unknown }[] = [];
  private delivered = new Set<string>();
  private results = new Map<string, { content: unknown; isError: boolean }>();
  private readonly options: ClaudeCodeSessionOptions;
  constructor(options: ClaudeCodeSessionOptions = {}) {
    claudeCodeEffort(options.effort);
    this.options = options;
    this.state = {
      version: 1,
      ...(options.statePath ? { binding: hash(options.statePath) } : {}),
      sessionId: randomUUID(),
      started: false,
      pending: [],
      emitted: emptyUsage(),
    };
    if (options.statePath) {
      try {
        const saved = object(readPrivateJson(options.statePath));
        if (
          saved.version !== 1 ||
          saved.binding !== hash(options.statePath) ||
          typeof saved.sessionId !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(saved.sessionId) ||
          typeof saved.started !== 'boolean' ||
          !Array.isArray(saved.pending) ||
          !saved.emitted ||
          (saved.lastUser !== undefined && typeof saved.lastUser !== 'string')
        )
          throw new Error('Invalid native session state');
        this.state = saved as unknown as NativeState;
        for (const key of usageKeys)
          if (!isCount(this.state.emitted[key])) throw new Error('Invalid native usage checkpoint');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    options.signal?.addEventListener(
      'abort',
      () => {
        void this.disconnect();
      },
      { once: true },
    );
  }
  status(): NativeChatStatus {
    return {
      sessionId: this.state.sessionId,
      state: this.transportReady && this.child ? 'ready' : this.state.started ? 'disconnected' : 'new',
      ...(this.state.blocked || this.failure
        ? { detail: this.state.blocked ?? this.failure }
        : this.state.pending.length && !this.child
          ? {
              detail:
                'An interrupted native tool batch cannot be resumed safely; review the OMS tool results, select Claude Code in /model, then use /clear to start a fresh native chat and clear the OMS conversation view; task files and verification are retained.',
            }
          : {}),
    };
  }
  private save(): void {
    if (this.options.statePath) writePrivateJson(this.options.statePath, this.state);
  }
  async reset(): Promise<void> {
    if (this.active) throw new Error('Wait for the native turn to finish');
    await this.disconnect();
    this.state = {
      version: 1,
      ...(this.state.binding ? { binding: this.state.binding } : {}),
      sessionId: randomUUID(),
      started: false,
      pending: [],
      emitted: emptyUsage(),
      ...(this.state.lastUser ? { lastUser: this.state.lastUser } : {}),
    };
    this.failure = undefined;
    this.retryUser = undefined;
    this.toolResultDelivered = false;
    this.save();
  }
  configure(model: Model<Api>, context: TranscriptContext, maxTokens: number): void {
    this.configuration = { model, context, maxTokens, effort: claudeCodeEffort(this.options.effort) };
  }
  async reconnect(): Promise<void> {
    if (this.active) throw new Error('Wait for the native turn to finish');
    if (this.state.blocked) throw new Error(this.state.blocked);
    if (this.state.pending.length)
      throw new Error(
        'Interrupted native tool batch: review OMS tool results, select Claude Code in /model, then use /clear to start a fresh native chat and clear the OMS conversation view; task files and verification are retained; tools will not be replayed',
      );
    if (!this.state.started) throw new Error('Send a message to start the native chat first');
    if (!this.configuration) throw new Error('Send a new message to reconnect the saved native session');
    await this.disconnect();
    await this.start();
  }
  private kill(signal: NodeJS.Signals): void {
    const child = this.child;
    try {
      if (process.platform !== 'win32' && child?.pid) process.kill(-child.pid, signal);
      else child?.kill(signal);
    } catch {
      /* exited */
    }
  }
  disconnect(): Promise<void> {
    return (this.disconnection ??= this.stop().finally(() => {
      this.disconnection = undefined;
    }));
  }
  private async stop(): Promise<void> {
    this.initialized = false;
    this.transportReady = false;
    this.active?.reject(new Error('Native conversation disconnected'));
    this.handshake?.reject(new Error('Native conversation disconnected'));
    if (this.child) {
      this.kill('SIGTERM');
      const timer = setTimeout(() => this.kill('SIGKILL'), 500);
      await this.exited;
      clearTimeout(timer);
    }
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.waiting = [];
    this.results.clear();
    this.delivered.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    if (this.transportDirectory) await rm(this.transportDirectory, { recursive: true, force: true });
    this.transportDirectory = undefined;
  }
  async close(): Promise<void> {
    await this.disconnect();
    if (this.temporaryWork) await rm(this.temporaryWork, { recursive: true, force: true });
  }
  private fail(error: unknown): void {
    this.failure =
      error instanceof SyntaxError
        ? 'Native returned malformed structured data'
        : error instanceof Error
          ? error.message
          : 'Invalid native protocol';
    if (!(error instanceof NativeEmptyResponseError || error instanceof NativeRefusalError))
      this.state.blocked =
        'Native protocol failed verification; review the OMS transcript, select Claude Code in /model, then use /clear to start a fresh native chat and clear the OMS conversation view; task files and verification are retained';
    this.save();
    this.handshake?.reject(new Error(this.failure));
    if (this.active) {
      this.active.failed = true;
      this.active.reject(
        error instanceof NativeEmptyResponseError || error instanceof NativeRefusalError
          ? error
          : new Error(this.failure),
      );
    }
    this.kill('SIGTERM');
    // Reap the whole native/MCP process group even when a protocol peer stalls.
    const child = this.child;
    setTimeout(() => {
      if (this.child === child) this.kill('SIGKILL');
    }, 500).unref();
  }
  private emptyResponse(): boolean {
    return (
      !!this.active &&
      !this.active.message.content.some(
        (block) => block.type === 'toolCall' || (block.type === 'text' && block.text.trim()),
      ) &&
      this.state.pending.every((call) => this.delivered.has(call.id))
    );
  }
  private async start(signal?: AbortSignal): Promise<void> {
    if (this.child) return;
    if (!this.configuration) throw new Error('No native session configuration');
    if (this.state.blocked) throw new Error(this.state.blocked);
    if (this.state.pending.length)
      throw new Error(
        'Interrupted native tool batch: review OMS tool results, select Claude Code in /model, then use /clear to start a fresh native chat and clear the OMS conversation view; task files and verification are retained; tools will not be replayed',
      );
    const startupSignal =
      signal && this.options.signal ? AbortSignal.any([signal, this.options.signal]) : (signal ?? this.options.signal);
    const auth = await inspectClaudeCode(startupSignal);
    startupSignal?.throwIfAborted();
    if (!auth.configured) throw new ClaudeCodeSignInError(auth.detail);
    const { model, context, maxTokens, effort } = this.configuration;
    const tools = getCurrentTools(context.messages);
    const names = new Set(tools.map((tool) => `mcp__oms__${tool.name}`));
    if (tools.some((tool) => !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) || names.size !== tools.length)
      throw new Error('Unsupported OMS tool declaration');
    const work = this.options.statePath
      ? `${this.options.statePath}.work`
      : (this.temporaryWork ??= await mkdtemp(join(tmpdir(), 'oms-native-work-')));
    if (this.options.statePath) privateDirectory(work);
    this.transportDirectory = await mkdtemp(join(tmpdir(), 'oc-'));
    const declarations = join(this.transportDirectory, 'tools.json');
    await writeFile(
      declarations,
      JSON.stringify(
        tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
      ),
      { mode: 0o600, flag: 'wx' },
    );
    const socketPath = join(this.transportDirectory, 's');
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      let pending = '';
      socket.setEncoding('utf8');
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => {});
      socket.on('data', (part) => {
        pending += part;
        if (Buffer.byteLength(pending) > 1_048_576) {
          this.fail(new Error('Oversized MCP request'));
          return;
        }
        const index = pending.indexOf('\n');
        if (index < 0) return;
        try {
          const call = object(JSON.parse(pending.slice(0, index)));
          if (call.type === 'register') {
            if (!isCount(call.pid) || call.pid === 0 || call.parentPid !== this.child?.pid)
              throw new Error('MCP process ownership changed');
            this.options.onSpawn?.(call.pid, work);
            socket.end(JSON.stringify({ registered: true }) + '\n');
            return;
          }
          if (
            typeof call.name !== 'string' ||
            !names.has(`mcp__oms__${call.name}`) ||
            this.waiting.some((item) => item.socket === socket)
          )
            throw new Error('Unregistered MCP request');
          this.waiting.push({ socket, name: call.name, args: call.arguments });
          this.flushResults();
        } catch (error) {
          this.fail(error);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(socketPath, resolve);
    });
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model',
      NATIVE_MODELS[model.id as NativeAlias],
      '--effort',
      effort,
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({
        mcpServers: tools.length
          ? {
              oms: {
                command: process.execPath,
                args: [fileURLToPath(new URL('./claude-code-mcp.ts', import.meta.url)), declarations, socketPath],
              },
            }
          : {},
      }),
      '--restricted',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--permission-prompts',
      'none',
      '--settings',
      '{"disableAllHooks":true,"autoMemoryEnabled":false,"claudeMdExcludes":["**"],"disableClaudeAiConnectors":true}',
      '--system-prompt',
      getCurrentSystemPrompt(context.messages),
      this.state.started ? '--resume' : '--session-id',
      this.state.sessionId,
    ];
    if (names.size) args.push('--allowedTools', ...names);
    const environment = claudeCodeEnvironment();
    environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
    const child = spawn(executable(), args, {
      cwd: work,
      env: environment,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.failure = undefined;
    this.exited = new Promise((resolve) =>
      child.once('close', () => {
        this.kill('SIGKILL');
        this.child = undefined;
        this.initialized = false;
        this.transportReady = false;
        this.active?.reject(
          this.emptyResponse()
            ? new NativeEmptyResponseError('Native process exited before completing its response')
            : new Error('Native process exited before completing its response'),
        );
        this.handshake?.reject(new Error('Native process exited before session initialization'));
        resolve();
      }),
    );
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', (error) => this.fail(error));
    child.stdout.setEncoding('utf8');
    let pending = '';
    child.stdout.on('data', (part) => {
      pending += part;
      if (Buffer.byteLength(pending) > 8_388_608) {
        this.fail(new Error('Oversized native event'));
        return;
      }
      for (;;) {
        const index = pending.indexOf('\n');
        if (index < 0) break;
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (!line.trim()) continue;
        try {
          this.event(object(JSON.parse(line)), names);
        } catch (error) {
          this.fail(error);
        }
      }
    });
    if (child.pid) {
      try {
        this.options.onSpawn?.(child.pid, work);
      } catch (error) {
        this.fail(error);
        throw error;
      }
    }
    // The native SDK's initialize control request validates startup/resume without
    // submitting a user prompt or making a model request; account data is ignored.
    const id = randomUUID();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.handshake = { id, resolve, reject };
        timeout = setTimeout(() => reject(new Error('Native session initialization timed out')), 15_000);
        child.stdin.write(
          JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } }) + '\n',
        );
      });
    } finally {
      clearTimeout(timeout);
      this.handshake = undefined;
    }
  }
  private flushResults(): void {
    if (!this.results.size) return;
    // Matching includes arguments and order, so identical calls remain separate and
    // every native tool-use ID gets exactly its own Pi result, including denials.
    for (const request of this.waiting) {
      if (request.socket.destroyed || request.socket.writableEnded) continue;
      const call = this.state.pending.find(
        (call) =>
          !this.delivered.has(call.id) &&
          call.name === request.name &&
          canonical(call.arguments) === canonical(request.args),
      );
      if (!call) {
        // Claude may start its next MCP call before the stream's message_stop.
        // It stays blocked until that response is published and Pi supplies results.
        if (this.active && !this.active.stopped) continue;
        if (this.state.pending.length) throw new Error('Native MCP call differs from assistant call');
        continue;
      }
      const result = this.results.get(call.id);
      if (!result) continue;
      this.delivered.add(call.id);
      this.toolResultDelivered = true;
      request.socket.end(JSON.stringify(result) + '\n');
    }
  }
  private finish(usage: NativeUsage, reason: 'toolUse' | 'stop' | 'length'): void {
    const current = this.active!;
    Object.assign(current.message.usage, usage);
    current.message.usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    if (
      usage.output > current.model.maxTokens ||
      usage.input + usage.cacheRead + usage.cacheWrite > current.model.contextWindow
    )
      throw new Error('Native usage exceeds the admitted model limits');
    calculateCost(current.model, current.message.usage);
    if (current.finishing) throw new Error('Duplicate native completion');
    current.finishing = true;
    // Consume the rest of this transport batch before publishing a trustworthy
    // checkpoint; duplicate stops/receipts in the batch must fail, not settle.
    setImmediate(() => {
      if (current.failed || this.active !== current) return;
      current.message.stopReason = reason;
      current.settled = true;
      this.active = undefined;
      current.resolve();
      current.output.push({ type: 'done', reason, message: current.message });
      current.output.end();
    });
  }

  private event(event: Record<string, unknown>, names: Set<string>): void {
    this.active?.onEvent();
    if (event.type === 'control_response') {
      const response = object(event.response);
      if (!this.handshake || response.request_id !== this.handshake.id || response.subtype !== 'success')
        throw new Error('Native session initialization refused');
      this.transportReady = true;
      this.handshake.resolve();
      return;
    }
    if (event.session_id !== undefined && event.session_id !== this.state.sessionId)
      throw new Error('Native session identity changed');
    if (event.type === 'system' && event.subtype === 'init') {
      if (
        !Array.isArray(event.tools) ||
        event.tools.length !== names.size ||
        event.tools.some((name) => typeof name !== 'string' || !names.has(name))
      )
        throw new Error('Native tool isolation failed');
      if (
        names.size &&
        (!Array.isArray(event.mcp_servers) ||
          !event.mcp_servers.some((server) => {
            const value = object(server);
            return value.name === 'oms' && value.status === 'connected';
          }))
      )
        throw new Error('OMS native tool bridge did not connect');
      this.initialized = true;
      this.state.started = true;
      this.save();
      return;
    }
    if (event.type === 'assistant') {
      if (event.parent_tool_use_id || !this.active || object(event.message).id !== this.active.nativeId)
        throw new Error('Unexpected native assistant or subagent response');
      return; // Partial events below carry the same response, exactly once.
    }
    if (event.type === 'stream_event') {
      const current = this.active;
      if (!current || !this.initialized || event.parent_tool_use_id) throw new Error('Unadmitted native model request');
      const part = object(event.event);
      if (part.type === 'message_start') {
        const native = object(part.message);
        if (
          current.nativeId ||
          native.model !== NATIVE_MODELS[current.model.id as NativeAlias] ||
          typeof native.id !== 'string'
        )
          throw new Error('Duplicate or changed native model response');
        current.nativeId = native.id;
        current.rawUsage = { ...object(native.usage) };
      } else if (part.type === 'content_block_start') {
        if (!current.nativeId || typeof part.index !== 'number' || current.blocks.has(part.index))
          throw new Error('Duplicate native block');
        const block = object(part.content_block),
          index = current.message.content.length;
        const mapping = { index: -1, json: '', stopped: false };
        current.blocks.set(part.index, mapping);
        if (block.type === 'text') {
          mapping.index = index;
          current.message.content.push({ type: 'text', text: typeof block.text === 'string' ? block.text : '' });
          current.output.push({ type: 'text_start', contentIndex: index, partial: current.message });
        } else if (block.type === 'tool_use') {
          if (
            typeof block.id !== 'string' ||
            typeof block.name !== 'string' ||
            !names.has(block.name) ||
            current.message.content.some((call) => call.type === 'toolCall' && call.id === block.id)
          )
            throw new Error('Unregistered or duplicate native tool call');
          mapping.index = index;
          current.message.content.push({
            type: 'toolCall',
            id: block.id,
            name: block.name.slice('mcp__oms__'.length),
            arguments: object(block.input ?? {}) as ToolCall['arguments'],
          });
          current.output.push({ type: 'toolcall_start', contentIndex: index, partial: current.message });
        } else if (block.type !== 'thinking' && block.type !== 'redacted_thinking')
          throw new Error('Unsupported native block');
      } else if (part.type === 'content_block_delta' || part.type === 'content_block_stop') {
        const mapping = current.blocks.get(part.index as number);
        if (!mapping || mapping.stopped) throw new Error('Unexpected native content event');
        const block = current.message.content[mapping.index];
        if (part.type === 'content_block_stop') {
          mapping.stopped = true;
          if (block?.type === 'text')
            current.output.push({
              type: 'text_end',
              contentIndex: mapping.index,
              content: block.text,
              partial: current.message,
            });
          else if (block?.type === 'toolCall') {
            if (mapping.json) block.arguments = object(JSON.parse(mapping.json)) as ToolCall['arguments'];
            current.output.push({
              type: 'toolcall_end',
              contentIndex: mapping.index,
              toolCall: block,
              partial: current.message,
            });
          }
        } else {
          const delta = object(part.delta);
          if (block?.type === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') {
            block.text += delta.text;
            current.output.push({
              type: 'text_delta',
              contentIndex: mapping.index,
              delta: delta.text,
              partial: current.message,
            });
          } else if (
            block?.type === 'toolCall' &&
            delta.type === 'input_json_delta' &&
            typeof delta.partial_json === 'string'
          ) {
            mapping.json += delta.partial_json;
            current.output.push({
              type: 'toolcall_delta',
              contentIndex: mapping.index,
              delta: delta.partial_json,
              partial: current.message,
            });
          } else if (mapping.index >= 0) throw new Error('Unexpected native delta');
        }
      } else if (part.type === 'message_delta') {
        if (!current.rawUsage || current.stop) throw new Error('Unexpected native usage delta');
        Object.assign(current.rawUsage, object(part.usage));
        current.stop = String(object(part.delta).stop_reason);
      } else if (part.type === 'message_stop') {
        if (
          current.stopped ||
          !current.stop ||
          !current.rawUsage ||
          [...current.blocks.values()].some((block) => !block.stopped)
        )
          throw new Error('Incomplete or duplicate native response');
        current.stopped = true;
        const usage = nativeUsage(current.rawUsage);
        const calls = current.message.content.filter((block) => block.type === 'toolCall');
        if (calls.length) {
          if (current.stop !== 'tool_use') throw new Error('Unexpected native tool stop');
          this.state.pending = structuredClone(calls);
          for (const key of usageKeys) this.state.emitted[key] += usage[key];
          this.delivered.clear();
          this.results.clear();
          this.waiting = this.waiting.filter((item) => !item.socket.writableEnded);
          this.save();
          this.finish(usage, 'toolUse');
        }
      }
      return;
    }
    if (event.type === 'result') {
      const current = this.active;
      if (current && event.is_error === true && event.subtype === 'error_during_execution' && this.emptyResponse()) {
        const usage = nativeUsage(event.usage);
        const reason = JSON.stringify([event.errors, event.error, event.result]);
        if (
          (usageKeys.every((key) => usage[key] === 0) ||
            usageKeys.every((key) => usage[key] === this.state.emitted[key])) &&
          !NATIVE_ACCOUNT_REASON.test(reason)
        )
          throw new NativeEmptyResponseError('Unexpected or failed native receipt');
      }
      if (
        !current ||
        current.finishing ||
        !current.stopped ||
        event.is_error ||
        event.subtype !== 'success' ||
        current.message.content.some((block) => block.type === 'toolCall')
      )
        throw classifyNativeReceipt(event);
      const models = object(event.modelUsage),
        nativeModel = NATIVE_MODELS[current.model.id as NativeAlias];
      if (Object.keys(models).length !== 1 || !Object.hasOwn(models, nativeModel))
        throw new Error('Unpriced native model fallback');
      const model = object(models[nativeModel]);
      if (
        model.provider !== 'firstParty' ||
        !isCount(model.contextWindow) ||
        !model.contextWindow ||
        model.contextWindow > current.model.contextWindow ||
        !isCount(model.maxOutputTokens) ||
        !model.maxOutputTokens ||
        model.maxOutputTokens > current.model.maxTokens
      )
        throw new Error('Native model limits changed');
      const aggregate = nativeUsage(event.usage),
        response = nativeUsage(current.rawUsage);
      for (const key of usageKeys)
        if (aggregate[key] !== this.state.emitted[key] + response[key])
          throw new Error('Native receipt does not reconcile assistant usage; hidden or missing request');
      const hosted = object(event.usage).server_tool_use;
      if (hosted && Object.values(object(hosted)).some((value) => value !== 0))
        throw new Error('Unpriced hosted tool usage');
      if (this.emptyResponse() && usageKeys.every((key) => response[key] === 0))
        throw new NativeEmptyResponseError('Native returned an empty response without usage');
      if (!current.message.content.length) throw new Error('Incomplete or duplicate native response');
      this.state.pending = [];
      this.state.emitted = emptyUsage();
      this.save();
      this.finish(response, current.stop === 'max_tokens' ? 'length' : 'stop');
    }
  }
  stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions) {
    const output = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      stopReason: 'stop',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    void (async () => {
      let abort: (() => void) | undefined;
      let timer: NodeJS.Timeout | undefined;
      let requestFinished = false;
      // Flips only once user input or tool results reach the native transport: before that,
      // a rejection proves no provider request exists and the reservation must be released.
      let nativeDispatched = false;
      try {
        options?.signal?.throwIfAborted();
        this.options.signal?.throwIfAborted();
        if (this.active) throw new Error('Native conversation is already active');
        if (
          model.provider !== CLAUDE_CODE_PROVIDER ||
          model.api !== CLAUDE_CODE_PROVIDER ||
          model.baseUrl !== CLAUDE_CODE_BASE_URL ||
          !Object.hasOwn(NATIVE_MODELS, model.id)
        )
          throw new Error('Unsupported Claude Code model');
        const effort = claudeCodeEffort(this.options.effort);
        const key = hash({
          model: model.id,
          effort,
          prompt: getCurrentSystemPrompt(context.messages),
          tools: getCurrentTools(context.messages),
        });
        if (this.configurationKey && this.configurationKey !== key) await this.disconnect();
        this.configuration = {
          model,
          context,
          maxTokens: Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens),
          effort,
        };
        this.configurationKey = key;
        // Cancellation covers native startup/auth as well as model streaming.
        abort = () => {
          if (requestFinished) return;
          this.handshake?.reject(new Error('Native startup cancelled'));
          this.active?.reject(new Error('Native turn cancelled'));
          this.kill('SIGTERM');
        };
        options?.signal?.addEventListener('abort', abort, { once: true });
        // Start/resume never silently substitutes a new native identity.
        await this.start(options?.signal);
        options?.signal?.throwIfAborted();
        const pending = this.state.pending;
        const user = context.messages.findLast((item) => item.role === 'user');
        const userKey = user ? hash(user) : undefined;
        await options?.onPayload?.(
          { model: model.id, effort, nativeSessionId: this.state.sessionId, continuation: pending.length > 0 },
          model,
        );
        const completion = new Promise<void>((resolve, reject) => {
          this.active = {
            model,
            message,
            output,
            resolve: () => {
              requestFinished = true;
              resolve();
            },
            reject,
            onEvent: () => {
              timer?.refresh();
            },
            stopped: false,
            settled: false,
            finishing: false,
            failed: false,
            blocks: new Map(),
          };
        });
        void completion.catch(() => {});
        timer = setTimeout(() => {
          if (this.emptyResponse()) {
            this.active?.reject(new NativeEmptyResponseError('Native turn timed out without a response'));
            this.kill('SIGTERM');
          } else abort?.();
        }, options?.timeoutMs || 120_000);
        output.push({ type: 'start', partial: message });
        if (pending.length) {
          if (userKey !== this.state.lastUser)
            throw new Error('Wait for the native tool batch to finish before sending another user message');
          for (const call of pending) {
            const result = context.messages.findLast(
              (item) => item.role === 'toolResult' && item.toolCallId === call.id,
            );
            if (!result || result.role !== 'toolResult')
              throw new Error('Missing real Pi tool result; native inference remains paused');
            if (result.content.some((block) => block.type !== 'text'))
              throw new Error('Native tool results currently support text only');
            this.results.set(call.id, { content: result.content, isError: result.isError });
          }
          nativeDispatched = true;
          this.flushResults();
          // Native owns the exact tool_result history; do not send a duplicate user message.
        } else {
          if (!user || user.role !== 'user' || (userKey === this.state.lastUser && userKey !== this.retryUser))
            throw new Error('No new user message for the native chat');
          if (typeof user.content !== 'string' && user.content.some((block) => block.type !== 'text'))
            throw new Error('Native chat currently supports text only');
          const retrying = userKey === this.retryUser;
          if (!retrying) this.toolResultDelivered = false;
          this.state.lastUser = userKey;
          this.retryUser = undefined;
          this.state.emitted = emptyUsage();
          this.save();
          this.child!.stdin.write(
            JSON.stringify({
              type: 'user',
              message: {
                role: 'user',
                content: retrying && this.toolResultDelivered ? CLAUDE_CODE_EMPTY_CONTINUATION : user.content,
              },
              parent_tool_use_id: null,
              session_id: this.state.sessionId,
            }) + '\n',
          );
          nativeDispatched = true;
        }
        await completion;
      } catch (error) {
        this.failure = error instanceof Error ? error.message : 'Native transport failed';
        this.initialized = false;
        this.transportReady = false;
        message.stopReason = options?.signal?.aborted || this.options.signal?.aborted ? 'aborted' : 'error';
        if (error instanceof NativeEmptyResponseError && message.stopReason === 'error' && !this.state.blocked) {
          message.rawStopReason = CLAUDE_CODE_EMPTY_RESPONSE;
          this.retryUser = this.state.lastUser;
          // Delivered tool results remain in the native session; retry with a continuation after any delivery.
          this.state.pending = [];
          this.state.emitted = emptyUsage();
          this.save();
        } else if (message.stopReason === 'error') {
          const interruptedMark = this.state.pending.length ? '|pending' : '';
          if (error instanceof ClaudeCodeSignInError) message.rawStopReason = CLAUDE_CODE_SIGNIN;
          else if (!nativeDispatched) message.rawStopReason = `${CLAUDE_CODE_NOT_DISPATCHED}:${this.failure}`;
          else if (error instanceof NativeAuthError) message.rawStopReason = `${CLAUDE_CODE_AUTH}${interruptedMark}`;
          else if (error instanceof NativeRateLimitError)
            message.rawStopReason = `${CLAUDE_CODE_RATE_LIMIT}${interruptedMark}`;
          else if (error instanceof NativeLimitError)
            message.rawStopReason = `${CLAUDE_CODE_LIMIT}${interruptedMark}${error.reset ? `:${error.reset}` : ''}`;
          // A refused turn admits the same user message again once its cause is fixed; a
          // still-pending tool batch keeps blocking new sends because replay cannot be proven safe.
          if (error instanceof NativeRefusalError && this.state.lastUser && !this.state.pending.length)
            this.retryUser = this.state.lastUser;
        }
        message.errorMessage = `Claude Code native chat stopped: ${this.failure}. No API-key fallback was used.`;
        // Error completion is not visible until the owned CLI/MCP process group
        // has exited, including the bounded SIGKILL escalation in stop().
        try {
          await this.disconnect();
        } catch {
          message.errorMessage += ' Native cleanup could not be verified; close OMS before continuing.';
        }
        output.push({ type: 'error', reason: message.stopReason, error: message });
        output.end();
      } finally {
        clearTimeout(timer);
        if (abort) options?.signal?.removeEventListener('abort', abort);
        if (this.active?.message === message) this.active = undefined;
      }
    })();
    return output;
  }
}
export function createClaudeCodeStream(session = new ClaudeCodeSession()) {
  return (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) =>
    session.stream(model, context, options);
}

/** Registers an ambient-auth native transport; no OAuth tokens enter Pi storage. */
export async function createClaudeCodeProvider(
  runtime: ModelRuntime,
  options?: ClaudeCodeSessionOptions,
): Promise<ClaudeCodeSession> {
  await inspectClaudeCode();
  const models = (Object.entries(NATIVE_MODELS) as [NativeAlias, string][]).flatMap(([alias, id]) => {
    const original = runtime.getModel('anthropic', id);
    return original
      ? [
          {
            ...original,
            id: alias,
            name: `Claude Code ${alias[0]!.toUpperCase() + alias.slice(1)} (subscription)`,
            provider: CLAUDE_CODE_PROVIDER,
            api: CLAUDE_CODE_PROVIDER,
            baseUrl: CLAUDE_CODE_BASE_URL,
            input: ['text'] as 'text'[],
            reasoning: false,
          },
        ]
      : [];
  });
  const session = new ClaudeCodeSession(options);
  const stream = createClaudeCodeStream(session);
  const provider: Provider = {
    id: CLAUDE_CODE_PROVIDER,
    name: 'Claude Code (subscription)',
    baseUrl: CLAUDE_CODE_BASE_URL,
    auth: {
      apiKey: {
        name: 'Native Claude Code login',
        async check() {
          return status.configured ? { type: 'api_key', source: 'Claude Code native login' } : undefined;
        },
        async resolve() {
          return status.configured ? { auth: {}, source: 'Claude Code native login' } : undefined;
        },
      },
    },
    getModels: () => models,
    stream,
    streamSimple: stream,
  };
  runtime.registerNativeProvider(provider);
  return session;
}
