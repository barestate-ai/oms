import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHarnessSession, type HarnessSession } from '@oms/engine';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createHarnessFixture } from '../../engine/test-support/runtime-fixture.ts';
import { runOmsInterface } from '../src/tui/interface.ts';
import { InterfaceTerminal } from '../test-support/interface-terminal.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

/** The spinner row, or the spinner in the composer's top rule, shows while the agent works. */
const working = (screen: string): boolean => /(?:^|── )[⠁-⣿] \S/m.test(screen);
const binary = process.env.SURFPOOL_BINARY;
const image = process.env.OMS_SANDBOX_IMAGE;
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE;

function command(terminal: InterfaceTerminal, text: string): void {
  terminal.send('\x0b'); // Ctrl+K opens a command field separate from the agent draft.
  terminal.send(text);
  terminal.send('\r');
}

test(
  'one application edits files, shares its terminal with the agent, switches views and verifies on the same session',
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
    let harness: HarnessSession | undefined;
    const terminal = new InterfaceTerminal(120, 36);
    let run: Promise<void> | undefined;
    try {
      harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
      const session = harness.session;
      const id = session.sessionManager.getSessionId();
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall('read', { path: 'amount.mjs' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Read the saved workbench change.'),
      ]);
      run = runOmsInterface(harness, { terminal });
      await terminal.screen();
      terminal.send('preserved agent draft');
      command(terminal, 'open amount.mjs');
      await terminal.until(
        (screen) => screen.includes('amount.mjs') && screen.includes('export const amount = 0;'),
        30_000,
      );
      terminal.send('\x01');
      terminal.send('\x1b[200~export const amount = 10;\n\x1b[201~');
      terminal.send('\x13');
      await terminal.until((screen) => screen.includes('Saved amount.mjs'), 30_000);
      assert.equal(readFileSync(join(f.task.codeRoot, 'amount.mjs'), 'utf8'), 'export const amount = 10;\n');
      assert.equal(readFileSync(join(f.repo, 'amount.mjs'), 'utf8'), 'export const amount = 0;\n');
      assert.equal(f.faux.state.callCount, 0);
      terminal.send('\x1b[13~');
      await terminal.until((screen) => screen.includes('preserved agent draft') && !working(screen));
      terminal.send('\x1b[13~');
      await terminal.until((screen) => screen.includes('export const amount = 10;'));
      command(terminal, 'terminal');
      await terminal.until((screen) => screen.includes('■ stop'), 30_000);
      terminal.send("printf 'shared-terminal-ready\\n'\r");
      await terminal.until((screen) => screen.includes('shared-terminal-ready'), 30_000);
      terminal.send('\x1b[13~');
      await terminal.until((screen) => screen.trim() !== '' && !working(screen));
      terminal.send('\x0c');
      terminal.send('\x01');
      terminal.send('Read the current amount.');
      terminal.send('\r');
      // Real sandbox tools may take longer than the UI fixture's per-render wait.
      const settled = new Promise<void>((resolve) => {
        const unsubscribe = session.subscribe((event) => {
          if (event.type === 'agent_settled') {
            unsubscribe();
            resolve();
          }
        });
      });
      await settled;
      assert.equal(f.faux.state.callCount, 2);
      assert.ok(
        session.messages.some(
          (message) =>
            message.role === 'toolResult' &&
            message.content.some((part) => part.type === 'text' && part.text.includes('export const amount = 10;')),
        ),
      );
      terminal.send('\x1b[13~');
      await terminal.until((screen) => screen.includes('■ stop') && screen.includes('export const amount = 10;'));
      assert.equal(harness.session, session);
      assert.equal(session.sessionManager.getSessionId(), id);
      await assert.rejects(harness.verify('fixture'), /Stop terminal before verification/);
      command(terminal, 'terminal stop');
      await terminal.until((screen) => screen.includes('▸ start'), 30_000);
      const result = await harness.verify('fixture');
      assert.equal(result.result.closed, true);
      assert.equal(session.sessionManager.getSessionId(), id);
      command(terminal, 'status');
      terminal.send('\x11');
      await run;
      run = undefined;
    } finally {
      terminal.send('\x11');
      terminal.send('\x11');
      await harness?.close();
      try {
        await run;
      } finally {
        terminal.vt.dispose();
        rmSync(f.base, { recursive: true, force: true });
      }
    }
  },
);
