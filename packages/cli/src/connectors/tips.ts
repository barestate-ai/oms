import type { ConnectorId, ConnectorsConfig, TipState } from './config.ts';
import { effectiveAccess } from './config.ts';
import type { HostRun } from './host.ts';

/** The connectors the sign-in tip is about. Connecting any of them ends the tip. */
const TIP_CONNECTORS: readonly ConnectorId[] = ['github', 'gitlab', 'gitlab-remote', 'linear', 'slack'];

/** Never before the third launch, and at most three times: after the 3rd launch, after 7 more, then after 20 more (3, 10, 30). */
const FIRST_LAUNCH = 3;
const GAPS = [7, 20];
const MAX_SHOWS = GAPS.length + 1;

export interface TipContext {
  tips: TipState;
  config: ConnectorsConfig;
  /** The folder chat, not a pinned task. */
  chat: boolean;
  modelConfigured: boolean;
  rows: number;
}

/** Whether the optional "connect your tools" tip may show now. Pure: the caller records that it showed. */
export function shouldShowTip({ tips, config, chat, modelConfigured, rows }: TipContext): boolean {
  if (!chat || !modelConfigured || rows < 18) return false;
  if (tips.dismissed || tips.launches < FIRST_LAUNCH || tips.shown >= MAX_SHOWS) return false;
  if (TIP_CONNECTORS.some((id) => effectiveAccess(config.connectors[id]) !== 'off')) return false;
  return tips.shown === 0 || tips.launches - tips.lastShown >= GAPS[tips.shown - 1]!;
}

/** The tip after one more show. */
export const afterShown = (tips: TipState): TipState => ({ ...tips, shown: tips.shown + 1, lastShown: tips.launches });

export type RemoteKind = 'github' | 'gitlab' | 'other';
/** Which service this folder's `origin` points at: one quick `git remote get-url origin`, or `other`. */
export async function remoteKind(run: HostRun, cwd: string): Promise<RemoteKind> {
  const result = await run('git', ['remote', 'get-url', 'origin'], { cwd, timeoutMs: 1_500 });
  if (result.code !== 0) return 'other';
  const url = result.stdout.trim().toLowerCase();
  // The host is the part right after `://` or `@`, up to the next `/` or `:`.
  const host = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/.exec(url)?.[1] ?? '';
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return 'gitlab';
  return 'other';
}

/** The one line shown to the person. It names the service this folder uses when it can. */
export function tipLine(kind: RemoteKind): string {
  if (kind === 'github')
    return 'Tip: connect GitHub so the agent can read issues, pull requests and CI. Run /connectors.';
  if (kind === 'gitlab') return 'Tip: connect GitLab so the agent can read merge requests and CI. Run /connectors.';
  return 'Tip: connect GitHub, GitLab, Linear or Slack so the agent can use them. Run /connectors.';
}

/** The line after a successful /login. */
export const LOGIN_TIP = 'Optional: connect GitHub, GitLab, Linear or Slack in /connectors.';
