import type { OmsSession } from '@oms/engine';
import { CATALOG, type ConnectorSpec } from './catalog.ts';
import type { ConnectorId, ConnectorsConfig } from './config.ts';
import type { HostRun } from './host.ts';

/** Where a connector stands on this machine. Only the account name is ever read from a program's output, never a credential. */
export type Availability = 'ready' | 'signin' | 'missing' | 'error';
export interface Detection {
  state: Availability;
  /** Who is signed in, or which version or profile: one short word. */
  account?: string;
  /** One plain sentence about the state, for when it is not ready. */
  detail?: string;
}

export interface DetectDeps {
  run: HostRun;
  env: NodeJS.ProcessEnv;
  cwd: string;
  config: ConnectorsConfig;
  /** Whether a sign-in was stored for a hosted connector. Presence only. */
  hasSignIn(server: string, url: string): boolean;
}

const word = (text: string | undefined): string | undefined => {
  const found = text?.trim();
  return found && /^[A-Za-z0-9_.@+-]{1,64}$/.test(found) ? found : undefined;
};
const AUTH_CHECK_MS = 4_000;

/** `gh auth status` / `glab auth status`: the exit code decides; the account name is read from the line that names it. */
export function parseAuthStatus(output: string): string | undefined {
  return word(/Logged in to \S+ (?:account|as) (\S+)/i.exec(output)?.[1]);
}

async function detectCli(spec: ConnectorSpec, deps: DetectDeps): Promise<Detection> {
  const host = deps.config.connectors[spec.id]?.options?.host ?? spec.host!;
  const result = await deps.run(spec.program!, ['auth', 'status', '--hostname', host], {
    cwd: deps.cwd,
    timeoutMs: AUTH_CHECK_MS,
    env: deps.env,
  });
  if (result.error === 'missing') return { state: 'missing', detail: `${spec.program} is not installed.` };
  if (result.error === 'timeout') return { state: 'error', detail: `${spec.program} did not answer in time.` };
  if (result.code === 0) return { state: 'ready', account: parseAuthStatus(`${result.stdout}\n${result.stderr}`) };
  return { state: 'signin', detail: `Not signed in to ${host}.` };
}

async function detectDocker(spec: ConnectorSpec, deps: DetectDeps): Promise<Detection> {
  const result = await deps.run('docker', ['version', '--format', '{{.Server.Version}}'], {
    cwd: deps.cwd,
    timeoutMs: 4_000,
    env: deps.env,
  });
  if (result.error === 'missing') return { state: 'missing', detail: 'Docker is not installed.' };
  if (result.code === 0) return { state: 'ready', account: word(result.stdout) };
  return { state: 'error', detail: 'Docker is installed but not running. Start Docker Desktop.' };
}

/** Profiles from `aws configure list-profiles`, or the environment's own keys. No network call. */
export async function detectAws(deps: DetectDeps): Promise<Detection> {
  const result = await deps.run('aws', ['configure', 'list-profiles'], {
    cwd: deps.cwd,
    timeoutMs: 4_000,
    env: deps.env,
  });
  if (result.error === 'missing') return { state: 'missing', detail: 'The AWS command line is not installed.' };
  const profiles =
    result.code === 0
      ? result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
  const chosen = deps.config.connectors.aws?.options?.profile ?? deps.env.AWS_PROFILE;
  const fromEnv = !!deps.env.AWS_ACCESS_KEY_ID && !!deps.env.AWS_SECRET_ACCESS_KEY;
  if (!profiles.length && !fromEnv) return { state: 'signin', detail: 'No AWS profile yet.' };
  if (chosen && !fromEnv && !profiles.includes(chosen))
    return { state: 'signin', detail: `The profile ${chosen} does not exist.` };
  return {
    state: 'ready',
    account:
      word(chosen) ??
      (fromEnv && !profiles.length ? 'environment keys' : profiles.includes('default') ? 'default' : word(profiles[0])),
  };
}

function detectHosted(spec: ConnectorSpec, deps: DetectDeps): Detection {
  return deps.hasSignIn(spec.mcp!.server, spec.mcp!.url)
    ? { state: 'ready', account: 'signed in' }
    : { state: 'signin', detail: `Not signed in to ${spec.label}.` };
}

