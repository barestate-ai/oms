import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fetchMcpText, wrapUntrusted } from './knowledge-service.ts';
import { createSourceFetch, SOURCE_LIMITS, type SourceLimits } from './source-fetch.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Web access for normal OMS sessions: web_search (BYOK backends), web_fetch and the official Solana MCP doc tools.
 * Runs in the trusted host process, never in the sandbox. Keys come from the user's own environment and never enter
 * a prompt or tool result. Everything returned is capped and framed as untrusted. Bench cells never construct this.
 */
export interface WebConfig {
  /** Initial state; `/web on|off` flips it for the session. */
  enabled: boolean;
  /** Where BYOK keys are read; defaults to the host process environment. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** DNS resolver for web_fetch's private-address check (tests inject one). */
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  now?: () => number;
  /** Where source_fetch extracts archives: readable by the agent's commands, outside the task's code root. Defaults to a folder under the OS temp directory. */
  sourcesDir?: string;
  sourceLimits?: Partial<SourceLimits>;
  solanaMcpUrl?: string;
  /** The signed-in OMS account, if any: without OMS_SEARCH_URL/OMS_SEARCH_TOKEN the oms backend uses its gateway route. */
  account?: () => { origin: string; token: string } | undefined;
}
/**
 * Call counts, plus the backend that answered each successful web_search / web_fetch. An oms-search answer is named by
 * the backends the service says answered, e.g. "oms:searxng+tinyfish", so a run record shows what "OMS search" was.
 */
export interface WebUsage {
  webSearch: number;
  webFetch: number;
  solanaMcp: number;
  searchBy: Record<string, number>;
  fetchBy: Record<string, number>;
}
export interface WebControls {
  extension: ExtensionFactory;
  toolNames: string[];
  enabled(): boolean;
  setEnabled(on: boolean): void;
  usage(): WebUsage;
}

export const WEB_RESULT_LIMIT = 16_000;
const WEB_FETCH_BYTE_LIMIT = 2_000_000;
const WEB_TIMEOUT_MS = 20_000;
const SOURCE_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
/** web_fetch pages resent to the model in full; at 16,000 bytes each, 3 keep a session inside the bench's 131,072-byte input cap. */
const WEB_FETCH_KEPT = 3;
/** Pages web_fetch returns per user message (refused or failed fetches do not count); headless sends one message per progress step, so there it is per step. Passing bench runs read at most 7; a runaway search read 49 and hit the input cap. */
const WEB_FETCH_BUDGET = 12;

type ContextMessage = { role?: string; toolName?: string; toolCallId?: string; content?: unknown };
/**
 * What the model sees of past web_fetch pages: the newest WEB_FETCH_KEPT in full, older ones as a one-line stub naming
 * the URL (fetch again to reread). Applied per model call only; the session transcript keeps every page.
 */
export function elideOldFetches<M extends ContextMessage>(messages: M[]): M[] {
  const fetches = messages.flatMap((m, i) => (m.role === 'toolResult' && m.toolName === 'web_fetch' ? [i] : []));
  if (fetches.length <= WEB_FETCH_KEPT) return messages;
  const urls = new Map<string, string>();
  for (const m of messages)
    if (m.role === 'assistant' && Array.isArray(m.content))
      for (const block of m.content)
        if (block?.type === 'toolCall' && typeof block.arguments?.url === 'string')
          urls.set(block.id, block.arguments.url);
  const old = new Set(fetches.slice(0, -WEB_FETCH_KEPT));
  return messages.map((m, i) =>
    !old.has(i)
      ? m
      : {
          ...m,
          content: [
            {
              type: 'text',
              text: `[earlier web_fetch of ${urls.get(m.toolCallId ?? '') ?? 'a page'} removed to fit the context limit; call web_fetch again to reread it]`,
            },
          ],
        },
  );
}
export const SOLANA_MCP_URL = 'https://mcp.solana.com/mcp';

export { WEB_PROMPT, WEB_PROMPT_NO_KNOWLEDGE } from './system-prompt.ts';

