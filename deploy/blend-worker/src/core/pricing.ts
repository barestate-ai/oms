import type { Provider, Usage } from './types.ts';

type Rates = { input: number; output: number; cached: number };
type Spec = { provider: Provider; rates: Rates; high?: Rates; threshold?: number; inclusive?: boolean; peak?: boolean };
const rates = (input: number, output: number, cached: number): Rates => ({ input, output, cached });

// 2026-11-20 models.md: Go list accounting, not PAYG nor usage.cost=0.
export const MODELS: Record<string, Spec> = {
  'claude-fable-5-2': { provider: 'anthropic', rates: rates(8, 40, 0.2) },
  'claude-opus-5-5': { provider: 'anthropic', rates: rates(4, 20, 0.2) },
  'claude-sonnet-5-5': { provider: 'anthropic', rates: rates(2, 10, 0.1) },
  'claude-haiku-5-5': {
    provider: 'anthropic',
    rates: rates(0.1, 0.5, 0.01),
    high: rates(0.5, 2.5, 0.05),
    threshold: 100000,
  },
  'grok-4.7': { provider: 'xai', rates: rates(2, 6, 0.5), high: rates(4, 12, 1), threshold: 200000, inclusive: true },
  'grok-4.3': {
    provider: 'xai',
    rates: rates(1.25, 2.5, 0.2),
    high: rates(2.5, 5, 0.4),
    threshold: 200000,
    inclusive: true,
  },
  'deepseek-v4-pro': { provider: 'opencode-go', rates: rates(0.66, 1.98, 0.022), peak: true },
  'deepseek-v4.1-flash': { provider: 'opencode-go', rates: rates(0.15, 0.6, 0.003), peak: true },
  'mimo-v2.6-pro': { provider: 'opencode-go', rates: rates(0.435, 0.87, 0.003625) },
  'mimo-v2.6-flash': { provider: 'opencode-go', rates: rates(0.14, 0.28, 0.0028) },
  'qwen3.8-flash': { provider: 'opencode-go', rates: rates(0.15, 0.47, 0.016) },
  'muse-wonder-1.0': { provider: 'muse', rates: rates(4, 20, 0.2) },
  'muse-spark-1.3': { provider: 'muse', rates: rates(1.25, 4.25, 0.15) },
  'muse-spark-1.3-contributor': { provider: 'muse', rates: rates(0.1, 0.2, 0.002) },
  'muse-ember-1.0': {
    provider: 'muse',
    rates: rates(0.1, 0.5, 0.004),
    high: rates(0.3, 1.5, 0.012),
    threshold: 200000,
  },
};

export function modelSpec(model: string): Spec {
  if (!Object.hasOwn(MODELS, model)) throw new Error('Unknown upstream model');
  return MODELS[model]!;
}

export function costUsd(model: string, usage: Usage, at: number): number {
  const spec = modelSpec(model);
  for (const value of Object.values(usage))
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid usage');
  if (usage.cached + usage.cacheWrite > usage.input) throw new Error('Invalid cached usage');
  const high =
    spec.threshold !== undefined && (spec.inclusive ? usage.input >= spec.threshold : usage.input > spec.threshold);
  const price = high ? spec.high! : spec.rates;
  const date = new Date(at);
  const hour = date.getUTCHours();
  const weekday = date.getUTCDay() >= 1 && date.getUTCDay() <= 5;
  const multiplier = spec.peak && weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)) ? 2 : 1;
  return (
    (multiplier *
      ((usage.input - usage.cached - usage.cacheWrite) * price.input +
        usage.cached * price.cached +
        usage.cacheWrite * price.input * 1.25 +
        usage.output * price.output)) /
    1e6
  );
}
