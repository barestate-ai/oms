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
  'claude-code': 'Claude Code',
  opencode: 'OpenCode Zen',
  xiaomi: 'Xiaomi',
  'xiaomi-token-plan-cn': 'Xiaomi Token Plan CN',
  'xiaomi-token-plan-sgp': 'Xiaomi Token Plan SGP',
  'xiaomi-token-plan-ams': 'Xiaomi Token Plan AMS',
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
  if (status === 401 || status === 403) {
    // Providers without an API-key path authenticate by sign-in; a 401/403 is about that login, not a key.
    if (provider === 'openai-codex')
      return `${name} says the sign-in is invalid or expired. Sign in again in /connect to fix it.`;
    if (provider === 'claude-code')
      return `${name} says the sign-in is invalid or expired. Run claude auth login, then check the connection in /connect.`;
    return `${name} says the API key is invalid. /connect to fix it.`;
  }
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

/** Claude Code's local sign-in check ran before any native process started, so provably no provider request exists. */
export function describeClaudeCodeSignIn(provider: string): string {
  return `${providerName(provider)} needs its Claude subscription sign-in before it can answer. Run claude auth login in a terminal, then check the connection in /connect and send your message again. No provider request was sent.`;
}

/** Recovery for a native turn refused with a tool batch still in flight; replay cannot be proven safe. */
const INTERRUPTED_NATIVE_BATCH =
  'An interrupted native tool batch was not replayed; review OMS tool results, select Claude Code in /model, then use /clear to start a fresh native chat and clear the OMS conversation view. Task files and verification are retained.';

/** An in-flight Claude Code turn was refused because the Claude subscription sign-in lapsed. */
export function describeClaudeCodeAuth(provider: string, interruptedBatch = false): string {
  return `${providerName(provider)}'s Claude subscription sign-in is no longer valid. Run claude auth login in a terminal and check the connection in /connect before sending your message again. It is counted at its maximum cost.${interruptedBatch ? ` ${INTERRUPTED_NATIVE_BATCH}` : ''}`;
}

/** The provider refused a Claude Code turn when the Claude plan usage limit was reached; reset is its own hint, if given. */
export function describeClaudeCodeLimit(provider: string, reset?: string, interruptedBatch = false): string {
  const when = reset ? ` It resets ${reset}.` : '';
  return `${providerName(provider)}'s usage limit was reached.${when} It is counted at its maximum cost. Send your message again after the limit resets.${interruptedBatch ? ` ${INTERRUPTED_NATIVE_BATCH}` : ''}`;
}

/** A bare throttle refused a Claude Code turn that kept a tool batch in flight; nothing proves plan exhaustion. */
export function describeClaudeCodeRateLimit(provider: string, interruptedBatch = false): string {
  return `${providerName(provider)} rate limited the request. Wait a short while and send your message again. It is counted at its maximum cost.${interruptedBatch ? ` ${INTERRUPTED_NATIVE_BATCH}` : ''}`;
}

/** Claude Code rejected the turn before any native model request existed; the rejection itself carries the recovery step. */
export function describeClaudeCodeNotDispatched(provider: string, detail?: string): string {
  return `${providerName(provider)} did not start a native request: ${detail ?? 'the session is not safe to resume'}. No provider request was sent.`;
}

function plain(text: string | undefined): string {
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
