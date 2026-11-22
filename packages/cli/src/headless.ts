import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KNOWLEDGE_TOOL_NAMES,
  knowledgePrimer,
  modelReadiness,
  parseRunRecord,
  type HarnessSession,
  type HarnessSessionOptions,
  type RunRecord,
} from '@oms/engine';
import { openHarnessWithOwnership } from './ownership.ts';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const harnessDigest = () =>
  digest(
    [
      import.meta.url,
      new URL('../../engine/src/runtime/session.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/session-types.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/session-lifecycle.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/session-environment.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/session-tools.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/session-hooks.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/session-model.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/session-api.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/task-definition.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/system-prompt.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/usage.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/run-record.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/knowledge-service.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/solana-diagnosis.ts', import.meta.url).href,
      new URL('../../engine/src/runtime/edge-check.ts', import.meta.url).href,
    ]
      .map((path) => readFileSync(new URL(path), 'utf8'))
      .join('\n'),
  );

function itemStates(harness: HarnessSession | undefined): RunRecord['items'] {
  const state = harness?.evaluator.read();
  if (!state?.ok) return [];
  return state.value.items.map((item) => ({
    id: item.id,
    status: item.status,
    evidence: item.evidence
      ? {
          specificationDigest: item.evidence.specificationDigest,
          codeDigest: item.evidence.codeDigest,
          verifierDigest: item.evidence.verifierDigest,
          snapshotDigest: item.evidence.snapshotDigest,
        }
      : null,
  }));
}

/** Consecutive turns that may end without any task item changing state before the run ends as 'no-verified-progress'. */
export const MAX_NO_PROGRESS_TURNS = 3;

export const HEADLESS_INSTRUCTION =
  'Complete the active trusted task item: implement the change and call propose_done. Only offline verifier evidence can close it.';

/** The model's whole starting context: what task_status and TASK.md would return, so it needs neither call to begin. */
export function buildFirstTurn(parts: { status?: unknown; brief: string; primer?: string }): string {
  return [
    HEADLESS_INSTRUCTION,
    ...(parts.status === undefined
      ? []
      : [`task_status (trusted, already read; no need to call it first):\n${JSON.stringify(parts.status, null, 2)}`]),
    ...(parts.brief ? [`TASK.md (already read; no need to open it):\n${parts.brief}`] : []),
    ...(parts.primer ? [parts.primer] : []),
  ].join('\n\n');
}

