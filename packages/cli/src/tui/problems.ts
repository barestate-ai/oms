import { stripTerminalSequences } from '@earendil-works/pi-tui';

export interface Problem {
  severity: 'error' | 'warning';
  message: string;
  /** Project-relative path, when the tool named one. */
  path?: string;
  line?: number;
  column?: number;
  /** A compiler or program error code: E0433, TS2322, 6000. */
  code?: string;
  /** What Enter does on a row that has no file: a slash command that explains it. */
  command?: string;
}

/** Anything of the form `/work/x`, `./x` or an absolute path inside `root` becomes `x`. */
function relative(path: string, root?: string): string {
  let result = path.replace(/^\.\//, '').replace(/^\/work\//, '');
  if (root && result.startsWith(root.replace(/\/$/, '') + '/'))
    result = result.slice(root.replace(/\/$/, '').length + 1);
  return result;
}

const RUST = /^(error|warning)(?:\[(\w+)\])?: (.+)$/;
const RUST_AT = /^\s*--> (.+?):(\d+):(\d+)\s*$/;
const TSC_PAREN = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/;
const TSC_COLON = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.+)$/;
const ANCHOR = /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: ([^.]*(?:\.[^.]+)*?)\.?\s*$/;
const THROWN = /AnchorError thrown in (\S+?):(\d+)/;
const CUSTOM = /custom program error: (0x[0-9a-f]+)/i;
const NOISE = /^(aborting due to|could not compile|warning: `.+` \(.+\) generated|error: aborting)/;

/**
 * Compiler and test failures in command output, as clickable problems: rustc and Anchor builds, tsc, and Anchor or
 * program error codes. Output is untrusted text, so nothing here runs or follows it: it only finds locations.
 */
export function parseProblems(output: string, root?: string): Problem[] {
  const lines = stripTerminalSequences(output).split(/\r?\n/);
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const add = (problem: Problem) => {
    const key = `${problem.severity}|${problem.path}|${problem.line}|${problem.column}|${problem.code}|${problem.message}`;
    if (seen.has(key) || problems.length >= 200) return;
    seen.add(key);
    problems.push(problem);
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const tsc = TSC_PAREN.exec(line) ?? TSC_COLON.exec(line);
    if (tsc) {
      add({
        severity: tsc[4] as 'error' | 'warning',
        path: relative(tsc[1]!, root),
        line: Number(tsc[2]),
        column: Number(tsc[3]),
        code: tsc[5],
        message: tsc[6]!.trim(),
      });
      continue;
    }
    const rust = RUST.exec(line);
    if (rust && !NOISE.test(line)) {
      let located: RegExpExecArray | null = null;
      for (let ahead = 1; ahead <= 3 && index + ahead < lines.length && !located; ahead++)
        located = RUST_AT.exec(lines[index + ahead]!);
      if (located) {
        add({
          severity: rust[1] as 'error' | 'warning',
          path: relative(located[1]!, root),
          line: Number(located[2]),
          column: Number(located[3]),
          code: rust[2],
          message: rust[3]!.trim(),
        });
      } else if (rust[1] === 'error' && !/^(aborting|could not compile)/.test(rust[3]!)) {
        add({ severity: 'error', message: rust[3]!.trim(), code: rust[2] });
      }
      continue;
    }
    const anchor = ANCHOR.exec(line);
    if (anchor) {
      // The location, when the build log names it, is on this line or just above.
      const where = THROWN.exec(line) ?? THROWN.exec(lines[index - 1] ?? '');
      add({
        severity: 'error',
        code: anchor[2],
        message: `${anchor[1]} (${anchor[2]}): ${anchor[3]!.trim()}`,
        ...(where ? { path: relative(where[1]!, root), line: Number(where[2]) } : {}),
        command: `/error ${anchor[2]}`,
      });
      continue;
    }
    const custom = CUSTOM.exec(line);
    if (custom) {
      add({
        severity: 'error',
        code: custom[1],
        message: `Program error ${custom[1]}`,
        command: `/error ${custom[1]}`,
      });
    }
  }
  return problems;
}
