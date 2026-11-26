/**
 * solbench-harness: our harness-level Solana Bench environment (not the Foundation's published benchmark).
 * usage: node bench/src/run.ts --cell <id>... --variant basic|swap --runs <n> --out-root <dir> [--prefix main|dev]
 *          [--max-submissions 50] [--start <run index>]
 * Cells run interleaved, run by run (cell A run 0, cell B run 0, ..., cell A run 1, ...). A run dir with result.json is skipped.
 * Dev runs (--prefix dev) must use a short budget (--max-submissions 10) and never write into main-* dirs.
 *        node bench/src/run.ts report --out-root <dir> [--prefix main|dev]   (markdown section on stdout)
 *        node bench/src/run.ts egress [--log <file>]   (the open-HTTPS tunnel the online cells need; keep it running)
 * Environment: SOLBENCH_HARNESS_SURFPOOL (Surfpool 0.10.4 binary), SOLBENCH_HARNESS_DEPS (workspace SDK dependencies),
 *   OMS_SEARCH_URL / OMS_SEARCH_TOKEN (hosted search for the OMS cell), OMS_KNOWLEDGE_TOKEN (optional; OMS_KNOWLEDGE_URL defaults to
 *   https://barestate.xyz/oms/api/knowledge/mcp), SOLBENCH_HARNESS_EGRESS_LOG (optional egress log to slice per run). See docs/solana-bench.md.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createTask,
  defaultHarnessEnvironment,
  openWorkspace,
  parseHarnessTaskDefinition,
  prepareHarnessTask,
} from '@oms/engine';
import { ONLINE_NETWORK } from './contenders.ts';
import { infraReason } from './infra.ts';
import {
  AGENT_HOME,
  benchInputTokens,
  benchOutputTokens,
  buildSubscriptionLaunch,
  parseCliUsage,
} from './harnesses.ts';
import { SUBSCRIPTION_MODELS } from './matrix.ts';
import { startEgressProxy } from './egress.ts';
import { codexCredential } from './subscription.ts';
import { createEnv, freshWallet, listenEnv, MAX_SUBMISSIONS, RUN_WALL_MS } from './solbench-harness/service.ts';
import { renderSection, type RunResult } from './solbench-harness/report.ts';
import { sliceEgressLog, startWorkspaceTrace } from './solbench-harness/trace.ts';
import {
  prepareWorkspace,
  SOL_LAMPORTS,
  SWAP_TOKENS,
  WORKSPACE_SOURCE,
  type Variant,
} from './solbench-harness/workspace.ts';
import { lostSubscriptionAuth, scrubCredentials, stageSubscriptionLogin } from './external.ts';
import { isClaudeCodeCell, omsCellArgs, runOmsContender } from './oms-run.ts';
import { BLEND_MODELS, BlendBudget, startBlendRouter, apiSandboxProbe } from './blend-router.ts';
import { retryFork } from './solbench-harness/attempts.ts';
import type { ContenderModel } from './contenders.ts';

const IMAGE = 'oms-solbench-harness:1';
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SHIM = join(REPO, 'bench/solbench-harness/surfpool-shim.mjs');
const DEPS = process.env.SOLBENCH_HARNESS_DEPS ?? join(REPO, '.tmp/solbench-harness/deps');
/** The fork's Surfpool: 0.10.4, the version the gym run uses (the release current at the gym's pinned commit), pinned by digest. */
const SURFPOOL = process.env.SOLBENCH_HARNESS_SURFPOOL ?? join(REPO, '.tmp/solbench-harness/surfpool-0.10.4');
const SURFPOOL_SHA256 = '3c4a22f4376d007141cc6ac709f60c766a678af24c5224c26ddb78df3566ffd9';
const MAINNET = 'https://api.mainnet-beta.solana.com';
/** The online tunnel (`solbench-harness.ts egress`) that admits public HTTPS for the vendor CLIs. */
const EGRESS_PORT = 3171;
const EGRESS = `http://${ONLINE_NETWORK.gateway}:${EGRESS_PORT}`;

