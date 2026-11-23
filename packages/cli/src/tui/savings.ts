import { MODEL_CATALOG, type TokenRates } from '@oms/core/catalog';

/**
 * The OMS receipt: what a finished task would have cost in the model's own command-line harness, estimated from the
 * published benchmark. Input tokens per solved task on the Oh My Sol fresh Solana tasks (README "Fresh Solana tasks";
 * barestate-home src/data/benchmarks.ts). Models outside this table never get a comparison.
 */
const BENCHMARK: Readonly<
  Record<string, { name: string; rival: string; oms: number; rivalTokens: number; omsPass: number; rivalPass: number }>
> = {
  'gpt-6.1-sol': {
    name: 'GPT-6.1 Sol',
    rival: 'Codex CLI',
    oms: 134_945,
    rivalTokens: 230_696,
    omsPass: 96,
    rivalPass: 76,
  },
  'gpt-6-astra': {
    name: 'GPT-6 Astra',
    rival: 'Codex CLI',
    oms: 131_487,
    rivalTokens: 267_644,
    omsPass: 92,
    rivalPass: 71,
  },
  'claude-opus-5-5': {
    name: 'Opus 5.5',
    rival: 'Claude Code',
    oms: 183_079,
    rivalTokens: 475_987,
    omsPass: 92,
    rivalPass: 79,
  },
  'claude-sonnet-5-5': {
    name: 'Sonnet 5.5',
    rival: 'Claude Code',
    oms: 198_726,
    rivalTokens: 488_286,
    omsPass: 71,
    rivalPass: 46,
  },
};

export const BENCHMARK_URL = 'barestate.xyz/oh-my-sol';
/** A turn with less input than this was a question, not a task. */
export const TASK_INPUT_TOKENS = 20_000;
/** The receipt shows on the first task, again on this one, then only when the running total crosses a milestone. */
const REPEAT_AT_TASK = 5;
const MILESTONES = [1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000];

/** One model's usage over a turn, as the provider reported it. */
export interface TurnUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The running total, kept across launches. */
export interface SavingsState {
  tasks: number;
  keptTokens: number;
  keptMicroUsd: number;
  off?: true;
}

export interface Receipt {
  kind: 'first' | 'repeat' | 'milestone';
  model: string;
  rival: string;
  /** Rival input tokens over OMS input tokens on the benchmark. */
  ratio: number;
  omsPass: number;
  rivalPass: number;
  inputTokens: number;
  rivalTokens: number;
  percent: number;
  /** At API list prices; absent when the model has no catalog price. */
  omsMicroUsd?: number;
  rivalMicroUsd?: number;
  total: SavingsState;
  milestone?: number;
}

export const emptySavings = (): SavingsState => ({ tasks: 0, keptTokens: 0, keptMicroUsd: 0 });

/** The native Claude Code adapter names its models 'opus' and 'sonnet'. */
const canonical = (model: string): string => (/^(opus|sonnet|haiku)$/.test(model) ? `claude-${model}-5-5` : model);

