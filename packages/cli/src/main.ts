import { DEFAULT_OPTIONS, renderText, runChecks, summarize } from './doctor/checks.ts';
import { nodeEnv } from './doctor/node-env.ts';
import { installPinnedSurfpool } from './doctor/install.ts';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { configuredBackend, defaultHarnessEnvironment, omsCommand } from '@oms/engine';
import { runHarnessCommand } from './harness.ts';
import { toolchainCommand } from './toolchain.ts';
import { runReviewCommand } from './review.ts';
import { checkLocalPrerequisites, joinLocal, omsHome, startLocal } from '../../../scripts/start-local.ts';
import { runUpdate, updateDeps, updateNotice } from './update.ts';
import { runExec } from './exec.ts';
import { COMMANDS, commandHelp, suggestCommand, wantsHelp } from './help.ts';
import { runErrorCommand } from './error-command.ts';
import { runSessionsCommand } from './sessions.ts';
import { accountControls, runAccountCommand } from './account-command.ts';
import { completionScript, SHELLS, type Shell } from './completion.ts';
import { runConfigCommand } from './config-command.ts';
import { runUninstall } from './uninstall.ts';

const installRoot = new URL('../../../', import.meta.url);
// The packed archive's root package.json carries the release version.
const version = (): string => JSON.parse(readFileSync(new URL('package.json', installRoot), 'utf8')).version;

