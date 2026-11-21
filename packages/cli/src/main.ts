import { DEFAULT_OPTIONS, renderText, runChecks, summarize } from './doctor/checks.ts';
import { nodeEnv } from './doctor/node-env.ts';
import { installPinnedSurfpool } from './doctor/install.ts';
import { readFileSync } from 'node:fs';
import { configuredBackend, defaultHarnessEnvironment, omsCommand } from '@oms/engine';
import { runHarnessCommand } from './harness.ts';
import { toolchainCommand } from './toolchain.ts';
import { runReviewCommand } from './review.ts';
import { startLocal } from '../../../scripts/start-local.ts';

const HELP = `oms · Solana coding agent

  ${omsCommand()}                 Start in the current folder (any folder works)
  ${omsCommand()} doctor          Check your setup
  ${omsCommand()} review [path]   Offline security review of a Solana program
  ${omsCommand()} --version       Print the version

Options
  --spend-usd <n>     Cap API spend for this session (default $5)
  --yolo              Run commands without the sandbox or approval
  --no-web            Start with web search off

Inside oms
  /connect   Sign in: ChatGPT, Claude, Grok or an API key
  /model     Pick a model
  /help      Commands and keys

More: ${omsCommand()} help advanced
`;

const ADVANCED_HELP = `oms advanced commands

Usage:
  ${omsCommand()} [--bounded] [--tokens <cap>] [--spend-usd <cap>] [--minutes <cap>] [--output-tokens <cap>]
              Start OMS in the current folder.
  ${omsCommand()} toolchain check|fix [--project <path>] [--apply] [--verify]
  ${omsCommand()} review [path] --phase A [--program <name>] [--json] [--out <new-directory>] [--state-root <directory>]
  ${omsCommand()} review [path] --purge <reviewId|all> [--state-root <directory>]
  ${omsCommand()} doctor [--json] [--programs] [--rpc <url>] [--surfpool-binary <path>] [--install]
  ${omsCommand()} workspace init <repository> --ignore gitignore|exclude|require-existing
  ${omsCommand()} task create --workspace <repository> [--base <revision>] --requirements <file> [--id <task-id>]
  ${omsCommand()} run [--workspace <repository>] [--task <task-id>] [--session <session-id>]
          [--provider <provider> --model <model>] [--bounded] [--tokens <cap>] [--spend-usd <cap>]
          [--minutes <cap>] [--output-tokens <cap>] [--surfpool-binary <path>]
          [--sandbox host|docker] [--host-approval deny|allow]

Commands:
  review      Run a local offline Phase A security review
  doctor      Check local prerequisites; does not launch an agent
  workspace   Initialize local repository identity and ignored OMS storage
  task        Create a managed worktree and pin explicit requirements
  run         Open the OMS task interface over its persistent session

Options
  --state-root <dir>     Where workspace, task and run keep state
  --session <id>         Resume a conversation (and its Claude chat)
  --tokens <n>           Tokens per turn (default 2,000,000)
  --minutes <n>          Minutes per turn (default 30)
  --spend-usd <n>        Total API spend (default $5)
  --output-tokens <n>    Max output tokens (default 32,768, or the model's own max)
  --bounded              Apply the caps to the whole session, idle time included
  --sandbox docker       Run task commands in Docker (oms run only)

Notes
  Harness is the default view; /workbench or F3 switches.
  Normal sessions are interactive: idle time does not expire the conversation.
  To use native Claude chat, run \`${omsCommand()} run --provider claude-code --model sonnet\`.
`;

async function doctor(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const rpcIdx = args.indexOf('--rpc');
  const surfnetRpcUrl = rpcIdx >= 0 ? args[rpcIdx + 1] : process.env.SURFNET_RPC_URL;
  const binaryIdx = args.indexOf('--surfpool-binary');
  if (binaryIdx >= 0 && (!args[binaryIdx + 1] || args[binaryIdx + 1]!.startsWith('--'))) {
    throw new Error('--surfpool-binary needs a path');
  }
  if (rpcIdx >= 0 && (!args[rpcIdx + 1] || args[rpcIdx + 1]!.startsWith('--'))) throw new Error('--rpc needs a URL');
  const sandboxIdx = args.indexOf('--sandbox');
  const backend = configuredBackend(sandboxIdx >= 0 ? (args[sandboxIdx + 1] ?? '') : undefined);
  const environment = defaultHarnessEnvironment(binaryIdx >= 0 ? args[binaryIdx + 1] : undefined, backend);
  if (args.includes('--install')) {
    const version = await installPinnedSurfpool(environment.binary);
    console.log(`Installed Surfpool ${version} at ${environment.binary} (SHA-256 verified)`);
  }
  const env = nodeEnv();
  const results = await runChecks(env, {
    ...DEFAULT_OPTIONS,
    backend,
    needsPrograms: args.includes('--programs'),
    ...(surfnetRpcUrl ? { surfnetRpcUrl } : {}),
    surfpoolBinary: environment.binary,
    sandboxImage: environment.image,
  });
  const summary = summarize(results);
  console.log(json ? JSON.stringify({ results, summary }, null, 2) : renderText(results, env.env));
  return summary.exitCode;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === '--version' || cmd === '-v') {
    // The packed archive's root package.json carries the release version.
    console.log(JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version);
  } else if (cmd === undefined || cmd === 'start' || (cmd.startsWith('--') && cmd !== '--help')) {
    await startLocal(cmd === undefined || cmd === 'start' ? rest : [cmd, ...rest]);
  } else if (cmd === 'toolchain') {
    process.exitCode = await toolchainCommand(rest);
  } else if (cmd === 'review') {
    process.exitCode = await runReviewCommand(rest);
  } else if (cmd === 'doctor') {
    process.exitCode = await doctor(rest);
  } else if (cmd === 'workspace' || cmd === 'task' || cmd === 'run') {
    process.exitCode = await runHarnessCommand(cmd, rest);
  } else if (cmd === 'help' && rest[0] === 'advanced') {
    console.log(ADVANCED_HELP);
  } else if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP);
  } else {
    console.error(`oms: unknown command "${cmd}" · see ${omsCommand()} --help`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`oms: ${error instanceof Error ? error.message : 'local command failed'}`);
  process.exitCode = 1;
}
