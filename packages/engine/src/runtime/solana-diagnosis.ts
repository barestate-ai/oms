import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { programReference } from './program-reference.ts';
import {
  fetchMcpText,
  readWorktreeText,
  resolveKnowledge,
  wrapUntrusted,
  type KnowledgeSource,
} from './knowledge-service.ts';

/**
 * Structured diagnosis of a failed Solana build, deploy, test or transaction (pilot feature A1).
 * A failing command whose output carries a Solana failure is shown to the model as a short diagnosis plus a bounded tail of its raw log;
 * the whole raw log stays readable through `raw_output`. Everything here is parsed from untrusted command output.
 */
export const DIAGNOSIS_LIMIT = 2_048;
export const RAW_OUTPUT_TOOL = 'raw_output';
const RAW_TAIL_LINES = 60;
const RAW_TAIL_BYTES = 6_000;
const FAILURE_LINE = /InstructionError|Program \S+ failed:|AnchorError|custom program error/;
const FAILURE_LINES_KEPT = 6;
const MAX_IDL_FILES = 16;
const MAX_IDL_BYTES = 1_000_000;
const KEPT_RAW_OUTPUTS = 16;

interface IdlAccount {
  name: string;
  signer?: boolean;
  writable?: boolean;
  isSigner?: boolean;
  isMut?: boolean;
  accounts?: IdlAccount[];
}
export interface Idl {
  address?: string;
  name?: string;
  metadata?: { name?: string; address?: string };
  instructions?: Array<{ name: string; accounts?: IdlAccount[] }>;
  errors?: Array<{ code: number; name: string; msg?: string }>;
}
export interface TransactionFacts {
  logs: string[];
  computeUnits?: number;
  changes: Array<{ account: string; lamports?: [number, number]; owner?: [string, string] }>;
}
export interface DiagnosisSources {
  idls(): Idl[];
  /** knowledge decode_error, for codes no local IDL defines. */
  decodeError?(code: string, program: string): Promise<string | undefined>;
  /** Surfpool facts for a landed transaction signature. */
  transaction?(signature: string): Promise<TransactionFacts | undefined>;
}

const B58 = '[1-9A-HJ-NP-Za-km-z]';
const END = `[^"'\`\\n\\]]*`;
const PROGRAM_LINE = new RegExp(
  `Program (${B58}{32,44}) (?:consumed (\\d+) of (\\d+) compute units|failed: (${END}))`,
  'g',
);
const ANCHOR = new RegExp(
  `AnchorError (?:caused by account: (\\w+)|thrown in (\\S+?)|occurred)\\. Error Code: (\\w+)\\. Error Number: (\\d+)\\. Error Message: (${END})`,
);
const LEFT_RIGHT = new RegExp(`Program log: (Left|Right):${END}[\\s\\S]{0,12}?Program log: (${B58}{32,44}|\\S+)`, 'g');
const INSTRUCTION = /Program log: Instruction: (\w+)/g;
const CUSTOM = /custom program error: 0x([0-9a-f]+)|"?Custom"?\s*:\s*(\d+)/i;
const ACCOUNT_INDEX = /account_index"?\s*:\s*(\d+)|account (?:index|#)\s*(\d+)/i;
const SIGNATURE = new RegExp(`(?<!${B58})${B58}{87,88}(?!${B58})`, 'g');
const KINDS: Array<[string, RegExp]> = [
  ['compute budget exceeded', /exceeded CUs meter|Computational ?budget ?exceeded|ComputeBudgetExceeded/i],
  [
    'missing signer',
    /missing required signature|MissingRequiredSignature|signer privilege escalated|missing signatures? for/i,
  ],
  [
    'account not writable',
    /writable privilege escalated|read-only account|Readonly(?:Data|Lamport)(?:Modified|Change)|not writable/i,
  ],
];
const SIGNAL = /Program \S+ failed:|AnchorError|custom program error|InstructionError|exceeded CUs meter/;

const normalize = (name: string) => name.replace(/_/g, '').toLowerCase();
const idlName = (idl: Idl) => idl.metadata?.name ?? idl.name ?? 'program';
const idlAddress = (idl: Idl) => idl.address ?? idl.metadata?.address;
const flatten = (accounts: IdlAccount[] = []): IdlAccount[] =>
  accounts.flatMap((a) => (a.accounts ? flatten(a.accounts) : [a]));