interface Hit {
  title: string;
  url: string;
  snippet: string;
}
interface Backend {
  name: string;
  key: string;
  request(key: string, query: string, count: number, base?: string): { url: string; init: RequestInit };
  parse(body: any): Hit[];
  /** Label for the usage record; defaults to the backend name. */
  label?(body: any): string;
  /** Failure line for statuses this backend answers differently; consumes the body when it answers. */
  refusal?(response: Response): Promise<string | undefined>;
}
const json = (headers: Record<string, string>, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
/** "oms:searxng+tinyfish" from oms-search's `answered`; names outside a short lowercase vocabulary are dropped. */
const omsLabel = (answered: unknown) =>
  `oms:${
    Array.isArray(answered)
      ? answered
          .filter((name) => typeof name === 'string' && /^[a-z]{1,20}$/.test(name))
          .slice(0, 5)
          .join('+')
      : ''
  }`;
const joined = (parts: unknown) =>
  Array.isArray(parts) ? parts.filter((part) => typeof part === 'string').join(' … ') : '';

/** Selection order: OMS's own oms-search first, then BYOK. Request shapes from each provider's API reference (links in CHANGELOG / progress notes). */
export const SEARCH_BACKENDS: Backend[] = [
  // oms-search (packages/search-service): SearXNG + Firecrawl + TinyFish fused server-side, same bearer scheme as the knowledge service.
  // base: OMS_SEARCH_URL (https: or loopback http:), else the signed-in account's gateway route; see omsEndpoint.
  {
    name: 'oms',
    key: 'OMS_SEARCH_TOKEN',
    request: (key, query, count, base) => ({
      url: `${base}/search`,
      init: json({ authorization: `Bearer ${key}` }, { query, count }),
    }),
    parse: (body) =>
      (body?.results ?? []).map((r: any) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.snippet ?? '' })),
    label: (body) => omsLabel(body?.answered),
    // A 402 is a refusal, not a rate limit: say hosted search is out and keep falling through to BYOK backends.
    refusal: async (response) => (response.status === 402 ? paywallText(await paywallDetails(response)) : undefined),
  },
  {
    name: 'exa',
    key: 'EXA_API_KEY',
    request: (key, query, count) => ({
      url: 'https://api.exa.ai/search',
      init: json({ 'x-api-key': key }, { query, numResults: count, contents: { highlights: true } }),
    }),
    parse: (body) =>
      (body?.results ?? []).map((r: any) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: joined(r.highlights) || (r.text ?? ''),
      })),
  },
  {
    name: 'firecrawl',
    key: 'FIRECRAWL_API_KEY',
    request: (key, query, count) => ({
      url: 'https://api.firecrawl.dev/v2/search',
      init: json({ authorization: `Bearer ${key}` }, { query, limit: count }),
    }),
    parse: (body) =>
      (body?.data?.web ?? []).map((r: any) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.description ?? '',
      })),
  },
  {
    name: 'tavily',
    key: 'TAVILY_API_KEY',
    request: (key, query, count) => ({
      url: 'https://api.tavily.com/search',
      init: json({ authorization: `Bearer ${key}` }, { query, max_results: count }),
    }),
    parse: (body) =>
      (body?.results ?? []).map((r: any) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' })),
  },
  {
    name: 'parallel',
    key: 'PARALLEL_API_KEY',
    request: (key, query, count) => ({
      url: 'https://api.parallel.ai/v1/search',
      init: json(
        { 'x-api-key': key },
        { objective: query, search_queries: [query], advanced_settings: { max_results: count } },
      ),
    }),
    parse: (body) =>
      (body?.results ?? []).map((r: any) => ({ title: r.title ?? '', url: r.url ?? '', snippet: joined(r.excerpts) })),
  },
  // shortcut: TinyFish has no result-count parameter (one page, ~10 results); we slice locally.
  {
    name: 'tinyfish',
    key: 'TINYFISH_API_KEY',
    request: (key, query) => ({
      url: `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`,
      init: { method: 'GET', headers: { 'x-api-key': key } },
    }),
    parse: (body) =>
      (body?.results ?? []).map((r: any) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.snippet ?? '' })),
  },
];

