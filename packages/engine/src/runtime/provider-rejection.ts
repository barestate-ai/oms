const PROVIDER_NAMES: Record<string, string> = {
  xai: 'xAI',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'google-vertex': 'Google',
  groq: 'Groq',
  mistral: 'Mistral',
  openrouter: 'OpenRouter',
  cerebras: 'Cerebras',
  deepseek: 'DeepSeek',
  'openai-codex': 'Codex',
  'github-copilot': 'GitHub Copilot',
};

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

/** A 4xx answer is a refusal to start. 408 and 429 say nothing about whether work began, so they keep their transient handling. */
export function isRejectionStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** A failure that proves nothing about usage, in words that still read as transient so the turn is retried. */
export function describeTransient(provider: string, cause: string | undefined): string {
  const name = providerName(provider);
  const text = cause ?? '';
  if (/rate.?limit|too many requests|(?<![a-z0-9])429(?![a-z0-9])/i.test(text))
    return `${name} is rate limiting requests. Wait a moment and try again.`;
  if (/overloaded|server.?error|(?<![a-z0-9])(?:500|502|503|504)(?![a-z0-9])|service.?unavailable/i.test(text))
    return `${name} reported a server error. Try again in a moment.`;
  if (/network|connection|fetch failed|econn|enotfound|socket|terminated|stream/i.test(text))
    return `Network error reaching ${name}. Check your connection and try again.`;
  return `Provider stream disconnected before completion; ${name} may have partly answered. Try again.`;
}

const KEY_LIKE = /\b(?:sk|xai|gsk|key)[-_][A-Za-z0-9_-]{8,}/g;

function messageFrom(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const field of ['message', 'error', 'detail', 'msg']) {
    const found = messageFrom(record[field]);
    if (found) return found;
  }
  return undefined;
}

/** One plain sentence for a rejected request: the provider's own reason, never raw JSON and never a key. */
export function describeRejection(provider: string, status: number, body: string): string {
  const name = providerName(provider);
  if (status === 401 || status === 403) return `${name} says the API key is invalid. /connect to fix it.`;
  let reason: string | undefined;
  try {
    reason = messageFrom(JSON.parse(body));
  } catch {
    reason = /^\s*[{[]/.test(body) ? undefined : body;
  }
  const clean = plain(reason);
  return clean ? `${name} rejected the request: ${clean}` : `${name} rejected the request (HTTP ${status}).`;
}

/**
 * A request that broke off after it was sent. The provider's raw text stays out of the transcript, and the words must not
 * read as retryable to pi, which would resend a request whose cost is already uncertain.
 */
export function describeFailure(provider: string): string {
  return `${providerName(provider)}'s answer broke off before it finished. It is counted at its maximum cost. Send your message again to continue.`;
}

/**
 * The native Claude Code transport reports refusals as stream errors, never HTTP statuses. When the message carried no
 * content and no usage, refusal words in its bounded error text mean the provider did no billable work: the request can
 * be released as not dispatched. 'limit' alone is too ambiguous (it appears in partial-answer failures); only refusal
 * words that say the request never ran count.
 */
const REFUSAL =
  /too long|overflow|context window|context length|rate.?limit|too many requests|auth|log(?:ged)?.?in|sign.?in|credential|api.?key|subscription|quota|billing|payment|credit|unauthorized|forbidden|\b(?:401|403)\b/i;

export function nativeRefusalText(message: {
  content?: unknown[];
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  errorMessage?: string;
}): string | undefined {
  if (message.content?.length) return undefined;
  const usage = message.usage;
  if (usage && (usage.input! + usage.output! + usage.cacheRead! + usage.cacheWrite!) !== 0) return undefined;
  // The boilerplate wrapper claude-code.ts adds would itself trip the refusal words ('API-key').
  const inner = (message.errorMessage ?? '')
    .replace(/^Claude Code native chat stopped:/i, '')
    .replace(/No API-key fallback was used\.?/i, '');
  const text = plain(inner);
  return REFUSAL.test(text) ? text : undefined;
}

export function plain(text: string | undefined): string {
  return (
    (text ?? '')
      .replace(KEY_LIKE, '[key]')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240)
  );
}
