import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { TestContext } from 'node:test';
import {
  createWriteToolDefinition,
  SessionManager,
  type ExtensionFactory,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createBudgetLedger } from '@oms/core';
import { createDispatchAllocator } from '@oms/core/dispatch';
import { createHelpers } from '../src/runtime/helpers/index.ts';
import type { SandboxTools } from '../src/runtime/sandbox-tools.ts';
import type { SessionApiParts } from '../src/runtime/session-api.ts';
import { createFauxModel } from './runtime-fixture.ts';

/** Real helper sessions and accounting, with in-memory tools so lifecycle tests need no host processes. */
export async function helperRunnerFixture(t: TestContext, tokens = 5_000_000) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-helper-runner-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const folder = join(base, 'project');
  mkdirSync(folder);
  const agentRoot = join(base, 'agent');
  mkdirSync(agentRoot);
  const { faux, modelRuntime, model } = await createFauxModel(base);
  const budget = createBudgetLedger({
    caps: { tokens, spendMicroUsd: 10_000_000, wallClockMs: 3_600_000 },
    executionMode: 'bounded',
    clock: Date.now,
    persist() {},
  });
  const trust = { yolo: true, allowed: new Set<string>() };
  const helpers = createHelpers({
    dirs: { personal: join(base, 'personal'), project: join(folder, '.oms-agents') },
    trust,
  });
  let closed = 0;
  const parts = {
    account: { searchCredential: () => undefined },
    options: { maxOutputTokens: 128, hostTrust: trust, environment: { backend: 'host' } },
    life: { trace: { append: () => ({ ok: true }) }, liveSession: { model } },
    env: {
      root: { codeRoot: folder, agentRoot, stateDir: base },
      manager: SessionManager.inMemory(folder),
      sessionId: 'test',
      protectedFiles: [],
      executionMode: 'bounded',
      budget,
      allocate: createDispatchAllocator(),
      surfnetPort: 8899,
    },
    model: { session: { model, thinkingLevel: 'off' }, modelRuntime },
    tools: {
      taskRoot: folder,
      backend: { approvesCommands: false },
      toolchainSummary: '',
      knowledgeSource: () => undefined,
      sandboxTools: {
        helperTools: ({ onWrite }: Parameters<SandboxTools['helperTools']>[0]) => ({
          extension: ((pi) => {
            pi.registerTool(
              createWriteToolDefinition(folder, {
                operations: {
                  async writeFile(path, content) {
                    writeFileSync(path, content);
                    onWrite?.(relative(folder, path));
                  },
                  async mkdir(path) {
                    mkdirSync(path, { recursive: true });
                  },
                },
              }),
            );
          }) as ExtensionFactory,
          close: () => {
            closed++;
          },
        }),
      },
    },
  } as unknown as SessionApiParts;
  helpers.bind(parts);
  let tool!: ToolDefinition;
  let before!: (event: unknown, ctx: unknown) => unknown;
  helpers.extension({
    registerTool: (next: ToolDefinition) => {
      tool = next;
    },
    on: (name: string, handler: typeof before) => {
      if (name === 'before_agent_start') before = handler;
    },
    getActiveTools: () => ['agent'],
  } as never);
  t.after(() => helpers.abortAll());
  return {
    faux,
    modelRuntime,
    model,
    parts,
    helpers,
    folder,
    agentRoot,
    closed: () => closed,
    // The chat's live agent state, as the parent's agent loop keeps it while tools run.
    chat: (messages: unknown[]) => {
      (parts.model.session as { agent?: unknown }).agent = { state: { messages } };
    },
    text: (path: string) => readFileSync(join(folder, path), 'utf8'),
    description: () => tool.description,
    start: () => before({ messageType: 'user', systemPrompt: '' }, { model }),
    execute: (agent = 'explore', task = 'Go.', files?: string[]) =>
      tool.execute('test-call', { agent, task, files }, undefined, undefined, {} as never),
  };
}
