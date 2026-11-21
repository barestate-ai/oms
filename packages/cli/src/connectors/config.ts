import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { connectorSpec } from './catalog.ts';

/**
 * What the agent may do through a connector. `off` gives it nothing, `read` lets it look, `ask` lets it act after the user
 * approves each action, `allow` lets it act without asking. Writes are never offered to the model below `ask`.
 */
export type Access = 'off' | 'read' | 'ask' | 'allow';
export const ACCESS_LEVELS: readonly Access[] = ['off', 'read', 'ask', 'allow'];

export const CONNECTOR_IDS = [
  'github',
  'gitlab',
  'gitlab-remote',
  'linear',
  'slack',
  'docker',
  'aws',
  'solana-rpc',
] as const;
export type ConnectorId = (typeof CONNECTOR_IDS)[number];

/** One connector's saved choice. It never holds a token: only an on/off flag, an access level and non-secret settings. */
export interface ConnectorEntry {
  enabled: boolean;
  access: Access;
  /** Settings a connector accepts, by name: `profile` (aws), `host` (gitlab), `rpc` (solana-rpc, `${ENV}` references only). */
  options?: Record<string, string>;
}

/** How often the sign-in tip has been counted and shown. See tips.ts. */
export interface TipState {
  launches: number;
  shown: number;
  lastShown: number;
  dismissed: boolean;
}

export interface ConnectorsConfig {
  version: 1;
  connectors: Partial<Record<ConnectorId, ConnectorEntry>>;
  tips: TipState;
}

export const DEFAULT_TIPS: TipState = { launches: 0, shown: 0, lastShown: 0, dismissed: false };
export const emptyConfig = (): ConnectorsConfig => ({ version: 1, connectors: {}, tips: { ...DEFAULT_TIPS } });

const RANK: Readonly<Record<Access, number>> = { off: 0, read: 1, ask: 2, allow: 3 };
/**
 * The level a connector really offers for a saved one: the highest it has that is not above it. Docker and AWS never
 * offer `allow` (every change or call asks), and the Solana lookup only reads, whatever a hand-edited file says.
 */
export function offeredAccess(id: ConnectorId, saved: Access): Access {
  const spec = connectorSpec(id);
  if (!spec || saved === 'off') return saved;
  const offered = spec.levels.filter((level) => RANK[level] <= RANK[saved]).sort((a, b) => RANK[b] - RANK[a])[0];
  return offered ?? 'off';
}

/** The option names each connector may carry. Anything else in the file is ignored. */
export const OPTION_KEYS: Partial<Record<ConnectorId, readonly string[]>> = {
  aws: ['profile'],
  gitlab: ['host'],
  'solana-rpc': ['rpc'],
};

const file = (stateRoot: string) => join(stateRoot, 'connectors.json');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** A setting value is a short single line; an RPC address may only name its key through `${ENV}`, never hold it. */
export function validOption(key: string, value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 300 || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (key === 'rpc') {
    if (!/^https:\/\//.test(value) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(value)) return false;
    // A literal key in the address would be a token on disk.
    const literalKey = /[?&](?:api[-_]?key|key|token|access[-_]?token)=(?!\$\{[A-Z0-9_]+\})[^&]+/i;
    if (literalKey.test(value)) return false;
    if (/\/\/[^/]*@/.test(value)) return false;
  }
  if (key === 'profile' && !/^[A-Za-z0-9_.-]{1,64}$/.test(value)) return false;
  if (key === 'host' && !/^[A-Za-z0-9.-]{1,253}$/.test(value)) return false;
  return true;
}

export interface LoadedConnectors {
  config: ConnectorsConfig;
  /** One plain sentence per thing in the file that was not usable. Empty when the file is fine or absent. */
  problems: string[];
  /** False when the file exists but could not be read as JSON: it is kept as it is and never overwritten. */
  writable: boolean;
}

/**
 * The saved connectors. A missing file means defaults. A file that is not valid JSON turns every connector off and says
 * so; one bad entry turns only that connector off. It never throws and never starts anything.
 */
export function readConnectorsConfig(stateRoot: string): LoadedConnectors {
  let text: string;
  try {
    text = readFileSync(file(stateRoot), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { config: emptyConfig(), problems: [], writable: true };
    return {
      config: emptyConfig(),
      problems: ['connectors.json could not be read, so connectors are off. Check its permissions.'],
      writable: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      config: emptyConfig(),
      problems: ['connectors.json is not valid JSON, so connectors are off. Fix or delete the file to continue.'],
      writable: false,
    };
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    return {
      config: emptyConfig(),
      problems: ['connectors.json is not in a format this version understands, so connectors are off.'],
      writable: false,
    };
  }
  const config = emptyConfig();
  const problems: string[] = [];
  if (isRecord(parsed.connectors)) {
    for (const id of CONNECTOR_IDS) {
      const raw = parsed.connectors[id];
      if (raw === undefined) continue;
      if (!isRecord(raw) || typeof raw.enabled !== 'boolean' || !ACCESS_LEVELS.includes(raw.access as Access)) {
        problems.push(`connectors.json: the ${id} entry is not valid, so ${id} is off.`);
        continue;
      }
      let enabled = raw.enabled;
      const options: Record<string, string> = {};
      if (isRecord(raw.options)) {
        for (const key of OPTION_KEYS[id] ?? []) {
          const value = raw.options[key];
          if (value === undefined) continue;
          if (validOption(key, value)) options[key] = value;
          else {
            problems.push(
              key === 'rpc'
                ? `connectors.json: ${id} ${key} must be an https address that names its key as \${ENV_VAR}, so ${id} is off.`
                : `connectors.json: ${id} ${key} is not valid, so ${id} is off.`,
            );
            enabled = false;
          }
        }
      }
      const access = offeredAccess(id, raw.access as Access);
      if (access !== raw.access) {
        problems.push(
          `connectors.json: ${id} cannot be set to ${String(raw.access)}; it is ${access === 'off' ? 'off' : `set to ${access}`}.`,
        );
        if (access === 'off') enabled = false;
      }
      config.connectors[id] = {
        enabled,
        access: access === 'off' ? 'read' : access,
        ...(Object.keys(options).length ? { options } : {}),
      };
    }
  }
  if (isRecord(parsed.tips)) {
    config.tips = {
      launches: count(parsed.tips.launches),
      shown: count(parsed.tips.shown),
      lastShown: count(parsed.tips.lastShown),
      dismissed: parsed.tips.dismissed === true,
    };
  }
  return { config, problems, writable: true };
}

/** Replace the file with `config`: a private file written beside it and renamed over it. False when it could not be written. */
export function writeConnectorsConfig(stateRoot: string, config: ConnectorsConfig): boolean {
  const target = file(stateRoot);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    // The mode of a new file is masked by the umask; the rule here is exactly 0600.
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    return true;
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Nothing was written there.
    }
    return false;
  }
}

/** The access the agent actually has: nothing unless the connector is switched on. */
export function effectiveAccess(entry: ConnectorEntry | undefined): Access {
  return entry?.enabled ? entry.access : 'off';
}
