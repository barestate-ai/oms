import { wrapUntrusted } from '@oms/engine';
import { buildCall, type Call, type CliConnector, type Params } from './argv.ts';
import type { HostRun } from './host.ts';
import { RESULT_LIMIT, plainOutput } from './extension.ts';
import { callHostedTool, type HostedCallDeps, type McpCredentials } from './mcp.ts';
import { connectorSpec } from './catalog.ts';

export type ContextKind = 'pr' | 'issue' | 'ci';
export type Forge = 'github' | 'gitlab';

/** What the person typed after the command: an optional number (or a Linear key), then optional words that replace the default request. */
export interface ContextArgument {
  ref?: string;
  /** A Linear issue key such as LIN-123. */
  linear?: string;
  instruction?: string;
}

const LINEAR_KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,6}$/;

/** `42 fix the failing test`, `#42`, `LIN-12`, or only words. The first word is a reference only when it is one. */
export function parseContextArgument(argument: string): ContextArgument {
  const text = argument.trim();
  if (!text) return {};
  const [first = '', ...rest] = text.split(/\s+/);
  const instruction = rest.join(' ').trim() || undefined;
  if (/^#?\d{1,9}$/.test(first)) return { ref: first.replace('#', ''), ...(instruction ? { instruction } : {}) };
  if (LINEAR_KEY.test(first)) return { linear: first, ...(instruction ? { instruction } : {}) };
  return { instruction: text };
}

const DEFAULT_INSTRUCTION: Record<ContextKind, string> = {
  pr: 'Review this pull request. Say what is good, what is risky and what to change.',
  issue: 'Plan and implement this issue. Start by saying your plan in a few lines.',
  ci: 'Find and fix the cause of these failing checks.',
};

export interface ContextDeps {
  run: HostRun;
  folder: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  credentials?: McpCredentials;
  /** How a hosted call reaches its server; tests pass a transport wired to a fake one, so none opens a socket. */
  hosted?: HostedCallDeps;
}
export interface LoadedContext {
  /** One short line for the conversation. */
  note: string;
  /** What the agent receives as the person's message: the request, then the outside text framed as data. */
  message: string;
}

const clipText = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}\n[cut]`);
/** A log's end says why it failed: keep the end. */
const clipEnd = (text: string, max: number): string =>
  text.length <= max ? text : `[earlier output cut]\n${text.slice(-max)}`;

async function runCall(label: string, call: Call, deps: ContextDeps): Promise<string> {
  const result = await deps.run(call.program, call.args, {
    cwd: deps.folder,
    timeoutMs: call.timeoutMs,
    signal: deps.signal,
    env: deps.env,
  });
  return plainOutput(label, call.program, call, result);
}

const frame = (source: string, program: string, body: string): string =>
  wrapUntrusted(program, body, RESULT_LIMIT, source);

/** Fetch what the agent needs for `/pr`, `/issue` or `/ci` on the host, framed as outside data. Throws a plain sentence on failure. */
export async function loadContext(
  kind: ContextKind,
  argument: ContextArgument,
  forge: Forge,
  deps: ContextDeps,
): Promise<LoadedContext> {
  const instruction = argument.instruction ?? DEFAULT_INSTRUCTION[kind];
  const label = connectorSpec(forge)!.label;
  const program = forge === 'github' ? 'gh' : 'glab';
  const call = (action: string, params: Params = {}) => buildCall(forge as CliConnector, action, params);
  const parts: string[] = [];
  let heading: string;
  if (kind === 'pr') {
    const ref = argument.ref;
    heading = ref ? `${forge === 'github' ? 'pull request' : 'merge request'} #${ref}` : 'the current pull request';
    parts.push(
      clipText(await runCall(label, call(forge === 'github' ? 'pr_view' : 'mr_view', { number: ref }), deps), 10_000),
    );
    // The agent reads files itself; a long diff is never pasted in.
    if (forge === 'github')
      parts.push('Changed files:\n' + clipText(await runCall(label, call('pr_files', { number: ref }), deps), 4_000));
  } else if (kind === 'issue') {
    if (!argument.ref) throw new Error('Say which issue, for example /issue 42.');
    heading = `issue #${argument.ref}`;
    parts.push(clipText(await runCall(label, call('issue_view', { number: argument.ref }), deps), 14_000));
  } else {
    heading = 'the checks of this branch';
    if (forge === 'gitlab') parts.push(await runCall(label, call('ci_status'), deps));
    else {
      const checks = await runCall(label, call('pr_checks', { number: argument.ref }), deps);
      parts.push(clipText(checks, 4_000));
      const failing = firstFailedRun(checks);
      if (failing)
        parts.push(
          `Failed log of run ${failing}:\n` +
            clipEnd(await runCall(label, call('run_failed_log', { run_id: failing }), deps), 10_000),
        );
      else parts.push('No failed run was found in these checks.');
    }
  }
  const body = parts.join('\n\n');
  return {
    note: `Fetched ${heading} from ${label}. Sending it to the agent.`,
    message: `${instruction}\n\n${frame(`${label} through ${program}`, program, body)}`,
  };
}

/** The first failed check whose link names a workflow run: `.../actions/runs/123/job/456` gives 123. */
export function firstFailedRun(checksJson: string): string | undefined {
  try {
    const checks = JSON.parse(checksJson) as Array<{ bucket?: string; state?: string; link?: string }>;
    for (const check of Array.isArray(checks) ? checks : []) {
      if (check.bucket !== 'fail' && !/^(FAILURE|ERROR|TIMED_OUT)$/i.test(check.state ?? '')) continue;
      const id = /\/actions\/runs\/(\d{1,15})(?:\/|$)/.exec(check.link ?? '')?.[1];
      if (id) return id;
    }
  } catch {
    // Not JSON: no run to read.
  }
  return undefined;
}

/** `/issue LIN-123` on a connected Linear: the issue text, fetched by OMS itself with the stored sign-in. */
export async function loadLinearIssue(
  key: string,
  instruction: string | undefined,
  deps: ContextDeps,
): Promise<LoadedContext> {
  const spec = connectorSpec('linear')!;
  if (!deps.credentials) throw new Error('Linear is not connected. Run /connectors.');
  const text = await callHostedTool(
    {
      name: spec.mcp!.server,
      url: spec.mcp!.url,
      credentials: deps.credentials,
      tool: 'get_issue',
      args: { id: key },
      signal: deps.signal,
    },
    deps.hosted,
  );
  return {
    note: `Fetched ${key} from Linear. Sending it to the agent.`,
    message: `${instruction ?? DEFAULT_INSTRUCTION.issue}\n\n${frame('Linear (hosted connector)', 'get_issue', clipText(text, 14_000))}`,
  };
}