function rates(model: string): TokenRates | undefined {
  return Object.values(MODEL_CATALOG).find((spec) => spec.modelId === model)?.cost;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

interface Estimate {
  bench: (typeof BENCHMARK)[string];
  inputTokens: number;
  rivalTokens: number;
  omsMicroUsd: number | undefined;
  keptMicroUsd: number | undefined;
}

/** The turn on benchmarked models only, labelled by the model that read the most. */
function estimate(usage: readonly TurnUsage[]): Estimate | undefined {
  let primary: { input: number; bench: Estimate['bench'] } | undefined;
  let inputTokens = 0;
  let rivalTokens = 0;
  let omsMicroUsd: number | undefined = 0;
  let keptMicroUsd: number | undefined = 0;
  for (const turn of usage) {
    const model = canonical(turn.model);
    const bench = BENCHMARK[model];
    if (!bench) continue;
    const ratio = bench.rivalTokens / bench.oms;
    const input = count(turn.input) + count(turn.cacheRead) + count(turn.cacheWrite);
    inputTokens += input;
    rivalTokens += Math.round(input * ratio);
    if (!primary || input > primary.input) primary = { input, bench };
    const rate = rates(model);
    if (!rate || omsMicroUsd === undefined || keptMicroUsd === undefined) {
      omsMicroUsd = keptMicroUsd = undefined;
      continue;
    }
    // USD per million tokens is micro-USD per token.
    const inputCost =
      rate.input * count(turn.input) +
      rate.cacheRead * count(turn.cacheRead) +
      (rate.cacheWrite ?? rate.input) * count(turn.cacheWrite);
    omsMicroUsd += inputCost + rate.output * count(turn.output);
    keptMicroUsd += inputCost * (ratio - 1);
  }
  if (!primary || inputTokens === 0) return undefined;
  return { bench: primary.bench, inputTokens, rivalTokens, omsMicroUsd, keptMicroUsd };
}

/** Add a settled turn to the running total, and say whether this is a turn that shows the receipt. */
export function recordTurn(
  state: SavingsState,
  usage: readonly TurnUsage[],
): { state: SavingsState; receipt?: Receipt } {
  const found = estimate(usage);
  if (!found || found.inputTokens < TASK_INPUT_TOKENS) return { state };
  const kept = found.rivalTokens - found.inputTokens;
  const next: SavingsState = {
    ...state,
    tasks: state.tasks + 1,
    keptTokens: state.keptTokens + kept,
    keptMicroUsd: state.keptMicroUsd + Math.round(found.keptMicroUsd ?? 0),
  };
  if (state.off) return { state: next };
  const milestone = MILESTONES.findLast((mark) => state.keptTokens < mark && next.keptTokens >= mark);
  const kind =
    next.tasks === 1 ? 'first' : next.tasks === REPEAT_AT_TASK ? 'repeat' : milestone ? 'milestone' : undefined;
  if (!kind) return { state: next };
  const { bench } = found;
  return {
    state: next,
    receipt: {
      kind,
      model: bench.name,
      rival: bench.rival,
      ratio: bench.rivalTokens / bench.oms,
      omsPass: bench.omsPass,
      rivalPass: bench.rivalPass,
      inputTokens: found.inputTokens,
      rivalTokens: found.rivalTokens,
      percent: Math.round((100 * kept) / found.rivalTokens),
      ...(found.omsMicroUsd === undefined || found.keptMicroUsd === undefined
        ? {}
        : {
            omsMicroUsd: Math.round(found.omsMicroUsd),
            rivalMicroUsd: Math.round(found.omsMicroUsd + found.keptMicroUsd),
          }),
      total: next,
      ...(milestone ? { milestone } : {}),
    },
  };
}

/** '$0.41', '<$0.01'. */
export function dollars(microUsd: number): string {
  if (microUsd > 0 && microUsd < 10_000) return '<$0.01';
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

/** A saved running total, or undefined for anything malformed. */
export function parseSavings(value: unknown): SavingsState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { tasks, keptTokens, keptMicroUsd, off } = value as Record<string, unknown>;
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!whole(tasks) || !whole(keptTokens) || !whole(keptMicroUsd)) return undefined;
  return { tasks, keptTokens, keptMicroUsd, ...(off === true ? { off: true as const } : {}) };
}

/** What /savings says. */
export function savingsSummary(state: SavingsState): string {
  const models = Object.values(BENCHMARK)
    .map((bench) => `${bench.name} vs ${bench.rival}`)
    .join(', ');
  const tally =
    state.tasks === 0
      ? 'No finished tasks on a benchmarked model yet.'
      : `~${(state.keptTokens / 1_000_000).toFixed(2)}M input tokens${state.keptMicroUsd > 0 ? ` (~${dollars(state.keptMicroUsd)} at API list prices)` : ''} kept over ${state.tasks} ${state.tasks === 1 ? 'task' : 'tasks'}, estimated.`;
  return [
    tally,
    `Compared with the same model in its own lab's harness, at the input-token ratio measured on Oh My Sol's fresh Solana tasks: ${models}. Other models are not compared. ${BENCHMARK_URL}`,
    `Receipts ${state.off ? 'off · /savings on' : 'on · /savings off'}`,
  ].join('\n');
}
