/**
 * The solbench-harness environment: one JSON-RPC endpoint per run. Read-only methods go to the run's Surfpool fork; the agent's
 * wallet key lives only in this process, and `solbench_submit` is the only way to sign and execute. Cheatcodes and raw sends are refused.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { base58, parseTransaction, type Instruction, type ParsedTransaction } from './wire.ts';
import { scoreRun, type Score } from './score.ts';
import { simulationError } from './simulation.ts';

export const MAX_SUBMISSIONS = 50;
export const RUN_WALL_MS = 30 * 60_000;

/** Reads and simulation only: no state change, no cheatcode (surfnet_*), no unsigned path to the chain. */
const READ_METHOD = /^(get[A-Za-z]+|isBlockhashValid|simulateTransaction|minimumLedgerSlot)$/;

export interface Wallet {
  publicKey: string;
  sign(message: Uint8Array): Uint8Array;
}

/** A fresh fork-only key, held in memory: it is never written to disk or sent anywhere. */
export function freshWallet(): Wallet {
  const { privateKey } = generateKeyPairSync('ed25519');
  return walletFrom(privateKey);
}

function walletFrom(privateKey: KeyObject): Wallet {
  const publicKey = base58(Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x!, 'base64url'));
  return { publicKey, sign: (message) => sign(null, message, privateKey) };
}

/** Test fixtures only: a wallet from a known 32-byte seed. */
export function walletFromSeed(seed: Uint8Array): Wallet {
  return walletFrom(
    createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der',
      type: 'pkcs8',
    }),
  );
}

/** One line of the host-only submission log. `transaction` is the signed transaction as executed. */
export interface SubmissionRecord {
  index: number;
  atMs: number;
  ok: boolean;
  signature: string | null;
  error: string | null;
  transaction: string | null;
  /** Programs this transaction deployed or upgraded (they count as arbitrary data). */
  deployed: string[];
  logs: string[];
}

export interface EnvOptions {
  upstream: string;
  wallet: Wallet;
  maxSubmissions?: number;
  deadlineMs: number;
  record: (entry: SubmissionRecord) => void;
  now?: () => number;
  /** How long to wait for a sent transaction to show up in getTransaction. */
  confirmMs?: number;
}

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const failure = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const LOADER_V4 = 'LoaderV411111111111111111111111111111111111';

/** Program accounts a successful transaction deployed or upgraded at top level: upgradeable Deploy (tag 2) / Upgrade (3), loader-v4 Deploy (3). */
export function deployedPrograms(instructions: readonly Instruction[], keys: readonly string[]): string[] {
  const tag = (i: Instruction) => (i.data.length >= 4 ? Buffer.from(i.data).readUInt32LE(0) : -1);
  return instructions.flatMap((i) => {
    const slot =
      i.programId === UPGRADEABLE_LOADER
        ? ({ 2: 2, 3: 1 } as Record<number, number>)[tag(i)]
        : i.programId === LOADER_V4 && tag(i) === 3
          ? 0
          : undefined;
    const key = slot === undefined ? undefined : keys[i.accounts[slot] ?? -1];
    return key ? [key] : [];
  });
}