/** The internal Docker network the online cells share with the tunnel; created once. */
function ensureOnlineNetwork(): void {
  try {
    execFileSync('docker', ['network', 'inspect', ONLINE_NETWORK.name], { stdio: 'ignore' });
    return;
  } catch {
    /* create below */
  }
  execFileSync('docker', [
    'network',
    'create',
    '--internal',
    '--subnet',
    ONLINE_NETWORK.subnet,
    '--gateway',
    ONLINE_NETWORK.gateway,
    ONLINE_NETWORK.name,
  ]);
}
/** The words every harness gets; the rules are all in GOAL.md. */
const PROMPT =
  'Your working directory contains GOAL.md. Read it and pursue that goal until you are done or the budget is spent.';

/** The three cells of the brief; each runs as shipped and online. */
const CELLS: Record<string, { harness: 'oms3' | 'codex' | 'claude-code'; model: ContenderModel }> = {
  'oms3-web:gpt-sol': { harness: 'oms3', model: SUBSCRIPTION_MODELS.oms3!['gpt-sol']! },
  'codex-web:gpt-sol': { harness: 'codex', model: SUBSCRIPTION_MODELS.codex!['gpt-sol']! },
  'claude-code-web:opus-sub': { harness: 'claude-code', model: SUBSCRIPTION_MODELS['claude-code']!['opus-sub']! },
  'claude-code-web:fable-sub': { harness: 'claude-code', model: SUBSCRIPTION_MODELS['claude-code']!['fable-sub']! },
  'oms3-web:opus-sub': { harness: 'oms3', model: SUBSCRIPTION_MODELS.oms3!['opus-sub']! },
  'oms3:fable-sub': { harness: 'oms3', model: SUBSCRIPTION_MODELS.oms3!['fable-sub']! },
  ...Object.fromEntries(
    Object.entries(BLEND_MODELS).flatMap(([id, model]) =>
      ['oms3', 'oms3-web'].map((harness) => [`${harness}:blend/${id}`, { harness: 'oms3' as const, model }]),
    ),
  ),
};
type Cell = keyof typeof CELLS;

/** Run directories are named by cell; the two OMS cells share a harness prefix, so only their model tells them apart. */
const cellDir = (cell: string) =>
  cell.startsWith('oms3-web:blend/')
    ? 'oms3-web-blend-' + cell.slice('oms3-web:blend/'.length)
    : cell.startsWith('oms3:blend/')
      ? 'oms3-blend-' + cell.slice('oms3:blend/'.length)
      : cell === 'oms3-web:opus-sub'
        ? 'oms3-web-opus-sub'
        : cell.split(':')[0]!;

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** A fresh mainnet fork per run, bound to host loopback (no container can reach its cheatcodes). */
async function startFork(dir: string): Promise<{ url: string; child: ChildProcess }> {
  const [port, ws] = [await freePort(), await freePort()];
  mkdirSync(dir, { recursive: true });
  const log = createWriteStream(join(dir, 'surfpool.log'));
  if (sha256(readFileSync(SURFPOOL)) !== SURFPOOL_SHA256)
    throw new Error(`${SURFPOOL} is not the pinned Surfpool 0.10.4`);
  const child = spawn(
    SURFPOOL,
    [
      'start',
      '--no-tui',
      '--no-studio',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--ws-port',
      String(ws),
      '-u',
      MAINNET,
      '--airdrop-amount',
      '0',
    ],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`surfpool exited (${child.exitCode}); see ${dir}/surfpool.log`);
    try {
      if ((await rpc(url, 'getHealth')) === 'ok') return { url, child };
    } catch {
      /* starting */
    }
    await sleep(500);
  }
  child.kill('SIGKILL');
  throw new Error('surfpool did not become healthy in 60 s');
}

