import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultHarnessEnvironment } from '@oms/engine';
import { createNodeServer } from '../../deploy/blend-worker/src/node-server.ts';
import { validateProfiles } from '../../deploy/blend-worker/src/core/policies.ts';
import { MemorySessions } from '../../deploy/blend-worker/src/core/sessions.ts';
import { MODELS } from '../../deploy/blend-worker/src/core/pricing.ts';
import type { RequestLog, Target } from '../../deploy/blend-worker/src/core/types.ts';
import { UpstreamError } from '../../deploy/blend-worker/src/core/types.ts';
import { providerGate, roundRobin, schedule, settleCalls, type Cell } from './schedule.ts';
import { hashTaskDirectory } from './tree.ts';
import { infraReason, RETRY_BACKOFF_MS } from '../src/infra.ts';

const here = dirname(fileURLToPath(import.meta.url)),
  repo = resolve(here, '../..');
export const IMAGE = defaultHarnessEnvironment(undefined, 'docker').image;
export interface Options {
  tasks: string;
  profiles?: string;
  configs: string[];
  reps: number;
  concurrency: number;
  batch: string;
  maxUsd: number;
  runUsd: number;
  minutes: number;
  tokens: number;
  out: string;
  taskIds?: string[];
  backend: 'auto' | 'host' | 'docker';
  providerConcurrency: Record<string, number>;
  infraRetries: number;
}
export function parseArgs(args: string[]): Options {
  const flags = new Map<string, string>();
  const allowed = [
    'tasks',
    'profiles',
    'configs',
    'reps',
    'concurrency',
    'batch',
    'max-usd',
    'run-usd',
    'minutes',
    'tokens',
    'out',
    'task-ids',
    'backend',
    'provider-concurrency',
    'infra-retries',
  ];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const value = args[i + 1];
    if (
      !args[i]?.startsWith('--') ||
      !key ||
      !allowed.includes(key) ||
      !value ||
      value.startsWith('--') ||
      flags.has(key)
    )
      throw Error('Invalid arguments');
    flags.set(key, value);
  }
  const batch = flags.get('batch'),
    configs = flags.get('configs')?.split(','),
    maxUsd = Number(flags.get('max-usd'));
  if (
    !batch ||
    !/^[\w.-]{1,100}$/.test(batch) ||
    !configs?.length ||
    configs.some((c) => !/^[-\w.]{1,128}$/.test(c)) ||
    new Set(configs).size !== configs.length ||
    !Number.isFinite(maxUsd) ||
    maxUsd <= 0
  )
    throw Error('Require --batch, --configs and --max-usd');
  const options: Options = {
    tasks: resolve(flags.get('tasks') ?? join(here, 'tasks')),
    ...(flags.has('profiles') ? { profiles: resolve(flags.get('profiles')!) } : {}),
    configs,
    batch,
    maxUsd,
    reps: Number(flags.get('reps') ?? 1),
    concurrency: Number(flags.get('concurrency') ?? 4),
    runUsd: Number(flags.get('run-usd') ?? 0.6),
    minutes: Number(flags.get('minutes') ?? 12),
    tokens: Number(flags.get('tokens') ?? 250000),
    out: resolve(flags.get('out') ?? join(homedir(), 'blend-batches', batch)),
    backend: (flags.get('backend') ?? 'auto') as Options['backend'],
    providerConcurrency: { anthropic: 3, xai: 2, 'opencode-go': 1, muse: 2 },
    infraRetries: Number(flags.get('infra-retries') ?? 2),
    ...(flags.has('task-ids') ? { taskIds: flags.get('task-ids')!.split(',') } : {}),
  };
  if (flags.has('provider-concurrency'))
    for (const entry of flags.get('provider-concurrency')!.split(',')) {
      const [provider, value, extra] = entry.split('=');
      if (
        !provider ||
        !Object.hasOwn(options.providerConcurrency, provider) ||
        extra ||
        !/^\d+$/.test(value ?? '') ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < 1
      )
        throw Error('Invalid provider concurrency');
      options.providerConcurrency[provider] = Number(value);
    }
  if (
    ![options.reps, options.concurrency, options.tokens].every((n) => Number.isSafeInteger(n) && n > 0) ||
    !Number.isSafeInteger(options.infraRetries) ||
    options.infraRetries < 0 ||
    options.infraRetries > 2 ||
    !Number.isFinite(options.runUsd) ||
    options.runUsd <= 0 ||
    !Number.isFinite(options.minutes) ||
    options.minutes <= 0 ||
    options.minutes > 120 ||
    !['auto', 'host', 'docker'].includes(options.backend) ||
    options.taskIds?.some((id) => !/^[-\w.]+$/.test(id))
  )
    throw Error('Invalid limits');
  return options;
}
export function revision() {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
  const sha = git('rev-parse', 'HEAD').toString().trim();
  const hash = createHash('sha256').update(git('diff', '--binary', 'HEAD', '--'));
  for (const file of git('ls-files', '--others', '--exclude-standard', '-z')
    .toString()
    .split('\0')
    .filter(Boolean)
    .sort()) {
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(join(repo, file)))
      .update('\0');
  }
  return { git_sha: sha, dirty_tree_hash: hash.digest('hex') };
}
export function policyReservationCost(
  target: Target,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  if (typeof target === 'string') {
    const spec = MODELS[target];
    if (!spec) throw Error('Unknown upstream');
    const multiplier = spec.peak ? 2 : 1;
    const input = Math.max(spec.rates.input, spec.high?.input ?? 0) * multiplier;
    return {
      input,
      output: Math.max(spec.rates.output, spec.high?.output ?? 0) * multiplier,
      cacheRead: Math.max(spec.rates.cached, spec.high?.cached ?? 0) * multiplier,
      cacheWrite: input * 1.25,
    };
  }
  if (target.type === 'single') return policyReservationCost(target.model);
  if (target.type !== 'escalate') return undefined;
  const cheap = policyReservationCost(target.cheap),
    strong = policyReservationCost(target.strong);
  if (!cheap || !strong) return undefined;
  return {
    input: cheap.input + strong.input,
    output: cheap.output + strong.output,
    cacheRead: cheap.cacheRead + strong.cacheRead,
    cacheWrite: cheap.cacheWrite + strong.cacheWrite,
  };
}
function cleanEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    LANG: 'C.UTF-8',
    SURFPOOL_BINARY: process.env.SURFPOOL_BINARY ?? defaultHarnessEnvironment().binary,
  };
}
async function command(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number },
) {
  return new Promise<{ status: number | null; signal: NodeJS.Signals | null; output: string; timedOut: boolean }>(
    (accept) => {
      const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '',
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10000).unref();
      }, options.timeout);
      const collect = (chunk: Buffer) => {
        if (output.length < 1024 * 1024) output += chunk.toString();
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', () => {
        clearTimeout(timer);
        accept({ status: 127, signal: null, output: '', timedOut: false });
      });
      child.once('close', (status, signal) => {
        clearTimeout(timer);
        accept({ status, signal, output, timedOut });
      });
    },
  );
}
function snapshot(directory: string): Map<string, string> {
  const result = new Map<string, string>();
  function visit(path: string, prefix = '') {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(path, entry.name), name);
      else if (entry.isFile())
        result.set(
          name,
          createHash('sha256')
            .update(readFileSync(join(path, entry.name)))
            .digest('hex'),
        );
      else throw Error('Unsafe workspace');
    }
  }
  visit(directory);
  return result;
}
export async function runBatch(options: Options) {
  if (options.out === repo || options.out.startsWith(repo + '/'))
    throw Error('Batch artifacts must be outside the checkout');
  mkdirSync(options.out, { recursive: true, mode: 0o700 });
  const batchFile = join(options.out, 'runs.jsonl');
  if (existsSync(batchFile) || existsSync(join(options.out, 'batch.json')))
    throw Error('Batch already exists; choose a new id/output');
  const profileBytes = readFileSync(options.profiles ?? join(repo, 'deploy/blend-worker/profiles.json'));
  const profiles = validateProfiles(JSON.parse(profileBytes.toString()));
  if (options.configs.some((config) => !Object.hasOwn(profiles, config))) throw Error('Unknown profile');
  const ids = readdirSync(options.tasks, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const selected = options.taskIds ?? ids;
  if (!selected.length || new Set(selected).size !== selected.length || selected.some((id) => !ids.includes(id)))
    throw Error('Unknown task id');
  const taskHashes = new Map<string, string>();
  for (const id of selected) taskHashes.set(id, await hashTaskDirectory(join(options.tasks, id)));
  const stamp = { ...revision(), profiles_hash: createHash('sha256').update(profileBytes).digest('hex') };
  let backend: 'host' | 'docker' = options.backend === 'host' ? 'host' : 'docker';
  if (options.backend === 'auto') {
    const probe = spawnSync('docker', ['run', '--rm', '--network', 'none', IMAGE, 'node', '--version'], {
      encoding: 'utf8',
      timeout: 60000,
    });
    if (probe.status !== 0) backend = 'host';
  }
  const keys = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    xai: process.env.XAI_API_KEY,
    'opencode-go': process.env.OPENCODE_API_KEY,
    muse: process.env.MUSE_API_KEY,
  };
  const acquireProvider = providerGate(options.providerConcurrency);
  async function cell(cell: Cell, index: number, probe = false, attempt = 0) {
    const runDir = mkdtempSync(join(options.out, probe ? 'probe-' : `run-${String(index).padStart(4, '0')}-`));
    const directory = join(options.tasks, cell.task_id),
      before = snapshot(join(directory, 'workspace'));
    const logFile = join(runDir, 'router.jsonl');
    const logs: RequestLog[] = [];
    let spent = 0,
      held = 0,
      liability = 0,
      guardStopped = false,
      unknown = false;
    let pendingBounds: number[] = [];
    const server = createNodeServer({
      profiles,
      sessions: new MemorySessions(),
      keys,
      beforeCall: async (model) => acquireProvider(MODELS[model]!.provider),
      afterCall: async (_call, permit) => {
        (permit as () => void)();
      },
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body)),
          model = String(body.model),
          spec = MODELS[model];
        if (!spec) throw Error('Unknown upstream');
        const inputRate = Math.max(spec.rates.input, spec.high?.input ?? 0) * 1.25 * (spec.peak ? 2 : 1),
          outRate = Math.max(spec.rates.output, spec.high?.output ?? 0) * (spec.peak ? 2 : 1);
        const bound =
          ((Buffer.byteLength(String(init?.body)) + 1024) * inputRate +
            Number(body.max_tokens ?? body.max_completion_tokens ?? 4096) * outRate) /
          1e6;
        if (spent + held + liability + bound > options.runUsd) {
          guardStopped = true;
          throw new UpstreamError(429, 'Run spend guard.', 'budget');
        }
        held += bound;
        pendingBounds.push(bound);
        return await fetch(input, init);
      },
      log: (line) => {
        logs.push(line);
        appendFileSync(logFile, JSON.stringify(line) + '\n', { mode: 0o600 });
        spent += line.total_usd;
        const settlement = settleCalls(line.calls, pendingBounds);
        if (!settlement.valid) unknown = true;
        liability += settlement.liability;
        held = Math.max(0, held - settlement.released);
        pendingBounds = [];
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', accept);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No router port');
    const admissionCost = policyReservationCost(profiles[cell.config]!);
    const inputFile = join(runDir, 'input.json');
    writeFileSync(
      inputFile,
      JSON.stringify({
        directory,
        runDir,
        config: cell.config,
        backend,
        spend: options.runUsd,
        minutes: options.minutes,
        tokens: options.tokens,
        probe,
        admissionCost,
      }),
      { mode: 0o600 },
    );
    const started = Date.now();
    let outcome: Awaited<ReturnType<typeof command>>;
    try {
      outcome = await command(process.execPath, [join(here, 'worker.ts'), inputFile], {
        env: {
          ...cleanEnv(runDir),
          OMS_BLEND_URL: `http://127.0.0.1:${address.port}/v1`,
          OMS_BLEND_TOKEN: 'local-bench',
        },
        timeout: options.minutes * 60000 + 30000,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
    }
    const wallMs = Date.now() - started;
    const workerFile = join(runDir, 'worker-result.json');
    const worker = existsSync(workerFile) ? JSON.parse(readFileSync(workerFile, 'utf8')) : {};
    if (probe) return { ok: outcome.status === 0, runDir };
    const paid = logs.flatMap((line) => line.calls);
    const totals = {
      input: paid.reduce((sum, c) => sum + c.in, 0),
      cached: paid.reduce((sum, c) => sum + c.cached, 0),
      output: paid.reduce((sum, c) => sum + c.out, 0),
    };
    let grade = { score: 0, passed: 0, total: 0 },
      errorClass = outcome.timedOut
        ? 'WallClock'
        : guardStopped
          ? 'SpendCap'
          : (worker.error_class ?? (outcome.status !== 0 ? 'WorkerError' : null));
    let changedFiles: string[] = [];
    const infra = infraReason(
      { status: worker.oms_status, reason: worker.oms_reason, dispatches: worker.oms_dispatches },
      paid,
    );
    if (infra) errorClass = 'InfrastructureError';
    if (worker.finished_workspace && !infra) {
      try {
        const after = snapshot(worker.finished_workspace);
        changedFiles = [...new Set([...before.keys(), ...after.keys()])]
          .filter((path) => before.get(path) !== after.get(path))
          .sort();
        const args =
          backend === 'docker'
            ? [
                'run',
                '--rm',
                '--network',
                'none',
                '--cap-drop=ALL',
                '--security-opt=no-new-privileges',
                '--pids-limit=128',
                '--memory=1g',
                '--read-only',
                '--tmpfs',
                '/tmp:rw,nosuid,nodev,size=128m',
                '--mount',
                `type=bind,source=${join(here, 'grade.ts')},target=/tool/grade.ts,readonly`,
                '--mount',
                `type=bind,source=${realpathSync(directory)},target=/task,readonly`,
                '--mount',
                `type=bind,source=${worker.finished_workspace},target=/finished,readonly`,
                IMAGE,
                'node',
                '/tool/grade.ts',
                '/task',
                '/finished',
              ]
            : [join(here, 'grade.ts'), directory, worker.finished_workspace];
        const graded = await command(backend === 'docker' ? 'docker' : process.execPath, args, {
          env: cleanEnv(runDir),
          timeout: 90000,
        });
        if (graded.status !== 0) throw Error('Grader failed');
        grade = JSON.parse(graded.output.trim());
        if (
          !Number.isSafeInteger(grade.total) ||
          grade.total < 8 ||
          !Number.isSafeInteger(grade.passed) ||
          grade.passed < 0 ||
          grade.passed > grade.total ||
          grade.score !== grade.passed / grade.total
        )
          throw Error('Invalid grade');
      } catch {
        errorClass = 'GraderError';
      }
    }
    const uncertain = unknown || held > 1e-12;
    const charge = uncertain ? options.runUsd : spent + liability;
    const row = {
      batch_id: options.batch,
      ...stamp,
      task_id: cell.task_id,
      task_hash: taskHashes.get(cell.task_id),
      config: cell.config,
      rep: cell.rep,
      ...grade,
      ...(infra ? { score: null, passed: null, total: null } : {}),
      attempt,
      eligible: !infra,
      infra_reason: infra,
      retry_after_ms: infra && attempt < options.infraRetries ? RETRY_BACKOFF_MS * 2 ** attempt : null,
      usd: spent,
      oms_usd: worker.oms_usd ?? null,
      ...totals,
      wall_ms: wallMs,
      oms_exit_status: outcome.status,
      oms_signal: outcome.signal,
      error_class: errorClass,
      session_id: worker.session_id ?? null,
      router_log: logFile,
      budget_charge_usd: spent,
      billing_upper_usd: charge,
      estimated_cost: logs.some((line) => line.calls.some((call) => call.usage_source === 'estimated')),
      uncertain_spend: uncertain,
      backend,
      changed_files: changedFiles,
      reservation_cost: admissionCost,
      settings: {
        run_usd: options.runUsd,
        minutes: options.minutes,
        tokens: options.tokens,
        input_tokens: 32768,
        output_tokens: 4096,
      },
      ...(backend === 'docker' ? { image: IMAGE } : {}),
    };
    appendFileSync(batchFile, JSON.stringify(row) + '\n', { mode: 0o600 });
    mkdirSync(join(homedir(), 'blend-research'), { recursive: true, mode: 0o700 });
    for (const line of logs)
      for (const call of line.calls)
        appendFileSync(
          join(homedir(), 'blend-research/spend.jsonl'),
          JSON.stringify({
            ts: line.ts,
            phase: 'blend-benchmark',
            batch_id: options.batch,
            task_id: cell.task_id,
            config: cell.config,
            model: call.model,
            tokens: { input: call.in, cached: call.cached, output: call.out },
            usd: call.usd,
            status_class: call.status_class,
            usage_source: call.usage_source,
            attempt: call.attempt,
          }) + '\n',
          { mode: 0o600 },
        );
    console.log(
      JSON.stringify({
        task_id: cell.task_id,
        config: cell.config,
        rep: cell.rep,
        score: row.score,
        eligible: row.eligible,
        infra_reason: row.infra_reason,
        usd: spent,
        wall_ms: wallMs,
        error_class: errorClass,
      }),
    );
    return { chargeUsd: charge, value: row, retry: Boolean(infra) };
  }
  const probe = await cell({ task_id: selected[0]!, config: options.configs[0]!, rep: 0 }, -1, true);
  if (!probe.ok) {
    if (options.backend === 'auto' && backend === 'docker') {
      backend = 'host';
      const host = await cell({ task_id: selected[0]!, config: options.configs[0]!, rep: 0 }, -1, true);
      if (!host.ok) throw Error('No usable OMS backend');
    } else throw Error('OMS backend probe failed');
  }
  writeFileSync(
    join(options.out, 'batch.json'),
    JSON.stringify(
      { batch_id: options.batch, ...stamp, backend, options, task_hashes: Object.fromEntries(taskHashes) },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ batch_id: options.batch, backend }));
  const rows = await schedule(roundRobin(selected, options.configs, options.reps), {
    concurrency: options.concurrency,
    maxUsd: options.maxUsd,
    perRunUsd: options.runUsd,
    providerConcurrency: options.providerConcurrency,
    provider: (cell) => {
      const policy = profiles[cell.config]!;
      return policy.type === 'single' ? MODELS[policy.model]!.provider : 'mixed';
    },
    retryBackoffMs: RETRY_BACKOFF_MS,
    maxRetries: options.infraRetries,
    run: async (cellInput, index, attempt) => {
      const result = await cell(cellInput, index, false, attempt);
      if (typeof result.chargeUsd !== 'number' || !result.value) throw Error('Missing run');
      return { chargeUsd: result.chargeUsd, value: result.value, retry: result.retry };
    },
  });
  console.log(
    JSON.stringify({
      batch_id: options.batch,
      attempts: rows.length,
      runs: rows.filter((row) => row.eligible).length,
      planned: selected.length * options.configs.length * options.reps,
      usd: rows.reduce((sum, row) => sum + row.usd, 0),
      budget_charge_usd: rows.reduce((sum, row) => sum + row.budget_charge_usd, 0),
      billing_upper_usd: rows.reduce((sum, row) => sum + row.billing_upper_usd, 0),
      max_usd: options.maxUsd,
    }),
  );
  return rows;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runBatch(parseArgs(process.argv.slice(2)));
  } catch {
    console.error(
      'Blend batch stopped: invalid inputs, existing batch, backend failure or unknown spend. Inspect private batch artifacts.',
    );
    process.exitCode = 1;
  }
}
