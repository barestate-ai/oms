import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultHarnessEnvironment, omsCommand } from '@oms/engine';
import { webSetting } from './interactive.ts';
import { shortPath } from './sessions.ts';
import type { Install } from './update.ts';

const INSTALLED_BY: Record<Install['kind'], string> = {
  installer: 'curl installer',
  npm: 'npm (global)',
  brew: 'Homebrew',
  npx: 'npx',
  project: 'a project dependency',
  source: 'source checkout',
};

/** `oms config`: where OMS keeps things. It reports whether secret files exist and never opens them. */
export function runConfigCommand(
  args: string[],
  context: { version: string; install: Install; installFolder: string; stateRoot: string },
  log: (line: string) => void,
  error: (line: string) => void,
): number {
  if (args.some((arg) => arg !== '--json')) {
    error(`Usage: ${omsCommand()} config [--json]`);
    return 2;
  }
  const { stateRoot } = context;
  const settings = join(stateRoot, 'config.json');
  let webSearch: string;
  try {
    webSearch = webSetting(stateRoot);
  } catch (failure) {
    webSearch = `invalid: ${failure instanceof Error ? failure.message : 'unreadable settings'}`;
  }
  const saved = (name: string) => (existsSync(join(stateRoot, 'agent', name)) ? 'saved' : 'none');
  const surfpool = defaultHarnessEnvironment().binary;
  const values: [key: string, label: string, value: string, path?: boolean][] = [
    ['version', 'Version', context.version],
    ['installedBy', 'Installed by', INSTALLED_BY[context.install.kind]],
    ['installFolder', 'Install folder', context.installFolder, true],
    ['stateFolder', 'State folder', stateRoot, true],
    ['settingsFile', existsSync(settings) ? 'Settings file' : 'Settings file (not created)', settings, true],
    ['webSearch', 'Web search', webSearch],
    ['modelSignIns', 'Model sign-ins', saved('auth.json')],
    ['accountSignIn', 'OMS account', saved('oms-account.json')],
    ['surfpool', existsSync(surfpool) ? 'Surfpool' : 'Surfpool (not installed)', surfpool, true],
  ];
  if (args.includes('--json')) {
    log(JSON.stringify(Object.fromEntries(values.map(([key, , value]) => [key, value])), null, 2));
    return 0;
  }
  const width = Math.max(...values.map(([, label]) => label.length)) + 2;
  for (const [, label, value, path] of values) log(`${label.padEnd(width)}${path ? shortPath(value) : value}`);
  return 0;
}
