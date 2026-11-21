import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessSession, HarnessSessionOptions } from '@oms/engine';
import { openHarnessWithOwnership } from './ownership.ts';
import { runOmsInterface } from './tui/interface.ts';
import { interfacePreferences } from './tui/preferences.ts';

function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Resume the OMS owner and its current selection, including a bound native Claude chat. */
export function resumeHarnessArguments(
  options: HarnessSessionOptions,
  harness: Pick<HarnessSession, 'workspace' | 'task' | 'session'>,
  sessionId: string,
  capArgs: string[],
): string[] {
  const model = harness.session.model;
  return [
    process.execPath,
    fileURLToPath(new URL('./bin.ts', import.meta.url)),
    'run',
    '--workspace',
    harness.workspace.root,
    '--state-root',
    dirname(dirname(harness.workspace.stateDir)),
    '--task',
    harness.task.id,
    '--session',
    sessionId,
    '--surfpool-binary',
    options.environment.binary,
    ...(model ? ['--provider', model.provider, '--model', model.id] : []),
    ...capArgs,
  ];
}

/** `web` from `<state root>/config.json` (default on). A malformed file is an error, never a silent default. */
export function webSetting(stateRoot: string): 'on' | 'off' {
  const path = join(stateRoot, 'config.json');
  if (!existsSync(path)) return 'on';
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const web = (config as { web?: unknown } | null)?.web ?? 'on';
  if (web !== 'on' && web !== 'off') throw new Error(`${path}: web must be "on" or "off"`);
  return web;
}

/** The CLI owns the application lifetime; the controller owns every task resource. */
export async function runInteractiveHarness(
  options: HarnessSessionOptions,
  launch: {
    /** false for --no-web. Web tools are still registered so /web on can turn them on later. */
    web?: boolean;
  } = {},
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('OMS needs an interactive terminal');
  // Internal SDK policy: no automatic catalog refresh, update checks or telemetry.
  process.env.PI_OFFLINE = '1';
  const stateRoot = dirname(dirname(options.workspace.stateDir));
  options = { ...options, web: { enabled: launch.web !== false && webSetting(stateRoot) === 'on' } };
  const harness = await openHarnessWithOwnership(options);
  if (!harness) return;
  const sessionId = harness.session.sessionManager.getSessionId();
  process.stdout.write(`OMS ready | task ${harness.task.id} | Harness\n`);
  try {
    await runOmsInterface(harness, { ...interfacePreferences(stateRoot), view: 'harness' });
  } finally {
    await harness.close();
  }
  const microDollars = BigInt(options.caps.spendMicroUsd);
  const dollars = `${microDollars / 1_000_000n}.${(microDollars % 1_000_000n).toString().padStart(6, '0')}`;
  const capArgs = [
    '--tokens',
    String(options.caps.tokens),
    '--spend-usd',
    dollars,
    '--minutes',
    String(options.caps.wallClockMs / 60_000),
    '--output-tokens',
    String(options.maxOutputTokens),
  ];
  if (options.executionMode !== 'interactive') capArgs.push('--bounded');
  if (harness.web?.enabled() === false) capArgs.push('--no-web');

  const conversation = harness.session.sessionManager.getSessionFile();
  if (conversation && existsSync(conversation)) {
    const args = resumeHarnessArguments(options, harness, sessionId, capArgs);
    process.stdout.write(`Run this command to resume this OMS session.\n${args.map(shellWord).join(' ')}\n`);
  }
}
