import { copyToClipboard } from '@earendil-works/pi-coding-agent';
import { readLocalIdls, readWorktreeText, type Idl, type OmsSession } from '@oms/engine';
import type { SidebarItem, SidebarSection } from './explorer.ts';
import { localChain } from './solana-commands.ts';

export interface ProgramInfo {
  name: string;
  /** The program id from Anchor.toml (localnet first), when it names one. */
  id?: string;
  idl?: Idl;
}

/** `[programs.localnet]` style tables of Anchor.toml: name = "id" pairs, by cluster. Comments and other tables are ignored. */
export function parseAnchorToml(text: string): Array<{ cluster: string; name: string; id: string }> {
  const programs: Array<{ cluster: string; name: string; id: string }> = [];
  let cluster: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const table = /^\[(.+)\]$/.exec(line);
    if (table) {
      cluster = /^programs\.(.+)$/.exec(table[1]!.trim())?.[1]?.trim();
      continue;
    }
    const pair = /^"?([\w-]+)"?\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"$/.exec(line);
    if (cluster && pair) programs.push({ cluster, name: pair[1]!, id: pair[2]! });
  }
  return programs;
}

const idlName = (idl: Idl): string => idl.metadata?.name ?? idl.name ?? '';

/** The Anchor programs of a project: Anchor.toml's ids (localnet preferred), matched with the IDLs a build left behind. */
export function detectPrograms(root: string): { anchor: boolean; programs: ProgramInfo[] } {
  const toml = readWorktreeText(root, 'Anchor.toml');
  const idls = readLocalIdls(root);
  const listed = toml === undefined ? [] : parseAnchorToml(toml);
  const names = new Map<string, ProgramInfo>();
  for (const cluster of ['localnet', ...new Set(listed.map((program) => program.cluster))]) {
    for (const program of listed.filter((candidate) => candidate.cluster === cluster)) {
      if (!names.has(program.name)) names.set(program.name, { name: program.name, id: program.id });
    }
  }
  for (const idl of idls) {
    const name = idlName(idl);
    if (!name) continue;
    const known =
      names.get(name) ??
      [...names.values()].find((program) => program.id && program.id === (idl.address ?? idl.metadata?.address));
    if (known) known.idl = idl;
    else names.set(name, { name, id: idl.address ?? idl.metadata?.address, idl });
  }
  return { anchor: toml !== undefined, programs: [...names.values()] };
}

// ---------------------------------------------------------------------------------------------------- IDL text