const lastMatch = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].at(-1);

async function decodeCustom(
  code: number,
  program: string | undefined,
  idl: Idl | undefined,
  sources: DiagnosisSources,
): Promise<string> {
  const head = `custom program error 0x${code.toString(16)} (${code})`;
  const local = idl?.errors?.find((error) => error.code === code);
  if (local) return `${head} = ${local.name}: ${local.msg ?? ''} [local IDL ${idlName(idl!)}]`;
  const remote =
    program && sources.decodeError
      ? await sources.decodeError(String(code), program).catch(() => undefined)
      : undefined;
  if (!remote) return head;
  const excerpt = remote.replace(/<\s*\/\s*solana-knowledge-excerpt/gi, '<\\/solana-knowledge-excerpt')
    .replace(/\s+/g, ' ').slice(0, 300);
  return `${head} = <solana-knowledge-excerpt>${excerpt}</solana-knowledge-excerpt> [decode_error]`;
}

/** A short diagnosis wrapped as untrusted text, or undefined when the output shows no Solana failure. */
export async function diagnose(
  output: string,
  sources: DiagnosisSources,
  noteShown: (note: string) => boolean = () => false,
): Promise<string | undefined> {
  const signature = sources.transaction ? lastMatch(output, SIGNATURE)?.[0] : undefined;
  const facts = signature ? await sources.transaction!(signature).catch(() => undefined) : undefined;
  const text = facts ? `${output}\n${facts.logs.join('\n')}` : output;
  if (!SIGNAL.test(text)) return undefined;
  const lines: string[] = [];
  const programs = [...text.matchAll(PROGRAM_LINE)];
  const failed = programs.findLast((m) => m[4] !== undefined);
  const program = failed?.[1];
  const idl = sources.idls().find((candidate) => idlAddress(candidate) === program);
  const instruction = lastMatch(text, INSTRUCTION)?.[1];
  const idlInstruction =
    instruction === undefined
      ? undefined
      : idl?.instructions?.find((ix) => normalize(ix.name) === normalize(instruction));
  const accounts = idlInstruction ? flatten(idlInstruction.accounts) : [];
  if (failed) lines.push(`failed: program ${program}: ${failed[4]!.trim()}`);
  for (const [kind, pattern] of KINDS) if (pattern.test(text)) lines.push(`kind: ${kind}`);
  const custom = text.match(CUSTOM);
  if (custom)
    lines.push(
      `error: ${await decodeCustom(custom[1] ? parseInt(custom[1], 16) : Number(custom[2]), program, idl, sources)}`,
    );
  const anchor = text.match(ANCHOR);
  if (anchor) {
    const [, account, origin, code, number, message] = anchor;
    const values = [...text.matchAll(LEFT_RIGHT)].map((m) => `${m[1]!.toLowerCase()} ${m[2]}`).join(', ');
    lines.push(
      `anchor: ${code} (${number})${account ? ` on account \`${account}\`` : ''}${origin ? ` at ${origin}` : ''}: ${message!.trim()}${values ? ` (${values})` : ''}`,
    );
  }
  if (instruction) lines.push(`instruction: ${instruction}`);
  const index = text.match(ACCOUNT_INDEX);
  if (index) {
    const at = Number(index[1] ?? index[2]);
    lines.push(`account #${at}${accounts[at] ? ` = \`${accounts[at]!.name}\` (${idlInstruction!.name})` : ''}`);
  }
  if (idlInstruction && /missing signer/.test(lines.join('\n'))) {
    lines.push(
      `IDL signers of ${idlInstruction.name}: ${
        accounts
          .filter((a) => a.signer || a.isSigner)
          .map((a) => a.name)
          .join(', ') || 'none'
      }`,
    );
  }
  if (idlInstruction && /account not writable/.test(lines.join('\n'))) {
    lines.push(
      `IDL writable accounts of ${idlInstruction.name}: ${
        accounts
          .filter((a) => a.writable || a.isMut)
          .map((a) => a.name)
          .join(', ') || 'none'
      }`,
    );
  }
  const meters = [
    ...new Map(programs.filter((m) => m[2] !== undefined).map((m) => [m[1], `${m[1]} ${m[2]} of ${m[3]} CU`])).values(),
  ];
  if (meters.length) lines.push(`compute: ${meters.join('; ')}`);
  if (facts) {
    if (facts.computeUnits !== undefined) lines.push(`transaction: ${facts.computeUnits} CU`);
    for (const change of facts.changes) {
      const parts = [
        change.lamports &&
          `lamports ${change.lamports[0]} -> ${change.lamports[1]} (${change.lamports[1] - change.lamports[0] >= 0 ? '+' : ''}${change.lamports[1] - change.lamports[0]})`,
        change.owner && `owner ${change.owner[0]} -> ${change.owner[1]}`,
      ].filter(Boolean);
      lines.push(`${change.account}: ${parts.join('; ')}`);
    }
  }
  const reference = program ? programReference().programs.find((entry) => entry.id === program) : undefined;
  const line = reference?.deploymentNote ? `Note for ${reference.name}: ${reference.deploymentNote}` : undefined;
  const note = line && !noteShown(line) ? `\n${line}` : '';
  const diagnosis = wrapUntrusted(
    'solana_diagnosis',
    `Solana failure diagnosis (parsed from the command output; the full log is available via ${RAW_OUTPUT_TOOL})\n${lines.join('\n')}`,
    DIAGNOSIS_LIMIT - Buffer.byteLength(note),
    "the failing command's own output",
  );
  return diagnosis + note;
}

