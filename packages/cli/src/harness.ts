import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  configuredBackend,
  createTask,
  defaultHarnessEnvironment,
  openWorkspace,
  omsCommand,
  parseHarnessTaskDefinition,
  prepareHarnessTask,
  readTask,
  resolveBaseOid,
  type HarnessSessionOptions,
  type OpenWorkspaceOptions,
  type Workspace,
} from '@oms/engine';
import { DEFAULT_BUDGET_CAPS } from '@oms/core';
import { runInteractiveHarness } from './interactive.ts';
import { runHeadlessHarness } from './headless.ts';

interface CommandFlags {
  values: Map<string, string>;
  positional: string[];
}

function flags(args: string[], admitted: readonly string[], switches: readonly string[] = []): CommandFlags {
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    if (!admitted.includes(value)) throw new Error(`Unknown option ${value}`);
    if (values.has(value)) throw new Error(`Option ${value} was repeated`);
    if (switches.includes(value)) {
      values.set(value, 'true');
      continue;
    }
    const parameter = args[++index];
    if (!parameter || parameter.startsWith('--')) throw new Error(`Option ${value} needs a value`);
    values.set(value, parameter);
  }
  return { values, positional };
}

function integer(value: string | undefined, fallback: number, label: string, multiplier = 1): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const result = Number(value) * multiplier;
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the safe bound`);
  return result;
}

function microDollars(value: string | undefined): number {
  if (value === undefined) return DEFAULT_BUDGET_CAPS.spendMicroUsd;
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(value);
  if (!match) throw new Error('--spend-usd requires nonnegative dollars with at most six decimal places');
  const amount = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('--spend-usd is outside the permitted bound');
  return Number(amount);
}

/** Large enough for a medium file write; each model request is lowered to that model's own maximum, so a smaller model stays usable. */
const DEFAULT_OUTPUT_TOKENS = 32_768;

export type LaunchOptions = Pick<HarnessSessionOptions, 'caps' | 'maxOutputTokens'> & {
  executionMode: NonNullable<HarnessSessionOptions['executionMode']>;
};

/** Chat and task launches use the same explicit limits. */
export function parseLaunchOptions(
  args: string[],
  extraOptions: readonly string[] = [],
  extraSwitches: readonly string[] = [],
): CommandFlags & LaunchOptions {
  const parsed = flags(
    args,
    ['--sandbox', '--bounded', '--tokens', '--spend-usd', '--minutes', '--output-tokens', '--no-web', ...extraOptions],
    ['--bounded', '--no-web', ...extraSwitches],
  );
  if (parsed.positional.length) throw new Error('OMS launch accepts named options only');
  return {
    ...parsed,
    executionMode: parsed.values.has('--bounded') ? 'bounded' : 'interactive',
    caps: {
      tokens: integer(parsed.values.get('--tokens'), DEFAULT_BUDGET_CAPS.tokens, '--tokens'),
      spendMicroUsd: microDollars(parsed.values.get('--spend-usd')),
      wallClockMs: integer(parsed.values.get('--minutes'), DEFAULT_BUDGET_CAPS.wallClockMs, '--minutes', 60_000),
    },
    maxOutputTokens: integer(parsed.values.get('--output-tokens'), DEFAULT_OUTPUT_TOKENS, '--output-tokens'),
  };
}

/** Headless runs default to $4 and 40 minutes; explicit flags are honored as given. */
export const headlessCaps = (parsed: CommandFlags & LaunchOptions) => ({
  ...parsed.caps,
  spendMicroUsd: parsed.values.has('--spend-usd') ? parsed.caps.spendMicroUsd : 4_000_000,
  wallClockMs: parsed.values.has('--minutes') ? parsed.caps.wallClockMs : 40 * 60_000,
});

/** Claude Code constructs its own request, so a serialized-input token cap cannot be enforced. */
export function headlessInputTokens(
  parsed: Pick<CommandFlags, 'values'>,
  provider: string | undefined,
): number | undefined {
  if (provider === 'claude-code') {
    if (parsed.values.has('--input-tokens'))
      throw new Error(
        '--input-tokens is unavailable for Claude Code; its native CLI constructs the request. Total token and time limits still apply.',
      );
    return undefined;
  }
  return Math.min(integer(parsed.values.get('--input-tokens'), 65_536, '--input-tokens'), 1_000_000);
}

function stateOptions(values: Map<string, string>): OpenWorkspaceOptions {
  const stateRoot = values.get('--state-root');
  return stateRoot === undefined ? {} : { stateRoot: resolve(stateRoot) };
}

function selectedTask(workspace: Workspace, taskId: string | undefined) {
  if (taskId) return readTask(workspace, taskId);
  const ids = readdirSync(resolve(workspace.omsDir, 'tasks')).filter((id) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id));
  if (ids.length !== 1)
    throw new Error(
      ids.length
        ? `Choose --task from: ${ids.join(', ')}`
        : `No task exists. Create one with \`${omsCommand()} task create\` and explicit requirements first.`,
    );
  return readTask(workspace, ids[0]!);
}