/** Retry-After as delta-seconds or an HTTP date; absent or unreadable means 60 s. */
export function retryAfterMs(header: string | null, now: number): number {
  if (!header?.trim()) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, date - now);
}

const PAYWALL_CODE = /^[A-Z_]{1,64}$/;
const BYOK_SEARCH_KEYS = 'EXA_API_KEY, FIRECRAWL_API_KEY, TAVILY_API_KEY, PARALLEL_API_KEY, TINYFISH_API_KEY';
const UTC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `Dec 1` in UTC from an ms epoch. */
const utcMonthDay = (ms: number) => {
  const date = new Date(ms);
  return `${UTC_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
};

interface PaywallDetails {
  code?: string;
  resetsAt?: number;
  billing?: string;
}

/** `error.billing` counts only as a barestate.xyz https link; any other value is dropped like a bad code. */
const billingUrl = (raw: unknown): raw is string => {
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && (url.hostname === 'barestate.xyz' || url.hostname.endsWith('.barestate.xyz'));
  } catch {
    return false;
  }
};

/**
 * `error.code`, `error.resetsAt` and `error.billing` from an oms 402 body, read with a hard byte cap; each is
 * undefined when the body is oversized, not JSON, or the value fails its shape check. The server's message is
 * never surfaced.
 */
async function paywallDetails(response: Response): Promise<PaywallDetails> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      size += value.byteLength;
      if (size > 4_096) {
        await reader.cancel().catch(() => {});
        return {};
      }
      chunks.push(value);
    }
    reader.releaseLock();
    const error = (
      JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        error?: { code?: unknown; resetsAt?: unknown; billing?: unknown };
      }
    )?.error;
    const resetsAt = error?.resetsAt;
    return {
      ...(typeof error?.code === 'string' && PAYWALL_CODE.test(error.code) ? { code: error.code } : {}),
      ...(typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0 && resetsAt <= 8_640_000_000_000_000
        ? { resetsAt }
        : {}),
      ...(billingUrl(error?.billing) ? { billing: error.billing } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * The failure line a 402 from oms records; only the validated code, resetsAt and billing link pick the text, never
 * the server's message. The advice is always the same two options: a BYOK key, or the billing page the refusal names.
 */
function paywallText({ code, resetsAt, billing }: PaywallDetails): string {
  const advice = `set one of ${BYOK_SEARCH_KEYS}${billing ? ` or go to ${billing}` : ''}`;
  if (code === 'SEARCH_LIMIT_REACHED' && resetsAt !== undefined)
    return `this month's free hosted searches are used up (reset ${utcMonthDay(resetsAt)}) — ${advice} to keep searching`;
  return `hosted search is unavailable for this account — ${advice}`;
}

// Two lists: Node checks IPv4 addresses against IPv4-mapped IPv6 rules, so ::ffff:0:0/96 would block every IPv4 address.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  BLOCKED_V4.addSubnet(net, prefix, 'ipv4');
// IPv4-compatible, IPv4-mapped, NAT64 and 6to4 forms are refused outright rather than unpacked.
for (const [net, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  BLOCKED_V6.addSubnet(net, prefix, 'ipv6');

/** Loopback, RFC 1918, link-local, CGNAT, multicast, reserved and unspecified addresses. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return true;
  return family === 4 ? BLOCKED_V4.check(address, 'ipv4') : BLOCKED_V6.check(address, 'ipv6');
}

/** The only URLs web_fetch accepts: HTTPS, no credentials, and an IP literal must be public. */
function parseFetchUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('web_fetch needs an absolute https:// URL');
  }
  if (url.protocol !== 'https:') throw new Error('web_fetch only fetches https:// URLs');
  if (url.username || url.password) throw new Error('web_fetch refuses URLs with credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host))
    throw new Error('web_fetch refuses private, loopback and link-local addresses');
  return url;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{0,15});/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

// Everything below scans with indexOf, never a lazy or unbounded regex span: hostile markup (thousands of unclosed
// tags) must cost linear time, because this runs on the main thread where the fetch timeout cannot stop it.
/** Removes `<...>` tags; an unclosed `<` and everything after it stays as text. */
function tags(html: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const lt = html.indexOf('<', at);
    const gt = lt < 0 ? -1 : html.indexOf('>', lt);
    if (gt < 0) return out + html.slice(at);
    out += html.slice(at, lt);
    at = gt + 1;
  }
}
// Entities are decoded once, last, so decoded text such as `Vec&lt;u8&gt;` is never mistaken for a tag.
const strip = (html: string) => decode(tags(html));

