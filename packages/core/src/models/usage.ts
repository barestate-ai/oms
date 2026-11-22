import type { Api, Model, ModelCostRates, Usage } from '@earendil-works/pi-ai';
import { MODEL_CATALOG, MIMO_BINDINGS, type WorkerSpec } from './catalog.ts';
const supportedApis: Record<string, true> = {
  'openai-completions': true,
  'openai-responses': true,
  'anthropic-messages': true,
  'openai-codex-responses': true,
};
const costFields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function priced(rates: ModelCostRates): boolean {
  return (
    rates != null &&
    costFields.every((field) => Number.isFinite(rates[field]) && rates[field] >= 0) &&
    rates.input > 0 &&
    rates.output > 0
  );
}
function pricingKnown(model: Model<Api>): boolean {
  return priced(model.cost) && (model.cost.tiers ?? []).every((tier) => count(tier.inputTokensAbove) && priced(tier));
}

const curated = Object.values(MODEL_CATALOG);

/** This route is implemented by OMS's subscription-only native Claude Code adapter. */
export function isClaudeCodeModel(model: Model<Api>): boolean {
  return (
    model.provider === 'claude-code' &&
    model.api === 'claude-code' &&
    model.baseUrl === 'claude-code://local' &&
    ['sonnet', 'opus', 'haiku'].includes(model.id)
  );
}

function curatedSpec(model: Model<Api>): WorkerSpec | undefined {
  return curated.find(
    (spec) =>
      spec.modelId === model.id &&
      spec.api === model.api &&
      ((spec.provider === model.provider && spec.baseUrl === model.baseUrl) ||
        (spec.provider === 'xiaomi' &&
          Object.entries(MIMO_BINDINGS).some(
            ([provider, binding]) => provider === model.provider && binding.baseUrl === model.baseUrl,
          ))),
  );
}

/** Pi input/cache fields are disjoint; reasoning and cacheWrite1h are subsets, not extra tokens.
 * Prices are USD/million tokens, numerically identical to micro-USD/token. Cache support cannot be
 * inferred from zero normalized cache fields, so no measured cache-hit ratio is asserted here.
 */
export function normalizePiUsage(
  model: Model<Api>,
  usage: Usage,
): {
  tokens: number;
  spendMicroUsd: number;
} | null {
  if (!pricingKnown(model) || !usage || !costFields.every((field) => count(usage[field]))) return null;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const tokens = inputTokens + usage.output;
  if (
    !count(tokens) ||
    tokens === 0 ||
    usage.totalTokens !== tokens ||
    (usage.reasoning !== undefined && (!count(usage.reasoning) || usage.reasoning > usage.output)) ||
    (usage.cacheWrite1h !== undefined && (!count(usage.cacheWrite1h) || usage.cacheWrite1h > usage.cacheWrite))
  )
    return null;
  let rates: ModelCostRates = model.cost;
  let threshold = -1;
  for (const tier of model.cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      rates = tier;
      threshold = tier.inputTokensAbove;
    }
  }
  // Same partition/tier rule as Pi calculateCost, avoiding dollar round-trips before integer rounding.
  const longWrite = usage.cacheWrite1h ?? 0;
  const spec = curatedSpec(model);
  if (
    Object.keys(usage).some((key) => key.startsWith('cacheWrite') && key !== 'cacheWrite' && key !== 'cacheWrite1h') ||
    (spec && usage.cacheWrite > 0 && spec.cachePolicy.write === 'unsupported') ||
    (spec && longWrite > 0 && !spec.cachePolicy.writeTtlSeconds.includes(3600)) ||
    (usage.cacheRead > 0 && rates.cacheRead === 0) ||
    (usage.cacheWrite > longWrite && rates.cacheWrite === 0 && spec?.cachePolicy.write !== 'temporary-free')
  )
    return null;
  const calculated =
    rates.input * usage.input +
    rates.output * usage.output +
    rates.cacheRead * usage.cacheRead +
    rates.cacheWrite * (usage.cacheWrite - longWrite) +
    rates.input * 2 * longWrite;
  const reported = usage.cost?.total;
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) return null;
  const spendMicroUsd = Math.ceil(Math.max(calculated, reported * 1_000_000));
  return count(spendMicroUsd) ? { tokens, spendMicroUsd } : null;
}

