import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { inspectMutationLease, omsCommand } from '@oms/engine';
import { shortPath } from './sessions.ts';
import type { Install } from './update.ts';

const PACKAGE = '@barestate/oms';
const SHELL_FILES = ['.zshrc', '.bashrc', '.bash_profile', '.bash_login', '.profile', '.config/fish/config.fish'];

export interface UninstallDeps {
  install: Install;
  npm: string;
  home: string;
  /** ~/.oms: conversations, sign-ins, settings and downloaded tools. */
  stateRoot: string;
  exec: (file: string, args: string[]) => Promise<number>;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Absent when there is no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>;
}

const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

const shellQuote = (path: string): string => "'" + path.replaceAll("'", "'\\''") + "'";

function hasInstallerLauncher(root: string): boolean {
  const target = shellQuote(join(root, 'cli', 'bin', 'oms'));
  return read(join(root, 'bin', 'oms'))
    .split('\n')
    .some((line) => line.startsWith('exec ') && line.endsWith(` ${target} "$@"`));
}

/** Where install.sh put this copy, recognised by its launcher so a custom OMS_HOME counts too. */
function installerHome(install: Install): string | undefined {
  if (install.kind === 'installer') return dirname(install.prefix);
  if (install.kind !== 'npm' || basename(install.prefix) !== 'cli') return undefined;
  const root = dirname(install.prefix);
  return hasInstallerLauncher(root) ? root : undefined;
}

const statIfPresent = (path: string) => lstatSync(path, { throwIfNoEntry: false });

function privateDirExists(path: string): boolean {
  const info = statIfPresent(path);
  if (!info) return false;
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error('State directory is not private');
  return true;
}

function stateDirs(parent: string): string[] {
  if (!privateDirExists(parent)) return [];
  return readdirSync(parent).map((name) => {
    const path = join(parent, name);
    if (!privateDirExists(path)) throw new Error('State directory disappeared');
    return path;
  });
}

function* nestedWorkspaceLeases(stateRoot: string): Iterable<string> {
  const pending = [stateRoot];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      if (
        (entry.name === 'registry.lease' || entry.name === 'registry.lease.recovery') &&
        dir !== stateRoot &&
        statIfPresent(join(dir, 'workspaces'))?.isDirectory()
      ) {
        yield join(dir, 'registry.lease');
      } else if (
        (entry.name === 'mutation.lease' || entry.name === 'mutation.lease.recovery') &&
        /\/workspaces\/[^/]+(?:\/tasks\/[^/]+)?$/.test(dir)
      ) {
        yield join(dir, 'mutation.lease');
      }
    }
  }
}

function canPurge(stateRoot: string, home: string, error: UninstallDeps['error']): boolean {
  try {
    if (!privateDirExists(stateRoot)) return true;

    const leases = new Set([
      join(stateRoot, 'registry.lease'),
      ...stateDirs(join(stateRoot, 'folders')).map((dir) => join(dir, 'session.lease')),
      ...stateDirs(join(stateRoot, 'workspaces')).flatMap((dir) => [
        join(dir, 'mutation.lease'),
        ...stateDirs(join(dir, 'tasks')).map((task) => join(task, 'mutation.lease')),
      ]),
      ...nestedWorkspaceLeases(stateRoot),
    ]);
    for (const lease of leases) {
      if (statIfPresent(`${lease}.recovery`)) throw new Error('Recovery lease exists');
      const stat = statIfPresent(lease);
      if (stat && !stat.isFile()) throw new Error('Invalid lease file');
      const { status } = inspectMutationLease(lease);
      if (status === 'live') {
        error(`oms: OMS is open in ${shortPath(dirname(lease), home)}. Close it first.`);
        return false;
      }
      if (status !== 'absent') throw new Error('Unresolved lease');
    }
    return true;
  } catch {
    error('oms: Cannot verify ownership of saved state. Close OMS and recover any held sessions before purging.');
    return false;
  }
}

export async function runUninstall(args: string[], deps: UninstallDeps): Promise<number> {
  const { install, home, stateRoot, log, error } = deps;
  const unknown = args.find((arg) => arg !== '--purge' && arg !== '--yes');
  if (unknown) {
    error(`oms uninstall: unknown option "${unknown}"\nUsage: ${omsCommand()} uninstall [--purge] [--yes]`);
    return 2;
  }
  const purge = args.includes('--purge');

  const root = installerHome(install);
  // Only what install.sh creates is removed, never the folder it was told to use.
  const paths: string[] = [];
  let command: { file: string; args: string[] } | undefined;
  if (root) {
    paths.push(join(root, 'cli'));
    if (hasInstallerLauncher(root)) paths.push(join(root, 'bin', 'oms'));
    if (existsSync(join(root, 'node', 'bin', 'node'))) paths.push(join(root, 'node'));
  } else if (install.kind === 'npm') {
    command = { file: deps.npm, args: ['uninstall', '-g', '--prefix', install.prefix, PACKAGE] };
  } else if (install.kind === 'brew') {
    command = { file: 'brew', args: ['uninstall', 'barestate-ai/tap/oms'] };
  }
  if (!paths.length && !command && !purge) {
    error(
      install.kind === 'npx'
        ? 'oms: npx runs a cached copy and installs nothing to remove.'
        : install.kind === 'project'
          ? `oms: oms is a dependency of a project. Run: npm uninstall ${PACKAGE} (in ${install.dir})`
          : 'oms: this is a source checkout; delete the folder yourself if you no longer need it.',
    );
    return 1;
  }
  if (purge && !canPurge(stateRoot, home, error)) return 1;

  log('This removes:');
  for (const path of paths) log(`  ${shortPath(path, home)}`);
  if (command) log(`  the oms package, with: ${[command.file, ...command.args].join(' ')}`);
  if (purge) log(`  ${shortPath(stateRoot, home)} · all saved conversations, model sign-ins, settings and tools`);
  else log(`Kept: your conversations, sign-ins and settings in ${shortPath(stateRoot, home)} (--purge deletes them).`);

  if (!args.includes('--yes')) {
    if (!deps.confirm) {
      error('oms: nothing removed. There is no terminal to confirm on; add --yes.');
      return 1;
    }
    if (!(await deps.confirm('Uninstall oms?'))) {
      log('Nothing removed.');
      return 1;
    }
  }

  if (purge && !canPurge(stateRoot, home, error)) return 1;
  if (command && (await deps.exec(command.file, command.args)) !== 0) {
    error(`oms: the uninstall failed, so nothing else was removed. Run: ${[command.file, ...command.args].join(' ')}`);
    return 1;
  }
  for (const path of paths) rmSync(path, { recursive: true, force: true });
  if (purge) {
    if (!canPurge(stateRoot, home, error)) return 1;
    rmSync(stateRoot, { recursive: true, force: true });
  }
  log('Removed.');
  if (root) {
    const bin = join(root, 'bin');
    const lines = SHELL_FILES.filter((file) => {
      const content = read(join(home, file));
      return content.includes(bin) || content.includes(shellQuote(bin));
    });
    if (lines.length)
      log(
        `Delete the PATH line for ${shortPath(join(root, 'bin'), home)} from: ${lines.map((file) => `~/${file}`).join(', ')}`,
      );
  }
  const reviews = join(home, '.oms-review');
  if (purge && existsSync(reviews)) log(`Security review reports are still in ${shortPath(reviews, home)}.`);
  return 0;
}