/** The names a saved RPC address takes its key from: `${HELIUS_API_KEY}` gives HELIUS_API_KEY. */
export const referencedEnv = (value: string | undefined): string[] =>
  [...(value ?? '').matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((match) => match[1]!);

function detectRpc(deps: DetectDeps): Detection {
  const saved = deps.config.connectors['solana-rpc']?.options?.rpc;
  if (saved) {
    const missing = referencedEnv(saved).filter((name) => !deps.env[name]);
    return missing.length
      ? { state: 'signin', detail: `Set ${missing[0]} in your shell, then recheck.` }
      : { state: 'ready', account: 'your RPC' };
  }
  return deps.env.HELIUS_API_KEY ? { state: 'ready', account: 'Helius' } : { state: 'ready', account: 'public RPC' };
}

const settled = async (work: Promise<Detection>): Promise<Detection> =>
  work.catch(() => ({ state: 'error', detail: 'The check did not complete.' }) as Detection);

/** Every connector's state, checked in parallel. A failed check is an error row, never an exception. */
export async function detectAll(deps: DetectDeps): Promise<Record<ConnectorId, Detection>> {
  const out = {} as Record<ConnectorId, Detection>;
  await Promise.all(
    CATALOG.map(async (spec) => {
      out[spec.id] = await settled(
        (async () => {
          if (spec.id === 'docker') return detectDocker(spec, deps);
          if (spec.id === 'aws') return detectAws(deps);
          if (spec.kind === 'cli') return detectCli(spec, deps);
          if (spec.kind === 'mcp-remote') return detectHosted(spec, deps);
          return detectRpc(deps);
        })(),
      );
    }),
  );
  return out;
}

/** `aws sts get-caller-identity`: the one network check, run only when the person asks. Returns the account id or a failure. */
export async function verifyAws(deps: DetectDeps): Promise<Detection> {
  const profile = deps.config.connectors.aws?.options?.profile;
  const result = await deps.run(
    'aws',
    ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager', ...(profile ? ['--profile', profile] : [])],
    {
      cwd: deps.cwd,
      timeoutMs: 15_000,
      env: deps.env,
    },
  );
  if (result.code !== 0)
    return { state: 'signin', detail: 'AWS did not accept the credentials. Run aws configure sso, then recheck.' };
  try {
    const account = word(String((JSON.parse(result.stdout) as { Account?: unknown }).Account));
    return { state: 'ready', account: account ? `account ${account}` : 'verified' };
  } catch {
    return { state: 'ready', account: 'verified' };
  }
}

// ---------------------------------------------------------------- what OMS has built in

export interface BuiltinRow {
  id: string;
  label: string;
  state: Availability | 'off';
  detail: string;
  /** The command that manages it, shown as a hint. */
  manage?: string;
}

/** The tools every session already has, read from the live session. They are shown here so one list covers everything. */
export async function builtinRows(harness: OmsSession): Promise<BuiltinRow[]> {
  const rows: BuiltinRow[] = [];
  const web = harness.web;
  rows.push(
    web
      ? {
          id: 'web',
          label: 'Web search',
          state: web.enabled() ? 'ready' : 'off',
          detail: web.enabled() ? 'on' : 'off',
          manage: '/web on|off',
        }
      : { id: 'web', label: 'Web search', state: 'off', detail: 'not in this session' },
    web
      ? {
          id: 'solana-docs',
          label: 'Solana docs',
          state: web.enabled() ? 'ready' : 'off',
          detail: web.enabled() ? 'official docs, on with web' : 'off with web',
          manage: '/web on|off',
        }
      : { id: 'solana-docs', label: 'Solana docs', state: 'off', detail: 'not in this session' },
    harness.knowledge?.config?.()
      ? { id: 'knowledge', label: 'Docs search', state: 'ready', detail: 'hosted Solana docs', manage: '/account' }
      : {
          id: 'knowledge',
          label: 'Docs search',
          state: 'off',
          detail: 'sign in with /login to turn on',
          manage: '/login',
        },
  );
  if (harness.chain) {
    const health = await harness.chain.health().catch(() => ({ ok: false }) as { ok: boolean });
    rows.push({
      id: 'chain',
      label: 'Local chain',
      state: health.ok ? 'ready' : 'off',
      detail: health.ok ? 'Surfpool is running' : 'Surfpool is not running',
      manage: '/chain',
    });
  }
  rows.push({
    id: 'program-reference',
    label: 'Program reference',
    state: 'ready',
    detail: 'offline, always on',
    manage: '/program',
  });
  return rows;
}