const HELP = `oms · Solana coding agent

  ${omsCommand()}                 Start in the current folder (any folder works)
  ${omsCommand()} exec "<prompt>"  Run one prompt and print the reply
  ${omsCommand()} doctor          Check your setup
  ${omsCommand()} review [path]   Offline security review of a Solana program
  ${omsCommand()} error <code>    Name a Solana program error
  ${omsCommand()} sessions        Folders with saved conversations
  ${omsCommand()} join <link>     Open a session a teammate shared with /share
  ${omsCommand()} login           Sign in to your Oh My Sol account
  ${omsCommand()} update          Update to the latest release (--check to only look)
  ${omsCommand()} --version       Print the version

Options
  --new               Start a new conversation in this folder
  --spend-usd <n>     Cap API spend for this session (default $5)
  --yolo              Run commands without the sandbox or approval
  --no-web            Start with web search off

Inside oms
  /setup     Set up a model and web search
  /connect   Sign in: ChatGPT, Claude, Grok or an API key
  /model     Pick a model
  /help      Commands and keys

More: ${omsCommand()} <command> --help · ${omsCommand()} help advanced
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
  exec        Run one prompt without the interface, for scripts and CI
  update      Install the latest release (--check only reports; --version <x.y.z> picks one)
  review      Run a local offline Phase A security review
  error       Name a custom program error from the built-in tables and local IDLs
  sessions    List folders with saved conversations (--prune removes state of deleted ones)
  join        Take a copy of a session a teammate shared with /share, and open it here
  config      Show where settings and state are kept
  login       Sign in to your account (also: logout, whoami)
  completion  Print a bash, zsh or fish completion script
  uninstall   Remove oms (--purge also deletes conversations, sign-ins and settings)
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
const log = (line: string): void => console.log(line);
const fail = (line: string): void => console.error(line);

/** A yes/no question, only when someone is at a terminal to answer it. Anything but yes, Ctrl+C included, is no. */
const confirm =
  process.stdin.isTTY && process.stdout.isTTY
    ? async (question: string): Promise<boolean> => {
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        terminal.once('SIGINT', () => terminal.close());
        try {
          const closed = once(terminal, 'close').then(() => '');
          const answer = await Promise.race([terminal.question(`${question} [y/N] `).catch(() => ''), closed]);
          return /^y(es)?$/i.test(answer.trim());
        } finally {
          terminal.close();
        }
      }
    : undefined;
try {
  // `review` prints its own help, with its disclaimer.
  if (cmd !== undefined && cmd !== 'review' && Object.hasOwn(COMMANDS, cmd) && wantsHelp(rest)) {
    console.log(commandHelp(cmd));
  } else if (cmd?.startsWith('--') && wantsHelp([cmd, ...rest])) {
    console.log(HELP);
  } else if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(version());
  } else if (cmd === 'update') {
    process.exitCode = await runUpdate(rest, updateDeps(fileURLToPath(installRoot), version()));
  } else if (cmd === undefined || cmd === 'start' || (cmd.startsWith('--') && cmd !== '--help')) {
    const notice = updateNotice(version());
    await startLocal(cmd === undefined || cmd === 'start' ? rest : [cmd, ...rest]);
    const newer = notice();
    if (newer) console.log(newer);
  } else if (cmd === 'exec') {
    const stop = new AbortController();
    process.once('SIGINT', () => stop.abort());
    process.exitCode = await runExec(rest, {
      folder: process.cwd(),
      stateRoot: omsHome(),
      prepare: (environment) => checkLocalPrerequisites(environment, (text) => void process.stderr.write(text)),
      readStdin: () => text(process.stdin),
      out: log,
      note: fail,
      signal: stop.signal,
    });
  } else if (cmd === 'join') {
    process.exitCode = await joinLocal(rest);
  } else if (cmd === 'toolchain') {
    process.exitCode = await toolchainCommand(rest);
  } else if (cmd === 'review') {
    process.exitCode = await runReviewCommand(rest);
  } else if (cmd === 'error') {
    process.exitCode = runErrorCommand(rest, process.cwd(), log, fail);
  } else if (cmd === 'sessions') {
    process.exitCode = await runSessionsCommand(rest, omsHome(), { log, error: fail, confirm });
  } else if (cmd === 'config') {
    const { install } = updateDeps(fileURLToPath(installRoot), version());
    const context = { version: version(), install, installFolder: fileURLToPath(installRoot), stateRoot: omsHome() };
    process.exitCode = runConfigCommand(rest, context, log, fail);
  } else if (cmd === 'login' || cmd === 'logout' || cmd === 'whoami') {
    const stop = new AbortController();
    process.once('SIGINT', () => stop.abort());
    const controls = accountControls(omsHome(), stop.signal);
    process.exitCode = await runAccountCommand(cmd, rest, { controls, signal: stop.signal, log, error: fail });
  } else if (cmd === 'completion') {
    if (rest.length === 1 && (SHELLS as readonly string[]).includes(rest[0]!)) {
      console.log(completionScript(rest[0] as Shell));
    } else {
      fail(`Usage: ${omsCommand()} completion ${SHELLS.join('|')}`);
      process.exitCode = 2;
    }
  } else if (cmd === 'uninstall') {
    const { install, npm, exec } = updateDeps(fileURLToPath(installRoot), version());
    const deps = { install, npm, exec, home: homedir(), stateRoot: omsHome(), log, error: fail, confirm };
    process.exitCode = await runUninstall(rest, deps);
  } else if (cmd === 'doctor') {
    process.exitCode = await doctor(rest);
  } else if (cmd === 'workspace' || cmd === 'task' || cmd === 'run') {
    process.exitCode = await runHarnessCommand(cmd, rest);
  } else if (cmd === 'help' && rest[0] === 'advanced') {
    console.log(ADVANCED_HELP);
  } else if (cmd === 'help' && rest[0] && Object.hasOwn(COMMANDS, rest[0])) {
    console.log(commandHelp(rest[0]));
  } else if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP);
  } else {
    const guess = suggestCommand(cmd);
    const hint = guess ? ` · did you mean "${omsCommand()} ${guess}"?` : '';
    console.error(`oms: unknown command "${cmd}"${hint} · see ${omsCommand()} --help`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`oms: ${error instanceof Error ? error.message : 'local command failed'}`);
  process.exitCode = 1;
}
