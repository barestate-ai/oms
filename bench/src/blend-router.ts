import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createNodeServer } from '../../deploy/blend-worker/src/node-server.ts';
import { escalationTriggered, validateProfiles } from '../../deploy/blend-worker/src/core/policies.ts';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Message, Provider, Target } from '../../deploy/blend-worker/src/core/types.ts';
import { estimatedInput } from '../../deploy/blend-worker/src/core/adapters.ts';
import { MemorySessions } from '../../deploy/blend-worker/src/core/sessions.ts';
import { MODELS, modelSpec } from '../../deploy/blend-worker/src/core/pricing.ts';
import { UpstreamError, type RequestLog } from '../../deploy/blend-worker/src/core/types.ts';
import type { ContenderModel } from './contenders.ts';
import { SURFPOOL_LIBS } from '../../packages/sandbox/src/resources.ts';

export const apiSandboxProbe = (image: string) => [
  'run',
  '--rm',
  '--network',
  'none',
  ...SURFPOOL_LIBS.flatMap((path) => ['--mount', `type=bind,src=${path},dst=${path},readonly`]),
  image,
  '/bin/sh',
  '-c',
  'node --version',
];

export const blendProfiles = validateProfiles(
  JSON.parse(readFileSync(new URL('../../deploy/blend-worker/profiles.json', import.meta.url), 'utf8')),
);
export const BLEND_MODELS: Record<string, ContenderModel> = Object.fromEntries(
  Object.entries(blendProfiles).map(([id, policy]) => {
    const spec = policy.type === 'single' ? MODELS[policy.model] : undefined,
      multiplier = spec?.peak ? 2 : 1;
    const cost = spec
      ? {
          input: Math.max(spec.rates.input, spec.high?.input ?? 0) * multiplier,
          output: Math.max(spec.rates.output, spec.high?.output ?? 0) * multiplier,
          cacheRead: Math.max(spec.rates.cached, spec.high?.cached ?? 0) * multiplier,
          cacheWrite: Math.max(spec.rates.input, spec.high?.input ?? 0) * multiplier * 1.25,
        }
      : { input: 8, output: 40, cacheRead: 8, cacheWrite: 16 };
    return [
      id,
      {
        provider: 'blend',
        id,
        name: id,
        api: 'openai-completions',
        reasoning: false,
        contextWindow: 200000,
        maxTokens: 32000,
        cost,
      },
    ];
  }),
);
type Event = { id: string; kind: 'reserve' | 'settle'; amount: number; retained?: number };
const micro = (usd: number) => {
  const value = Math.ceil(usd * 1e6);
  if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid Blend cost');
  return value;
};

export class BlendBudget {
  blocked = false;
  readonly file: string;
  readonly maximum: number;
  readonly scope: 'all' | 'anthropic-muse';
  private readonly entries = new Map<string, { amount: number; charged?: number }>();
  constructor(file: string, maxUsd: number, scope: 'all' | 'anthropic-muse' = 'all') {
    this.file = file;
    this.scope = scope;
    this.maximum = Math.floor(maxUsd * 1e6);
    if (!Number.isSafeInteger(this.maximum) || this.maximum <= 0) throw Error('Invalid --max-usd');
    if (existsSync(file)) {
      const data = readFileSync(file, 'utf8');
      if (data && !data.endsWith('\n')) throw Error('Incomplete Blend ledger; reconcile before resuming');
      for (const line of data.split('\n').filter(Boolean)) this.apply(JSON.parse(line));
    }
  }
  private apply(event: Event) {
    if (!Number.isSafeInteger(event.amount) || event.amount < 0) throw Error('Invalid ledger amount');
    if (event.kind === 'reserve') {
      if (this.entries.has(event.id)) throw Error('Duplicate reservation');
      this.entries.set(event.id, { amount: event.amount });
    } else if (event.kind === 'settle') {
      const entry = this.entries.get(event.id);
      if (
        !entry ||
        entry.charged !== undefined ||
        (event.retained !== undefined && (!Number.isSafeInteger(event.retained) || event.retained < 0))
      )
        throw Error('Invalid settlement');
      entry.charged = event.amount;
    } else throw Error('Unknown ledger event');
  }
  get used() {
    return [...this.entries.values()].reduce((sum, e) => sum + (e.charged ?? e.amount), 0);
  }
  get assessed() {
    return [...this.entries.values()].reduce((sum, e) => sum + (e.charged ?? 0), 0);
  }
  get remainingUsd() {
    return Math.max(0, this.maximum - this.used) / 1e6;
  }
  covers(provider: Provider): boolean {
    return this.scope === 'all' || provider === 'anthropic' || provider === 'muse';
  }
  reserve(usd: number) {
    const amount = micro(usd);
    if (this.used + amount > this.maximum) {
      this.blocked = true;
      throw new UpstreamError(402, 'Solana Bench dollar cap reached.', 'budget');
    }
    const event: Event = { id: randomUUID(), kind: 'reserve', amount };
    appendFileSync(this.file, JSON.stringify(event) + '\n', { mode: 0o600 });
    this.apply(event);
    return event.id;
  }
  settle(id: string, usd: number) {
    const entry = this.entries.get(id);
    if (!entry || entry.charged !== undefined) throw Error('Invalid settlement');
    const event: Event = { id, kind: 'settle', amount: micro(usd) };
    appendFileSync(this.file, JSON.stringify(event) + '\n', { mode: 0o600 });
    this.apply(event);
  }
}

