import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createOmsAccountControls, omsCommand, privateDirectory, type OmsAccountControls } from '@oms/engine';
import { displayText } from './tui/transcript.ts';

export interface AccountDeps {
  controls: Pick<OmsAccountControls, 'snapshot' | 'login' | 'logout' | 'refresh'>;
  signal: AbortSignal;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** The same account session the chat's /login uses, stored under the state root. */
export function accountControls(stateRoot: string, signal: AbortSignal): OmsAccountControls {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const agentRoot = join(stateRoot, 'agent');
  privateDirectory(agentRoot);
  return createOmsAccountControls({ agentRoot, signal, withUserOperation: (action) => action() });
}

const clean = (text: string): string => displayText(text, 320).replace(/\s+/g, ' ');

export async function runAccountCommand(
  command: 'login' | 'logout' | 'whoami',
  args: string[],
  { controls, signal, log, error }: AccountDeps,
): Promise<number> {
  if (args.length) {
    error(`Usage: ${omsCommand()} ${command}`);
    return 2;
  }
  const who = (): string => {
    const { email, userId } = controls.snapshot();
    return clean(email ?? userId ?? 'your account');
  };
  const signedOut = (): boolean => controls.snapshot().state === 'signed-out';
  try {
    const { state, message } = controls.snapshot();
    if (state === 'unavailable') {
      error(`oms: ${message ?? 'the account is unavailable'}`);
      return 1;
    }
    if (command === 'login') {
      if (state === 'signed-in') {
        await controls.refresh(signal);
        const current = controls.snapshot();
        if (current.state === 'signed-in') {
          log(`Already signed in · ${omsCommand()} logout to switch accounts.`);
          return 0;
        }
        if (current.state === 'unavailable') throw new Error(current.message ?? 'the account is unavailable');
      }
      await controls.login(
        {
          showDevice: ({ verificationUri, userCode }) =>
            log(`Open ${clean(verificationUri)} and enter the code ${clean(userCode)}\nWaiting for approval…`),
          notice: (text) => log(clean(text)),
        },
        signal,
      );
      log(`Signed in as ${who()}.`);
      return 0;
    }
    if (state === 'signed-out') {
      log(command === 'logout' ? 'Not signed in.' : `Not signed in · ${omsCommand()} login`);
      return command === 'logout' ? 0 : 1;
    }
    if (command === 'logout') {
      const { serverRevoked } = await controls.logout(signal);
      log(
        serverRevoked ? 'Signed out.' : 'Signed out on this device. The server did not confirm it ended the session.',
      );
      return 0;
    }
    try {
      await controls.refresh(signal);
    } catch {
      log('Signed in on this device. The account service could not be reached to confirm it.');
      return 0;
    }
    if (signedOut()) {
      log(`Not signed in (the saved session has ended) · ${omsCommand()} login`);
      return 1;
    }
    log(`Signed in as ${who()}.`);
    return 0;
  } catch (failure) {
    const text = failure instanceof Error ? failure.message : 'the account request failed';
    error(`oms: ${clean(text).replaceAll('/login', `${omsCommand()} login`)}`);
    return 1;
  }
}