/** Only local user commands call this; the model receives no host-path/configuration primitive. */
export async function runHarnessCommand(
  command: string,
  args: string[],
  runtime: Pick<HarnessSessionOptions, 'modelRuntime' | 'clock'> = {},
): Promise<number> {
  if (command === 'workspace') {
    const parsed = flags(args, ['--ignore', '--state-root']);
    if (parsed.positional.length !== 2 || parsed.positional[0] !== 'init') {
      throw new Error(
        `Usage: ${omsCommand()} workspace init <repository> --ignore gitignore|exclude|require-existing [--state-root <directory>]`,
      );
    }
    const ignore = parsed.values.get('--ignore');
    if (ignore !== 'gitignore' && ignore !== 'exclude' && ignore !== 'require-existing') {
      throw new Error('Initialization requires an explicit --ignore gitignore|exclude|require-existing decision');
    }
    const workspace = openWorkspace(resolve(parsed.positional[1]!), {
      ...stateOptions(parsed.values),
      initialize: { ignore },
    });
    console.log(JSON.stringify(workspace, null, 2));
    return 0;
  }
  if (command === 'task') {
    const parsed = flags(args, [
      '--workspace',
      '--state-root',
      '--id',
      '--base',
      '--requirements',
      '--surfpool-binary',
      '--sandbox',
    ]);
    if (parsed.positional.length !== 1 || parsed.positional[0] !== 'create') {
      throw new Error(
        `Usage: ${omsCommand()} task create --workspace <repository> [--base <revision>] --requirements <file> [--id <task-id>]`,
      );
    }
    const requirementsFile = parsed.values.get('--requirements');
    if (!requirementsFile) throw new Error('Task creation requires --requirements <file>');
    let requirements: unknown;
    try {
      requirements = JSON.parse(readFileSync(resolve(requirementsFile), 'utf8'));
    } catch {
      throw new Error(
        `Requirements file is missing or is not valid JSON; values were not printed. Expected a JSON object {"contract", "verifierPaths", "codePaths"} with nonempty verifierPaths and codePaths arrays; see packages/engine/NOTES.md`,
      );
    }
    const definition = parseHarnessTaskDefinition(requirements);
    const workspace = openWorkspace(
      resolve(parsed.values.get('--workspace') ?? process.cwd()),
      stateOptions(parsed.values),
    );
    const baseOid = resolveBaseOid(workspace, parsed.values.get('--base'));
    const id = parsed.values.get('--id');
    const task = createTask(workspace, { baseOid, ...(id === undefined ? {} : { id }) });
    const environment = defaultHarnessEnvironment(
      parsed.values.get('--surfpool-binary'),
      configuredBackend(parsed.values.get('--sandbox')),
    );
    await prepareHarnessTask(workspace, task, environment, definition);
    console.log(
      JSON.stringify(
        { taskId: task.id, workspaceId: workspace.id, codeRoot: task.codeRoot, requirements: task.taskFile },
        null,
        2,
      ),
    );
    return 0;
  }
  if (command === 'run') {
    const parsed = parseLaunchOptions(
      args,
      [
        '--workspace',
        '--state-root',
        '--task',
        '--session',
        '--surfpool-binary',
        '--provider',
        '--model',
        '--headless',
        '--json-out',
        '--knowledge',
        '--knowledge-hint',
        '--knowledge-inject',
        '--input-tokens',
        '--sandbox',
        '--host-approval',
        '--subscription-spend-exempt',
        '--web',
        '--edge-check',
      ],
      [
        '--headless',
        '--knowledge',
        '--knowledge-hint',
        '--knowledge-inject',
        '--subscription-spend-exempt',
        '--web',
        '--edge-check',
      ],
    );
    const headless = parsed.values.has('--headless');
    const approval = parsed.values.get('--host-approval') ?? 'deny';
    if (approval !== 'deny' && approval !== 'allow') throw new Error('--host-approval must be deny or allow');
    if (headless && ['--task', '--provider', '--model', '--json-out'].some((key) => !parsed.values.has(key))) {
      throw new Error('Headless requires --task, --provider, --model and --json-out');
    }
    if (!headless && (!process.stdin.isTTY || !process.stdout.isTTY))
      throw new Error('Run OMS in an interactive terminal');
    if (!headless && parsed.values.has('--json-out')) throw new Error('--json-out requires --headless');
    const provider = parsed.values.get('--provider');
    const model = parsed.values.get('--model');
    if (!!provider !== !!model) throw new Error('Provide --provider and --model together');
    const inputTokens = headless || provider === 'claude-code' ? headlessInputTokens(parsed, provider) : undefined;
    const workspace = openWorkspace(
      resolve(parsed.values.get('--workspace') ?? process.cwd()),
      stateOptions(parsed.values),
    );
    const task = selectedTask(workspace, parsed.values.get('--task'));
    const sessionId = parsed.values.get('--session');
    // Benchmark cells pin their reference setup with --knowledge (token from the trusted environment, the hint and primer only as flagged).
    // Every other run resolves it in the session: OMS_KNOWLEDGE_URL plus OMS_KNOWLEDGE_TOKEN, else the signed-in account.
    const pinnedToken = parsed.values.has('--knowledge') ? process.env.OMS_KNOWLEDGE_TOKEN : undefined;
    const knowledge = pinnedToken
      ? { endpoint: process.env.OMS_KNOWLEDGE_URL ?? 'https://barestate.xyz/oms/api/knowledge/mcp', token: pinnedToken }
      : undefined;
    const options: HarnessSessionOptions = {
      workspace,
      task,
      hostApprovalPolicy: approval,
      environment: defaultHarnessEnvironment(
        parsed.values.get('--surfpool-binary'),
        configuredBackend(parsed.values.get('--sandbox')),
      ),
      executionMode: headless ? 'bounded' : parsed.executionMode,
      caps: headless ? headlessCaps(parsed) : parsed.caps,
      maxOutputTokens: parsed.maxOutputTokens,
      ...(headless
        ? { ...(inputTokens === undefined ? {} : { maxInputTokens: inputTokens }), outputMode: 'head-tail' as const }
        : {}),
      // Subscription-backed calls spend no API credit; opt in only when the provider is a ChatGPT subscription.
      ...(headless && parsed.values.has('--subscription-spend-exempt') ? { subscriptionSpendExempt: true } : {}),
      ...runtime,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(provider && model ? { modelSelection: { provider, id: model } } : {}),
      ...(knowledge
        ? {
            knowledge,
            knowledgeHint: parsed.values.has('--knowledge-hint'),
            knowledgeInject: parsed.values.has('--knowledge-inject'),
          }
        : {
            ...(parsed.values.has('--knowledge-hint') ? { knowledgeHint: true } : {}),
            ...(parsed.values.has('--knowledge-inject') ? { knowledgeInject: true } : {}),
          }),
      ...(parsed.values.has('--edge-check') ? { edgeCheck: true } : {}),
    };
    // Headless (the bench runner, CI) is offline unless --web asks; the bench runner never passes it.
    if (headless)
      return runHeadlessHarness(
        parsed.values.has('--web') && !parsed.values.has('--no-web') ? { ...options, web: { enabled: true } } : options,
        resolve(parsed.values.get('--json-out')!),
      );
    await runInteractiveHarness(options, { web: !parsed.values.has('--no-web') });
    return 0;
  }
  throw new Error('Unknown Harness command');
}
