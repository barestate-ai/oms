export type Provider = 'anthropic' | 'xai' | 'opencode-go' | 'muse';
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type Tool = {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
};
export type ChatInput = {
  model: string;
  messages: Message[];
  failedToolCalls?: readonly string[];
  stream: boolean;
  maxTokens: number;
  tools?: Tool[];
  toolChoice?: unknown;
  temperature?: number;
  topP?: number;
  stop?: string[];
};
export type Usage = { input: number; cached: number; output: number; cacheWrite: number };
export type Delta = {
  role?: 'assistant';
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
};
export type Completion = {
  message: Message;
  finishReason: string;
  usage: Usage;
  deltas: Delta[];
  reasoningChars?: number;
};
export type StatusClass =
  | 'ok'
  | 'http_5xx'
  | 'http_4xx'
  | 'rate_limit'
  | 'transport'
  | 'timeout'
  | 'cancelled'
  | 'parse_error'
  | 'stream_error'
  | 'provider_error'
  | 'stream_limit'
  | 'truncated_stream'
  | 'budget'
  | 'not_configured';
export type Call = {
  model: string;
  in: number;
  cached: number;
  out: number;
  ms: number;
  usd: number;
  attempt: number;
  status_class: StatusClass;
  upstream_status?: number;
  usage_source: 'reported' | 'estimated' | 'none';
  dispatched: boolean;
  finish_reason?: string;
  tool_calls?: number;
  text_chars?: number;
  reasoning_chars?: number;
};
export type Target = string | Policy;
export type Policy =
  | { type: 'single'; model: string }
  | {
      type: 'escalate';
      cheap: Target;
      strong: Target;
      trigger: { tool_failures?: number; assistant_turns?: number; retry_on_error_or_empty?: boolean };
    }
  | { type: 'plan-exec'; planner: Target; executor: Target; replan_every?: number }
  | {
      type: 'checkpoint';
      strong: string;
      worker: string;
      opening_turns?: number;
      failure_streak?: number;
      worker_turns?: number;
      review_tools?: string[];
    }
  | {
      type: 'orchestrate';
      planners: Target[];
      judge?: string;
      worker: Target;
      validator?: string;
      repair?: Target;
      max_rejections?: number;
      defer_plan_until_tools?: boolean;
    }
  | {
      type: 'deescalate';
      strong: Target;
      cheap: Target;
      handoff_after_turns?: number;
      return_after_failures?: number;
      cooldown_turns?: number;
    }
  | { type: 'classify'; classifier: string; routes: Record<'easy' | 'medium' | 'hard', Target> };
export type Profiles = Record<string, Policy>;
export type SessionState = {
  escalated: Record<string, boolean>;
  labels: Record<string, 'easy' | 'medium' | 'hard'>;
  executorTurns: Record<string, number>;
  orchestrations: Record<
    string,
    { plan: string; feedback: string; rejections: number; repair: boolean; goal?: string }
  >;
  deescalations?: Record<string, { cheap: boolean; until: number }>;
  checkpoints?: Record<string, { workerTurns: number; reviewedFailure?: string }>;
};
export interface SessionStore {
  run<T>(key: string, operation: (state: SessionState) => Promise<T>): Promise<T>;
}
export type PolicyEvent = {
  type: 'plan' | 'judge' | 'validate_pass' | 'validate_fail' | 'validate_unparsable' | 'repair' | 'handoff' | 'return';
  path: string;
  reason?: 'turns' | 'cooldown' | 'tool_failures' | 'empty_or_error' | 'checkpoint_interval' | 'guarded_tool' | 'final';
  tools?: string[];
};
export type RequestLog = {
  ts: string;
  profile: string | null;
  calls: Call[];
  total_usd: number;
  status: number;
  events?: PolicyEvent[];
};
export type Dependencies = {
  fetch: typeof fetch;
  keys: Partial<Record<Provider, string>>;
  profiles: Profiles;
  sessions: SessionStore;
  log: (line: RequestLog) => void | Promise<void>;
  now?: () => number;
  upstreamTimeoutMs?: number;
  retryDelayMs?: number;
  beforeCall?: (model: string, input: ChatInput) => Promise<unknown>;
  afterCall?: (call: Call, reservation: unknown) => Promise<void>;
};

export class BlendError extends Error {
  status: number;
  type: string;
  constructor(status: number, message: string, type = 'upstream_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}
export class UpstreamError extends BlendError {
  statusClass: StatusClass;
  retryable: boolean;
  upstreamStatus?: number;
  constructor(status: number, message: string, statusClass: StatusClass, retryable = false, upstreamStatus?: number) {
    super(status, message);
    this.statusClass = statusClass;
    this.retryable = retryable;
    this.upstreamStatus = upstreamStatus;
  }
}
export function invalid(message = 'Invalid chat-completions request.'): never {
  throw new BlendError(400, message, 'invalid_request_error');
}
