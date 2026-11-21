import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { formatDuration, formatInteger, formatMicroUsd } from '@oms/core';
import { taskDiff, type OmsSession } from '@oms/engine';
import { claudeChatStatus } from './claude-chat.ts';
import { previewBytes, refuse, REPORT_BYTES, type Prepared } from './prepared.ts';
import { singleLine } from './transcript.ts';
import type { CommandContext } from './commands.ts';

/** Diff text shown in the conversation; a longer one opens in the workbench. */
const DIFF_SHOWN_CHARS = 8_000;

/** What the header and the terminal title call this session: the repository of a task, or the folder of a chat. */
export function sessionLabel(harness: OmsSession): string {
  return harness.kind === 'chat'
    ? harness.folder.scratch
      ? 'scratch'
      : basename(harness.folder.path)
    : basename(harness.workspace.root);
}

/** `30m0s` and `1h0m0s` read better as `30m` and `1h`. */
const duration = (ms: number): string =>
  formatDuration(ms)
    .replace(/(?<=[hm])0s$/, '')
    .replace(/(?<=h)0m$/, '');

/** Aligned label and value rows; a value on several lines keeps its column. */
export function labelRows(
  rows: readonly (readonly [string, string])[],
  width = Math.max(...rows.map(([label]) => label.length)) + 2,
): string {
  return rows
    .map(([label, value]) =>
      value
        .split('\n')
        .map((line, index) => `${(index === 0 ? label : '').padEnd(width)}${line}`)
        .join('\n'),
    )
    .join('\n');
}

/** What is left of the token, spend and time allowance, on one line. */
export function budgetLine(harness: OmsSession): string {
  const budget = harness.budget.snapshot();
  const dollars = formatMicroUsd(budget.remaining.spendMicroUsd);
  const allowance = `${formatInteger(budget.remaining.tokens)} tokens`;
  const time = duration(budget.remaining.wallClockMs);
  // In an interactive session tokens and time reset every turn; the spend cap is for the whole session.
  const left =
    budget.executionMode === 'interactive'
      ? `${allowance} and ${time} per turn · ${dollars} left`
      : `${allowance} · ${time} · ${dollars} left`;
  return (
    left + (budget.exhausted ? ' · exhausted' : '') + (budget.accounting === 'known' ? '' : ' · usage unconfirmed')
  );
}

/** Calls made and what the provider cached, from the budget ledger. Empty before the first call. */
function callsLine(harness: OmsSession): string {
  const reservations = harness.budget.reservations();
  const receipts = new Map(harness.budget.receipts().map((receipt) => [receipt.dispatchId, receipt]));
  if (reservations.length === 0) return '';
  let cacheRead = 0,
    cacheWrite = 0,
    unconfirmed = 0;
  for (const item of reservations) {
    const receipt = receipts.get(item.dispatchId);
    if (!receipt || receipt.outcome === 'uncertain') unconfirmed++;
    else if (receipt.outcome === 'known' && receipt.usage) {
      cacheRead += receipt.usage.cacheReadTokens;
      cacheWrite += receipt.usage.cacheWriteTokens;
    }
  }
  return (
    `${reservations.length} · cache ${formatInteger(cacheRead)} read / ${formatInteger(cacheWrite)} written` +
    (unconfirmed ? ` · ${unconfirmed} unconfirmed` : '')
  );
}

export function prepareDiff(argument: string, harness: OmsSession): Prepared {
  const path = argument.trim() || undefined;
  return {
    ok: true,
    async run() {
      if (harness.kind === 'chat' && !harness.folder.git)
        return { title: 'diff', text: 'Not a git repository · nothing to compare' };
      const [codeRoot, baseOid, branch] =
        harness.kind === 'chat'
          ? [harness.root, 'HEAD', gitBranch(harness.root)]
          : [harness.task.codeRoot, harness.task.baseOid, harness.task.branch];
      let diff;
      try {
        diff = await taskDiff(codeRoot, baseOid, path);
      } catch (error) {
        if (harness.kind === 'chat' && /unknown revision|ambiguous argument/.test(String(error)))
          return { title: 'diff', text: 'No commits yet · nothing to compare' };
        throw error;
      }
      const head = `Against ${harness.kind === 'chat' ? 'HEAD' : `base ${baseOid.slice(0, 12)}`} · ${branch}${path ? ` · ${path}` : ''}`;
      const untracked = diff.untracked.length
        ? `Untracked (${diff.untracked.length}):\n${diff.untracked
            .slice(0, 30)
            .map((file) => '  ' + file)
            .join('\n')}${diff.untracked.length > 30 ? `\n  [${diff.untracked.length - 30} more]` : ''}`
        : '';
      if (!diff.patch && !untracked) return { title: 'diff', text: `${head}\nNo changes.` };
      const summary = [head, diff.stat, untracked].filter(Boolean).join('\n');
      if (diff.patch.length <= DIFF_SHOWN_CHARS && !diff.truncated)
        return { title: 'diff', text: `${summary}\n\n${diff.patch}` };
      return {
        title: 'diff',
        text: `${summary}\n\n${diff.patch.slice(0, DIFF_SHOWN_CHARS)}\n[Full diff opened in the workbench]`,
        report: {
          id: `diff-${Date.now()}`,
          text: previewBytes(
            `${summary}\n\n${diff.patch}${diff.truncated ? '\n[Diff truncated at 256 KiB]' : ''}`,
            REPORT_BYTES,
          ),
        },
      };
    },
  };
}

