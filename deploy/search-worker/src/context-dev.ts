import type { Hit } from './fusion.ts';
import { readCapped, type Page } from './fetch-guard.ts';

/** The backend name in `answered`, `backends` and `attempts`; dot-free so the OMS client keeps it in run records. */
export const CONTEXT_DEV = 'contextdev';
const API = 'https://api.context.dev/v1';
const DEFAULT_RETRY_AFTER_MS = 60_000;
/** Largest upstream JSON body read. */
const RESPONSE_BYTE_LIMIT = 4_000_000;
/** Results asked for on every search; answers are cached for any `count` (as the old service fused its top 20). */
export const SEARCH_RESULTS = 20;

export type Outcome<T> =
  | { ok: true; value: T; credits: number }
  /**
   * `error` is a short, upstream-free description. `unavailable` marks a 402, 429, 5xx or unreachable upstream;
   * `pauseMs` is set when it asked us to back off (429, 402, or any Retry-After).
   */
  | { ok: false; error: string; unavailable: boolean; pauseMs?: number; credits: number };

/** Retry-After as delta-seconds or an HTTP date; absent or unreadable means 60 s. */
export function retryAfterMs(header: string | null, now: number): number {
  if (!header?.trim()) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, date - now);
}

export interface ContextDevConfig {
  apiKey: string;
  zdr: boolean;
  fetch: typeof fetch;
  now: () => number;
}

const creditsOf = (response: Response) => Number(response.headers.get('x-credits-used')) || 0;
const fail = (error: string, credits: number, unavailable = false, pauseMs?: number) =>
  ({ ok: false, error, unavailable, credits, ...(pauseMs === undefined ? {} : { pauseMs }) }) as const;

async function call(
  config: ContextDevConfig,
  path: string,
  body: object,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Outcome<any>> {
  let response: Response;
  try {
    response = await config.fetch(`${API}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, ...(config.zdr ? { zdr: 'enabled' } : {}) }),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
  } catch (error) {
    return fail(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable', 0, true);
  }
  // Error bodies are never read or echoed.
  if (response.status === 429 || response.status === 402 || response.status >= 500) {
    const header = response.headers.get('retry-after');
    void response.body?.cancel().catch(() => {});
    const pause = response.status < 500 || header ? retryAfterMs(header, config.now()) : undefined;
    return fail(`HTTP ${response.status}`, creditsOf(response), true, pause);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    return fail(`HTTP ${response.status}`, creditsOf(response));
  }
  let bytes: Uint8Array;
  let truncated: boolean;
  try {
    ({ bytes, truncated } = await readCapped(response, RESPONSE_BYTE_LIMIT));
  } catch {
    return fail('unreachable', creditsOf(response), true);
  }
  if (truncated) return fail('response too large', creditsOf(response));
  let parsed: any;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return fail('unreadable response', creditsOf(response));
  }
  const credits = Number(parsed?.key_metadata?.credits_consumed ?? response.headers.get('x-credits-used')) || 0;
  return { ok: true, value: parsed, credits };
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** Ranked hits, best first. */
export async function contextDevSearch(
  config: ContextDevConfig,
  query: string,
  signal?: AbortSignal,
): Promise<Outcome<Hit[]>> {
  const outcome = await call(config, '/web/search', { query, numResults: SEARCH_RESULTS }, 12_000, signal);
  if (!outcome.ok) return outcome;
  const results: any[] = Array.isArray(outcome.value?.results) ? outcome.value.results : [];
  const hits = results
    .filter((r) => typeof r?.url === 'string')
    .map((r) => ({ title: str(r.title), url: r.url as string, snippet: str(r.description) }));
  return { ok: true, value: hits, credits: outcome.credits };
}

/** Main-content Markdown of one page. */
export async function contextDevScrape(
  config: ContextDevConfig,
  url: string,
  signal?: AbortSignal,
): Promise<Outcome<Page>> {
  const outcome = await call(
    config,
    '/web/scrape',
    {
      url,
      formats: { markdown: true },
      sharedParams: { mainContentOnly: true },
      timeoutOpts: { milliseconds: 8_000 },
    },
    10_000,
    signal,
  );
  if (!outcome.ok) return outcome;
  const markdown = outcome.value?.markdown;
  if (markdown?.success !== true || typeof markdown.data !== 'string') {
    const code = /^[a-z_]{1,40}$/i.exec(str(markdown?.error_code))?.[0]?.toLowerCase() ?? 'unknown';
    return fail(`no page (${code})`, outcome.credits);
  }
  return {
    ok: true,
    credits: outcome.credits,
    value: {
      finalUrl: str(outcome.value.url) || url,
      title: str(outcome.value.metadata?.title),
      text: markdown.data,
      truncated: false,
    },
  };
}