interface Tokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Codex or Claude Code in the shared image, on the online network; the env is its only Solana endpoint. */
async function runVendor(
  cell: Cell,
  runDir: string,
  repo: string,
  envUrl: string,
): Promise<{
  exit: number;
  reason: string | null;
  tokensComplete: boolean;
  tokens: Tokens | null;
  turns: number | null;
}> {
  const { harness, model } = CELLS[cell] as { harness: 'codex' | 'claude-code'; model: { id: string } };
  const home = join(runDir, 'home');
  const logs = join(runDir, 'logs');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(logs, { recursive: true });
  const launch = buildSubscriptionLaunch({ harness, modelId: model.id, prompt: PROMPT, egress: EGRESS, online: true });
  stageSubscriptionLogin(harness, home);
  for (const [path, content] of Object.entries(launch.files)) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), content, { mode: 0o600 });
  }
  const name = `oms-solbh-${sha256(runDir).slice(0, 12)}`;
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '--label',
    'oms.component=bench-agent',
    '--pull=never',
    '--network',
    ONLINE_NETWORK.name,
    '--read-only',
    '--tmpfs',
    '/tmp:exec,size=1g',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    `${process.getuid!()}:${process.getgid!()}`,
    '--pids-limit',
    '1024',
    '--memory',
    '6g',
    '--cpus',
    '3',
    '-w',
    '/work',
    '-v',
    `${repo}:/work:rw`,
    '-v',
    `${home}:${AGENT_HOME}:rw`,
    '-v',
    `${join(DEPS, 'node_modules')}:/work/node_modules:ro`,
    ...Object.entries({ ...launch.env, SOLANA_RPC_URL: envUrl }).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    IMAGE,
    ...launch.argv,
  ];
  // What exactly ran: the CLI argv (prompt by hash), env names only (values may be credentials), image and limits.
  writeFileSync(
    join(logs, 'invocation.json'),
    JSON.stringify(
      {
        harness,
        model: model.id,
        image: IMAGE,
        cpus: 3,
        memory: '6g',
        argv: launch.argv.map((arg) => (arg === PROMPT ? `<prompt sha256 ${sha256(PROMPT)}>` : arg)),
        envNames: Object.keys(launch.env).sort(),
      },
      null,
      2,
    ) + '\n',
  );
  const out = createWriteStream(join(logs, 'stdout.txt'), { mode: 0o600 });
  const err = createWriteStream(join(logs, 'stderr.txt'), { mode: 0o600 });
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(err);
  // The env refuses submissions at 30 minutes; the agent gets a short grace to print its last words.
  const timer = setTimeout(() => execFile('docker', ['rm', '-f', name], () => {}), RUN_WALL_MS + 60_000);
  const exit = await new Promise<number>((done) => {
    child.once('error', () => done(127));
    child.once('close', (code) => done(code ?? 137));
  });
  clearTimeout(timer);
  await Promise.all([new Promise((done) => out.end(done)), new Promise((done) => err.end(done))]);
  execFile('docker', ['rm', '-f', name], () => {});
  scrubCredentials(home);
  const stdout = readFileSync(join(logs, 'stdout.txt'), 'utf8');
  const text = stdout + readFileSync(join(logs, 'stderr.txt'), 'utf8');
  const usage = parseCliUsage(harness, stdout);
  // Only the CLI's closing words count: an online agent can print an RPC 429 from its own web calls long before it stops.
  const reason =
    exit !== 0 && /usage limit|limit reached|quota|too many requests|\b429\b/i.test(text.slice(-2000))
      ? 'usage-limit'
      : lostSubscriptionAuth(stdout) || (exit !== 0 && /not signed in|login required|please log ?in/i.test(text))
        ? 'auth-missing'
        : !usage
          ? `no-usage:exit-${exit}`
          : null;
  return {
    exit,
    reason,
    tokensComplete: Boolean(usage),
    tokens: usage && {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    },
    turns: usage?.turns ?? null,
  };
}