/** Tokens, spend and time against their caps, then the calls behind them. */
export function prepareUsage(argument: string, harness: OmsSession): Prepared {
  if (argument) return refuse('Usage: /usage');
  return {
    ok: true,
    async run() {
      const snapshot = harness.budget.snapshot();
      let input = 0,
        output = 0,
        cacheRead = 0,
        cacheWrite = 0,
        known = 0,
        unbroken = 0;
      for (const receipt of harness.budget.receipts()) {
        if (receipt.outcome !== 'known') continue;
        if (receipt.usage) {
          input += receipt.usage.inputTokens;
          output += receipt.usage.outputTokens;
          cacheRead += receipt.usage.cacheReadTokens;
          cacheWrite += receipt.usage.cacheWriteTokens;
          known++;
        } else unbroken++;
      }
      const { used, caps, remaining } = snapshot;
      const calls = callsLine(harness);
      return {
        title: 'usage',
        text:
          labelRows([
            ['Tokens', `${formatInteger(used.tokens)} of ${formatInteger(caps.tokens)}`],
            [
              'Detail',
              `input ${formatInteger(input)} · cached ${formatInteger(cacheRead)} read / ${formatInteger(cacheWrite)} written · output ${formatInteger(output)}` +
                `${unbroken ? ` · ${unbroken} earlier ${unbroken === 1 ? 'call has' : 'calls have'} no breakdown` : ''}${known + unbroken === 0 ? ' · no model calls yet' : ''}`,
            ],
            [
              'Spend',
              `${formatMicroUsd(used.spendMicroUsd)} of ${formatMicroUsd(caps.spendMicroUsd)} · ${formatMicroUsd(remaining.spendMicroUsd)} left`,
            ],
            ['Time', `${duration(used.wallClockMs)} of ${duration(caps.wallClockMs)}`],
            ...(calls ? [['Calls', calls] as const] : []),
          ]) +
          (snapshot.accounting === 'known' && !snapshot.exhausted
            ? ''
            : `\n${snapshot.exhausted ? 'Budget used up' : 'Usage unconfirmed'}${snapshot.accounting === 'known' ? '' : ' · a failed request may not be counted'}`),
      };
    },
  };
}

/** The checked-out branch, read from the repository's HEAD without running git. */
function gitBranch(folder: string): string {
  try {
    const head = readFileSync(join(folder, '.git', 'HEAD'), 'utf8').trim();
    return /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? 'detached HEAD';
  } catch {
    return 'branch unknown';
  }
}

/** The model and what is left to spend; a task adds its requirements. The requirements are re-read when the command runs. */
export function prepareStatus(ctx: CommandContext): Prepared {
  return {
    ok: true,
    async run() {
      const { harness } = ctx;
      const model = harness.session.model;
      const detail = ctx.modelDetail();
      const context = harness.session.getContextUsage?.()?.percent;
      const rows: (readonly [string, string])[] = [
        [
          'Model',
          (model && model.provider.trim() && model.id.trim() && model.provider !== 'unknown' && model.id !== 'unknown'
            ? `${singleLine(model.provider, 80)}/${singleLine(model.id, 120)}`
            : 'none selected · /model') + (detail ? `\n${singleLine(detail, 200)}` : ''),
        ],
        ...(context == null ? [] : [['Context', `${Math.round(context)}% full`] as const]),
        ['Budget', budgetLine(harness)],
        ...(harness.web ? [['Web', harness.web.enabled() ? 'on' : 'off'] as const] : []),
      ];
      if (harness.kind === 'chat') return { title: 'status', clearNotice: true, text: labelRows(rows) };
      const requirements = ctx.checkRequirements();
      const items = requirements.items
        .slice(0, 12)
        .map((item) => `  ${singleLine(item.id, 80)}  ${singleLine(item.status, 80)}  ${singleLine(item.title, 160)}`);
      const task: (readonly [string, string])[] = [
        ['Task', singleLine(harness.task.id, 120)],
        [
          'Checked',
          requirements.proofAvailable ? `requirements at ${requirements.checkedAt}` : 'requirements unavailable',
        ],
      ];
      // One label column for the task and for the model and budget below its requirements.
      const width = Math.max(...[...task, ...rows].map(([label]) => label.length)) + 2;
      return {
        title: 'status',
        clearNotice: true,
        text: [labelRows(task, width), ...items, '', labelRows(rows, width)].join('\n'),
      };
    },
  };
}

export function prepareSession(harness: OmsSession): Prepared {
  return {
    ok: true,
    async run() {
      const id = harness.session.sessionManager.getSessionId();
      const place =
        harness.kind === 'chat'
          ? `Folder: ${harness.folder.requested}${harness.folder.scratch ? ` (this chat works in the scratch folder ${harness.folder.path})` : ''}\nGit: ${harness.folder.git ? gitBranch(harness.root) : 'not a git repository'}`
          : `Repository: ${harness.workspace.root}\nTask: ${harness.task.id}\nWorktree: ${harness.task.codeRoot}\nBranch: ${harness.task.branch}`;
      return {
        title: 'session',
        clearNotice: true,
        text: `OMS session: ${id}\n${place}` + (harness.nativeChat ? `\n${claudeChatStatus(harness)}` : ''),
      };
    },
  };
}