/** The output cap a request to this model carries: the session cap lowered to the model's own maximum, never raised. */
export const modelOutputCap = (model: Model<Api>, maxOutputTokens: number): number =>
  Math.min(maxOutputTokens, model.maxTokens);

export function modelReservationBound(
  model: Model<Api>,
  sessionMaxOutputTokens: number,
  inputBound?: number,
): { tokens: number; spendMicroUsd: number } | null {
  if (
    !count(sessionMaxOutputTokens) ||
    sessionMaxOutputTokens === 0 ||
    (supportedApis[model.api] !== true && !isClaudeCodeModel(model)) ||
    !pricingKnown(model) ||
    !count(model.contextWindow) ||
    model.contextWindow === 0 ||
    !count(model.maxTokens) ||
    model.maxTokens === 0
  )
    return null;
  const maxOutputTokens = modelOutputCap(model, sessionMaxOutputTokens);
  if (maxOutputTokens > model.contextWindow) return null;
  const rates = [model.cost, ...(model.cost.tiers ?? [])];
  // Native Codex and Claude Code do not accept a reliable client output cap. Reserve their entire catalog output capacity.
  // Subscription spend is a conservative catalog-equivalent bound, not an invoice or free usage.
  const outputTokens =
    model.api === 'openai-codex-responses' || isClaudeCodeModel(model) ? model.maxTokens : maxOutputTokens;
  if (outputTokens === 0 || outputTokens > model.contextWindow) return null;
  // `inputBound` is the caller-proven upper bound on provider-visible input (e.g. the
  // measured transcript the payload hook holds the serialized request to). It may be lower
  // than the model window but never replaces it as the provider limit.
  const inputTokens = inputBound === undefined ? model.contextWindow : Math.min(inputBound, model.contextWindow);
  if (!count(inputTokens) || inputTokens === 0) return null;
  // Full context capacity, not a tokenizer guess. This includes long-cache writes.
  const inputRate = Math.max(...rates.flatMap((rate) => [rate.input, rate.cacheRead, rate.cacheWrite, rate.input * 2]));
  const outputRate = Math.max(...rates.map((rate) => rate.output));
  const tokens = inputTokens + outputTokens;
  const spendMicroUsd = Math.ceil(inputTokens * inputRate + outputTokens * outputRate);
  return count(tokens) && count(spendMicroUsd) ? { tokens, spendMicroUsd } : null;
}

/** Invoked after payload hooks, on upstream OpenAI requests. */
export function enforceCachePolicy(model: Model<Api>, body: Record<string, unknown>): void {
  if (model.provider !== 'openai' || model.api !== 'openai-responses') return;
  const cache = body.prompt_cache_options;
  if (
    cache !== undefined &&
    (!cache || typeof cache !== 'object' || Array.isArray(cache) || ('ttl' in cache && cache.ttl !== '30m'))
  )
    throw new Error('Unsupported OpenAI cache lifetime');
  const visit = (value: unknown, depth: number): void => {
    if (depth > 32) throw new Error('Cache payload nesting exceeds supported depth');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (
        key === 'prompt_cache_breakpoint' &&
        (!child || typeof child !== 'object' || Array.isArray(child) || ('ttl' in child && child.ttl !== '30m'))
      )
        throw new Error('Unsupported OpenAI cache breakpoint lifetime');
      visit(child, depth + 1);
    }
  };
  visit(body, 0);
  body.prompt_cache_options = { ...(cache as Record<string, unknown> | undefined), ttl: '30m' };
}
