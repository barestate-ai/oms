import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createHarnessSession,
  prepareHarnessTask,
  defaultHarnessEnvironment,
  openWorkspace,
  createTask,
  modelReadiness,
} from '@oms/engine';
import { blendModel } from '../../packages/engine/src/runtime/blend.ts';
import { VISIBLE_TEST_COMMAND } from './grade.ts';

export async function worker(file: string): Promise<void> {
  const input = JSON.parse(readFileSync(file, 'utf8')) as {
    directory: string;
    runDir: string;
    config: string;
    backend: 'host' | 'docker';
    spend: number;
    minutes: number;
    tokens: number;
    probe?: boolean;
    admissionCost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
  const { runDir } = input;
  let harness: Awaited<ReturnType<typeof createHarnessSession>> | undefined;
  let result: Record<string, unknown> = { error_class: 'InfrastructureError', oms_usd: 0, session_id: null };
  let phase = 'workspace';
  try {
    const repo = join(runDir, 'workspace');
    cpSync(join(input.directory, 'workspace'), repo, { recursive: true, errorOnExist: true, force: false });
    const paths = (dir: string, prefix = ''): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw Error('Unsafe workspace');
        if (/(?:^|\/)(?:hidden|grade\.test\.ts)$/.test(relative)) throw Error('Grader in workspace');
        return entry.isDirectory() ? paths(join(dir, entry.name), relative) : [relative];
      });
    const files = paths(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH, HOME: runDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      }).trim();
    git('init', '-q');
    git('add', '--', ...files);
    git(
      '-c',
      'user.name=Blend seed',
      '-c',
      'user.email=blend@invalid.test',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'offline workspace seed',
    );
    const workspace = openWorkspace(repo, { stateRoot: join(runDir, 'state'), initialize: { ignore: 'exclude' } });
    const task = createTask(workspace, { id: 'offline', baseOid: git('rev-parse', 'HEAD') });
    const environment = defaultHarnessEnvironment(process.env.SURFPOOL_BINARY, input.backend);
    delete environment.dependencies;
    phase = 'prepare';
    await prepareHarnessTask(workspace, task, environment, {
      contract: {
        version: 0,
        items: [
          {
            id: 'offline',
            title: 'Offline coding task',
            status: 'active',
            reopenCount: 0,
            done: [{ kind: 'tests', command: [...VISIBLE_TEST_COMMAND], expect: 'pass' }],
          },
        ],
      },
      verifierPaths: ['visible.test.ts'],
      codePaths: files.filter((p) => p !== 'visible.test.ts'),
    });
    result = { ...result, finished_workspace: task.codeRoot };
    phase = 'session';
    harness = await createHarnessSession({
      workspace,
      task,
      environment,
      modelSelection: { provider: 'blend', id: input.config },
      ...(input.admissionCost
        ? { model: { ...blendModel(input.config, process.env.OMS_BLEND_URL!), cost: input.admissionCost } }
        : {}),
      caps: { tokens: input.tokens, spendMicroUsd: Math.floor(input.spend * 1e6), wallClockMs: input.minutes * 60000 },
      maxOutputTokens: 4096,
      maxInputTokens: 32768,
      hostApprovalPolicy: 'allow',
      knowledgeHint: false,
      knowledgeInject: false,
      endRunOnProposal: true,
    });
    result = { ...result, session_id: harness.session.sessionManager.getSessionId() };
    phase = 'turn';
    const readiness = harness.session.model
      ? modelReadiness(harness.session.model, harness.budget, 4096, 'bounded', 32768)
      : null;
    if (input.probe) {
      const command = await harness.runCommand('node --version');
      if (command.exitCode !== 0) throw Error('Sandbox probe failed');
    } else if (readiness && !readiness.ready && readiness.detail.startsWith('The remaining API limit')) {
      result = { ...result, oms_status: 'capped', oms_reason: 'capped:usd', oms_dispatches: [] };
    } else await harness.session.prompt(readFileSync(join(input.directory, 'PROMPT.md'), 'utf8'));
    const snapshot = harness.budget.snapshot(),
      last = harness.session.messages.filter((m) => m.role === 'assistant').at(-1);
    const error = input.probe
      ? null
      : snapshot.accounting !== 'known'
        ? 'UnknownUsage'
        : snapshot.remaining.spendMicroUsd === 0
          ? 'SpendCap'
          : last?.role === 'assistant' && last.stopReason === 'error'
            ? 'ModelError'
            : last?.role === 'assistant' && last.stopReason === 'length'
              ? 'OutputLimit'
              : null;
    result = {
      ...result,
      error_class: error,
      oms_usd: snapshot.used.spendMicroUsd / 1e6,
      oms_accounting: snapshot.accounting,
    };
  } catch (error) {
    result = {
      ...result,
      error_class: 'InfrastructureError',
      phase,
      error_code:
        typeof (error as NodeJS.ErrnoException).code === 'string' ? (error as NodeJS.ErrnoException).code : null,
      error_frames:
        error instanceof Error
          ? error.stack
              ?.split('\n')
              .filter((line) => /^\s+at /.test(line))
              .slice(0, 6)
          : [],
      ...(harness ? { oms_usd: harness.budget.snapshot().used.spendMicroUsd / 1e6 } : {}),
    };
  } finally {
    try {
      await harness?.close();
    } catch {
      result = { ...result, error_class: 'CleanupError' };
    }
    writeFileSync(join(runDir, 'worker-result.json'), JSON.stringify(result) + '\n', { mode: 0o600 });
  }
  if (result.error_class) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await worker(process.argv[2]!);
