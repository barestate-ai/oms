import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Grade = { passed: number; total: number; score: number };
export const NODE_TEST_FLAGS = ['--experimental-transform-types', '--test'] as const;
export const VISIBLE_TEST_COMMAND = ['node', ...NODE_TEST_FLAGS, 'visible.test.ts'] as const;

async function copyWorkspace(source: string, target: string): Promise<void> {
  if (!(await lstat(source)).isDirectory()) throw new Error('Workspace must be a directory');
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Workspace contains a symlink: ${entry.name}`);
    if (entry.isDirectory()) await copyWorkspace(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error(`Workspace contains a nonregular file: ${entry.name}`);
  }
}

export async function grade(
  taskDirectory: string,
  workspaceDirectory: string,
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<Grade> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Timeout must be an integer from 1 to 60000 milliseconds');
  }
  const source = await readFile(join(taskDirectory, 'hidden', 'grade.test.ts'), 'utf8');
  const total = source.match(/\btest\s*\(/g)?.length ?? 0;
  if (total < 8 || total > 20) throw new Error('Expected 8–20 independent hidden tests');
  const directory = await mkdtemp(join(tmpdir(), 'blend-grade-'));
  try {
    const workspace = join(directory, 'workspace');
    await copyWorkspace(resolve(workspaceDirectory), workspace);
    const injected = join(workspace, 'grade.test.ts');
    await rm(injected, { recursive: true, force: true });
    await copyFile(join(taskDirectory, 'hidden', 'grade.test.ts'), injected);
    const environment: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
    delete environment.NODE_TEST_CONTEXT;
    const result = await new Promise<{ output: string; interrupted: boolean }>((accept, reject) => {
      const child = spawn(process.execPath, [...NODE_TEST_FLAGS, '--test-reporter=tap', 'grade.test.ts'], {
        cwd: workspace,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let output = '';
      let bytes = 0;
      let interrupted = false;
      const kill = () => {
        interrupted = true;
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      };
      const timer = setTimeout(kill, timeoutMs);
      const collect = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) kill();
        else output += chunk.toString('utf8');
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', () => {
        clearTimeout(timer);
        accept({ output, interrupted });
      });
    });
    const summary = (name: string) => {
      const values = [...result.output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
      return values.length === 1 ? Number(values[0][1]) : -1;
    };
    const passed = summary('pass');
    const failed = summary('fail');
    if (result.interrupted || summary('tests') !== total || passed < 0 || failed < 0 || passed + failed !== total) {
      return { passed: 0, total, score: 0 };
    }
    return { passed, total, score: passed / total };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , task, workspace, ...extra] = process.argv;
  if (!task || !workspace || extra.length) {
    console.error(`Usage: node ${basename(process.argv[1])} <task-directory> <finished-workspace>`);
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await grade(resolve(task), resolve(workspace))));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