/**
 * The diagnosis followed by a bounded tail of the raw output (the last RAW_TAIL_LINES lines, at most RAW_TAIL_BYTES), with
 * the earlier failure lines (instruction index, failed program) the tail would otherwise cut, so one result is usually enough.
 */
export function withRawTail(diagnosis: string, output: string, callId: string): string {
  const lines = output.replace(/\s+$/, '').split('\n');
  const tail = lines.slice(-RAW_TAIL_LINES);
  let text = tail.join('\n');
  const cutBytes = Buffer.byteLength(text) > RAW_TAIL_BYTES;
  if (cutBytes)
    text = Buffer.from(text)
      .subarray(-RAW_TAIL_BYTES)
      .toString('utf8')
      .replace(/^[^\n]*\n/, '');
  const earlier = lines
    .slice(0, -tail.length || undefined)
    .filter((line) => FAILURE_LINE.test(line))
    .slice(-FAILURE_LINES_KEPT)
    .map((line) => line.slice(0, 300));
  const body = `${earlier.length ? `[earlier failure lines]\n${earlier.join('\n')}\n` : ''}[last ${text.split('\n').length} of ${lines.length} lines]\n${text}`;
  const more = lines.length > tail.length || cutBytes;
  return (
    `${diagnosis}\n${wrapUntrusted('raw_output_tail', body, RAW_TAIL_BYTES + 1_024, "the failing command's own output")}\n` +
    `${more ? `Full output: ${RAW_OUTPUT_TOOL} call_id=${callId}` : `That is the whole output (${RAW_OUTPUT_TOOL} call_id=${callId} returns it again).`}`
  );
}

/**
 * Anchor IDLs under target/idl, read fresh each time (a build may have just written them). This runs on the host over a
 * model-written tree, so files that resolve outside the worktree are skipped, as are bad or oversized ones.
 */
export function readLocalIdls(codeRoot: string): Idl[] {
  let names: string[];
  try {
    names = readdirSync(join(codeRoot, 'target', 'idl'))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .slice(0, MAX_IDL_FILES);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const text = readWorktreeText(codeRoot, `target/idl/${name}`, MAX_IDL_BYTES);
    try {
      const idl = text === undefined ? undefined : (JSON.parse(text) as unknown);
      return idl && typeof idl === 'object' && !Array.isArray(idl) ? [idl as Idl] : [];
    } catch {
      return [];
    }
  });
}

async function rpc(url: string, method: string, params: unknown[], signal: AbortSignal): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    signal,
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return ((await response.json()) as { result?: unknown }).result;
}

