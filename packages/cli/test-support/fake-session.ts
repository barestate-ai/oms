/**
 * Fake OMS sessions and screen helpers for full-screen TUI tests. Nothing here reaches a model provider.
 * Importing this module pins COLORTERM/TERM and clears NO_COLOR/TMUX so the startup art draws the same everywhere.
 *
 * Recipe for a new full-screen test:
 *
 *   import { chatFixture, start } from '../test-support/fake-session.ts';
 *
 *   test('Enter sends the prompt', async () => {
 *     const f = chatFixture(); // fixture() for the task layout with panes
 *     const { terminal, close } = start(f.harness, 100, 30);
 *     try {
 *       await terminal.until((s) => s.includes('/help'));
 *       terminal.send('hello');
 *       terminal.send('\r');
 *       await terminal.until(() => f.prompts.length === 1);
 *     } finally {
 *       f.promptGate.resolve(); // release held work so Ctrl+Q can finish
 *       f.abortGate.resolve();
 *       await close(); // Ctrl+Q, asserts the terminal was released, frees the VT
 *     }
 *   });
 */
import assert from 'node:assert/strict';
import type { HarnessSession } from '@oms/engine';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import { runOmsInterface } from '../src/tui/interface.ts';
import { barrier, InterfaceTerminal } from './interface-terminal.ts';

// The startup art's colour tier comes from the environment: pin it so the screen is the same everywhere.
Object.assign(process.env, { COLORTERM: 'truecolor', TERM: 'xterm-256color' });
delete process.env.NO_COLOR;
delete process.env.TMUX;

/** A task-kind session: listeners, emit(event), prompt/command/verify recorders, gates that hold async work, toggles. */
export function fixture() {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const prompts: string[] = [];
  const commands: string[] = [];
  const verified: string[] = [];
  const items = [
    { id: 'R1', title: 'Calculate rent exactly', status: 'active', done: [], reopenCount: 0 },
    { id: 'R2', title: 'Reject duplicate deposits', status: 'open', done: [], reopenCount: 0 },
  ];
  const promptGate = barrier<void>();
  const commandGate = barrier<unknown>();
  const abortGate = barrier<void>();
  let hasModel = true;
  const configuredProviders = new Set(['local']);
  let modelIdentity = { id: 'test-model', provider: 'local' };
  let abortRequested = false;
  let commandSignal: AbortSignal | undefined;
  let promptFailure: Error | undefined;
  let closed = false;
  let clears = 0;
  const messages: unknown[] = [];
  const emit = (event: unknown) => {
    for (const listener of listeners) listener(event as AgentSessionEvent);
  };
  const session = {
    messages,
    get model() {
      return hasModel ? modelIdentity : undefined;
    },
    sessionManager: {
      getSessionId: () => 'session-fixture',
      resetLeaf() {
        clears++;
      },
    },
    isStreaming: false,
    agent: {
      reset() {
        messages.length = 0;
      },
    },
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      if (promptFailure) throw promptFailure;
      prompts.push(text);
      messages.push({ role: 'user', content: text });
      emit({ type: 'agent_start' });
      await promptGate.promise;
      emit({ type: 'agent_settled', aborted: abortRequested });
    },
    async abort() {
      abortRequested = true;
      await abortGate.promise;
    },
  };
  const harness = {
    kind: 'task',
    root: '/fixtures/task',
    workspace: { root: '/fixtures/rental-ledger' },
    task: { id: 'rent', codeRoot: '/fixtures/task', branch: 'oms/rent' },
    session,
    evaluator: { read: () => ({ ok: true, value: { items } }) },
    listModels: () => [
      { provider: 'local', id: 'test-model', name: 'Local model', configured: true },
      { provider: 'other', id: 'other-model', name: 'Other model', configured: configuredProviders.has('other') },
    ],
    listProviders: () => [
      { id: 'local', name: 'Local provider', configured: true, apiKey: true, oauth: false },
      { id: 'other', name: 'Other provider', configured: configuredProviders.has('other'), apiKey: true, oauth: false },
    ],
    async selectModel(provider: string, id: string) {
      if (!configuredProviders.has(provider)) throw new Error('Provider is not configured');
      modelIdentity = { provider, id };
      hasModel = true;
    },
    async connectProvider(provider: string, _key: string) {
      configuredProviders.add(provider);
    },
    async loginProvider(provider: string, _method: string, interaction: AuthInteraction) {
      await interaction.prompt({ type: 'secret', message: 'Provider API key', signal: interaction.signal });
      configuredProviders.add(provider);
    },
    budget: {
      receipts: () => [],
      reservations: () => [],
      snapshot: () => ({
        caps: { tokens: 9000, spendMicroUsd: 3000000, wallClockMs: 120000 },
        used: { tokens: 200, spendMicroUsd: 2999999, wallClockMs: 1000 },
        remaining: { tokens: 8800, spendMicroUsd: 1, wallClockMs: 119000 },
        accounting: 'known',
        exhausted: false,
      }),
    },
    async verify(id?: string) {
      verified.push(id ?? 'R1');
      items[0]!.status = 'closed';
      return { itemId: id ?? 'R1', result: { closed: true } };
    },
    async runCommand(command: string, signal?: AbortSignal) {
      commands.push(command);
      commandSignal = signal;
      return commandGate.promise;
    },
    async close() {
      closed = true;
    },
  } as unknown as HarnessSession;
  return {
    harness,
    listeners,
    prompts,
    commands,
    verified,
    messages,
    emit,
    promptGate,
    commandGate,
    abortGate,
    model(value: boolean) {
      hasModel = value;
    },
    failPrompt(error: Error) {
      promptFailure = error;
    },
    identity(value: { id: string; provider: string }) {
      modelIdentity = value;
    },
    clears: () => clears,
    abortRequested: () => abortRequested,
    commandSignal: () => commandSignal,
    closed: () => closed,
  };
}