/** OMS through its production headless path; its sandbox's one Surfpool port is the env (through the shim). */
async function runOms(
  cell: Cell,
  runIndex: number,
  runDir: string,
  repo: string,
  envUrl: string,
  imageId: string,
  budget: BlendBudget,
) {
  const { model } = CELLS[cell]!;
  const api = model.provider === 'blend';
  const wrapper = join(runDir, 'surfpool');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${SHIM} ${envUrl} "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.OMS_BENCH_AGENT_IMAGE = imageId;
  process.env.OMS_BENCH_DEPENDENCIES = DEPS;
  const stateRoot = join(runDir, 'state');
  const workspace = openWorkspace(repo, { stateRoot, initialize: { ignore: 'exclude' } });
  const task = createTask(workspace, {
    id: 'solbench-harness',
    baseOid: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  });
  const environment = defaultHarnessEnvironment(wrapper, 'docker');
  const definition = parseHarnessTaskDefinition({
    verifierPaths: ['visible.test.ts'],
    codePaths: ['GOAL.md'],
    testTimeoutMs: 120_000,
    contract: {
      version: 0,
      items: [
        {
          id: 'goal',
          title: PROMPT,
          done: [{ kind: 'tests', command: ['node', '--test', 'visible.test.ts'], expect: 'pass' }],
          status: 'active',
          reopenCount: 0,
        },
      ],
    },
  });
  await prepareHarnessTask(workspace, task, environment, definition);
  const jsonOut = join(runDir, 'oms-record.json');
  const claude = isClaudeCodeCell(model);
  const home = join(runDir, 'home');
  if (claude) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    stageSubscriptionLogin('claude-code', home);
  }
  const previousUrl = process.env.OMS_BLEND_URL,
    previousToken = process.env.OMS_BLEND_TOKEN;
  const router = api ? await startBlendRouter(join(runDir, 'router.jsonl'), budget) : undefined;
  const before = budget.used;
  if (router) {
    process.env.OMS_BLEND_URL = router.url;
    process.env.OMS_BLEND_TOKEN = 'local-solbench';
  }
  try {
    const exit = await runOmsContender({
      contender: cell,
      runIndex,
      selection: { provider: model.provider, id: model.id },
      modelDefinition: model,
      jsonOut,
      ...(api
        ? {
            apiOptions: {
              workspace,
              task,
              environment,
              hostApprovalPolicy: 'deny' as const,
              executionMode: 'bounded' as const,
              caps: {
                tokens: 20000000,
                spendMicroUsd: budget.scope === 'all' ? Math.floor(budget.remainingUsd * 1e6) : Number.MAX_SAFE_INTEGER,
                wallClockMs: RUN_WALL_MS,
              },
              maxInputTokens: 131072,
              maxOutputTokens: 32000,
              requestCost: router!.requestCost,
              knowledgeHint: false,
              knowledgeInject: false,
              ...(cell.startsWith('oms3-web:blend/') ? { web: { enabled: true } } : {}),
            },
          }
        : claude
          ? { claudeHome: home }
          : { subscriptionCredential: codexCredential(join(homedir(), '.codex/auth.json')) }),
      args: omsCellArgs({
        cell,
        model,
        repo,
        stateRoot,
        taskId: task.id,
        surfpoolWrapper: wrapper,
        wallMinutes: RUN_WALL_MS / 60_000,
        outputTokens: benchOutputTokens(model),
        inputTokens: benchInputTokens({ modelDefinition: model, funding: 'subscription' }),
      }),
    }).finally(() => scrubCredentials(home));
    const record = JSON.parse(readFileSync(jsonOut, 'utf8')) as {
      status: string;
      reason: string | null;
      accounting: 'known' | 'unknown';
      dispatches: Array<{ usage: Tokens | null }>;
    };
    const sum = (key: keyof Tokens) => record.dispatches.reduce((total, d) => total + (d.usage?.[key] ?? 0), 0);
    // A request the local input cap refused was never sent (not_dispatched); only an uncertain dispatch leaves usage unknown.
    const unknown = record.accounting === 'unknown';
    const usageLimited = /usage.?limit|429/i.test(record.reason ?? '');
    const infra = infraReason(record, router?.logs.flatMap((line) => line.calls) ?? []);
    // A provider stream cut ends the OMS run as infra/usage-unknown; like the other bench tiers it is scored by its final state, and named.
    return {
      exit,
      reason:
        api && (budget.blocked || (record.status === 'capped' && record.reason === 'capped:usd'))
          ? 'api-budget'
          : infra
            ? infra
            : usageLimited
              ? 'usage-limit'
              : record.status === 'infra'
                ? `oms-${record.reason}`
                : null,
      ...(router
        ? {
            usd: router.logs.reduce((sum, line) => sum + line.total_usd, 0),
            billingUpperUsd: (budget.used - before) / 1e6,
            routerLog: join(runDir, 'router.jsonl'),
          }
        : {}),
      tokensComplete: !unknown,
      omsStatus: record.status,
      omsReason: record.reason,
      knowledge: Boolean(process.env.OMS_KNOWLEDGE_TOKEN),
      tokens: router
        ? {
            inputTokens: router.logs.flatMap((l) => l.calls).reduce((s, c) => s + c.in - c.cached, 0),
            cacheReadTokens: router.logs.flatMap((l) => l.calls).reduce((s, c) => s + c.cached, 0),
            cacheWriteTokens: 0,
            outputTokens: router.logs.flatMap((l) => l.calls).reduce((s, c) => s + c.out, 0),
          }
        : {
            inputTokens: sum('inputTokens'),
            outputTokens: sum('outputTokens'),
            cacheReadTokens: sum('cacheReadTokens'),
            cacheWriteTokens: sum('cacheWriteTokens'),
          },
      turns: record.dispatches.length,
    };
  } finally {
    await router?.close();
    if (previousUrl === undefined) delete process.env.OMS_BLEND_URL;
    else process.env.OMS_BLEND_URL = previousUrl;
    if (previousToken === undefined) delete process.env.OMS_BLEND_TOKEN;
    else process.env.OMS_BLEND_TOKEN = previousToken;
  }
}

