import { execFile } from 'node:child_process';

/** What a program run on the host gave back. Never thrown: a missing program, a timeout and a bad exit are all results. */
export interface HostResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: 'missing' | 'timeout' | 'aborted' | 'failed';
}
export interface HostOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}
/** The one way connectors start a program: a fixed argument list, no shell. Tests pass their own. */
export type HostRun = (file: string, args: readonly string[], options?: HostOptions) => Promise<HostResult>;

/** Larger than anything shown: the text is cut to what the model or the screen takes after it is read. */
const MAX_BUFFER = 4 * 1024 * 1024;

export const hostRun: HostRun = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: { ...(options.env ?? process.env), AWS_PAGER: '', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
        timeout: options.timeoutMs ?? 20_000,
        signal: options.signal,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (failure.code === 'ENOENT') return resolve({ code: null, stdout: '', stderr: '', error: 'missing' });
        if (options.signal?.aborted || failure.name === 'AbortError')
          return resolve({ code: null, stdout, stderr, error: 'aborted' });
        if (failure.killed) return resolve({ code: null, stdout, stderr, error: 'timeout' });
        // A process that wrote past the buffer was stopped, but what it wrote is still useful.
        if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ code: 0, stdout, stderr });
        resolve({ code: typeof failure.code === 'number' ? failure.code : null, stdout, stderr, error: 'failed' });
      },
    );
  });

/**
 * The environment Docker runs with: where programs and settings are, and Docker's own variables, and nothing else. A
 * compose file interpolates `${NAME}` from it, so the user's API keys must not be in it.
 */
export function dockerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env))
    if (
      /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z_]+|TERM|DOCKER_[A-Z_]+|COMPOSE_[A-Z_]+|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS)$/.test(
        name,
      )
    )
      out[name] = value;
  return out;
}

/** The last `lines` lines of `text`. */
export function tailLines(text: string, lines: number): string {
  const all = text.replace(/\n+$/, '').split('\n');
  return all.length <= lines
    ? text.replace(/\n+$/, '')
    : `[${all.length - lines} earlier lines left out]\n${all.slice(-lines).join('\n')}`;
}
