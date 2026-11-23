import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { omsBase, parseRunRecord, registerOmsCatalog, SEARCH_BACKENDS, type RunRecord } from '@oms/engine';
import type { ContenderModel } from './contenders.ts';
import type { CodexCredential } from './subscription.ts';
import { parseContender } from './matrix.ts';
import { runHarnessCommand } from '@oms/cli';

export interface OmsContenderRun {
  /** Cell id, for example `oms3-web:gpt-sol`. */
  contender: string;
  runIndex: number;
  selection: { provider: string; id: string };
  /** Explicit model metadata for the cell; the subscription path uses the SDK catalog entry instead. */
  modelDefinition?: ContenderModel;
  /** The ChatGPT (Codex) subscription login OMS signs in with; absent for the Claude Code cell, which owns its login. */
  subscriptionCredential?: CodexCredential;
  /** Claude Code cell: private home holding the staged, refresh-token-free `.claude/.credentials.json`. */
  claudeHome?: string;
  jsonOut: string;
  /** Headless `oms run` arguments other than provider, model and JSON output. */
  args: string[];
}

/**
 * The record's `online` label, from the contender id. An online cell launched without --web would carry the wrong label,
 * so it refuses before the run.
 */
export function onlineStamp(contender: string, args: readonly string[]): Pick<RunRecord, 'online'> {
  const online = parseContender(contender)?.online;
  if (Boolean(online) !== args.includes('--web'))
    throw new Error(`${contender} ${online ? 'needs' : 'must not get'} --web`);
  return online ? { online } : {};
}

/**
 * `--web` for the online OMS cell, on the hosted oms-search stack only: a bring-your-own search or fetch key in the environment would add
 * a backend the cell's label does not name, and a missing or non-loopback/https OMS_SEARCH_URL would leave web_search without one.
 * Credentials come from OMS_SEARCH_URL and OMS_SEARCH_TOKEN.
 */
export function omsWebArgs(contender: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!parseContender(contender)?.online) return [];
  if (!env.OMS_SEARCH_TOKEN || !omsBase(env.OMS_SEARCH_URL)) {
    throw new Error(
      `${contender} needs OMS_SEARCH_TOKEN and an https: or loopback OMS_SEARCH_URL (the oms-search stack)`,
    );
  }
  const byok = SEARCH_BACKENDS.filter((backend) => backend.name !== 'oms' && env[backend.key]).map(
    (backend) => backend.key,
  );
  if (env.FIRECRAWL_API_KEY) byok.push('FIRECRAWL_API_KEY');
  const provider = env.OMS_SEARCH_PROVIDER?.trim().toLowerCase();
  if (provider && provider !== 'auto' && provider !== 'oms') byok.push('OMS_SEARCH_PROVIDER');
  if (byok.length) throw new Error(`${contender} searches through oms-search only; unset ${byok.join(', ')}`);
  return ['--web'];
}

const ANTHROPIC_CREDENTIAL_ENV = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_|AWS_BEARER_TOKEN_BEDROCK)/;

/** The cell that drives the installed Claude Code CLI as OMS's model. */
export const isClaudeCodeCell = (model: { provider: string }) => model.provider === 'claude-code';

/** A Claude Code cell runs on its staged subscription login only: no Anthropic key, token or third-party switch may exist in the environment. */
export function assertNoAnthropicCredential(env: NodeJS.ProcessEnv = process.env): void {
  const found = Object.keys(env).filter((key) => ANTHROPIC_CREDENTIAL_ENV.test(key) && env[key]);
  if (found.length)
    throw new Error(`The Claude Code cell must run with no Anthropic credential; unset ${found.join(', ')}`);
}

export interface OmsCellArgsInput {
  cell: string;
  model: ContenderModel;
  repo: string;
  stateRoot: string;
  taskId: string;
  surfpoolWrapper: string;
  wallMinutes: number;
  outputTokens: number;
  inputTokens: number;
}

/** Headless `oms run` arguments of a bench cell. Claude Code builds its own request, so it gets no --input-tokens cap. */
export function omsCellArgs(o: OmsCellArgsInput, env: NodeJS.ProcessEnv = process.env): string[] {
  if (isClaudeCodeCell(o.model)) assertNoAnthropicCredential(env);
  return [
    '--sandbox',
    'docker',
    '--workspace',
    o.repo,
    '--state-root',
    o.stateRoot,
    '--task',
    o.taskId,
    '--minutes',
    String(o.wallMinutes),
    '--spend-usd',
    '4',
    '--output-tokens',
    String(o.outputTokens),
    ...(isClaudeCodeCell(o.model) ? [] : ['--input-tokens', String(o.inputTokens)]),
    '--tokens',
    '20000000',
    '--surfpool-binary',
    o.surfpoolWrapper,
    ...omsWebArgs(o.cell, env),
    ...(env.OMS_KNOWLEDGE_TOKEN ? ['--knowledge', '--knowledge-inject'] : []),
  ];
}

/** Runs one OMS cell through the production headless path, signed in to the Codex or Claude Code subscription. */
export async function runOmsContender(o: OmsContenderRun): Promise<number> {
  const stamp = onlineStamp(o.contender, o.args);
  const scratch = mkdtempSync(join(tmpdir(), 'oms-contender-'));
  try {
    const authPath = join(scratch, 'auth.json');
    const claude = isClaudeCodeCell(o.selection);
    if (claude ? !o.claudeHome : !o.subscriptionCredential) throw new Error(`${o.contender} has no subscription login`);
    if (claude) assertNoAnthropicCredential();
    writeFileSync(authPath, JSON.stringify(claude ? {} : { 'openai-codex': o.subscriptionCredential }), {
      mode: 0o600,
    });
    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    if (!o.args.includes('--task') || !o.args[o.args.indexOf('--task') + 1]) throw new Error('Cell runs need --task');
    registerOmsCatalog(runtime);
    // The native Claude Code provider registers itself inside the OMS session, so the session resolves that model.
    const model = claude ? o.selection : runtime.getModel(o.selection.provider, o.selection.id);
    if (!model) throw new Error(`Unknown model ${o.selection.provider}/${o.selection.id}`);
    const headlessOut = join(scratch, 'record.json');
    if (claude) process.env.OMS_CLAUDE_CODE_HOME = o.claudeHome;
    const exitCode = await runHarnessCommand(
      'run',
      [
        '--headless',
        ...o.args,
        '--subscription-spend-exempt',
        '--provider',
        model.provider,
        '--model',
        model.id,
        '--json-out',
        headlessOut,
      ],
      { modelRuntime: runtime },
    ).finally(() => {
      delete process.env.OMS_CLAUDE_CODE_HOME;
    });
    const record = parseRunRecord({
      ...JSON.parse(readFileSync(headlessOut, 'utf8')),
      contender: o.contender,
      runIndex: o.runIndex,
      funding: 'subscription',
      ...stamp,
    });
    mkdirSync(dirname(o.jsonOut), { recursive: true, mode: 0o700 });
    writeFileSync(o.jsonOut, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return exitCode;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
