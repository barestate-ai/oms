/** The section "Solana Bench, harness version (our environment)", rendered from the run results. */
import { meanPermutation, signTest } from './stats.ts';
import { withoutPrecompiles, type Score } from './score.ts';

export interface RunResult {
  cell: string;
  variant: 'basic' | 'swap';
  runIndex: number;
  wallMs: number;
  reason: string | null;
  forkSlot: number;
  score: Score;
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null;
  /** False when some model call's usage is unknown (a cut stream), so `tokens` is a lower bound. */
  tokensComplete: boolean;
  usd?: number;
  billingUpperUsd?: number;
  forkFailures?: number;
  identities: { commit: string; image: string; goal: string };
}

const median = (values: readonly number[]) => {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const fmt = (n: number) => (Number.isNaN(n) ? 'n/a' : Number.isInteger(n) ? String(n) : n.toFixed(1));
const k = (n: number) => (Number.isNaN(n) ? 'n/a' : `${Math.round(n / 1000)}k`);

const eligible = (r: RunResult) =>
  !['fork-failure', 'usage-limit', 'infra-no-start', 'api-budget'].includes(r.reason ?? '') &&
  !r.reason?.startsWith('oms-');
export function summarize(runs: readonly RunResult[]) {
  runs = runs.filter(eligible);
  const by = (pick: (r: RunResult) => number) => runs.map(pick);
  const headline = by((r) => r.score.headline);
  const known = runs.filter((r) => r.tokens && r.tokensComplete);
  return {
    runs: runs.length,
    median: median(headline),
    max: Math.max(...headline),
    min: Math.min(...headline),
    programs: median(by((r) => r.score.programs)),
    failed: median(by((r) => r.score.failed)),
    submissions: median(by((r) => r.score.submissions)),
    raw: median(by((r) => r.score.raw)),
    noPrecompile: median(by((r) => withoutPrecompiles(r.score.pairs).length)),
    arbitrary: median(by((r) => r.score.arbitrary)),
    memo: median(by((r) => r.score.memo)),
    input: median(known.map((r) => r.tokens!.inputTokens + r.tokens!.cacheReadTokens + r.tokens!.cacheWriteTokens)),
    cached: median(known.map((r) => r.tokens!.cacheReadTokens)),
    output: median(known.map((r) => r.tokens!.outputTokens)),
    tokensKnown: known.length,
    wallMin: median(by((r) => r.wallMs / 60_000)),
  };
}

/** Run i of cell A against run i of cell B in the same variant: the interleaved schedule ran them back to back. */
export function paired(runs: readonly RunResult[], a: string, b: string) {
  runs = runs.filter(eligible);
  const pairs = runs
    .filter((r) => r.cell === a)
    .flatMap((x) => {
      const y = runs.find((r) => r.cell === b && r.variant === x.variant && r.runIndex === x.runIndex);
      return y ? [{ variant: x.variant, runIndex: x.runIndex, a: x.score.headline, b: y.score.headline }] : [];
    });
  const test = signTest(
    pairs.map((p) => p.a > p.b),
    pairs.map((p) => p.b > p.a),
  );
  return {
    pairs,
    aWins: test.aOnly,
    bWins: test.bOnly,
    ties: test.neither,
    pValue: test.pValue,
    medianDifference: median(pairs.map((p) => p.a - p.b)),
  };
}

export function renderSection(all: readonly RunResult[], cells: readonly string[]): string {
  const isPaused = (r: RunResult) =>
    r.reason === 'usage-limit' || r.reason === 'infra-no-start' || r.reason === 'fork-failure';
  // A provider/harness-truncated run (OMS infra ending with submissions) is not a score: raw number listed apart, outside every statistic.
  const isTruncated = (r: RunResult) =>
    !isPaused(r) && (Boolean(r.reason?.startsWith('oms-')) || r.reason === 'api-budget');
  const runs = all.filter((r) => !isPaused(r) && !isTruncated(r));
  const lines = [
    '## Solana Bench, harness version (our environment)',
    '',
    'solbench-harness runs the Solana Bench scoring rule against whole harnesses: labelled subscription cells online, Blend API cells without web credentials.',
    'Goal (one file, the same for every harness): maximise unique (program id, first instruction-data byte) pairs in successfully executed',
    'transactions, on a Surfpool 0.10.4 mainnet fork, at most 50 `submit-tx` calls and 30 minutes per run. The agent never holds a key: the',
    'environment signs with a fresh fork-only wallet. Filtered score = no Memo / Memo v1, no arbitrary-data program, no program the run',
    'deployed itself (those are counted separately).',
    '',
  ];
  for (const variant of ['basic', 'swap'] as const) {
    lines.push(
      `### ${variant}`,
      '',
      '| harness | runs | filtered median | without precompiles (median) | max | min | programs (median) | failed submissions (median) | submissions (median) | raw (median) | arbitrary-data (median) | input tokens (median, of which cached) | output tokens (median) | wall min (median) |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const cell of cells) {
      const of = runs.filter((r) => r.cell === cell && r.variant === variant);
      if (!of.length) {
        lines.push(`| ${cell} | 0 | | | | | | | | | | | | |`);
        continue;
      }
      const s = summarize(of);
      lines.push(
        `| ${cell} | ${s.runs} | ${fmt(s.median)} | ${fmt(s.noPrecompile)} | ${s.max} | ${s.min} | ${fmt(s.programs)} | ${fmt(s.failed)} | ${fmt(s.submissions)} | ${fmt(s.raw)} | ${fmt(s.arbitrary)} | ${k(s.input)} (${k(s.cached)})${s.tokensKnown < s.runs ? ` [${s.tokensKnown} of ${s.runs} known]` : ''} | ${k(s.output)} | ${fmt(s.wallMin)} |`,
      );
    }
    lines.push('');
  }
  if (cells.length >= 2) {
    const p = paired(runs, cells[0]!, cells[1]!);
    lines.push(
      `### Paired: ${cells[0]} vs ${cells[1]}`,
      '',
      `Pairs are run i of each cell in the same variant (run back to back). ${p.pairs.length} pairs: ${cells[0]} higher in ${p.aWins}, ${cells[1]} higher in ${p.bWins}, ties ${p.ties}; ` +
        `median difference ${fmt(p.medianDifference)} pairs; exact two-sided sign test p = ${p.pValue.toFixed(3)}. With ${p.pairs.length} pairs this is a small sample.`,
      '',
    );
    for (const variant of ['basic', 'swap'] as const) {
      const left = runs.filter((r) => r.cell === cells[0] && r.variant === variant).map((r) => r.score.headline);
      const right = runs.filter((r) => r.cell === cells[1] && r.variant === variant).map((r) => r.score.headline);
      if (!left.length || !right.length) continue;
      const test = meanPermutation(left, right);
      lines.push(
        `${variant}: permutation test on the difference of means (${left.length} vs ${right.length} runs, ${test.exact ? `all ${test.splits} splits` : `${test.splits} seeded random splits`}): ` +
          `difference ${fmt(test.observed)} pairs, two-sided p = ${test.pValue.toFixed(3)}.`,
      );
    }
    lines.push('');
  }
  const slots = runs.map((r) => r.forkSlot);
  const commits = [...new Set(runs.map((r) => r.identities.commit.slice(0, 7)))];
  if (runs.length)
    lines.push(
      `Fork slots ${Math.min(...slots)}..${Math.max(...slots)} (fresh Surfpool 0.10.4 mainnet fork per run, as in the gym run; accounts are fetched lazily, so DeFi state moves between runs). Commit(s): ${commits.join(', ')}.`,
      '',
    );
  const truncated = all.filter(isTruncated);
  if (truncated.length)
    lines.push(
      `Truncated, not a score (ended on a provider or harness error; left out of every table and the paired test; raw headline in brackets): ${truncated.map((r) => `${r.cell} ${r.variant} run ${r.runIndex} (${r.reason}, ${r.score.submissions} submissions, headline ${r.score.headline})`).join('; ')}.`,
      '',
    );
  const paused = all.filter(isPaused);
  if (paused.length)
    lines.push(
      `${paused.length} run(s) paused (usage limit, or an OMS infra ending before any submission) are not counted: ${paused.map((r) => `${r.cell} ${r.variant} run ${r.runIndex} (${r.reason})`).join('; ')}.`,
      '',
    );
  for (const r of all.filter((r) => r.usd !== undefined))
    lines.push(
      `API usage (including set-aside attempts): ${r.cell} ${r.variant} run ${r.runIndex}: USD ${r.usd!.toFixed(8)}, billing upper ${(r.billingUpperUsd ?? r.usd)!.toFixed(8)}, fork failures ${r.forkFailures ?? 0}.`,
    );
  return lines.join('\n');
}
