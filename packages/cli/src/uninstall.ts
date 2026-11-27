import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { inspectMutationLease, omsCommand } from '@oms/engine';
import { savedFolders, shortPath } from './sessions.ts';
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

/** Where install.sh put this copy, recognised by its launcher so a custom OMS_HOME counts too. */
function installerHome(install: Install): string | undefined {
  if (install.kind === 'installer') return dirname(install.prefix);
  if (install.kind !== 'npm' || basename(install.prefix) !== 'cli') return undefined;
  const root = dirname(install.prefix);
  return read(join(root, 'bin', 'oms')).includes(`${install.prefix}/bin/oms`) ? root : undefined;
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
    if (read(join(root, 'bin', 'oms')).includes(join(root, 'cli'))) paths.push(join(root, 'bin', 'oms'));
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
  if (purge) {
    const open = savedFolders(stateRoot).find(
      (folder) => inspectMutationLease(join(folder.state, 'session.lease')).status === 'live',
    );
    if (open) {
      error(`oms: OMS is open in ${shortPath(open.path, home)}. Close it first.`);
      return 1;
    }
  }

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

  if (command && (await deps.exec(command.file, command.args)) !== 0) {
    error(`oms: the uninstall failed, so nothing else was removed. Run: ${[command.file, ...command.args].join(' ')}`);
    return 1;
  }
  for (const path of paths) rmSync(path, { recursive: true, force: true });
  if (purge) rmSync(stateRoot, { recursive: true, force: true });
  log('Removed.');
  if (root) {
    const lines = SHELL_FILES.filter((file) => read(join(home, file)).includes(join(root, 'bin')));
    if (lines.length)
      log(
        `Delete the PATH line for ${shortPath(join(root, 'bin'), home)} from: ${lines.map((file) => `~/${file}`).join(', ')}`,
      );
  }
  const reviews = join(home, '.oms-review');
  if (purge && existsSync(reviews)) log(`Security review reports are still in ${shortPath(reviews, home)}.`);
  return 0;
}
