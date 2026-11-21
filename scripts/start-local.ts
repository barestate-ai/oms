import { constants, accessSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  backendFor,
  configuredBackend,
  defaultHarnessEnvironment,
  DOCKER_CHAT_REFUSAL,
  omsCommand,
  type HarnessEnvironment,
} from '@oms/engine';
import { runInteractiveChat } from '../packages/cli/src/chat.ts';
import { DEFAULT_OPTIONS } from '../packages/cli/src/doctor/checks.ts';
import { installPinnedSurfpool } from '../packages/cli/src/doctor/install.ts';
import { parseLaunchOptions } from '../packages/cli/src/harness.ts';

export function omsHome(): string {
  return join(homedir(), '.oms');
}

export async function checkLocalPrerequisites(environment: HarnessEnvironment): Promise<void> {
  try {
    accessSync(environment.binary, constants.X_OK);
  } catch {
    process.stdout.write(`Installing Surfpool ${DEFAULT_OPTIONS.pinnedSurfpool} (local Solana network, one-time)…\n`);
    try {
      await installPinnedSurfpool(environment.binary);
    } catch (error) {
      throw new Error(
        `Couldn't install Surfpool: ${error instanceof Error ? error.message : 'unknown error'} · check your connection and retry, or run \`${omsCommand()} doctor\``,
      );
    }
  }
}

/** Plain `oms`: an interactive chat that edits the current folder in place. */
export async function startLocal(args: string[] = []): Promise<void> {
  const launch = parseLaunchOptions(args, ['--yolo'], ['--yolo']);
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(`Needs an interactive terminal · run ${omsCommand()} in a terminal window`);
  const environment = defaultHarnessEnvironment(undefined, configuredBackend(launch.values.get('--sandbox')));
  if (backendFor(environment).requiresDocker) throw new Error(DOCKER_CHAT_REFUSAL);
  await checkLocalPrerequisites(environment);
  await runInteractiveChat({
    folder: process.cwd(),
    stateRoot: omsHome(),
    environment,
    launch,
    web: !launch.values.has('--no-web'),
    yolo: launch.values.has('--yolo'),
  });
}