/** Replaces each `<name ...>inner</name>` with render(inner, openTag). Stops at the first unclosed element. */
function elements(html: string, name: string, render: (inner: string, open: string) => string): string {
  const lower = html.toLowerCase();
  let out = '';
  let at = 0;
  let from = 0;
  for (;;) {
    const lt = lower.indexOf(`<${name}`, from);
    if (lt < 0) break;
    if (!/[\s>/]/.test(lower[lt + name.length + 1] ?? '')) {
      from = lt + 1;
      continue;
    }
    const gt = lower.indexOf('>', lt);
    const close = gt < 0 ? -1 : lower.indexOf(`</${name}`, gt);
    if (close < 0) break;
    const closeGt = lower.indexOf('>', close);
    out += html.slice(at, lt) + render(html.slice(gt + 1, close), html.slice(lt, gt + 1));
    at = from = closeGt < 0 ? html.length : closeGt + 1;
  }
  return out + html.slice(at);
}

/** The outermost `<name>...</name>` span, if the page has one. */
function outer(html: string, name: string): string | undefined {
  const lower = html.toLowerCase();
  const start = lower.indexOf(`<${name}`);
  const end = lower.lastIndexOf(`</${name}>`);
  return start >= 0 && end > start ? html.slice(start, end + name.length + 3) : undefined;
}

/**
 * Readability-style extraction without a dependency: the <article> or <main> body (else <body>), page chrome removed,
 * headings, links, lists, tables and code kept as markdown.
 * shortcut: string scanning, not a DOM; nested same-name elements or odd markup degrade to plain text. Upgrade to @mozilla/readability if quality matters.
 */
export function htmlToMarkdown(html: string, base: string): { title: string; markdown: string } {
  let title = '';
  elements(html, 'title', (inner) => {
    title ||= strip(inner).trim();
    return '';
  });
  const focused = outer(html, 'article') ?? outer(html, 'main');
  let body = focused ?? outer(html, 'body') ?? html;
  let comments = '';
  for (let at = 0; ;) {
    const open = body.indexOf('<!--', at);
    const close = open < 0 ? -1 : body.indexOf('-->', open + 4);
    if (close < 0) {
      body = comments + body.slice(at);
      break;
    }
    comments += body.slice(at, open);
    at = close + 3;
  }
  // A page <header> is chrome; inside an article it usually holds the article's own title.
  for (const name of [
    'script',
    'style',
    'noscript',
    'svg',
    'nav',
    'footer',
    'aside',
    'form',
    'iframe',
    'template',
    ...(focused ? [] : ['header']),
  ]) {
    body = elements(body, name, () => '');
  }
  const blocks: string[] = [];
  body = elements(
    body,
    'pre',
    (code) => `\n\n\u0000${blocks.push('```\n' + strip(code).replace(/\n+$/, '') + '\n```') - 1}\u0000\n\n`,
  );
  for (let level = 1; level <= 6; level++)
    body = elements(body, `h${level}`, (text) => `\n\n${'#'.repeat(level)} ${tags(text).trim()}\n\n`);
  body = elements(body, 'a', (text, open) => {
    const label = tags(text).trim();
    const href = /\shref\s*=\s*["']([^"']{0,2048})["']/i.exec(open)?.[1];
    if (!label || href === undefined) return label;
    let target = href;
    try {
      target = new URL(decode(href), base).href;
    } catch {
      /* keep the raw href */
    }
    return target.startsWith('http') ? `[${label}](${target})` : label;
  });
  body = elements(body, 'code', (code) => '`' + tags(code) + '`')
    .replace(/<li(?=[\s>])/gi, '\n- <li')
    .replace(/<br(?=[\s>/])/gi, '\n<br')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/(p|div|section|ul|ol|table|blockquote|dl|dd|dt)>/gi, '\n\n');
  const markdown = strip(body)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/^- ?$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000(\d+)\u0000/g, (_m, index: string) => blocks[Number(index)]!)
    .trim();
  return { title, markdown };
}

