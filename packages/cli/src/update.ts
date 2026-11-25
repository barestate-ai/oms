import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PACKAGE = '@barestate/oms';
const RELEASE = /^\d+\.\d+\.\d+$/;
const LATEST_URL = 'https://registry.npmjs.org/@barestate%2Foms/latest';

export type Install =
  | { kind: 'installer'; prefix: string }
  | { kind: 'npm'; prefix: string }
  | { kind: 'brew' }
  | { kind: 'npx' }
  | { kind: 'project'; dir: string }
  | { kind: 'source' };

export interface UpdateDeps {
  current: string;
  install: Install;
  /** The npm that belongs to the Node running oms. */
  npm: string;
  latest: () => Promise<string>;
  exec: (file: string, args: string[]) => Promise<number>;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** Works out how oms was installed from the folder it runs in; `omsHome` is where install.sh put it (default ~/.oms). */
export function detectInstall(root: string, home: string, omsHome = join(home, '.oms')): Install {
  const path = root.replaceAll('\\', '/');
  if (path.includes('/Cellar/')) return { kind: 'brew' };
  if (path.includes('/_npx/')) return { kind: 'npx' };
  const global = /^(.*)\/lib\/node_modules\/@barestate\/oms$/.exec(path);
  if (global) {
    const prefix = global[1]!;
    return prefix === join(omsHome, 'cli') ? { kind: 'installer', prefix } : { kind: 'npm', prefix };
  }
  const local = /^(.*)\/node_modules\/@barestate\/oms$/.exec(path);
  return local ? { kind: 'project', dir: local[1]! } : { kind: 'source' };
}

/** True only for a plain x.y.z release that is above `current`; prereleases and junk are never offered. */
export function isNewer(candidate: string, current: string): boolean {
  if (!RELEASE.test(candidate) || !RELEASE.test(current)) return false;
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** The command that installs `version` in place, or undefined when oms cannot do that for this kind of install. */
export function installCommand(
  install: Install,
  version: string,
  npm: string,
): { file: string; args: string[] } | undefined {
  if (install.kind === 'brew') return { file: 'brew', args: ['upgrade', 'barestate-ai/tap/oms'] };
  if (install.kind !== 'npm' && install.kind !== 'installer') return undefined;
  return {
    file: npm,
    args: [
      'install',
      '-g',
      '--prefix',
      install.prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `${PACKAGE}@${version}`,
    ],
  };
}

function advice(install: Install, version: string): string {
  if (install.kind === 'npx')
    return `You are running oms through npx, which fetches releases itself. Use: npx ${PACKAGE}@latest`;
  if (install.kind === 'project') {
    return `oms is a dependency of a project. Run: npm install ${PACKAGE}@${version} (in ${install.dir})`;
  }
  return `You are running oms from a source checkout. Update it with: git pull && npm ci --ignore-scripts`;
}

export async function runUpdate(args: string[], deps: UpdateDeps): Promise<number> {
  let check = false;
  let pinned: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--check') check = true;
    else if (arg === '--version') {
      pinned = args[++i];
      if (!pinned || !RELEASE.test(pinned)) return usage(deps, '--version needs a release number such as 0.1.3');
    } else return usage(deps, `unknown option "${arg}"`);
  }
  if (pinned && deps.install.kind === 'brew') {
    return usage(deps, 'Homebrew cannot install a chosen version. Run: brew upgrade barestate-ai/tap/oms');
  }

  let target: string;
  try {
    target = pinned ?? (await deps.latest());
  } catch (error) {
    deps.error(`oms: could not check for updates (${error instanceof Error ? error.message : 'lookup failed'})`);
    return 1;
  }
  if (!pinned && !isNewer(target, deps.current)) {
    deps.log(`oms ${deps.current} is up to date.`);
    return 0;
  }
  if (pinned === deps.current) {
    deps.log(`oms ${deps.current} is already installed.`);
    return 0;
  }

  const command = installCommand(deps.install, target, deps.npm);
  const how = command ? 'oms update' : advice(deps.install, target);
  if (check) {
    deps.log(`oms ${target} is available (you have ${deps.current}). ${command ? `Run: ${how}` : how}`);
    return 0;
  }
  if (!command) {
    deps.error(`oms: ${how}`);
    return 1;
  }
  deps.log(`Installing oms ${target} (you have ${deps.current})`);
  if ((await deps.exec(command.file, command.args)) !== 0) {
    deps.error(
      `oms: the update failed; nothing was changed by oms itself. Run it yourself: ${[command.file, ...command.args].join(' ')}`,
    );
    return 1;
  }
  deps.log(`Updated oms ${deps.current} → ${target}. Run: oms doctor`);
  return 0;
}

function usage(deps: UpdateDeps, problem: string): number {
  deps.error(`oms update: ${problem}\nUsage: oms update [--check] [--version <x.y.z>]`);
  return 2;
}

async function fetchLatest(): Promise<string> {
  const response = await fetch(LATEST_URL, {
    signal: AbortSignal.timeout(8000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`registry answered ${response.status}`);
  const { version } = (await response.json()) as { version?: unknown };
  if (typeof version !== 'string' || !RELEASE.test(version)) throw new Error('registry returned no release version');
  return version;
}

function exec(file: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Real dependencies for `oms update`, given the folder this copy of oms runs from. */
export function updateDeps(root: string, current: string): UpdateDeps {
  const real = realpathSync(root);
  const npm = join(dirname(process.execPath), 'npm');
  return {
    current,
    install: detectInstall(real, homedir(), process.env.OMS_HOME),
    npm: existsSync(npm) ? npm : 'npm',
    latest: fetchLatest,
    exec,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}
