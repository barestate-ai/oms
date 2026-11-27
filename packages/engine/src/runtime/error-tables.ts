import { readFileSync } from 'node:fs';
import type { Idl } from './solana-diagnosis.ts';

/**
 * Offline error tables for the programs and frameworks a Solana task meets most: the Anchor framework (codes below 6000), System,
 * SPL Token, Token-2022 (including its extension errors) and the Associated Token program, snapshotted from pinned upstream sources. The knowledge service's decode_error
 * covers the rest. Programs report these as `custom program error: 0x..` / `{"Custom": n}`.
 */
export interface ErrorMatch {
  program: string;
  name: string;
  message: string;
  source: 'built-in table' | 'local IDL';
}
type Table = Array<[code: number, name: string, message: string]>;

interface Snapshot {
  tables: Array<{ program: string; id: string | null; source: string; errors: Table }>;
}
/** Generated from the pinned upstream sources named in each table's `source` (see error-tables.json); regenerate, do not hand-edit. */
const SNAPSHOT = JSON.parse(readFileSync(new URL('./error-tables.json', import.meta.url), 'utf8')) as Snapshot;
const table = (id: string | null): Table => {
  const found = SNAPSHOT.tables.find((entry) => entry.id === id);
  if (!found) throw new Error(`error-tables.json has no table for ${id ?? 'the Anchor framework'}`);
  return found.errors;
};
const ANCHOR = table(null);

interface Source {
  name: string;
  id?: string;
  aliases: string[];
  table: Table;
}
const SOURCES: Source[] = [
  { name: 'Anchor framework', aliases: ['anchor', 'framework'], table: ANCHOR },
  {
    name: 'System',
    id: '11111111111111111111111111111111',
    aliases: ['system'],
    table: table('11111111111111111111111111111111'),
  },
  {
    name: 'SPL Token',
    id: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    aliases: ['token', 'spl-token', 'spl token'],
    table: table('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  },
  {
    name: 'Token-2022',
    id: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    aliases: ['token-2022', 'token2022', 'spl-token-2022'],
    table: table('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
  },
  {
    name: 'Associated Token',
    id: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    aliases: ['ata', 'associated-token', 'associated token', 'associated'],
    table: table('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  },
];

export interface ErrorDecoding {
  matches: ErrorMatch[];
  /** The program argument named a program with no offline table (and no local IDL), so only the knowledge service can answer. */
  unknownProgram?: string;
  notes: string[];
}

const idlName = (idl: Idl) => idl.metadata?.name ?? idl.name ?? 'program';
const idlAddress = (idl: Idl) => idl.address ?? idl.metadata?.address;
const usableErrorIdl = (idl: Idl) =>
  typeof idlName(idl) === 'string' &&
  (idlAddress(idl) === undefined || typeof idlAddress(idl) === 'string') &&
  (idl.errors === undefined || Array.isArray(idl.errors));

/** Parse `3012`, `0xbc4` or `custom program error: 0xbc4`; undefined when it is not one non-negative integer. */
export function parseErrorCode(text: string): number | undefined {
  const match = /^(?:custom program error:\s*)?(0x[0-9a-f]+|\d+)$/i.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff ? value : undefined;
}

/** Decode a custom error code with the offline tables and the task's own IDLs. `program` is a name, alias or program id. */
export function decodeProgramError(
  code: number,
  program: string | undefined,
  idls: readonly Idl[] = [],
): ErrorDecoding {
  const wanted = program?.trim();
  const lower = wanted?.toLowerCase();
  const builtIn = wanted
    ? SOURCES.filter(
        (source) => source.id === wanted || source.aliases.includes(lower!) || source.name.toLowerCase() === lower,
      )
    : SOURCES;
  const owned = idls.filter(
    (idl) => usableErrorIdl(idl) && (!wanted || idlAddress(idl) === wanted || idlName(idl).toLowerCase() === lower),
  );
  const matches: ErrorMatch[] = [];
  const notes: string[] = [];
  for (const source of builtIn) {
    const row = source.table.find((entry) => entry[0] === code);
    if (row) matches.push({ program: source.name, name: row[1], message: row[2], source: 'built-in table' });
  }
  for (const idl of owned) {
    const row = idl.errors?.find(
      (entry) =>
        entry?.code === code &&
        typeof entry.name === 'string' &&
        (entry.msg === undefined || typeof entry.msg === 'string'),
    );
    if (row) matches.push({ program: idlName(idl), name: row.name, message: row.msg ?? '', source: 'local IDL' });
  }
  // An Anchor program also raises the framework's own codes.
  if (wanted && owned.length && !builtIn.includes(SOURCES[0]!)) {
    const row = ANCHOR.find((entry) => entry[0] === code);
    if (row) matches.push({ program: 'Anchor framework', name: row[1], message: row[2], source: 'built-in table' });
  }
  if (code >= 6000 && !matches.length)
    notes.push('Codes from 6000 are defined by the program itself: its IDL (target/idl/*.json) or source lists them');
  return { matches, notes, ...(wanted && !builtIn.length && !owned.length ? { unknownProgram: wanted } : {}) };
}

/** A program id or name for one of the built-in tables, for naming the failing program of a transaction. */
export function builtInProgramName(id: string): string | undefined {
  return SOURCES.find((source) => source.id === id)?.name;
}