type Lookup = NonNullable<WebConfig['lookup']>;
const systemLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

/** Connection-time check: the address actually dialled must be public, so DNS rebinding cannot slip past. */
function guardedLookup(resolve: Lookup): LookupFunction {
  return (host, options, callback) => {
    resolve(host).then(
      (addresses) => {
        if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
          callback(
            Object.assign(new Error('web_fetch refuses private, loopback and link-local addresses'), {
              code: 'EPRIVATE',
            }),
            '',
            4,
          );
        } else if (options.all) (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error) => callback(error, '', 4),
    );
  };
}

// A private agent: an env-configured proxy (NODE_USE_ENV_PROXY) would resolve hosts itself, past the address check.
const AGENT = new Agent();
interface Page {
  status: number;
  location?: string;
  contentType: string;
  body: string;
  truncated: boolean;
}
function getOnce(url: URL, lookup: LookupFunction, signal: AbortSignal): Promise<Page> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        agent: AGENT,
        lookup,
        signal,
        headers: {
          'user-agent': 'oms-web-fetch/1',
          accept: 'text/html, text/plain, text/markdown, application/json;q=0.9, */*;q=0.1',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > WEB_FETCH_BYTE_LIMIT) {
            chunks.push(chunk.subarray(0, chunk.length - (size - WEB_FETCH_BYTE_LIMIT)));
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            ...(res.headers.location ? { location: res.headers.location } : {}),
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
          });
        res.on('end', done);
        res.on('close', () => {
          if (truncated) done();
        });
        res.on('error', (error) => {
          if (!truncated) reject(error);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function plainFetch(
  start: URL,
  resolve: Lookup,
  signal: AbortSignal,
): Promise<{ url: string; text: string; truncated: boolean }> {
  const lookup = guardedLookup(resolve);
  let url = start;
  for (let hop = 0; hop <= 5; hop++) {
    const page = await getOnce(url, lookup, signal);
    if (page.status >= 300 && page.status < 400 && page.location) {
      url = parseFetchUrl(new URL(page.location, url).href);
      continue;
    }
    if (page.status < 200 || page.status >= 300) throw new Error(`web_fetch got HTTP ${page.status}`);
    if (/html/i.test(page.contentType)) {
      const { title, markdown } = htmlToMarkdown(page.body, url.href);
      return { url: url.href, text: title ? `# ${title}\n\n${markdown}` : markdown, truncated: page.truncated };
    }
    if (/^(text\/|application\/(json|xml|markdown))/i.test(page.contentType) || !page.contentType)
      return { url: url.href, text: page.body, truncated: page.truncated };
    // The server's own Content-Type text is not echoed: it would reach the model outside the untrusted frame.
    throw new Error(
      `web_fetch does not read ${/^[\w.+-]{1,64}\/[\w.+-]{1,64}/.exec(page.contentType)?.[0] ?? 'this'} content`,
    );
  }
  throw new Error('web_fetch stopped after 5 redirects');
}

const SOLANA_TOOLS = [
  {
    name: 'solana_docs_search',
    remote: 'Solana_Documentation_Search',
    label: 'Solana MCP: search docs',
    description:
      'Official Solana MCP (mcp.solana.com): semantic search over the Solana docs corpus. Use for narrow questions.',
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 1_000 }) }),
  },
  {
    name: 'solana_ask',
    remote: 'Solana_Expert__Ask_For_Help',
    label: 'Solana MCP: ask',
    description:
      'Official Solana MCP: ask a Solana how-to or debugging question (answers from the docs). Do not paste secrets or private code.',
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 4_000 }) }),
  },
  {
    name: 'solana_list_sections',
    remote: 'list_sections',
    label: 'Solana MCP: list sections',
    description: 'Official Solana MCP: list the doc sources and sections; call before solana_get_documentation.',
    parameters: Type.Object({}),
  },
  {
    name: 'solana_get_documentation',
    remote: 'get_documentation',
    label: 'Solana MCP: get docs',
    description:
      'Official Solana MCP: fetch full docs for a source id or section id from solana_list_sections (result capped at 16,000 bytes).',
    parameters: Type.Object({ section: Type.Union([Type.String(), Type.Array(Type.String(), { maxItems: 5 })]) }),
  },
] as const;

