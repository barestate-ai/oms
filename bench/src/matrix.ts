import { catalogThinking, type ContenderModel, type Rates } from './contenders.ts';
import { BLEND_MODELS } from './blend-router.ts';

/**
 * The Solana Bench cells, each a whole harness as shipped, run online on a subscription login:
 * `oms3-web` (OMS on GPT-6.1 Sol through the Codex subscription, or on Claude Opus through Claude Code), `codex-web` (Codex CLI)
 * and `claude-code-web` (Claude Code).
 */
export const HARNESSES = ['oms3', 'codex', 'claude-code'] as const;
export type Harness = (typeof HARNESSES)[number];

const free: Rates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const sub = (
  provider: string,
  id: string,
  contextWindow: number,
  api: ContenderModel['api'] = 'openai-responses',
): ContenderModel => ({
  provider,
  id,
  name: id,
  api,
  ...catalogThinking(provider, id),
  contextWindow,
  maxTokens: 128_000,
  cost: free,
});

/** Models served on a subscription login, by harness. Cost is reported as "subscription", with token counts from the CLI or run record. */
export const SUBSCRIPTION_MODELS: Record<Harness, Record<string, ContenderModel>> = {
  // OMS signs in to the ChatGPT subscription through pi's `openai-codex` provider.
  oms3: {
    'gpt-sol': sub('openai-codex', 'gpt-6.1-sol', 272_000),
    // OMS drives the installed Claude Code CLI as its model (provider `claude-code`, alias `opus` = Claude Opus 5.5).
    // Subscription serves the standard 200k window; 1M needs a `[1m]` opt-in the connector does not send.
    'opus-sub': sub('claude-code', 'opus', 200_000, 'anthropic-messages'),
    'fable-sub': sub('claude-code', 'fable', 200_000, 'anthropic-messages'),
  },
  codex: { 'gpt-sol': sub('openai', 'gpt-6.1-sol', 272_000) },
  'claude-code': {
    'opus-sub': sub('anthropic', 'claude-opus-5-5', 1_000_000, 'anthropic-messages'),
    'fable-sub': sub('anthropic', 'claude-fable-5-2', 1_000_000, 'anthropic-messages'),
  },
};

export type OnlineLabel = 'web + Solana MCP' | 'web: search + fetch';
/** Every published cell is online: its own web search and fetch plus the official Solana MCP. */
const ONLINE: Record<string, OnlineLabel> = {
  'codex-web:gpt-sol': 'web + Solana MCP',
  'oms3-web:gpt-sol': 'web + Solana MCP',
  'oms3-web:opus-sub': 'web + Solana MCP',
  'claude-code-web:opus-sub': 'web + Solana MCP',
  'claude-code-web:fable-sub': 'web + Solana MCP',
};

/** `oms3-web:gpt-sol` -> harness `oms3`, model key `gpt-sol`, online label. Anything else is not a cell. */
export function parseContender(
  id: string,
): { harness: Harness; modelKey: string; online: OnlineLabel | undefined } | null {
  if (id.startsWith('oms3-web:blend/') && Object.hasOwn(BLEND_MODELS, id.slice('oms3-web:blend/'.length)))
    return { harness: 'oms3', modelKey: id.slice('oms3-web:'.length), online: 'web: search + fetch' };
  if (id.startsWith('oms3:blend/') && Object.hasOwn(BLEND_MODELS, id.slice('oms3:blend/'.length)))
    return { harness: 'oms3', modelKey: id.slice(6), online: undefined };
  const online = ONLINE[id];
  if (!online) return null;
  const at = id.indexOf(':');
  return { harness: id.slice(0, at).replace(/-web$/, '') as Harness, modelKey: id.slice(at + 1), online };
}