export async function startBlendRouter(logFile: string, budget: BlendBudget, transport: typeof fetch = fetch) {
  const logs: RequestLog[] = [];
  const server = createNodeServer({
    profiles: blendProfiles,
    sessions: new MemorySessions(),
    keys: {
      anthropic: process.env.ANTHROPIC_API_KEY,
      xai: process.env.XAI_API_KEY,
      'opencode-go': process.env.OPENCODE_GO_KEY ?? process.env.OPENCODE_API_KEY,
      muse: process.env.MUSE_API_KEY,
    },
    fetch: transport,
    beforeCall: async (model, input) => {
      const spec = modelSpec(model),
        factor = spec.peak ? 2 : 1;
      if (!budget.covers(spec.provider)) return undefined;
      const inputRate =
          Math.max(spec.rates.input, spec.high?.input ?? 0) * factor * (spec.provider === 'anthropic' ? 1.25 : 1),
        outputRate = Math.max(spec.rates.output, spec.high?.output ?? 0) * factor;
      return budget.reserve((estimatedInput(model, input) * inputRate + input.maxTokens * outputRate) / 1e6);
    },
    afterCall: async (call, ticket) => {
      if (typeof ticket === 'string') budget.settle(ticket, call.usd);
    },
    log: (line) => {
      logs.push(line);
      appendFileSync(logFile, JSON.stringify(line) + '\n', { mode: 0o600 });
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing local router address');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    logs,
    requestCost: (model: Parameters<StreamFn>[0], context: Parameters<StreamFn>[1]) =>
      nextRequestCost(model.id, context, logs),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

export function nextRequestCost(id: string, context: Parameters<StreamFn>[1], logs: readonly RequestLog[]) {
  const policy = blendProfiles[id];
  if (!policy) throw Error('Unknown Blend profile');
  if (policy.type === 'orchestrate') {
    const costs: (typeof BLEND_MODELS)[string]['cost'][] = [];
    const visit = (target: Target): void => {
      if (typeof target === 'string') {
        costs.push(BLEND_MODELS[target]!.cost);
        return;
      }
      if (target.type === 'single') visit(target.model);
      else if (target.type === 'escalate') {
        visit(target.cheap);
        visit(target.strong);
      } else if (target.type === 'plan-exec') {
        visit(target.planner);
        visit(target.executor);
      } else if (target.type === 'deescalate') {
        visit(target.strong);
        visit(target.cheap);
      } else if (target.type === 'checkpoint') {
        visit(target.strong);
        visit(target.worker);
      } else if (target.type === 'classify') {
        visit(target.classifier);
        Object.values(target.routes).forEach(visit);
      } else {
        target.planners.forEach(visit);
        visit(target.worker);
        if (target.judge) visit(target.judge);
        if (target.validator) visit(target.validator);
        if (target.repair) visit(target.repair);
      }
    };
    visit(policy);
    return {
      input: Math.max(...costs.map((c) => c.input)),
      output: Math.max(...costs.map((c) => c.output)),
      cacheRead: Math.max(...costs.map((c) => c.cacheRead)),
      cacheWrite: Math.max(...costs.map((c) => c.cacheWrite)),
    };
  }
  if (policy.type !== 'escalate' || typeof policy.cheap !== 'string' || typeof policy.strong !== 'string')
    return BLEND_MODELS[id]!.cost;
  const messages: Message[] = context.messages.map((m) => ({
    role: m.role === 'toolResult' ? 'tool' : m.role === 'assistant' ? 'assistant' : 'user',
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n'),
  }));
  const escalated = logs.some((line) => line.profile === id && line.calls.some((call) => call.model === policy.strong));
  const target = escalated || escalationTriggered(policy, { messages }) ? policy.strong : policy.cheap;
  return BLEND_MODELS[target]!.cost;
}
