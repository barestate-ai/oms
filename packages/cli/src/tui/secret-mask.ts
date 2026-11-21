import { basename } from 'node:path';

/** What the screen shows in place of a secret. The model still receives the real value. */
export const MASK = '••••';

const SECRET_WORD = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|MNEMONIC|SEED|CREDENTIAL/i;

// Name, then `=` that is not `==`, `=>` or a `$` reference, then a quoted or bare value.
const ASSIGNMENT = /(?<![A-Za-z0-9_])((?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=(?![=>$])("[^"\n]*"|'[^'\n]*'|[^\s"']*)/g;

const PROVIDER_KEYS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxai-[A-Za-z0-9]{16,}/g,
  // GitHub: ghp_ (personal), gho_, ghu_, ghs_, ghr_, then github_pat_ (fine-grained).
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\blin_api_[A-Za-z0-9]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // A keypair file: 64 bytes as a JSON array.
  /\[\s*(?:\d{1,3}\s*,\s*){63,}\d{1,3}\s*\]/g,
];

/** `.env` and `.env.<anything>`, by basename. */
export function isEnvFile(path: unknown): boolean {
  return typeof path === 'string' && /^\.env(\..*)?$/.test(basename(path));
}

/** A shell command that names an env file as a word, such as `cat .env` or `source ./.env.local`. */
export function commandNamesEnvFile(command: unknown): boolean {
  return typeof command === 'string' && /(^|[\s/='"<])\.env(\.[\w.-]+)?(?=$|[\s'";|&<>)])/.test(command);
}

/** Masks `NAME=value` for secret-looking names and strings shaped like provider keys or keypairs. */
export function maskSecrets(text: string): string {
  let out = text.replace(ASSIGNMENT, (whole, exported: string, name: string) =>
    SECRET_WORD.test(name) ? `${exported}${name}=${MASK}` : whole,
  );
  for (const pattern of PROVIDER_KEYS) out = out.replace(pattern, MASK);
  return out;
}

/** Every `NAME=value` line of an env file shows as `NAME=••••`; comments and blank lines stay. */
export function maskEnvFile(text: string): string {
  const lines = text.split('\n');
  let quote: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (quote) {
      if (line.includes(quote)) quote = undefined;
      lines[i] = MASK;
      continue;
    }
    const match = /^(\s*(?:[+-]\s*\d*\s*)?(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    lines[i] = `${match[1]}${match[2]}=${MASK}`;
    const value = match[3]!.trimStart();
    const open = value[0];
    if ((open === '"' || open === "'") && !value.slice(1).includes(open)) quote = open;
  }
  return maskSecrets(lines.join('\n'));
}
