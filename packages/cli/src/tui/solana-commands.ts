import { formatDuration } from '@oms/core';
import {
  builtInProgramName,
  decodeProgramError,
  lookupProgramReference,
  parseErrorCode,
  programReference,
  readLocalIdls,
  type ErrorDecoding,
  type OmsSession,
  type Idl,
} from '@oms/engine';
import { explorerUrl, remoteRpc, splitCluster, type RemoteCluster } from '../connectors/solana.ts';
import type { Connectors } from '../connectors/runtime.ts';
import { refuse, type Prepared } from './prepared.ts';

// ---------------------------------------------------------------- base58 and formatting

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(text: string): Uint8Array | undefined {
  if (!text) return undefined;
  let value = 0n;
  for (const character of text) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) return undefined;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; value > 0n; value >>= 8n) bytes.unshift(Number(value & 0xffn));
  let zeros = 0;
  while (text[zeros] === '1') zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let text = '';
  for (; value > 0n; value /= 58n) text = ALPHABET[Number(value % 58n)]! + text;
  let zeros = 0;
  while (bytes[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + text;
}

/** An address is a base58 text of exactly 32 bytes; a signature, 64. */
export const isBase58Bytes = (text: string, length: number): boolean => base58Decode(text)?.length === length;

const sol = (lamports: number | bigint): string => {
  const whole = BigInt(lamports);
  const fraction = String(whole % 1_000_000_000n)
    .padStart(9, '0')
    .replace(/0+$/, '');
  return `${whole / 1_000_000_000n}${fraction ? '.' + fraction : ''} SOL`;
};
const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit)}…`);
const programName = (id: string): string | undefined =>
  builtInProgramName(id) ?? programReference().programs.find((program) => program.id === id)?.name;
const named = (id: string): string => {
  const name = programName(id);
  return name ? `${id} (${name})` : id;
};

// ---------------------------------------------------------------- the local chain

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The task's own Surfpool, or a refusal. Anything that is not its loopback RPC is never used. */
export function localChain(harness: OmsSession) {
  const chain = harness.chain;
  if (!chain) throw new Error('This session has no local chain.');
  const url = chain.rpcUrl();
  if (!url) throw new Error('The local chain is not running.');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Refusing: the chain RPC URL is not valid.');
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error(
      `Refusing: ${parsed.host} is not this session's local Surfpool. Chain commands never touch devnet or mainnet.`,
    );
  }
  return { chain, url };
}

/** Where an account or transaction is read from: the task's own chain, or a remote cluster read-only. */
interface RpcSource {
  call(method: string, params?: unknown[], signal?: AbortSignal): Promise<unknown>;
  /** "on the local chain", "on devnet". */
  where: string;
  explorer(kind: 'address' | 'tx', id: string): string;
}
function chainSource(harness: OmsSession): RpcSource {
  const { chain, url } = localChain(harness);
  return {
    call: (method, params) => chain.call(method, params),
    where: 'on the local chain',
    explorer: (kind, id) => explorerUrl(kind, id, 'local', url),
  };
}
function remoteSource(cluster: RemoteCluster, connectors: Connectors): RpcSource {
  return {
    call: (method, params, signal) =>
      remoteRpc(cluster, method, params ?? [], {
        saved: connectors.option('solana-rpc', 'rpc'),
        env: connectors.env,
        signal,
      }),
    where: `on ${cluster}`,
    explorer: (kind, id) => explorerUrl(kind, id, cluster),
  };
}
/** `--cluster` needs the Solana RPC connector on: nothing leaves the machine for a remote RPC before the user says so. */
function clusterRefusal(argument: string, connectors: Connectors | undefined, usage: string): Prepared | undefined {
  const { cluster, invalid } = splitCluster(argument);
  if (invalid) return refuse(`${usage} · devnet or mainnet only`);
  if (cluster && (!connectors || connectors.access('solana-rpc') === 'off'))
    return refuse(`Looking up ${cluster} needs Solana RPC. Turn it on in /connectors.`);
  return undefined;
}
/** The local chain by default; a remote cluster for `--cluster`. */
function sourceFor(argument: string, harness: OmsSession, connectors: Connectors | undefined): RpcSource {
  const { cluster } = splitCluster(argument);
  return cluster ? remoteSource(cluster, connectors!) : chainSource(harness);
}

const value = (result: unknown): unknown =>
  result && typeof result === 'object' && 'value' in result ? (result as { value: unknown }).value : result;

