#!/usr/bin/env node
import { DEFAULT_OPTIONS, renderText, runChecks, summarize } from './doctor/checks.ts';
import { nodeEnv } from './doctor/node-env.ts';
import { installPinnedSurfpool } from './doctor/install.ts';
import { readFileSync } from 'node:fs';
import { configuredBackend, defaultHarnessEnvironment } from '@oms/engine';
import { runHarnessCommand } from './harness.ts';
import { toolchainCommand } from './toolchain.ts';
import { runReviewCommand } from './review.ts';
import { startLocal } from '../../../scripts/start-local.ts';

const HELP = `oms: the Solana coding agent

  oms                 Start in the current folder (any folder works)
  oms doctor          Check your setup
  oms review [path]   Offline security review of a Solana program
  oms --version       Show the version

Inside OMS:
  /connect   Sign in (ChatGPT, Claude Code, or an API key)
  /model     Pick a model
  /blend     Use Blend (auto|pro|flash|off; invited OMS account, /login)
  /help      Every command and key

Options:
  --spend-usd <n>     Cap API spend for the session (default $5)
  --sandbox docker    Run commands in Docker instead of on this machine

More: oms help advanced
`;

const ADVANCED_HELP = `oms advanced commands

Usage:
  oms [--bounded] [--tokens <cap>] [--spend-usd <cap>] [--minutes <cap>] [--output-tokens <cap>]
              Start OMS in the current folder
  oms toolchain check|fix [--project <path>] [--apply] [--verify]
  oms review [path] --phase A [--program <name>] [--json] [--out <new-directory>] [--state-root <directory>]
  oms review [path] --purge <reviewId|all> [--state-root <directory>]
  oms doctor [--json] [--programs] [--rpc <url>] [--surfpool-binary <path>] [--install]
  oms workspace init <repository> --ignore gitignore|exclude|require-existing
  oms task create --workspace <repository> [--base <revision>] --requirements <file> [--id <task-id>]
  oms run [--workspace <repository>] [--task <task-id>] [--session <session-id>]
          [--provider <provider> --model <model>] [--bounded] [--tokens <cap>] [--spend-usd <cap>]
          [--minutes <cap>] [--output-tokens <cap>] [--surfpool-binary <path>]
          [--sandbox host|docker] [--host-approval deny|allow]

Commands:
  review      Run a local offline Phase A security review
  doctor      Check local prerequisites; does not launch an agent
  workspace   Initialize local repository identity and ignored OMS storage
  task        Create a managed worktree and pin explicit requirements
  run         Open the OMS task interface over its persistent session

Use --state-root <directory> with workspace/task/run to choose trusted external user state.
Harness is the default. /workbench or F3 switches views over the same session. Type / for commands.
Provider setup is in /connect; model selection is in /model. Signing and workspace-secret access are unavailable.
Native Claude chat: run --provider claude-code --model sonnet; Claude Code owns its login and chat history.
--session resumes the OMS conversation and its bound native Claude chat, when selected.
Normal launch uses interactive chat: idle time does not expire the conversation.
--tokens and --minutes bound each active turn/tool operation; --spend-usd caps cumulative API spend.
--bounded is advanced mode: token, spend and time caps apply to the whole session, including idle time.
Defaults: 2,000,000 tokens, $5 API spend, 30 minutes, 32,768 output tokens (lowered to a smaller model's own maximum).
Explicit limits are never raised automatically. Saved accounting and unknown usage are retained.
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
  const results = await runChecks(nodeEnv(), {
    ...DEFAULT_OPTIONS,
    backend,
    needsPrograms: args.includes('--programs'),
    ...(surfnetRpcUrl ? { surfnetRpcUrl } : {}),
    surfpoolBinary: environment.binary,
    sandboxImage: environment.image,
  });
  const summary = summarize(results);
  console.log(json ? JSON.stringify({ results, summary }, null, 2) : renderText(results));
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
    console.error(`oms: unknown command "${cmd}". Run oms to start, or oms --help.`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`oms: ${error instanceof Error ? error.message : 'local command failed'}`);
  process.exitCode = 1;
}
