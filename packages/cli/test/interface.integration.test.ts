import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHarnessSession, type HarnessSession } from '@oms/engine';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createHarnessFixture } from '../../engine/test-support/runtime-fixture.ts';
import { runOmsInterface } from '../src/tui/interface.ts';
import { getTheme } from '../src/tui/theme.ts';
import { InterfaceTerminal } from '../test-support/interface-terminal.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

/** The spinner row, or the spinner in the composer's top rule, shows while the agent works. */
const working = (screen: string): boolean => /(?:^|── )[⠁-⣿] \S/m.test(screen);
const binary = process.env.SURFPOOL_BINARY;
const image = process.env.OMS_SANDBOX_IMAGE;
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE;

test(
  'OMS interface drives real sandbox edits and offline proof without changing session on focus, resize or resume',
  { timeout: 150_000 },
  async (t) => {
    if (
      (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
      !binary ||
      !image ||
      !forwarderImage
    )
      return;
    const f = await createHarnessFixture({ binary, image, forwarderImage });
    let harness: HarnessSession | undefined;
    let interfaceRun: Promise<void> | undefined;
    let terminal: InterfaceTerminal | undefined;
    let unsubscribe: (() => void) | undefined;
    const observation = new AbortController();
    let observed: Promise<unknown> | undefined;
    try {
      f.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall('edit', { path: 'amount.mjs', edits: [{ oldText: 'amount = 0', newText: 'amount = 10' }] }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(fauxToolCall('propose_done', { itemId: 'fixture' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('The offline check has completed.'),
      ]);
      harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
      const liveSession = harness.session;
      const id = liveSession.sessionManager.getSessionId();
      const events = new EventEmitter();
      unsubscribe = liveSession.subscribe((event) => events.emit(event.type, event));
      const eventSignal = AbortSignal.any([observation.signal, AbortSignal.timeout(100_000)]);
      const toolStarted = once(events, 'tool_execution_start', { signal: eventSignal });
      const settled = once(events, 'agent_settled', { signal: eventSignal });
      observed = Promise.allSettled([toolStarted, settled]);
      terminal = new InterfaceTerminal();
      interfaceRun = runOmsInterface(harness, { terminal });
      let unexpectedEnd = interfaceRun.then(() => {
        throw new Error('The interface ended before its workflow completed');
      });
      await Promise.race([terminal.until((screen) => screen.includes('oms-controlled/controlled')), unexpectedEnd]);
      terminal.send('/status');
      terminal.send('\r');
      await Promise.race([terminal.until((screen) => screen.includes('set amount and verify offline')), unexpectedEnd]);
      terminal.send('Set the amount to 10 and request independent verification.');
      terminal.send('\r');
      await Promise.race([toolStarted, unexpectedEnd]);
      terminal.send('\x1b[12~');
      terminal.send('\t');
      terminal.send('\t');
      terminal.send('\t');
      terminal.send('\x1b[19~');
      await Promise.race([
        terminal.until(
          () =>
            terminal!.vt.buffer.active
              .getLine(0)
              ?.getCell(terminal!.columns - 1)
              ?.getFgColor() === Number.parseInt(getTheme('catppuccin')!.colors.foreground.slice(1), 16),
        ),
        unexpectedEnd,
      ]);
      terminal.setSize(68, 18);
      assert.equal(harness.session, liveSession);
      assert.equal(harness.session.sessionManager.getSessionId(), id);
      await Promise.race([settled, unexpectedEnd]);
      const proof = harness.evaluator.read();
      assert.ok(proof.ok);
      assert.equal(proof.value.items[0]?.status, 'closed');
      assert.equal(proof.value.items[0]?.evidence?.mode, 'offline-snapshot');
      assert.equal(readFileSync(join(f.task.codeRoot, 'amount.mjs'), 'utf8'), 'export const amount = 10;\n');
      assert.equal(readFileSync(join(f.repo, 'amount.mjs'), 'utf8'), 'export const amount = 0;\n');
      assert.equal(existsSync(f.extensionSentinel), false);
      assert.equal(f.faux.state.callCount, 3);
      terminal.setSize(110, 30);
      terminal.send('/status');
      terminal.send('\r');
      await terminal.until((screen) => screen.includes('closed'));
      const history = JSON.stringify(harness.session.messages);
      const used = harness.budget.snapshot().used;
      terminal.send('\x11');
      await interfaceRun;
      interfaceRun = undefined;
      unsubscribe();
      unsubscribe = undefined;
      terminal.vt.dispose();
      terminal = undefined;
      harness = undefined;

      harness = await createHarnessSession({
        ...f.options,
        modelRuntime: f.modelRuntime,
        model: f.model,
        sessionId: id,
      });
      assert.equal(JSON.stringify(harness.session.messages), history);
      assert.equal(harness.budget.snapshot().used.tokens, used.tokens);
      assert.equal(harness.budget.snapshot().used.spendMicroUsd, used.spendMicroUsd);
      terminal = new InterfaceTerminal();
      interfaceRun = runOmsInterface(harness, { terminal });
      unexpectedEnd = interfaceRun.then(() => {
        throw new Error('The resumed interface ended before inspection');
      });
      await Promise.race([terminal.until((screen) => screen.includes('oms-controlled/controlled')), unexpectedEnd]);
      terminal.send('/status');
      terminal.send('\r');
      await Promise.race([terminal.until((screen) => screen.includes('closed')), unexpectedEnd]);
      terminal.send('/session');
      terminal.send('\r');
      await terminal.until((screen) => screen.includes(id));
      assert.equal(f.faux.state.callCount, 3);
      assert.equal(harness.session.sessionManager.getSessionId(), id);
      terminal.send('\x11');
      await interfaceRun;
      interfaceRun = undefined;
    } finally {
      observation.abort();
      await observed;
      terminal?.send('\x11');
      unsubscribe?.();
      await harness?.close();
      try {
        await interfaceRun;
      } finally {
        terminal?.vt.dispose();
        rmSync(f.base, { recursive: true, force: true });
      }
    }
  },
);

test(
  'masked in-app setup persists a provider and continues the same metered conversation after resume',
  { timeout: 120_000 },
  async (t) => {
    if (
      (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
      !binary ||
      !image ||
      !forwarderImage
    )
      return;
    const f = await createHarnessFixture({ binary, image, forwarderImage });
    const provider = createFauxCore({
      api: 'openai-completions',
      provider: 'oms-ui-keyed',
      models: [
        {
          id: 'keyed',
          contextWindow: 4096,
          maxTokens: 128,
          cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
        },
      ],
    });
    f.modelRuntime.registerProvider('oms-ui-keyed', {
      api: provider.api,
      baseUrl: 'http://127.0.0.1:1',
      streamSimple: provider.streamSimple,
      models: provider.models.map((model) => ({
        type: 'chat' as const,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    });
    provider.setResponses([fauxAssistantMessage('Continued after in-app setup.')]);
    let harness: HarnessSession | undefined;
    let terminal: InterfaceTerminal | undefined;
    let run: Promise<void> | undefined;
    const secret = 'synthetic-ui-key-never-a-real-provider-key';
    const draft = 'Keep this precise request 界🙂 while configuring the model.';
    try {
      harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
      const session = harness.session;
      const id = session.sessionManager.getSessionId();
      terminal = new InterfaceTerminal();
      run = runOmsInterface(harness, { terminal });
      await terminal.screen();
      terminal.send(draft);
      terminal.send('\x1bOS');
      await terminal.until((screen) => screen.includes('Filter:'));
      terminal.send('oms-ui-keyed');
      terminal.send('\r');
      await terminal.until((screen) => screen.includes('Secret:') && screen.includes('oms-ui-keyed'));
      terminal.send(`\x1b[200~${secret}\x1b[201~`);
      await terminal.until((screen) => screen.includes('••••'));
      terminal.send('\r');
      await terminal.until((screen) => screen.includes('oms-ui-keyed/keyed') && screen.includes('Choose a model'));
      terminal.send('\r');
      await terminal.until((screen) => screen.includes(draft) && screen.includes('oms-ui-keyed/keyed'));
      assert.equal(harness.session, session);
      assert.equal(session.sessionManager.getSessionId(), id);
      assert.equal(harness.budget.snapshot().used.tokens, 0);
      assert.deepEqual(session.messages, []);
      assert.equal(provider.state.callCount, 0);
      const auth = join(f.base, 'model-auth.json');
      assert.equal(statSync(auth).mode & 0o777, 0o600);
      assert.equal(JSON.parse(readFileSync(auth, 'utf8'))['oms-ui-keyed'].key, secret);
      assert.equal(terminal.output.includes(secret), false);
      terminal.send('\r');
      await terminal.until((screen) => screen.includes('Continued after in-app setup.') && !working(screen));
      assert.equal(provider.state.callCount, 1);
      assert.equal(f.faux.state.callCount, 0);
      assert.equal(JSON.stringify(session.messages).includes(secret), false);
      const history = JSON.stringify(session.messages);
      const used = harness.budget.snapshot().used;
      terminal.send('\x11');
      await run;
      run = undefined;
      terminal.vt.dispose();
      terminal = undefined;
      harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, sessionId: id });
      assert.equal(harness.session.model?.provider, 'oms-ui-keyed');
      assert.equal(harness.session.model?.id, 'keyed');
      assert.equal(JSON.stringify(harness.session.messages), history);
      assert.equal(harness.budget.snapshot().used.tokens, used.tokens);
      assert.equal(harness.budget.snapshot().used.spendMicroUsd, used.spendMicroUsd);
    } finally {
      terminal?.send('\x11');
      await harness?.close();
      try {
        await run;
      } finally {
        terminal?.vt.dispose();
        rmSync(f.base, { recursive: true, force: true });
      }
    }
  },
);