async function runOne(
  cell: Cell,
  variant: Variant,
  runIndex: number,
  runDir: string,
  o: { maxSubmissions: number; imageId: string; budget: BlendBudget },
) {
  if (existsSync(runDir)) renameSync(runDir, `${runDir}.paused-${Date.now()}`);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const fork = await startFork(join(runDir, 'fork'));
  const servers: Awaited<ReturnType<typeof listenEnv>> = [];
  try {
    const wallet = freshWallet();
    await rpc(fork.url, 'surfnet_setAccount', [wallet.publicKey, { lamports: SOL_LAMPORTS }]);
    if (variant === 'swap')
      for (const t of SWAP_TOKENS)
        await rpc(fork.url, 'surfnet_setTokenAccount', [wallet.publicKey, t.mint, { amount: t.amount }]);
    const forkSlot = (await rpc(fork.url, 'getSlot')) as number;
    const repo = join(runDir, 'repo');
    prepareWorkspace(repo, { publicKey: wallet.publicKey, variant });
    const port = await freePort();
    const startedAt = Date.now();
    const log = join(runDir, 'submissions.jsonl');
    const env = createEnv({
      upstream: fork.url,
      wallet,
      maxSubmissions: o.maxSubmissions,
      deadlineMs: startedAt + RUN_WALL_MS,
      record: (entry) => appendFileSync(log, JSON.stringify(entry) + '\n', { mode: 0o600 }),
    });
    servers.push(...(await listenEnv(env, ['127.0.0.1', ONLINE_NETWORK.gateway], port)));
    const stopTrace = startWorkspaceTrace(repo, join(runDir, 'trace'));
    const ran = await (
      CELLS[cell]!.harness === 'oms3'
        ? runOms(cell, runIndex, runDir, repo, `http://127.0.0.1:${port}`, o.imageId, o.budget)
        : runVendor(cell, runDir, repo, `http://${ONLINE_NETWORK.gateway}:${port}`)
    ).finally(stopTrace);
    if (process.env.SOLBENCH_HARNESS_EGRESS_LOG) {
      mkdirSync(join(runDir, 'logs'), { recursive: true });
      sliceEgressLog(
        process.env.SOLBENCH_HARNESS_EGRESS_LOG,
        startedAt,
        Date.now(),
        join(runDir, 'logs', 'egress-window.jsonl'),
      );
    }
    const result = {
      schema: 'oms.solbench-harness/1',
      cell,
      variant,
      runIndex,
      startedAt: new Date(startedAt).toISOString(),
      wallMs: Date.now() - startedAt,
      forkSlot,
      surfpool: '0.10.4',
      wallet: wallet.publicKey,
      budget: { maxSubmissions: o.maxSubmissions, wallMs: RUN_WALL_MS },
      ...ran,
      score: env.score(),
      forkFailures: env.forkFailures(),
      identities: {
        goal: sha256(readFileSync(join(WORKSPACE_SOURCE, 'GOAL.md'))),
        prompt: sha256(PROMPT),
        image: o.imageId,
        commit: execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      },
    };
    // A usage limit, or an OMS infra ending before any submission, is not a score of 0: set aside as paused.json and rerun the slot.
    const unhealthy = env.forkFailures() >= 3 || fork.child.exitCode !== null;
    const paused =
      unhealthy ||
      ran.reason === 'usage-limit' ||
      ran.reason === 'api-budget' ||
      (ran.reason?.startsWith('oms-') && result.score.submissions === 0);
    if (paused)
      result.reason = ['usage-limit', 'api-budget'].includes(ran.reason ?? '') ? ran.reason : 'infra-no-start';
    if (unhealthy) result.reason = 'fork-failure';
    writeFileSync(join(runDir, paused ? 'paused.json' : 'result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    for (const server of servers) server.close();
    fork.child.kill('SIGTERM');
    await sleep(1000);
    if (fork.child.exitCode === null) fork.child.kill('SIGKILL');
  }
}

function report(outRoot: string, prefix: string): string {
  const results: RunResult[] = [];
  for (const variant of ['basic', 'swap'])
    for (const cell of Object.keys(CELLS)) {
      const dir = join(outRoot, `${prefix}-solbh-${cellDir(cell)}-${variant}`);
      if (!existsSync(dir)) continue;
      for (const run of readdirSync(dir))
        for (const file of ['result.json', 'paused.json']) {
          if (existsSync(join(dir, run, file))) results.push(JSON.parse(readFileSync(join(dir, run, file), 'utf8')));
        }
    }
  return renderSection(results, Object.keys(CELLS));
}

const USAGE = `solbench-harness: the Solana Bench harness environment (docs/solana-bench.md)
usage: node bench/src/run.ts --cell <id>... --variant basic|swap --runs <n> --out-root <dir> [--prefix main|dev] [--max-submissions 50] [--start <run index>] [--max-usd <n>] [--usd-scope all|anthropic-muse]
       node bench/src/run.ts report --out-root <dir> [--prefix main|dev]
       node bench/src/run.ts egress [--log <file>]
cells: ${Object.keys(CELLS).join(', ')}
`;

async function main(argv: string[]): Promise<number> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] === 'egress') {
    const { values } = parseArgs({ args: argv.slice(1), strict: true, options: { log: { type: 'string' } } });
    const logFile = values.log ?? join(REPO, '.tmp/solbench-harness/egress.log');
    mkdirSync(dirname(logFile), { recursive: true });
    ensureOnlineNetwork();
    const tunnel = await startEgressProxy({
      host: ONLINE_NETWORK.gateway,
      port: EGRESS_PORT,
      allow: 'public-https',
      logFile,
    });
    console.log(`egress tunnel on ${ONLINE_NETWORK.gateway}:${tunnel.port} (public HTTPS only); Ctrl+C to stop`);
    await new Promise<void>((done) => {
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
    await tunnel.close();
    return 0;
  }
  if (argv[0] === 'report') {
    const { values } = parseArgs({
      args: argv.slice(1),
      strict: true,
      options: { 'out-root': { type: 'string' }, prefix: { type: 'string' } },
    });
    if (!values['out-root']) throw new Error('report needs --out-root');
    console.log(report(values['out-root'], values.prefix ?? 'main'));
    return 0;
  }
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      cell: { type: 'string', multiple: true },
      variant: { type: 'string' },
      runs: { type: 'string' },
      start: { type: 'string' },
      'out-root': { type: 'string' },
      prefix: { type: 'string' },
      'max-submissions': { type: 'string' },
      'max-usd': { type: 'string' },
      'usd-scope': { type: 'string' },
    },
  });
  const cells = (values.cell ?? []) as Cell[];
  const variant = values.variant as Variant;
  const prefix = values.prefix ?? 'main';
  const maxSubmissions = Number(values['max-submissions'] ?? MAX_SUBMISSIONS);
  if (!cells.length || cells.some((cell) => !(cell in CELLS)))
    throw new Error(`--cell must be one of ${Object.keys(CELLS).join(', ')}`);
  if (variant !== 'basic' && variant !== 'swap') throw new Error('--variant basic|swap');
  if (!values['out-root'] || !values.runs) throw new Error('--out-root and --runs are required');
  mkdirSync(resolve(values['out-root']), { recursive: true });
  const scope = values['usd-scope'] ?? 'all';
  if (scope !== 'all' && scope !== 'anthropic-muse') throw new Error('--usd-scope all|anthropic-muse');
  const budget = new BlendBudget(
    join(resolve(values['out-root']), `${prefix}-blend-budget${scope === 'all' ? '' : '-anthropic-muse'}.jsonl`),
    Number(values['max-usd'] ?? 4),
    scope,
  );
  // A series name keeps each build's runs in their own directories (main, dev, ...).
  if (!/^[a-z][a-z0-9]{0,11}$/.test(prefix)) throw new Error('--prefix must be a short lowercase series name');
  // Development series (names starting with dev) tune on a short budget; every other series is scored on the full one.
  if (!prefix.startsWith('dev') ? maxSubmissions !== MAX_SUBMISSIONS : maxSubmissions > 10)
    throw new Error('scored runs use 50 submissions; dev* runs at most 10');
  if (cells.some((cell) => CELLS[cell]!.model.provider === 'blend')) ensureOnlineNetwork();
  const imageId = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', IMAGE], {
    encoding: 'utf8',
  }).trim();
  if (cells.some((cell) => CELLS[cell]!.model.provider === 'blend'))
    execFileSync('docker', apiSandboxProbe(imageId), { stdio: 'pipe', timeout: 60000 });
  for (let runIndex = Number(values.start ?? 0); runIndex < Number(values.runs); runIndex++) {
    for (const cell of cells) {
      if (existsSync(join(values['out-root']!, 'STOP'))) {
        console.log('STOP file present in --out-root: stopping');
        return 0;
      }
      const runDir = resolve(values['out-root'], `${prefix}-solbh-${cellDir(cell)}-${variant}`, `run-${runIndex}`);
      if (existsSync(join(runDir, 'result.json'))) continue;
      let attempt = 0;
      const result = await retryFork(
        async () => {
          const result = await runOne(cell, variant, runIndex, runDir, { maxSubmissions, imageId, budget });
          appendFileSync(
            join(values['out-root']!, `${prefix}-attempts.jsonl`),
            JSON.stringify({
              cell,
              variant,
              runIndex,
              attempt: attempt++,
              reason: result.reason,
              usd: (result as RunResult).usd ?? null,
              at: new Date().toISOString(),
            }) + '\n',
            { mode: 0o600 },
          );
          return result;
        },
        {
          canRetry: () => !budget.blocked && budget.remainingUsd > 0,
          onRetry: (r) => console.log(`${cell} run ${runIndex}: set aside (${r.reason}); retrying same slot`),
        },
      );
      if (result.reason === 'fork-failure') return 4;
      console.log(
        `${new Date().toISOString()} ${cell} ${variant} run ${runIndex}: headline ${result.score.headline} raw ${result.score.raw} ` +
          `submissions ${result.score.submissions} failed ${result.score.failed} wall ${Math.round(result.wallMs / 1000)}s reason ${result.reason}`,
      );
      if (result.reason === 'usage-limit') {
        console.log('usage limit: paused (the owner reset is never used)');
        return 3;
      }
      if (result.reason === 'api-budget') {
        console.log('API dollar cap: stopping without launching another slot');
        return 4;
      }
      if (result.reason === 'infra-no-start')
        console.log('infra ending before any submission: set aside, rerun this slot');
    }
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));