export function prepareChain(argument: string, harness: OmsSession): Prepared {
  if (argument) return refuse('Usage: /chain');
  return {
    ok: true,
    async run() {
      const { chain, url } = localChain(harness);
      const health = await chain.health();
      const [slot, version] = health.ok
        ? await Promise.all([
            chain.call('getSlot').catch(() => undefined),
            chain.call('getVersion').catch(() => undefined) as Promise<{ 'solana-core'?: string } | undefined>,
          ])
        : [undefined, undefined];
      return {
        title: 'chain',
        text: [
          `RPC: ${url}`,
          `Health: ${health.ok ? 'ok' : `down${health.detail ? ' · ' + clip(health.detail, 200) : ''}`}`,
          `Slot: ${slot ?? 'unavailable'}`,
          'Network: offline Surfpool, not a mainnet fork',
          `Uptime: ${formatDuration(chain.uptimeMs())}${version?.['solana-core'] ? ` · solana-core ${clip(String(version['solana-core']), 40)}` : ''}`,
        ].join('\n'),
      };
    },
  };
}

export function prepareRewind(argument: string, harness: OmsSession): Prepared {
  if (argument && argument !== 'confirm') return refuse('Usage: /rewind confirm');
  return {
    ok: true,
    async run() {
      const { chain } = localChain(harness);
      if (argument !== 'confirm') {
        return {
          title: 'rewind',
          text: 'This restarts the local chain from its starting state. Accounts, deployed programs and transactions made since this session started are lost; your files stay.\nRun /rewind confirm to do it.',
        };
      }
      await chain.rewind();
      const slot = await chain.call('getSlot').catch(() => undefined);
      return { title: 'rewind', text: `Local chain restored to its starting state · slot ${slot ?? 'unavailable'}` };
    },
  };
}

const AIRDROP_CAP_SOL = 100;