export type FakeSession = ReturnType<typeof fixture>;

/** Quits with Ctrl+Q and asserts the interface released the terminal. */
export async function quit(terminal: InterfaceTerminal, run: Promise<void>) {
  terminal.send('\x11');
  await run;
  assert.equal(terminal.active, false);
  assert.equal(terminal.drained, true);
}

/** Presses and releases the mouse on the first cell of `text` on `screen`. */
export function clickText(terminal: InterfaceTerminal, screen: string, text: string): void {
  const rows = screen.split('\n');
  const y = rows.findIndex((row) => row.includes(text));
  assert.ok(y >= 0, `Missing control ${text}`);
  const x = rows[y]!.indexOf(text);
  terminal.send(`\x1b[<0;${x + 2};${y + 1}M`);
  terminal.send(`\x1b[<0;${x + 2};${y + 1}m`);
}

/** Opens the interface on a headless terminal; `close()` quits, asserts the terminal was released and frees the VT. */
export function start(
  harness: HarnessSession,
  columns = 110,
  rows = 30,
  options: Omit<NonNullable<Parameters<typeof runOmsInterface>[1]>, 'terminal'> = {},
) {
  const terminal = new InterfaceTerminal(columns, rows);
  const run = runOmsInterface(harness, { ...options, terminal });
  return {
    terminal,
    run,
    async close() {
      try {
        await quit(terminal, run);
      } finally {
        terminal.vt.dispose();
      }
    },
  };
}

/** The same fake as a folder chat: no task fields, kind 'chat', a folder and a YOLO toggle. */
export function chatFixture(yolo = false, folder = '/fixtures/rental-ledger') {
  const f = fixture();
  const chat = f.harness as unknown as Record<string, unknown>;
  for (const field of ['workspace', 'task', 'evaluator', 'verify']) delete chat[field];
  let on = yolo;
  Object.assign(chat, {
    kind: 'chat',
    root: folder,
    folder: { path: folder, requested: folder, key: 'k', scratch: false },
    yolo: {
      enabled: () => on,
      set(value: boolean) {
        on = value;
      },
    },
  });
  return f;
}

/** Adds helper agents to a fake session; returns the agent drafts /agents new created. */
export function withHelpers(f: FakeSession, available: { ok: true } | { ok: false; reason: string } = { ok: true }) {
  const created: unknown[] = [];
  Object.assign(f.harness, {
    helpers: {
      agents: () => ({
        agents: [
          { name: 'explore', description: 'Find code and facts, report file paths', tools: 'read', source: 'built-in' },
          { name: 'build', description: 'Make one scoped change and run its check', tools: 'edit', source: 'built-in' },
          { name: 'auditor', description: 'Check accounts', tools: 'read', source: 'project' },
        ],
        problems: ['project: broken.md: needs a --- header with name and description'],
      }),
      list: () => [
        {
          id: 'explore#1',
          agent: 'explore',
          task: 'find vault PDA seeds',
          model: 'xai/grok-4.7',
          status: 'done',
          startedAt: 1000,
          endedAt: 15000,
          turnId: 't',
          sessionFile: '',
          tokens: 22_400,
          spendMicroUsd: 0,
        },
        {
          id: 'build#2',
          agent: 'build',
          task: 'add close_vault',
          model: 'xai/grok-4.7',
          status: 'waiting',
          startedAt: 1000,
          turnId: 't2',
          sessionFile: '',
          tokens: 0,
          spendMicroUsd: 0,
          waitingFor: 'build#1',
        },
      ],
      createAgent(draft: unknown) {
        created.push(draft);
        return '/home/dev/.oms/agents/scanner.md';
      },
      messages: () => [],
      cancel: async () => {},
      available: () => available,
    },
  });
  return created;
}
