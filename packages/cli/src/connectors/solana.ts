import { readLocalIdls, type Idl } from '@oms/engine';
import { referencedEnv } from './detect.ts';

export type Cluster = 'local' | 'devnet' | 'mainnet';
export const REMOTE_CLUSTERS = ['devnet', 'mainnet'] as const;
export type RemoteCluster = (typeof REMOTE_CLUSTERS)[number];

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

/** An explorer page for an address or a transaction. For the local chain it names the loopback RPC so the explorer can read it. */
export function explorerUrl(kind: 'address' | 'tx', id: string, cluster: Cluster, localRpc?: string): string {
  if (!BASE58.test(id)) throw new Error('Not a Solana address or signature.');
  const page = `https://explorer.solana.com/${kind}/${id}`;
  if (cluster === 'mainnet') return page;
  if (cluster === 'devnet') return `${page}?cluster=devnet`;
  if (!localRpc) throw new Error('The local chain has no address to show.');
  return `${page}?cluster=custom&customUrl=${encodeURIComponent(localRpc)}`;
}

// ---------------------------------------------------------------- read-only lookups on devnet and mainnet

/** The only methods that run remotely. None of them changes anything. */
export const REMOTE_METHODS: ReadonlySet<string> = new Set([
  'getAccountInfo',
  'getBalance',
  'getTransaction',
  'getSignaturesForAddress',
  'getTokenSupply',
  'getSlot',
  'getEpochInfo',
  'getVersion',
]);

const PUBLIC: Record<RemoteCluster, string> = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
};

/**
 * The address to ask for `cluster`: the saved one for mainnet (its `${ENV}` references filled from the environment now,
 * never stored), else Helius when HELIUS_API_KEY is set, else the public endpoint. The result holds a key: never print it.
 */
export function rpcAddress(cluster: RemoteCluster, saved: string | undefined, env: NodeJS.ProcessEnv): string {
  if (saved && cluster === 'mainnet') {
    const missing = referencedEnv(saved).filter((name) => !env[name]);
    if (missing.length) throw new Error(`Set ${missing[0]} in your shell, then try again.`);
    return saved.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => encodeURIComponent(env[name]!));
  }
  const key = env.HELIUS_API_KEY;
  if (key)
    return `https://${cluster === 'mainnet' ? 'mainnet' : 'devnet'}.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  return PUBLIC[cluster];
}

/** One read-only JSON-RPC call. Errors never carry the address, which may hold a key. */
export async function remoteRpc(
  cluster: RemoteCluster,
  method: string,
  params: unknown[],
  options: { saved?: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<unknown> {
  if (!REMOTE_METHODS.has(method)) throw new Error(`${method} is not available on ${cluster}: lookups are read-only.`);
  const url = rpcAddress(cluster, options.saved, options.env ?? process.env);
  const timeout = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch {
    throw new Error(`The ${cluster} RPC did not answer.`);
  }
  if (response.status === 401 || response.status === 403)
    throw new Error(`The ${cluster} RPC refused the key (HTTP ${response.status}).`);
  if (!response.ok) throw new Error(`The ${cluster} RPC answered HTTP ${response.status}.`);
  let body: { result?: unknown; error?: unknown };
  try {
    body = (await response.json()) as { result?: unknown; error?: unknown };
  } catch {
    throw new Error(`The ${cluster} RPC gave an unreadable answer.`);
  }
  if (body.error) throw new Error(`The ${cluster} RPC reported an error for ${method}.`);
  return body.result;
}

/** `--cluster devnet|mainnet` at the end of a command's argument: the rest, and the cluster. Undefined cluster when absent. */
export function splitCluster(argument: string): { rest: string; cluster?: RemoteCluster; invalid?: true } {
  const match = /^(.*?)(?:\s+|^)--cluster(?:\s+|=)(\S+)\s*$/.exec(argument.trim());
  if (!match) return { rest: argument.trim() };
  const cluster = match[2];
  return (REMOTE_CLUSTERS as readonly string[]).includes(cluster!)
    ? { rest: match[1]!.trim(), cluster: cluster as RemoteCluster }
    : { rest: match[1]!.trim(), invalid: true };
}

// ---------------------------------------------------------------- programs from the project's IDLs

export interface IdlProgram {
  name: string;
  address?: string;
  instructions: string[];
  errors: number;
}

/** What `target/idl` holds, for a programs list next to the editor. Empty when nothing is built yet. */
export function idlPrograms(root: string): IdlProgram[] {
  let idls: Idl[];
  try {
    idls = readLocalIdls(root);
  } catch {
    return [];
  }
  return idls.map((idl, index) => ({
    name: idl.metadata?.name ?? idl.name ?? `program ${index + 1}`,
    ...((idl.address ?? idl.metadata?.address) ? { address: idl.address ?? idl.metadata?.address } : {}),
    instructions: (idl.instructions ?? []).map((instruction) => instruction.name),
    errors: idl.errors?.length ?? 0,
  }));
}

/** The text Enter puts in the composer for an instruction: a request the person can finish. */
export const idlSnippet = (program: string, instruction?: string): string =>
  instruction ? `Add a test for the ${instruction} instruction of ${program}.` : `Explain the ${program} program.`;