type Loose = Record<string, unknown>;
const record = (value: unknown): Loose => (value && typeof value === 'object' ? (value as Loose) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** An IDL type as people write it: u64, Vec<u8>, Option<Pubkey>, [u8; 32], Vault. */
export function typeText(type: unknown): string {
  if (typeof type === 'string') return type === 'publicKey' ? 'pubkey' : type;
  const t = record(type);
  if ('vec' in t) return `Vec<${typeText(t.vec)}>`;
  if ('option' in t) return `Option<${typeText(t.option)}>`;
  if ('coption' in t) return `COption<${typeText(t.coption)}>`;
  if ('array' in t) {
    const [inner, size] = list(t.array);
    return `[${typeText(inner)}; ${String(size)}]`;
  }
  if ('defined' in t) return typeof t.defined === 'string' ? t.defined : text(record(t.defined).name) || 'defined';
  return 'unknown';
}

function accountFlags(account: Loose): string {
  const flags = [
    account.writable === true || account.isMut === true ? 'mut' : '',
    account.signer === true || account.isSigner === true ? 'signer' : '',
    account.pda ? 'pda' : '',
    account.optional === true || account.isOptional === true ? 'optional' : '',
  ].filter(Boolean);
  return flags.length ? ` (${flags.join(', ')})` : '';
}

function accountList(accounts: unknown[], depth = 0): string[] {
  return accounts.flatMap((raw) => {
    const account = record(raw);
    // A composite account holds more accounts.
    if (Array.isArray(account.accounts) && depth < 3) return accountList(account.accounts, depth + 1);
    return [`${text(account.name) || '?'}${accountFlags(account)}`];
  });
}

/** An IDL as readable text: instructions with their arguments and accounts, account types and errors with hex codes. */
export function formatIdl(idl: Idl, path?: string): string {
  const raw = record(idl);
  const name = idlName(idl) || 'program';
  const address = idl.address ?? idl.metadata?.address;
  const out = [[name, address, path].filter(Boolean).join(' · '), ''];
  const instructions = list(raw.instructions).map(record);
  out.push(`Instructions (${instructions.length})`);
  for (const instruction of instructions) {
    const args = list(instruction.args).map(record);
    out.push(
      `  ${text(instruction.name)}(${args.map((arg) => `${text(arg.name)}: ${typeText(arg.type)}`).join(', ')})`,
    );
    const accounts = accountList(list(instruction.accounts));
    if (accounts.length) out.push(`    accounts: ${accounts.join(' · ')}`);
  }
  const types = new Map(list(raw.types).map((type) => [text(record(type).name), record(type)] as const));
  const accounts = list(raw.accounts).map(record);
  if (accounts.length) {
    out.push('', `Accounts (${accounts.length})`);
    for (const account of accounts) {
      const shape = record(account.type ?? record(types.get(text(account.name))).type);
      const fields = list(shape.fields).map(record);
      out.push(
        fields.length
          ? `  ${text(account.name)} { ${fields.map((field) => `${text(field.name)}: ${typeText(field.type)}`).join(', ')} }`
          : `  ${text(account.name)}`,
      );
    }
  }
  const errors = list(raw.errors).map(record);
  if (errors.length) {
    out.push('', `Errors (${errors.length})`);
    for (const error of errors) {
      const code = Number(error.code);
      const message = text(error.msg);
      out.push(`  ${code} 0x${code.toString(16)} ${text(error.name)}${message ? ` — ${message}` : ''}`);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------- chain status

export interface ChainState {
  state: 'up' | 'down' | 'none';
  slot?: number;
  /** Why the chain is down, in plain words. */
  detail?: string;
}

const shortId = (id: string): string => `${id.slice(0, 4)}…${id.slice(-4)}`;

interface SolanaPanelOptions {
  harness: OmsSession;
  render: () => void;
  /** Run a slash command as if chosen from the menu. */
  run: (command: string) => void;
  /** Open the command palette with this text typed in, for a command that needs an argument. */
  prefill: (command: string) => void;
  openReport: (id: string, text: string, title: string) => void;
  notice: (message: string) => void;
  /** Whether anyone can see the section now; the chain is only polled while true. */
  visible: () => boolean;
}

/**
 * What a Solana project gets in the workbench's sidebar and status row: its programs, the actions that drive the
 * existing /run, /test and chain commands, and the local chain's health. Nothing here reaches any network but the
 * session's own loopback Surfpool (localChain refuses anything else).
 */
export class SolanaPanel {
  private found: { anchor: boolean; programs: ProgramInfo[] } = { anchor: false, programs: [] };
  private chainState: ChainState = { state: 'none' };
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private disposed = false;
  private readonly options: SolanaPanelOptions;

  constructor(options: SolanaPanelOptions) {
    this.options = options;
    this.refresh();
  }

  get chain(): ChainState {
    return this.chainState;
  }
  /** True for an Anchor project (or one with IDLs). */
  get present(): boolean {
    return this.found.anchor || this.found.programs.length > 0;
  }

  /** Read Anchor.toml and the IDLs again: a build or the agent may have changed them. */
  refresh(): void {
    try {
      this.found = detectPrograms(this.options.harness.root);
    } catch {
      this.found = { anchor: false, programs: [] };
    }
    this.options.render();
  }

  /** Check the chain once (never overlapping), then again every three seconds while the panel is visible. */
  start(): void {
    if (this.timer || this.disposed) return;
    void this.poll();
    this.timer = setInterval(() => {
      if (this.options.visible()) void this.poll();
    }, 3000);
    this.timer.unref();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    const before = JSON.stringify(this.chainState);
    try {
      if (!this.options.harness.chain) this.chainState = { state: 'none' };
      else {
        try {
          const { chain } = localChain(this.options.harness);
          const health = await chain.health();
          if (!health.ok) this.chainState = { state: 'down', detail: 'not responding' };
          else {
            const slot = await chain.call('getSlot').catch(() => undefined);
            this.chainState = { state: 'up', ...(typeof slot === 'number' ? { slot } : {}) };
          }
        } catch (error) {
          // The chain is not running, or its address is not loopback: either way nothing is read.
          const message = error instanceof Error ? error.message : '';
          this.chainState = /not running/.test(message) ? { state: 'down', detail: 'not running' } : { state: 'none' };
        }
      }
    } finally {
      this.polling = false;
    }
    if (!this.disposed && JSON.stringify(this.chainState) !== before) this.options.render();
  }

  /** The status row's chain chip, e.g. "localnet slot 18,234". Absent when the session has no local chain. */
  statusChip(): { text: string; role: 'success' | 'warning' | 'muted' } | undefined {
    if (!this.options.harness.chain) return undefined;
    const chain = this.chainState;
    if (chain.state === 'up')
      return {
        text: chain.slot === undefined ? 'localnet' : `localnet slot ${chain.slot.toLocaleString('en-US')}`,
        role: 'success',
      };
    return chain.state === 'down' ? { text: `localnet ${chain.detail ?? 'down'}`, role: 'warning' } : undefined;
  }

  /** The sidebar section, or undefined when this is not a Solana project. */
  section(): SidebarSection | undefined {
    if (!this.present) return undefined;
    const items: SidebarItem[] = [];
    const chain = this.chainState;
    if (this.options.harness.chain) {
      items.push({
        id: 'chain',
        label: 'localnet',
        detail:
          chain.state === 'up'
            ? chain.slot === undefined
              ? 'up'
              : `slot ${chain.slot.toLocaleString('en-US')}`
            : (chain.detail ?? 'off'),
        detailRole: chain.state === 'up' ? 'success' : 'warning',
        onActivate: () => this.options.run('/chain'),
      });
    }
    for (const program of this.found.programs.slice(0, 4)) {
      items.push({
        id: `program:${program.name}`,
        label: program.name,
        detail: program.id ? shortId(program.id) : 'no id',
        detailRole: 'muted',
        onActivate: program.id ? () => this.copyId(program) : undefined,
      });
    }
    items.push(
      { id: 'build', label: 'Build', onActivate: () => this.options.run('/run anchor build') },
      { id: 'test', label: 'Test', onActivate: () => this.options.run('/test') },
      {
        id: 'deploy',
        label: 'Deploy to localnet…',
        onActivate: () => this.options.prefill('/run anchor deploy --provider.cluster "$SURFNET_RPC_URL"'),
      },
      { id: 'airdrop', label: 'Airdrop…', onActivate: () => this.options.prefill('/airdrop ') },
      { id: 'tx', label: 'Look up a transaction…', onActivate: () => this.options.prefill('/tx ') },
    );
    for (const program of this.found.programs.filter((candidate) => candidate.idl).slice(0, 4)) {
      items.push({ id: `idl:${program.name}`, label: `IDL ${program.name}`, onActivate: () => this.openIdl(program) });
    }
    return { id: 'solana', title: 'solana', badge: this.found.anchor ? 'anchor' : undefined, items };
  }

  /** Programs with an IDL, for the command palette. */
  get idlPrograms(): readonly ProgramInfo[] {
    return this.found.programs.filter((program) => program.idl);
  }

  openIdl(program: ProgramInfo): void {
    if (!program.idl) return;
    this.options.openReport(
      `idl-${program.name}`,
      formatIdl(program.idl, `target/idl/${program.name}.json`),
      `IDL ${program.name}`,
    );
  }

  private copyId(program: ProgramInfo): void {
    if (!program.id) return;
    copyToClipboard(program.id).then(
      () => this.options.notice(`Copied the id of ${program.name}.`),
      () => this.options.notice(`${program.name}: ${program.id}`),
    );
  }
}