/** Facts of a landed transaction from Surfpool: logs, compute, lamport deltas (meta) and owner changes (transaction profile). */
async function surfpoolTransaction(url: string, signature: string): Promise<TransactionFacts | undefined> {
  const signal = AbortSignal.timeout(3_000);
  const tx = await rpc(
    url,
    'getTransaction',
    [signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }],
    signal,
  );
  if (!tx?.meta) return undefined;
  const keys: string[] = [
    ...(tx.transaction?.message?.accountKeys ?? []),
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const changes = new Map<string, TransactionFacts['changes'][number]>();
  keys.forEach((account, i) => {
    const pre = tx.meta.preBalances?.[i],
      post = tx.meta.postBalances?.[i];
    if (typeof pre === 'number' && typeof post === 'number' && pre !== post)
      changes.set(account, { account, lamports: [pre, post] });
  });
  const profile = await rpc(url, 'surfnet_getTransactionProfile', [signature, { encoding: 'base64' }], signal).catch(
    () => undefined,
  );
  for (const [account, state] of Object.entries<any>(profile?.value?.transactionProfile?.accountStates ?? {})) {
    const [before, after] = state?.accountChange?.type === 'update' ? state.accountChange.data : [];
    if (before?.owner && after?.owner && before.owner !== after.owner)
      changes.set(account, { ...changes.get(account), account, owner: [before.owner, after.owner] });
  }
  return {
    logs: tx.meta.logMessages ?? [],
    computeUnits: tx.meta.computeUnitsConsumed,
    changes: [...changes.values()],
  };
}

export interface DiagnosisOptions {
  codeRoot: string;
  rpcUrl: string;
  knowledge?: KnowledgeSource;
}

/**
 * Replaces a failing bash result that carries a Solana failure with its diagnosis and a raw tail. The raw text is kept per tool call
 * (the last 16) and served by `raw_output`.
 */
export function createDiagnosisExtension(options: DiagnosisOptions): ExtensionFactory {
  const raw = new Map<string, string>();
  const sources: DiagnosisSources = {
    idls: () => readLocalIdls(options.codeRoot),
    transaction: (signature) => surfpoolTransaction(options.rpcUrl, signature),
    decodeError: async (code: string, program: string) => {
      const config = resolveKnowledge(options.knowledge);
      if (!config) return undefined;
      const result = await fetchMcpText(config, 'decode_error', { code, program }, AbortSignal.timeout(5_000));
      return result.isError ? undefined : result.text;
    },
  };
  return (pi) => {
    pi.on('tool_result', async (event, ctx) => {
      if (event.toolName !== 'bash' || !event.isError) return undefined;
      const output = event.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      // A note is shown once per conversation: the current branch, so /clear shows it again and a resume does not.
      const noteShown = (line: string) =>
        ctx.sessionManager
          .getBranch()
          .some(
            (entry) =>
              entry.type === 'message' &&
              entry.message.role === 'toolResult' &&
              entry.message.content.some((part) => part.type === 'text' && part.text.includes(line)),
          );
      const diagnosis = await diagnose(output, sources, noteShown);
      if (!diagnosis) return undefined;
      raw.set(event.toolCallId, output);
      for (const key of [...raw.keys()].slice(0, -KEPT_RAW_OUTPUTS)) raw.delete(key);
      return { content: [{ type: 'text', text: withRawTail(diagnosis, output, event.toolCallId) }] };
    });
    const parameters = Type.Object({ call_id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })) });
    pi.registerTool({
      name: RAW_OUTPUT_TOOL,
      label: 'Raw command output',
      parameters,
      description:
        'Read the raw output of a failed command that was shown as a Solana diagnosis, 16,000 characters per page from offset.',
      async execute(_id, input) {
        const text = raw.get(input.call_id);
        if (text === undefined) throw new Error('Unknown call_id; only the last 16 diagnosed commands are kept');
        const offset = input.offset ?? 0;
        const page = text.slice(offset, offset + 16_000);
        return {
          content: [
            {
              type: 'text',
              text: page + (offset + page.length < text.length ? `\n[more: offset=${offset + page.length}]` : ''),
            },
          ],
          details: undefined,
        };
      },
    });
  };
}