/** OMS_SEARCH_URL without trailing slashes, only when https: or loopback http:; anything else would send the bearer in clear text. */
export function omsBase(raw: string | undefined): string | undefined {
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    return undefined;
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url.href.replace(/\/+$/, '') : undefined;
}

export function createWeb(config: WebConfig): WebControls {
  const env = config.env ?? process.env;
  const now = config.now ?? Date.now;
  const doFetch = config.fetch ?? fetch;
  const bench = env.OMS_SEARCH_TOKEN && omsBase(env.OMS_SEARCH_URL);
  /** The bench stack when OMS_SEARCH_URL/OMS_SEARCH_TOKEN are set, else the gateway route of the account signed in right now. */
  const omsEndpoint = (): { base: string; token: string } | undefined => {
    if (bench) return { base: bench, token: env.OMS_SEARCH_TOKEN! };
    const account = config.account?.();
    const gateway = account && omsBase(`${account.origin}/search/v1`);
    return gateway ? { base: gateway, token: account.token } : undefined;
  };
  const backends = SEARCH_BACKENDS.filter((backend) =>
    backend.name === 'oms' ? bench || config.account : env[backend.key],
  );
  const blockedUntil = new Map<string, number>();
  const usage: WebUsage = { webSearch: 0, webFetch: 0, solanaMcp: 0, searchBy: {}, fetchBy: {} };
  const note = (tally: Record<string, number>, label: string) => {
    tally[label] = (tally[label] ?? 0) + 1;
  };
  let enabled = config.enabled;
  const guard = () => {
    if (!enabled) throw new Error('Web access is off for this session (/web on turns it back on)');
  };
  const timeout = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(WEB_TIMEOUT_MS)]) : AbortSignal.timeout(WEB_TIMEOUT_MS);

  async function search(query: string, count: number, signal?: AbortSignal): Promise<string> {
    const failures: string[] = [];
    for (const backend of backends) {
      const until = blockedUntil.get(backend.name) ?? 0;
      if (until > now()) {
        failures.push(`${backend.name}: rate limited for ${Math.ceil((until - now()) / 1000)} s`);
        continue;
      }
      const oms = backend.name === 'oms' ? omsEndpoint() : undefined;
      if (backend.name === 'oms' && !oms) {
        failures.push('oms: sign in to OMS (/login)');
        continue;
      }
      const { url, init } = backend.request(oms?.token ?? env[backend.key]!, query, count, oms?.base);
      let response: Response;
      try {
        response = await doFetch(url, { ...init, redirect: 'error', signal: timeout(signal) });
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push(`${backend.name}: unreachable`);
        continue;
      }
      // Bodies of failures are never echoed: a provider error must not carry text past the untrusted frame.
      if (!response.ok) {
        const named = await backend.refusal?.(response);
        if (named === undefined) void response.body?.cancel().catch(() => {});
        if (response.status === 429 || response.status >= 500)
          blockedUntil.set(backend.name, now() + retryAfterMs(response.headers.get('retry-after'), now()));
        failures.push(`${backend.name}: ${named ?? `HTTP ${response.status}`}`);
        continue;
      }
      let hits: Hit[];
      let label: string;
      try {
        const body = await response.json();
        hits = backend.parse(body).slice(0, count);
        label = backend.label?.(body) ?? backend.name;
      } catch {
        failures.push(`${backend.name}: unreadable response`);
        continue;
      }
      note(usage.searchBy, label);
      const text =
        hits
          .map(
            (hit, i) =>
              `${i + 1}. ${hit.title.trim() || '(untitled)'}\n   ${hit.url}\n   ${hit.snippet.replace(/\s+/g, ' ').trim().slice(0, 600)}`,
          )
          .join('\n') || 'No results.';
      return wrapUntrusted(
        'web_search',
        `Results from ${backend.name} for: ${query}\n\n${text}`,
        WEB_RESULT_LIMIT,
        `a web search (${backend.name})`,
      );
    }
    throw new Error(`web_search failed on every configured backend (${failures.join('; ')})`);
  }

  async function firecrawlScrape(url: URL, key: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const response = await doFetch('https://api.firecrawl.dev/v2/scrape', {
        ...json({ authorization: `Bearer ${key}` }, { url: url.href, formats: ['markdown'] }),
        redirect: 'error',
        signal,
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { data?: { markdown?: string; metadata?: { title?: string } } };
      if (typeof body.data?.markdown !== 'string') return undefined;
      return body.data.metadata?.title ? `# ${body.data.metadata.title}\n\n${body.data.markdown}` : body.data.markdown;
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  /** oms-search /fetch (TinyFish -> Firecrawl -> plain, server-side); undefined on any failure so the local path takes over. */
  async function omsFetch(
    url: URL,
    base: string,
    token: string,
    signal: AbortSignal,
  ): Promise<{ text: string; label: string } | undefined> {
    try {
      const response = await doFetch(`${base}/fetch`, {
        ...json({ authorization: `Bearer ${token}` }, { url: url.href }),
        redirect: 'error',
        signal,
      });
      // An error answer carries no `text` (or is not JSON and throws), so it falls through to the local path.
      const body = (await response.json()) as { title?: unknown; text?: unknown; answered?: unknown };
      if (typeof body.text !== 'string') return undefined;
      return {
        text: typeof body.title === 'string' && body.title ? `# ${body.title}\n\n${body.text}` : body.text,
        label: omsLabel(body.answered),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  const resolveHost = config.lookup ?? systemLookup;
  /** Resolves a host and refuses private, loopback and link-local answers. */
  async function assertPublicHost(host: string, tool: string): Promise<void> {
    if (isIP(host)) return;
    const addresses = await resolveHost(host).catch(() => {
      throw new Error(`${tool} could not resolve the host`);
    });
    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address)))
      throw new Error(`${tool} refuses private, loopback and link-local addresses`);
  }
  const sources = createSourceFetch({
    dir: config.sourcesDir ?? join(tmpdir(), 'oms-sources'),
    fetch: doFetch,
    checkHost: (host) => assertPublicHost(host, 'source_fetch'),
    githubToken: env.GITHUB_TOKEN,
    limits: { ...config.sourceLimits },
  });

  async function webFetch(raw: string, signal?: AbortSignal): Promise<string> {
    const url = parseFetchUrl(raw);
    const deadline = timeout(signal);
    await assertPublicHost(url.hostname.replace(/^\[|\]$/g, ''), 'web_fetch');
    const key = env.FIRECRAWL_API_KEY;
    // oms-search, then BYOK Firecrawl, render JS pages from their own servers; any failure falls back to the local guarded fetch.
    const byok = async () => {
      const text = key ? await firecrawlScrape(url, key, deadline) : undefined;
      return text === undefined ? undefined : { text, label: 'firecrawl' };
    };
    const oms = omsEndpoint();
    const scraped = (oms ? await omsFetch(url, oms.base, oms.token, deadline) : undefined) ?? (await byok());
    const page =
      scraped !== undefined
        ? { url: url.href, text: scraped.text, truncated: false }
        : await plainFetch(url, resolveHost, deadline).catch((error) => {
            if (signal?.aborted || (error instanceof Error && error.message.startsWith('web_fetch'))) throw error;
            // Network and TLS errors can carry server-chosen text (certificate names); only a bare code goes to the model.
            const code = (error as { code?: unknown }).code;
            throw new Error(
              `web_fetch could not fetch the page (${typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'network error'})`,
            );
          });
    note(usage.fetchBy, scraped?.label ?? 'plain');
    return wrapUntrusted(
      'web_fetch',
      `Source: ${page.url}${page.truncated ? ' (download cut at 2 MB)' : ''}\n\n${page.text}`,
      WEB_RESULT_LIMIT,
      `a fetched web page (${url.hostname})`,
    );
  }

  const solana = { endpoint: config.solanaMcpUrl ?? SOLANA_MCP_URL, fetch: doFetch, timeoutMs: WEB_TIMEOUT_MS };
  const toolNames = [
    ...(backends.length ? ['web_search'] : []),
    'web_fetch',
    'source_fetch',
    ...SOLANA_TOOLS.map((tool) => tool.name),
  ];
  let pagesThisRequest = 0;
  const extension: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', (event) => {
      if (event.messageType === 'user') {
        pagesThisRequest = 0;
        sources.resetBudget();
      }
    });
    const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], details: undefined });
    if (backends.length)
      pi.registerTool({
        name: 'web_search',
        label: 'Web search',
        description: `Search the web (${backends.map((b) => b.name).join(', ')}; fails over on rate limits). Returns titles, URLs and snippets; read a page with web_fetch.`,
        parameters: Type.Object({
          query: Type.String({ minLength: 1, maxLength: 400 }),
          max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
        }),
        async execute(_id, params, signal) {
          guard();
          usage.webSearch++;
          return text(await search(params.query, params.max_results ?? 5, signal));
        },
      });
    pi.registerTool({
      name: 'web_fetch',
      label: 'Web fetch',
      description:
        'Fetch one public https:// page as markdown (20 s timeout, 16,000-byte result). Private and local addresses are refused.',
      parameters: Type.Object({ url: Type.String({ minLength: 9, maxLength: 2_048 }) }),
      async execute(_id, params, signal) {
        guard();
        usage.webFetch++;
        if (pagesThisRequest >= WEB_FETCH_BUDGET)
          throw new Error(
            `web_fetch budget for this request is used (${WEB_FETCH_BUDGET} pages) and the limit does not reset until the next user message, so further web_fetch calls will keep failing. Use the installed packages in node_modules, the program reference or search instead, or tell the user what is still unknown.`,
          );
        const page = await webFetch(params.url, signal);
        pagesThisRequest++;
        return text(page);
      },
    });
    pi.registerTool({
      name: 'source_fetch',
      label: 'Source fetch',
      description: `Download a GitHub repository ({ repo: "owner/name", ref?, paths? }) or an npm package ({ npm, version? }) into a local folder outside the task and return its path, commit and top-level tree; then grep and read it with bash. Use it for a program's instruction enums and state structs when no client is installed. At most ${SOURCE_LIMITS.repositories} repositories per user request, ${SOURCE_LIMITS.compressed / 2 ** 20} MB download, ${SOURCE_LIMITS.extracted / 2 ** 20} MB extracted.`,
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ maxLength: 201 })),
        ref: Type.Optional(Type.String({ maxLength: 200 })),
        paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 20 })),
        npm: Type.Optional(Type.String({ maxLength: 214 })),
        version: Type.Optional(Type.String({ maxLength: 64 })),
      }),
      async execute(_id, params, signal) {
        guard();
        return text(
          await sources.fetchSource(
            params,
            signal
              ? AbortSignal.any([signal, AbortSignal.timeout(SOURCE_TIMEOUT_MS)])
              : AbortSignal.timeout(SOURCE_TIMEOUT_MS),
          ),
        );
      },
    });
    for (const tool of SOLANA_TOOLS) {
      pi.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        async execute(_id, params, signal) {
          guard();
          usage.solanaMcp++;
          const result = await fetchMcpText(solana, tool.remote, params, signal, 'Solana MCP');
          const wrapped = wrapUntrusted(
            tool.name,
            result.text,
            WEB_RESULT_LIMIT,
            'the official Solana MCP (mcp.solana.com)',
          );
          if (result.isError) throw new Error(wrapped);
          return text(wrapped);
        },
      });
    }
  };
  return {
    extension,
    toolNames,
    enabled: () => enabled,
    setEnabled(on) {
      enabled = on;
    },
    usage: () => ({ ...usage, searchBy: { ...usage.searchBy }, fetchBy: { ...usage.fetchBy } }),
  };
}