/** Noninteractive ownership refuses contention. It never stops, recovers, or steals another owner. */
export async function runHeadlessHarness(options: HarnessSessionOptions, jsonOut: string): Promise<number> {
  const selection = options.modelSelection;
  if (!selection) {
    throw new Error('Headless requires an explicit provider and model');
  }
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  let harness: HarnessSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let firstVisiblePass: RunRecord['firstVisiblePass'] = null;
  let status: RunRecord['status'] = 'blocked';
  let reason: string | null = 'ownership';
  let cap: RunRecord['cap'] = null;
  let record: RunRecord;
  let firstTurn = HEADLESS_INSTRUCTION;
  let injection: RunRecord['injection'];
  let injectionFallback: string | undefined;
  let knowledgeBuilt: string | undefined;
  let noProgressTurns = 0;
  let noProgressContinuations = 0;
  const knowledgeCalls: Record<string, number> = {};
  try {
    harness = await openHarnessWithOwnership(
      { ...options, endRunOnProposal: true },
      {
        prompt: {
          async choose() {
            return 'cancel';
          },
          async confirmStop() {
            return false;
          },
          close() {},
        },
      },
    );
    if (harness) {
      const current = harness;
      const observe = () => {
        const items = itemStates(current);
        if (!firstVisiblePass && items.length && items.every((item) => item.status === 'closed')) {
          firstVisiblePass = {
            wallMs: Math.max(0, clock() - startedAt),
            spendMicroUsd: current.budget.snapshot().used.spendMicroUsd,
          };
        }
      };
      unsubscribe = current.session.subscribe((event) => {
        if (event.type === 'tool_execution_start' && KNOWLEDGE_TOOL_NAMES.includes(event.toolName))
          knowledgeCalls[event.toolName] = (knowledgeCalls[event.toolName] ?? 0) + 1;
        observe();
      });
      const state = current.evaluator.read();
      const brief = join(options.task.codeRoot, 'TASK.md');
      const briefText = existsSync(brief) ? readFileSync(brief, 'utf8') : '';
      let primerText: string | undefined;
      const knowledgeConfig = current.knowledge.config();
      if (knowledgeConfig && options.knowledgeInject !== false) {
        const taskText = [...(state.ok ? state.value.items.map((item) => item.title) : []), briefText].join('\n');
        const primer = await knowledgePrimer(knowledgeConfig, options.task.codeRoot, taskText);
        if (primer.text) {
          primerText = primer.text;
          injection = primer.injection;
          injectionFallback = primer.fallback;
        }
        knowledgeBuilt = primer.built;
      }
      firstTurn = buildFirstTurn({ status: state.ok ? state.value : undefined, brief: briefText, primer: primerText });
      for (let turn = 0; ; turn++) {
        observe();
        const items = itemStates(current);
        const budget = current.budget.snapshot();
        if (items.length && items.every((item) => item.status === 'closed')) {
          status = 'closed';
          reason = null;
          break;
        }
        if (budget.remaining.wallClockMs <= 0) {
          status = 'capped';
          cap = 'wall';
          reason = 'capped:wall';
          break;
        }
        if (budget.accounting !== 'known') {
          status = 'infra';
          reason = 'usage-unknown';
          break;
        }
        const model = current.session.model;
        if (!model) {
          reason = 'model-unavailable';
          break;
        }
        const ready = modelReadiness(
          model,
          current.budget,
          options.maxOutputTokens,
          'bounded',
          options.maxInputTokens,
          options.subscriptionSpendExempt,
        );
        if (!ready.ready) {
          // Holds are bounded and cannot be admitted if the remaining allowance cannot cover one more call.
          status = 'capped';
          cap =
            budget.remaining.tokens < (options.maxInputTokens ?? model.contextWindow) + options.maxOutputTokens
              ? 'tokens'
              : 'usd';
          reason = `capped:${cap}`;
          break;
        }
        if (!items.length || items.some((item) => item.status === 'blocked')) {
          reason = 'task-blocked';
          break;
        }
        const before = JSON.stringify(items);
        if (noProgressTurns > 0) noProgressContinuations++;
        await current.session.prompt(turn === 0 ? firstTurn : HEADLESS_INSTRUCTION);
        observe();
        if (JSON.stringify(itemStates(current)) !== before) {
          noProgressTurns = 0;
          continue;
        }
        // A narration-only response is not a completion proof, nor a reason to spend indefinitely.
        // Budget and deadline checks at the top of the loop still run before every continuation turn.
        if (
          ++noProgressTurns >= MAX_NO_PROGRESS_TURNS &&
          modelReadiness(
            model,
            current.budget,
            options.maxOutputTokens,
            'bounded',
            options.maxInputTokens,
            options.subscriptionSpendExempt,
          ).ready
        ) {
          reason = 'no-verified-progress';
          break;
        }
      }
    }
  } catch {
    status = 'infra';
    reason = 'runtime-error';
  } finally {
    unsubscribe?.();
    const budget = harness?.budget.snapshot();
    const reservations = harness?.budget.reservations() ?? [];
    const receipts = harness?.budget.receipts() ?? [];
    const dispatches: RunRecord['dispatches'] = reservations.map((reservation) => {
      const receipt = receipts.findLast((entry) => entry.dispatchId === reservation.dispatchId);
      return {
        dispatchId: reservation.dispatchId,
        provider: reservation.provenance?.provider ?? selection.provider,
        model: reservation.provenance?.modelId ?? selection.id,
        endpoint: reservation.provenance?.endpointId ?? 'unknown',
        outcome: receipt?.outcome ?? 'reserved',
        heldMicroUsd:
          receipt?.outcome === 'known' || receipt?.outcome === 'not_dispatched' ? 0 : (reservation.spendMicroUsd ?? 0),
        settledMicroUsd:
          receipt?.outcome === 'known' || receipt?.outcome === 'not_dispatched' ? receipt.spendMicroUsd : null,
        usage: receipt?.usage ?? null,
      };
    });
    const items = itemStates(harness);
    record = {
      schema: 'oms.run/1',
      taskId: options.task.id,
      contender: `${selection.provider}:${selection.id}`,
      runId: harness?.session.sessionManager.getSessionId() ?? `blocked:${options.task.id}`,
      runIndex: 0,
      status,
      reason,
      cap,
      items,
      visibleVerdict: status === 'closed' ? 'pass' : items.length ? 'fail' : null,
      privateVerdict: null,
      dispatches,
      accounting: budget?.accounting ?? 'known',
      settledMicroUsd: dispatches.reduce((sum, d) => sum + (d.settledMicroUsd ?? 0), 0),
      heldMicroUsd: dispatches.reduce((sum, d) => sum + d.heldMicroUsd, 0),
      funding: selection.provider === 'openai-codex' || selection.provider === 'claude-code' ? 'subscription' : 'api',
      wallMs: Math.max(0, clock() - startedAt),
      transcriptPath: harness?.session.sessionFile ?? null,
      firstVisiblePass,
      identities: {
        task: digest(readFileSync(options.task.pinFile)),
        harness: harnessDigest(),
        // oms3 differs from oms only in its first turn, so that turn is part of its prompt identity.
        prompt: digest((harness?.session.systemPrompt ?? '') + (injection ? `\n${firstTurn}` : '')),
        image: options.environment.image,
        forwarderImage: options.environment.forwarderImage,
      },
      caps: options.caps,
      web: harness?.web?.usage() ?? { webSearch: 0, webFetch: 0, solanaMcp: 0, searchBy: {}, fetchBy: {} },
      ...(injection ? { injection } : {}),
      ...(injectionFallback ? { injectionFallback } : {}),
      ...(knowledgeBuilt ? { knowledgeBuilt } : {}),
      ...(harness?.knowledge.config() ? { knowledgeCalls } : {}),
      ...(harness?.edgeCheck ? { edgeCheck: harness.edgeCheck.summary() } : {}),
      noProgressContinuations,
    };
    try {
      await harness?.close();
    } catch {
      record.status = 'infra';
      record.reason = 'cleanup-uncertain';
      record.cap = null;
    }
    if (record.transcriptPath && !existsSync(record.transcriptPath)) {
      // Pi does not persist setup-only sessions. Record the observed lifecycle instead
      // of inventing user/provider messages or bypassing the SDK's persistence policy.
      record.transcriptPath += '.headless.jsonl';
      writeFileSync(
        record.transcriptPath,
        JSON.stringify({
          type: 'headless_exit',
          runId: record.runId,
          taskId: record.taskId,
          status: record.status,
          reason: record.reason,
          cap: record.cap,
          dispatchCount: record.dispatches.length,
          wallMs: record.wallMs,
        }) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
    }
    writeFileSync(jsonOut, JSON.stringify(parseRunRecord(record), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return record.status === 'closed' ? 0 : record.status === 'capped' ? 2 : 1;
}