export function prepareAirdrop(argument: string, harness: OmsSession): Prepared {
  const [address, amount = '1', ...extra] = argument.split(/\s+/).filter(Boolean);
  if (!address || extra.length) return refuse('Usage: /airdrop <address> [sol]');
  if (!isBase58Bytes(address, 32)) return refuse('Not a valid Solana address · base58, 32 bytes');
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(amount);
  const lamports = match ? BigInt(match[1]!) * 1_000_000_000n + BigInt((match[2] ?? '').padEnd(9, '0')) : 0n;
  if (lamports <= 0n) return refuse('Amount must be a positive number of SOL, for example 2.5');
  if (lamports > BigInt(AIRDROP_CAP_SOL) * 1_000_000_000n)
    return refuse(`Airdrops are capped at ${AIRDROP_CAP_SOL} SOL`);
  return {
    ok: true,
    async run() {
      const { chain } = localChain(harness);
      const before = Number(value(await chain.call('getBalance', [address])) ?? 0);
      const signature = String(await chain.call('requestAirdrop', [address, Number(lamports)]));
      let after = before;
      for (let attempt = 0; attempt < 10 && after < before + Number(lamports); attempt++) {
        after = Number(value(await chain.call('getBalance', [address])) ?? after);
        if (after < before + Number(lamports)) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return {
        title: 'airdrop',
        text: `Airdropped ${sol(lamports)} to ${address} on the local chain\nSignature: ${signature}\nBalance: ${sol(after)}`,
      };
    },
  };
}

// ---------------------------------------------------------------- accounts

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const u64 = (bytes: Uint8Array, at: number): bigint => Buffer.from(bytes).readBigUInt64LE(at);
const optionKey = (bytes: Uint8Array, at: number): string =>
  bytes[at] === 1 ? base58Encode(bytes.subarray(at + 4, at + 36)) : 'none';

/** Mint and token-account basics from the layout every Token-compatible program shares (a mint is 82 bytes, an account 165). */
export function describeTokenData(data: Uint8Array): string[] {
  const extended = data.length > 165;
  const kind =
    data.length === 82
      ? 'mint'
      : data.length === 165
        ? 'token-account'
        : extended
          ? data[165] === 1
            ? 'mint'
            : data[165] === 2
              ? 'token-account'
              : undefined
          : undefined;
  if (kind === 'mint' && data.length >= 82) {
    return [
      'Token mint:',
      `  supply: ${u64(data, 36)} (raw)`,
      `  decimals: ${data[44]}`,
      `  initialized: ${data[45] === 1}`,
      `  mint authority: ${optionKey(data, 0)}`,
      `  freeze authority: ${optionKey(data, 46)}`,
      ...(extended ? ['  has extensions (Token-2022)'] : []),
    ];
  }
  if (kind === 'token-account' && data.length >= 165) {
    return [
      'Token account:',
      `  mint: ${base58Encode(data.subarray(0, 32))}`,
      `  owner: ${base58Encode(data.subarray(32, 64))}`,
      `  amount: ${u64(data, 64)} (raw)`,
      `  state: ${['uninitialized', 'initialized', 'frozen'][data[108]!] ?? 'unknown'}`,
      `  delegate: ${optionKey(data, 72)}`,
      `  close authority: ${optionKey(data, 129)}`,
      ...(extended ? ['  has extensions (Token-2022)'] : []),
    ];
  }
  return [];
}

const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

export function prepareAccount(argument: string, harness: OmsSession, connectors?: Connectors): Prepared {
  const { rest } = splitCluster(argument);
  if (!isBase58Bytes(rest, 32))
    return refuse('Usage: /account <address> [--cluster devnet|mainnet] · base58, 32 bytes');
  const refusal = clusterRefusal(argument, connectors, 'Usage: /account <address> [--cluster devnet|mainnet]');
  if (refusal) return refusal;
  const address = rest;
  return {
    ok: true,
    async run(signal) {
      const source = sourceFor(argument, harness, connectors);
      const info = value(await source.call('getAccountInfo', [address, { encoding: 'base64' }], signal)) as {
        lamports: number;
        owner: string;
        data: [string, string];
        executable: boolean;
      } | null;
      const link = `Explorer: ${source.explorer('address', address)}`;
      if (!info) return { title: 'account', text: `${address}\nNo account at this address ${source.where}.\n${link}` };
      const data = Buffer.from(info.data?.[0] ?? '', 'base64');
      return {
        title: 'account',
        text: [
          address,
          `Owner: ${named(info.owner)}`,
          `Lamports: ${info.lamports} (${sol(info.lamports)})`,
          `Data: ${data.length} bytes`,
          `Executable: ${info.executable}`,
          ...(data.length ? [`Preview: ${hex(data.subarray(0, 32))}${data.length > 32 ? '…' : ''}`] : []),
          ...(TOKEN_PROGRAMS.has(info.owner) ? describeTokenData(data) : []),
          link,
        ].join('\n'),
      };
    },
  };
}

// ---------------------------------------------------------------- transactions and errors

const LOG_LINES = 40;
const LOG_LINE_CHARS = 300;

function localIdls(harness: OmsSession): Idl[] {
  try {
    return readLocalIdls(harness.root);
  } catch {
    return [];
  }
}

function describeDecoding(decoding: ErrorDecoding): string[] {
  return [
    ...decoding.matches.map(
      (match) => `${match.program}: ${match.name}${match.message ? ' · ' + match.message : ''} (${match.source})`,
    ),
    ...decoding.notes,
  ];
}

/** One line for a transaction `err`: the raw error, and a decoded custom code when a table knows the failing program. */
export function describeTransactionError(
  err: unknown,
  keys: string[],
  programIndexes: number[],
  idls: readonly Idl[],
): string {
  const raw = clip(typeof err === 'string' ? err : JSON.stringify(err), 300);
  const failure =
    err && typeof err === 'object' && 'InstructionError' in err
      ? (err as { InstructionError: [number, unknown] }).InstructionError
      : undefined;
  const custom =
    failure && typeof failure[1] === 'object' && failure[1] && 'Custom' in failure[1]
      ? Number((failure[1] as { Custom: unknown }).Custom)
      : undefined;
  if (failure === undefined || custom === undefined || !Number.isSafeInteger(custom)) return raw;
  const program = keys[programIndexes[failure[0]] ?? -1];
  const decoding = decodeProgramError(custom, program, idls);
  const lines = describeDecoding(decoding.matches.length ? decoding : decodeProgramError(custom, 'anchor'));
  return `${raw}\n  instruction ${failure[0]}${program ? ` in ${named(program)}` : ''}, custom error ${custom} (0x${custom.toString(16)})${lines.length ? '\n  ' + lines.join('\n  ') : ''}`;
}

export function prepareTransaction(argument: string, harness: OmsSession, connectors?: Connectors): Prepared {
  const { rest } = splitCluster(argument);
  const signature = rest;
  if (!isBase58Bytes(signature, 64))
    return refuse('Usage: /tx <signature> [--cluster devnet|mainnet] · base58, 64 bytes');
  const refusal = clusterRefusal(argument, connectors, 'Usage: /tx <signature> [--cluster devnet|mainnet]');
  if (refusal) return refusal;
  return {
    ok: true,
    async run(signal) {
      const source = sourceFor(argument, harness, connectors);
      const tx = (await source.call(
        'getTransaction',
        [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
        signal,
      )) as {
        slot: number;
        meta: {
          err: unknown;
          fee: number;
          computeUnitsConsumed?: number;
          logMessages?: string[];
          loadedAddresses?: { writable?: string[]; readonly?: string[] };
        } | null;
        transaction: { message: { accountKeys: string[]; instructions: Array<{ programIdIndex: number }> } };
      } | null;
      const link = `Explorer: ${source.explorer('tx', signature)}`;
      if (!tx)
        return { title: 'tx', text: `${signature}\nNo transaction with this signature ${source.where}.\n${link}` };
      const meta = tx.meta;
      const keys = [
        ...tx.transaction.message.accountKeys,
        ...(meta?.loadedAddresses?.writable ?? []),
        ...(meta?.loadedAddresses?.readonly ?? []),
      ];
      const indexes = tx.transaction.message.instructions.map((instruction) => instruction.programIdIndex);
      const logs = (meta?.logMessages ?? []).slice(0, LOG_LINES).map((line) => clip(line, LOG_LINE_CHARS));
      const more = (meta?.logMessages?.length ?? 0) - logs.length;
      return {
        title: 'tx',
        text: [
          signature,
          `Status: ${meta?.err == null ? 'success' : 'failed · ' + describeTransactionError(meta.err, keys, indexes, localIdls(harness))}`,
          `Slot: ${tx.slot}`,
          `Fee: ${meta?.fee ?? 'unknown'} lamports${meta ? ` (${sol(meta.fee)})` : ''}`,
          `Compute units: ${meta?.computeUnitsConsumed ?? 'not reported'}`,
          ...(logs.length
            ? ['Logs:', ...logs.map((line) => '  ' + line), ...(more > 0 ? [`  [${more} more lines]`] : [])]
            : ['Logs: none']),
          link,
        ].join('\n'),
      };
    },
  };
}

/**
 * The program reference is written for the model: it names tool calls and counts "1 accounts". Shown to a person, the source
 * link and tool syntax go, the instruction list becomes a table and the lookup hint names this command.
 */
export function programForPeople(text: string, program: string): string {
  const rows = text.split('\n').map((line) => /^ {2}(.+?) (no tag|\S+), (\d+) accounts$/.exec(line));
  const found = rows.filter((row): row is RegExpExecArray => row !== null);
  const widths = [
    Math.max('Instruction'.length, ...found.map((row) => row[1]!.length)),
    Math.max('Tag'.length, ...found.map((row) => row[2]!.length)),
  ] as const;
  const table = (name: string, tag: string, accounts: string) =>
    `  ${name.padEnd(widths[0])}  ${tag.padEnd(widths[1])}  ${accounts}`;
  return text
    .split('\n')
    .map((line, index) => {
      const row = rows[index];
      if (row) return table(row[1]!, row[2]!, `${row[3]} account${row[3] === '1' ? '' : 's'}`);
      if (/^Instructions \(name, discriminator hex/.test(line))
        return `Instructions · /program ${program} <name> for accounts and arguments, /program ${program} * for all\n${table('Instruction', 'Tag', 'Accounts')}`;
      return line;
    })
    .filter((line) => !/^source: source_fetch\(|^Full layouts: /.test(line))
    .join('\n');
}

export function prepareProgram(argument: string): Prepared {
  const [program, ...rest] = argument.trim().split(/\s+/).filter(Boolean);
  if (!program) return refuse('Usage: /program <name|id> [instruction]');
  const instruction = rest.join(' ');
  return {
    ok: true,
    async run() {
      const reference = programForPeople(lookupProgramReference(program, instruction || undefined), program);
      // A program given by address also gets its explorer page.
      const text = isBase58Bytes(program, 32)
        ? `${reference}\nExplorer: ${explorerUrl('address', program, 'mainnet')}`
        : reference;
      return {
        title: 'program',
        text,
        ...(text.length > 10_000 ? { report: { id: `program-${Date.now()}`, text } } : {}),
      };
    },
  };
}

export function prepareError(argument: string, harness: OmsSession): Prepared {
  const [code, program, ...extra] = argument
    .replace(/^\s*custom program error:\s*/i, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const parsed = code === undefined ? undefined : parseErrorCode(code);
  if (parsed === undefined || extra.length) return refuse('Usage: /error <code> [program] · decimal or 0x hex');
  return {
    ok: true,
    async run(signal) {
      const decoding = decodeProgramError(parsed, program, localIdls(harness));
      const head = `Custom error ${parsed} (0x${parsed.toString(16)})${program ? ` in ${program}` : ''}`;
      if (decoding.matches.length) return { title: 'error', text: [head, ...describeDecoding(decoding)].join('\n') };
      try {
        const answer = await harness.knowledge.decodeError(String(parsed), program, signal);
        return {
          title: 'error',
          text: [head, 'Not in offline tables · Solana docs answer (unverified):', clip(answer, 3_000)].join('\n'),
        };
      } catch {
        return {
          title: 'error',
          text: [
            head,
            'Unknown code (not in built-in tables or local IDLs)',
            ...decoding.notes,
            "Check the program's IDL or source for its error definitions",
          ].join('\n'),
        };
      }
    },
  };
}