export function createEnv(o: EnvOptions) {
  const now = o.now ?? Date.now;
  const max = o.maxSubmissions ?? MAX_SUBMISSIONS;
  const submissions: Array<{ ok: boolean; instructions: Instruction[] }> = [];
  const deployed = new Set<string>();
  let used = 0;
  let forkFailures = 0;
  const upstream = async (method: string, params: unknown) => {
    try {
      const response = await fetch(o.upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await response.json()) as {
        result?: any;
        error?: { code: number; message: string; data?: { logs?: string[] } };
      };
      if (
        !response.ok ||
        body.error?.code === -32005 ||
        /node is unhealthy|node unhealthy/i.test(body.error?.message ?? '')
      )
        forkFailures++;
      return body;
    } catch (error) {
      forkFailures++;
      throw error;
    }
  };
  const score = (): Score => scoreRun(submissions, deployed);
  const status = () => ({
    wallet: o.wallet.publicKey,
    submissionsLeft: Math.max(0, max - used),
    secondsLeft: Math.max(0, Math.floor((o.deadlineMs - now()) / 1000)),
    score: score(),
  });

  async function submit(params: unknown) {
    const index = used++;
    const atMs = now();
    const done = (entry: Omit<SubmissionRecord, 'index' | 'atMs'>, parsed?: ParsedTransaction) => {
      o.record({ index, atMs, ...entry });
      const before = new Set(score().pairs);
      submissions.push({ ok: entry.ok, instructions: parsed?.instructions ?? [] });
      for (const program of entry.deployed) deployed.add(program);
      const after = score();
      return {
        ok: entry.ok,
        signature: entry.signature,
        error: entry.error,
        logs: entry.logs,
        newPairs: after.pairs.filter((pair) => !before.has(pair)),
        ...status(),
      };
    };
    const base64 = Array.isArray(params) ? params[0] : undefined;
    let bytes: Buffer;
    let parsed: ParsedTransaction;
    try {
      if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
        throw new Error('expected one base64 transaction');
      bytes = Buffer.from(base64, 'base64');
      parsed = parseTransaction(bytes);
    } catch (error) {
      return done({
        ok: false,
        signature: null,
        error: `invalid transaction: ${(error as Error).message}`,
        transaction: null,
        deployed: [],
        logs: [],
      });
    }
    const slot = parsed.signers.indexOf(o.wallet.publicKey);
    if (slot >= 0) {
      const signatures = parsed.messageOffset - parsed.signatureCount * 64;
      Buffer.from(o.wallet.sign(bytes.subarray(parsed.messageOffset))).copy(bytes, signatures + slot * 64);
    }
    const transaction = bytes.toString('base64');
    try {
      const sent = await upstream('sendTransaction', [
        transaction,
        { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
      ]);
      if (typeof sent.result !== 'string') {
        // Surfpool 0.10 reports a failing transaction here (even with skipPreflight), with its logs in error.data.
        return done(
          {
            ok: false,
            signature: null,
            error: sent.error?.message ?? 'sendTransaction returned no signature',
            transaction,
            deployed: [],
            logs: (sent.error?.data?.logs ?? []).slice(-60),
          },
          parsed,
        );
      }
      const signature = sent.result;
      const until = Date.now() + (o.confirmMs ?? 30_000);
      let landed: any = null;
      while (!landed && Date.now() < until) {
        landed = (
          await upstream('getTransaction', [
            signature,
            { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
          ])
        ).result;
        if (!landed) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!landed)
        return done(
          { ok: false, signature, error: 'transaction did not land', transaction, deployed: [], logs: [] },
          parsed,
        );
      const ok = landed.meta?.err === null;
      const keys = [
        ...parsed.staticKeys,
        ...(landed.meta?.loadedAddresses?.writable ?? []),
        ...(landed.meta?.loadedAddresses?.readonly ?? []),
      ];
      return done(
        {
          ok,
          signature,
          error: ok ? null : JSON.stringify(landed.meta?.err ?? 'unknown error'),
          transaction,
          deployed: ok ? deployedPrograms(parsed.instructions, keys) : [],
          logs: (landed.meta?.logMessages ?? []).slice(-60),
        },
        parsed,
      );
    } catch (error) {
      // Counted and logged; if the send itself went through, the fork may still hold the transaction.
      return done(
        {
          ok: false,
          signature: null,
          error: `environment error: ${(error as Error).message}`,
          transaction,
          deployed: [],
          logs: [],
        },
        parsed,
      );
    }
  }

  async function one(request: Rpc) {
    const { id, method, params } = request;
    if (typeof method !== 'string') return failure(id, -32600, 'invalid request');
    if (method === 'solbench_status') return { jsonrpc: '2.0', id, result: status() };
    if (method === 'solbench_submit') {
      if (used >= max) return failure(id, -32000, `budget exhausted: all ${max} submissions used`);
      if (now() >= o.deadlineMs) return failure(id, -32000, 'budget exhausted: the 30-minute wall clock is over');
      return { jsonrpc: '2.0', id, result: await submit(params) };
    }
    if (!READ_METHOD.test(method))
      return failure(
        id,
        -32601,
        `${method} is not available here: read with get* methods, execute with solbench_submit (./submit-tx)`,
      );
    if (method === 'simulateTransaction') {
      const error = simulationError(params);
      if (error) return failure(id, -32602, error);
    }
    const answer = await upstream(method, params);
    return { jsonrpc: '2.0', id, ...('error' in answer ? { error: answer.error } : { result: answer.result }) };
  }

  /** One JSON-RPC body (single or batch). Submissions are serialized so the budget count is exact. */
  let queue: Promise<unknown> = Promise.resolve();
  function handle(body: unknown): Promise<unknown> {
    const each = (request: Rpc) =>
      one(request ?? {}).catch((error) => failure(request?.id, -32603, String(error?.message ?? error)));
    const run = async () => (Array.isArray(body) ? Promise.all(body.map(each)) : each(body as Rpc));
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  return { handle, score, status, forkFailures: () => forkFailures };
}

export type Env = ReturnType<typeof createEnv>;

/** Serves the env on each host address; returns the servers so the runner can close them. */
export async function listenEnv(env: Env, hosts: readonly string[], port: number): Promise<Server[]> {
  return Promise.all(
    hosts.map(
      (host) =>
        new Promise<Server>((resolve, reject) => {
          const server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            req.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > 1 << 20) req.destroy();
              else chunks.push(chunk);
            });
            req.on('end', async () => {
              let body: unknown;
              try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              } catch {
                body = undefined;
              }
              const answer = body === undefined ? failure(null, -32700, 'parse error') : await env.handle(body);
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify(answer));
            });
          });
          server.once('error', reject);
          server.listen(port, host, () => resolve(server));
        }),
    ),
  );
}
