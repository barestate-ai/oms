import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { HarnessSession, HarnessVerification } from '@oms/engine';
import { getKeybindings, resetCapabilitiesCache, setCapabilities } from '@earendil-works/pi-tui';
import { runOmsInterface } from '../src/tui/interface.ts';
import { getTheme } from '../src/tui/theme.ts';
import { Conversation } from '../src/tui/transcript.ts';
import { barrier, InterfaceTerminal } from '../test-support/interface-terminal.ts';
import { chatFixture, clickText, fixture, quit, withHelpers } from '../test-support/fake-session.ts';

/** A turn or command is running: the spinner row (a braille frame and what it is doing) sits above the composer. */
const working = (screen: string): boolean => /(?:^|── )[⠁-⣿] \S/m.test(screen);
/** The interface has drawn and nothing is running. A toast may be replacing the status row's hints for a moment. */
const idle = (screen: string): boolean => screen.trim() !== '' && !working(screen);

test('pointer navigation controls switch the same session without submitting its draft', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  const session = f.harness.session;
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((screen) => screen.includes('chat'));
    terminal.send('preserve pointer draft');
    const before = await terminal.until((screen) => screen.includes('workbench') && screen.includes('chat'));
    clickText(terminal, before, 'workbench');
    const editor = await terminal.until((screen) => screen.includes('No file open'));
    assert.equal(f.harness.session, session);
    assert.equal(editor.includes('preserve pointer draft'), false);
    clickText(terminal, editor, 'chat');
    await terminal.until((screen) => screen.includes('preserve pointer draft'));
    assert.deepEqual(f.prompts, []);
    assert.equal(f.closed(), false);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('cancelled workbench toolbar SGR gestures preserve composer focus and draft typing', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  const run = runOmsInterface(f.harness, { terminal, view: 'workbench' });
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x0c');
    terminal.send('composer draft');
    const before = await terminal.until((screen) => screen.includes('composer draft'));
    const rows = before.split('\n');
    const y = rows.findIndex((row) => row.includes('New') && row.includes('Save'));
    assert.ok(y >= 0, 'workbench toolbar is visible alongside the composer');
    const x = rows[y]!.indexOf('New') + 1;
    terminal.send(`\x1b[<0;${x + 1};${y + 1}M`);
    terminal.send(' after press');
    await terminal.until((screen) => screen.includes('composer draft after press'));
    terminal.send(`\x1b[<32;${x + 2};${y + 1}M`);
    terminal.send(`\x1b[<0;${x + 2};${y + 1}m`);
    terminal.send(' after drag');
    await terminal.until((screen) => screen.includes('composer draft after press after drag'));
    assert.deepEqual(f.prompts, []);
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    assert.deepEqual(f.prompts, ['composer draft after press after drag']);
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('compact-start resize restores the full chrome and keeps the draft, Enter sends and Esc interrupts', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(40, 12);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((screen) => idle(screen) || screen.includes('❯'));
    terminal.send('resized composer draft');
    await terminal.until((screen) => screen.includes('resized composer draft'));
    terminal.setSize(80, 24);
    const expanded = await terminal.until((screen) => idle(screen));
    assert.ok(expanded.includes('resized composer draft'));
    assert.doesNotMatch(expanded, /\[ [^\]]+ \]/, 'no bracket buttons');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    assert.deepEqual(f.prompts, ['resized composer draft']);
    await terminal.until((screen) => working(screen));
    terminal.send('\x1b');
    await terminal.until(() => f.abortRequested());
    f.abortGate.resolve();
    f.promptGate.resolve();
    await terminal.until((screen) => idle(screen));
    terminal.setSize(40, 12);
    await terminal.until((screen) => !working(screen));
    terminal.send('compact typing');
    await terminal.until((screen) => screen.includes('compact typing'));
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

for (const [columns, rows] of [
  [40, 12],
  [80, 24],
  [120, 36],
] as const) {
  test(`global slash navigation preserves editor text and hidden agent draft at ${columns}x${rows}`, async () => {
    const f = fixture();
    const terminal = new InterfaceTerminal(columns, rows);
    let saved = '';
    f.harness.files = {
      ...f.harness.files,
      read: async () => ({ bytes: Buffer.from('SOURCE\nsecond\nthird'), revision: 'r1' }),
      write: async (_path, bytes) => {
        saved = Buffer.from(bytes).toString('utf8');
        return 'r2';
      },
    };
    const run = runOmsInterface(f.harness, { terminal });
    try {
      await terminal.until((screen) => screen.includes('❯'));
      terminal.send('agent draft 界');
      terminal.send('\x0b');
      terminal.send('open file.ts');
      terminal.send('\r');
      const editor = await terminal.until((screen) => screen.includes('SOURCE'));
      assert.ok(!editor.includes('agent draft 界'), 'inactive composer must not occupy editor space');
      // Hints give way to the facts on a narrow row; from 80 columns the editor offers the command menu.
      if (columns >= 80) assert.ok(editor.includes('ctrl+k commands'), 'global command entry stays discoverable');
      terminal.send('/');
      terminal.send('\t');
      terminal.send('\x0b');
      terminal.send('theme');
      terminal.send('\r');
      await terminal.until((screen) => screen.includes('Filter:'));
      terminal.send('\x1b');
      terminal.send('X');
      terminal.send('\x13');
      await terminal.until(() => saved.includes('X'));
      assert.equal(saved, '/\tXSOURCE\nsecond\nthird');
      terminal.send('\x0b');
      terminal.send('harness');
      terminal.send('\r');
      await terminal.until((screen) => screen.includes('agent draft 界'));
      terminal.send('!');
      terminal.send('\r');
      await terminal.until(() => f.prompts.length === 1);
      assert.deepEqual(f.prompts, ['agent draft 界!']);
    } finally {
      f.abortGate.resolve();
      f.promptGate.resolve();
      terminal.send('\x11');
      terminal.send('\x11');
      await run;
      terminal.vt.dispose();
    }
  });
}

test('read-only status and help remain reachable during work without dispatching or replacing the draft', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(80, 24);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('running');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    terminal.send('retained draft');
    terminal.send('\x1b/');
    terminal.send('status');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('8800') && screen.includes('known'));
    terminal.send('\x1b/');
    terminal.send('help');
    terminal.send('\r');
    // The help ends with the keyboard section; the conversation follows its end.
    await terminal.until((screen) => screen.includes('F6 optionally cycles panes'));
    terminal.send('\x1b');
    terminal.send('!');
    await terminal.until((screen) => screen.includes('retained draft!'));
    assert.deepEqual(f.prompts, ['running']);
    assert.equal(f.abortRequested(), false);
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('terminal slash, Tab, Escape and Ctrl+C stay child input while global navigation is isolated', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(40, 12);
  const exit = barrier<{
    exitCode: number;
    stdout: string;
    stderr: string;
    cancelled: boolean;
    timedOut: boolean;
    truncated: boolean;
  }>();
  const bytes: Buffer[] = [];
  f.harness.startTerminal = async () => ({
    write: (data) => {
      bytes.push(Buffer.from(data));
    },
    resize() {},
    subscribe: () => () => {},
    exited: exit.promise,
    close: async () => {},
  });
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/terminal');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('running'));
    terminal.send('/');
    terminal.send('\t');
    terminal.send('\x1b');
    terminal.send('\x03');
    terminal.send('\x1b/');
    terminal.send('help');
    terminal.send('\x1b');
    terminal.send('x');
    await terminal.until(() => Buffer.concat(bytes).toString('utf8').endsWith('x'));
    assert.equal(Buffer.concat(bytes).toString('utf8'), '/\t\x1b\x03x');
    assert.equal(f.closed(), false);
    assert.deepEqual(f.prompts, []);
  } finally {
    exit.resolve({ exitCode: 0, stdout: '', stderr: '', cancelled: false, timedOut: false, truncated: false });
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('short workbench keeps focused file content visible while editing', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(40, 12);
  f.harness.files = {
    ...f.harness.files,
    read: async () => ({ bytes: Buffer.from('VISIBLE_SOURCE'), revision: 'r1' }),
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/open file.ts');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('VISIBLE_SOURCE'));
    terminal.send('X');
    await terminal.until((screen) => screen.includes('XVISIBLE_SOURCE'));
    terminal.send('\x11');
    await terminal.screen();
    assert.equal(f.closed(), false);
    terminal.send('\x11');
    await run;
  } finally {
    terminal.send('\x11');
    terminal.send('\x11');
    await run;
    terminal.vt.dispose();
  }
});

test('late file opening cannot steal the newer composer focus', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const gate = barrier<void>();
  f.harness.files = {
    ...f.harness.files,
    read: async () => {
      await gate.promise;
      return { bytes: Buffer.from('ORIGINAL_SOURCE'), revision: 'r1' };
    },
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/open file.ts');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('Opening file.ts'));
    terminal.send('\x0c');
    terminal.send('new prompt');
    gate.resolve();
    await terminal.until((screen) => screen.includes('ORIGINAL_SOURCE'));
    terminal.send('!');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    assert.deepEqual(f.prompts, ['new prompt!']);
  } finally {
    gate.resolve();
    f.abortGate.resolve();
    f.promptGate.resolve();
    terminal.send('\x11');
    terminal.send('\x11');
    await run;
    terminal.vt.dispose();
  }
});

test('view switching during agent work preserves the live session, pending draft and request count', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const session = f.harness.session;
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('running request');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    terminal.send('next draft 界🙂');
    terminal.send('\x1b[13~');
    await terminal.until((screen) => screen.includes('No file open') && !screen.includes('next draft 界🙂'));
    assert.equal(f.harness.session, session);
    assert.equal(f.closed(), false);
    assert.equal(f.abortRequested(), false);
    assert.deepEqual(f.prompts, ['running request']);
    terminal.send('\x1b[13~');
    await terminal.until((screen) => screen.includes('next draft 界🙂') && !screen.includes('No file open'));
    f.promptGate.resolve();
    await terminal.until((screen) => idle(screen));
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 2);
    assert.deepEqual(f.prompts, ['running request', 'next draft 界🙂']);
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('slash command discovery works without a model and never dispatches the draft', async () => {
  const f = fixture();
  f.model(false);
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/');
    await terminal.until(
      (screen) => screen.includes('/model') && screen.includes('/connect') && screen.includes('/workbench'),
    );
    assert.deepEqual(f.prompts, []);
    assert.deepEqual(f.messages, []);
    assert.equal(f.closed(), false);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('multiline setup searches stay in the single-line picker without closing the task', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  const outcome = run.then(
    () => undefined,
    (error) => error,
  );
  try {
    await terminal.screen();
    terminal.send('\x1b[200~/model Local\nprovider\x1b[201~');
    terminal.send('\r');
    await Promise.race([
      terminal.until((screen) => screen.includes('Local provider') && screen.includes('Filter: Local provider')),
      outcome.then((error) => {
        throw error ?? new Error('Setup unexpectedly closed the task');
      }),
    ]);
    assert.equal(f.closed(), false);
    assert.deepEqual(f.prompts, []);
  } finally {
    terminal.send('\x11');
    await outcome;
    terminal.vt.dispose();
  }
});

test('slash filtering and Tab completion open setup without a model request', async () => {
  const f = fixture();
  f.model(false);
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/co');
    terminal.send('\t');
    await terminal.until((screen) => screen.includes('/connect '));
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('Other provider'));
    terminal.send('\x1b');
    terminal.send('returned draft');
    await terminal.until((screen) => screen.includes('returned draft'));
    assert.deepEqual(f.prompts, []);
    assert.deepEqual(f.messages, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('picker page navigation reaches catalog boundaries without wrapping at a narrow size', async () => {
  const f = fixture();
  f.model(false);
  f.harness.listModels = () =>
    Array.from({ length: 9 }, (_, index) => ({
      provider: 'local',
      id: `variant-${index}`,
      name: `Variant ${index}`,
      configured: true,
    }));
  const terminal = new InterfaceTerminal(40, 12);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('\x1bOS');
    await terminal.until((screen) => screen.includes('Local provider'));
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('variant-0'));
    for (let index = 0; index < 20; index++) terminal.send('\x1b[6~');
    terminal.send('\r');
    await terminal.until(() => f.harness.session.model?.id === 'variant-8');
    terminal.send('\x1bOS');
    await terminal.until((screen) => screen.includes('Local provider'));
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('variant-0'));
    for (let index = 0; index < 20; index++) terminal.send('\x1b[5~');
    terminal.send('\r');
    await terminal.until(() => f.harness.session.model?.id === 'variant-0');
    assert.deepEqual(f.prompts, []);
    assert.deepEqual(f.messages, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

for (const dismissal of ['\x1b', '\x0b']) {
  test(`narrow setup dismissal ${JSON.stringify(dismissal)} preserves the draft without leaking keys into undo`, async () => {
    const f = fixture();
    f.model(false);
    const terminal = new InterfaceTerminal(40, 12);
    const run = runOmsInterface(f.harness, { terminal });
    const secret = 'synthetic-discarded-provider-key';
    try {
      await terminal.screen();
      terminal.send('retain draft 界🙂');
      terminal.send('\x1bOS');
      await terminal.until((screen) => screen.includes('Local provider'));
      terminal.send('other');
      terminal.send('\r');
      await terminal.until((screen) => screen.includes('Secret:') && screen.includes('other'));
      terminal.send(`\x1b[200~${secret}\x1b[201~`);
      await terminal.until((screen) => screen.includes('••••'));
      assert.equal(terminal.output.includes(secret), false);
      terminal.send(dismissal);
      if (dismissal === '\x0b') {
        await terminal.until((screen) => screen.includes('/workbench'));
        terminal.send('\x1b');
      }
      await terminal.until((screen) => screen.includes('retain draft 界🙂'));
      terminal.send('\x1a');
      await terminal.screen();
      assert.equal(terminal.output.includes(secret), false);
      terminal.send('\x19');
      await terminal.until((screen) => screen.includes('retain draft 界🙂'));
      terminal.send('!');
      terminal.send('\x1bOS');
      await terminal.until((screen) => screen.includes('Local provider'));
      terminal.send('local');
      terminal.send('\r');
      await terminal.until((screen) => screen.includes('local/test-model'));
      terminal.send('\r');
      await terminal.until((screen) => screen.includes('retain draft 界🙂!'));
      terminal.send('\r');
      await terminal.until(() => f.prompts.length === 1);
      assert.deepEqual(f.prompts, ['retain draft 界🙂!']);
      assert.equal(JSON.stringify(f.messages).includes(secret), false);
    } finally {
      f.abortGate.resolve();
      f.promptGate.resolve();
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

test('Escape dismisses slash discovery without aborting the running session', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('current request');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    terminal.send('/');
    await terminal.until((screen) => screen.includes('/workbench'));
    terminal.send('\x1b');
    await terminal.screen();
    assert.equal(f.abortRequested(), false);
    assert.deepEqual(f.prompts, ['current request']);
    terminal.send('\x01');
    terminal.send('next request');
    f.promptGate.resolve();
    await terminal.until((screen) => idle(screen));
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 2);
    assert.deepEqual(f.prompts, ['current request', 'next request']);
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('credential-bearing setup failures cannot appear in the terminal or conversation', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const secret = 'synthetic-provider-key-in-upstream-error';
  let refused = false;
  f.harness.loginProvider = async (_provider, _method, interaction) => {
    await interaction.prompt({ type: 'secret', message: 'Provider API key', signal: interaction.signal });
    refused = true;
    throw new Error(secret);
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/connect other');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('Other provider'));
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('Secret:'));
    terminal.send(`\x1b[200~${secret}\x1b[201~`);
    terminal.send('\r');
    await terminal.until(() => refused);
    assert.equal(terminal.output.includes(secret), false);
    assert.equal(JSON.stringify(f.messages).includes(secret), false);
    terminal.send('\x1b');
    terminal.send('ordinary prompt');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    assert.deepEqual(f.prompts, ['ordinary prompt']);
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('task and session state render from the live consumer and verification updates actual requirement state', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/status');
    terminal.send('\r');
    const screen = await terminal.until((s) => s.includes('Calculate rent exactly'));
    assert.ok(screen.includes('rental-ledger') && screen.includes('rent') && screen.includes('test-model'));
    assert.ok(screen.includes('8800') && screen.includes('known') && screen.includes('$0.000001'));
    terminal.send('/verify R1');
    terminal.send('\r');
    await terminal.until((s) => s.includes('closed'));
    assert.deepEqual(f.verified, ['R1']);
    assert.deepEqual(f.prompts, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
  assert.equal(f.listeners.size, 0);
});

test('multiline paste and modified Enter submit losslessly; busy submit preserves the next draft', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('\x1b[200~first\r\n\t界🙂\x1b[201~');
    terminal.send('\x1b\r');
    terminal.send('last');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    assert.equal(f.prompts[0], 'first\r\n\t界🙂\nlast');
    terminal.send('next draft');
    terminal.send('\r');
    await terminal.until((s) => s.includes('next draft'));
    assert.equal(f.prompts.length, 1);
    f.promptGate.resolve();
    await terminal.until((s) => idle(s));
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 2);
    assert.equal(f.prompts[1], 'next draft');
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('with nothing connected the status line asks to connect instead of naming the default model', async () => {
  const f = fixture();
  f.identity({ provider: 'other', id: 'default-model' });
  f.harness.listModels = () => [
    { provider: 'other', id: 'default-model', name: 'Default model', configured: false, selectable: false },
  ];
  const terminal = new InterfaceTerminal(120, 36);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    const screen = await terminal.until((s) => s.includes('no model'));
    assert.match(screen, /Run \/connect to sign in/);
    assert.doesNotMatch(screen, /default-model/);
    assert.doesNotMatch(screen, /unavailable/);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('a chosen model whose provider needs setup still shows as unavailable once another provider is connected', async () => {
  const f = fixture();
  f.identity({ provider: 'other', id: 'chosen-model' });
  f.harness.listModels = () => [
    { provider: 'local', id: 'test-model', name: 'Local model', configured: true, selectable: true },
    { provider: 'other', id: 'chosen-model', name: 'Chosen model', configured: false, selectable: false },
  ];
  const terminal = new InterfaceTerminal(120, 36);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    const screen = await terminal.until((s) => s.includes('chosen-model · unavailable'));
    assert.match(screen, /chosen-model · unavailable/);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('missing model and failed dispatch preserve the editable prompt', async () => {
  const f = fixture();
  f.model(false);
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('retain this requirement');
    terminal.send('\r');
    await terminal.until((s) => s.includes('retain this requirement') && /unavailable|no model/i.test(s));
    assert.deepEqual(f.prompts, []);
    f.model(true);
    f.failPrompt(new Error('Admission refused'));
    terminal.send('\r');
    await terminal.until((s) => s.includes('Admission refused') && s.includes('retain this requirement'));
    assert.deepEqual(f.prompts, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('stream snapshots and contextual tool results are visible without terminal control injection', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('inspect');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    const message = { role: 'assistant', content: [{ type: 'text', text: 'Investigating totals' }] };
    f.emit({ type: 'message_start', message });
    f.emit({
      type: 'message_update',
      message: { ...message, content: [{ type: 'text', text: 'Investigating totals now' }] },
    });
    await terminal.until((s) => s.includes('Investigating totals now'));
    f.emit({ type: 'tool_execution_start', toolCallId: 'tool1', toolName: 'read', args: { path: 'rent.ts' } });
    await terminal.until((s) => s.includes('rent.ts'));
    f.emit({
      type: 'tool_execution_end',
      toolCallId: 'tool1',
      toolName: 'read',
      isError: false,
      result: { content: [{ type: 'text', text: '\x1b]52;c;INJECT\x07safe result\x1b[2J' }] },
    });
    await terminal.until((s) => s.includes('1 line'));
    terminal.send('\x0f');
    await terminal.until((s) => s.includes('safe result'));
    assert.ok(!terminal.output.includes('\x1b]52;c;INJECT'));
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

for (const tab of ['\t', '\x1b[Z']) {
  test(`closed requirements at 40x12 are skipped by ${JSON.stringify(tab)} focus traversal`, async () => {
    const f = fixture();
    const terminal = new InterfaceTerminal(40, 12);
    const run = runOmsInterface(f.harness, { terminal });
    try {
      await terminal.screen();
      terminal.send('draft');
      terminal.send(tab);
      terminal.send(tab);
      terminal.send('!');
      terminal.send('\x1b[200~ pasted\x1b[201~');
      await terminal.until((s) => s.includes('draft! pasted'));
      assert.deepEqual(f.prompts, []);
      assert.deepEqual(f.messages, []);
      assert.equal(f.closed(), false);
    } finally {
      f.abortGate.resolve();
      f.promptGate.resolve();
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

for (const awaitFrame of [false, true]) {
  test(`narrow resize repairs focused requirements before ${awaitFrame ? 'the next frame' : 'immediate input'}`, async () => {
    const f = fixture();
    const terminal = new InterfaceTerminal(110, 30);
    const run = runOmsInterface(f.harness, { terminal });
    try {
      await terminal.screen();
      terminal.send('draft survives');
      terminal.send('\x1b[12~');
      terminal.send('\t');
      await terminal.until((s) => /› .*R1/.test(s));
      terminal.setSize(40, 12);
      // The sidebar gives way to the status chip in the next frame, and the focus returns to the composer.
      if (awaitFrame) await terminal.until((s) => !s.includes('requirements'));
      terminal.send('!');
      await terminal.until((s) => s.includes('draft survives!'));
      terminal.setSize(110, 30);
      await terminal.until((s) => s.includes('draft survives!') && s.includes('Reject duplicate deposits'));
      assert.deepEqual(f.prompts, []);
      assert.deepEqual(f.messages, []);
      assert.equal(f.closed(), false);
    } finally {
      f.abortGate.resolve();
      f.promptGate.resolve();
      await quit(terminal, run);
      terminal.vt.dispose();
    }
    assert.equal(f.closed(), true);
  });
}

test('agent cancellation stays busy until abort and the actual prompt both settle', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('long request');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    terminal.send('\x1b');
    await terminal.until(() => f.abortRequested());
    f.abortGate.resolve();
    terminal.send('after cancel');
    terminal.send('\r');
    await terminal.until((s) => s.includes('after cancel'));
    assert.equal(f.prompts.length, 1);
    f.promptGate.resolve();
    await terminal.until((s) => idle(s));
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 2);
    assert.equal(f.prompts[1], 'after cancel');
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('sandbox command cancellation uses the controller signal and quit awaits its true completion', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  let ended = false;
  void run.then(() => {
    ended = true;
  });
  try {
    await terminal.screen();
    terminal.send('/run sleep 3');
    terminal.send('\r');
    await terminal.until(() => f.commands.length === 1);
    terminal.send('\x03');
    await terminal.until(() => !!f.commandSignal()?.aborted);
    assert.equal(ended, false);
    assert.equal(terminal.active, true);
    f.commandGate.resolve({ exitCode: 130, stdout: '', stderr: 'cancelled', timedOut: false });
    await run;
    assert.equal(terminal.active, false);
    assert.equal(f.listeners.size, 0);
  } finally {
    terminal.send('\x03');
    f.commandGate.resolve({ exitCode: 130, stdout: '', stderr: '', timedOut: false });
    await run;
    terminal.vt.dispose();
  }
});

test('terminal startup failure rejects while removing session subscriptions and restoring owned resources', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  terminal.start = () => {
    terminal.active = true;
    throw new Error('terminal unavailable');
  };
  await assert.rejects(runOmsInterface(f.harness, { terminal }), /terminal unavailable/);
  assert.equal(terminal.active, false);
  assert.equal(f.listeners.size, 0);
  terminal.vt.dispose();
});

test('unsupported actions never dispatch and retain their draft for correction', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/unrecognized');
    terminal.send('\r');
    await terminal.until((s) => s.includes('/unrecognized') && /unsupported|unknown/i.test(s));
    assert.deepEqual(f.prompts, []);
    assert.deepEqual(f.commands, []);
    assert.deepEqual(f.verified, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('quit during verification awaits the backend outcome rather than pretending it was cancelled', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const verification = barrier<{ itemId: string; result: { closed: true } }>();
  f.harness.verify = async () => (await verification.promise) as HarnessVerification;
  const run = runOmsInterface(f.harness, { terminal });
  let ended = false;
  void run.then(() => {
    ended = true;
  });
  try {
    await terminal.screen();
    terminal.send('/verify R1');
    terminal.send('\r');
    await terminal.until((s) => /verif/i.test(s));
    terminal.send('\x03');
    await terminal.screen();
    assert.equal(ended, false);
    assert.equal(terminal.active, true);
    verification.resolve({ itemId: 'R1', result: { closed: true } });
    await run;
    assert.equal(terminal.active, false);
  } finally {
    terminal.send('\x03');
    verification.resolve({ itemId: 'R1', result: { closed: true } });
    await run;
    terminal.vt.dispose();
  }
});

test('an admitted provider error leaves the input empty so the next message starts clean', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('retry the precise request');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    f.emit({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Provider interrupted' },
    });
    f.promptGate.resolve();
    await terminal.until((s) => idle(s) && s.includes('Provider interrupted'));
    terminal.send('next');
    const screen = await terminal.until((s) => s.includes('next'));
    assert.ok(!screen.includes('retry the precise requestnext'));
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 2);
    assert.equal(f.prompts[1], 'next');
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('explicit quit invokes authoritative cleanup and rejects cleanup failure after terminal restoration', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  f.harness.close = async () => {
    throw new Error('Lease recovery required');
  };
  const run = runOmsInterface(f.harness, { terminal });
  await terminal.screen();
  terminal.send('\x03');
  await assert.rejects(run, /Lease recovery required/);
  assert.equal(terminal.active, false);
  assert.equal(f.listeners.size, 0);
  terminal.vt.dispose();
});

test('editing and resize preserve last-checked requirements while an explicit status refresh reports unavailable proof', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/requirements');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Calculate rent exactly'));
    f.harness.evaluator.read = () => ({ ok: false, issues: [] });
    terminal.send('draft during write');
    terminal.setSize(100, 28);
    await terminal.until((s) => s.includes('draft during write'));
    assert.ok((await terminal.screen()).includes('Calculate rent exactly'));
    terminal.send('\x01');
    terminal.send('/status');
    terminal.send('\r');
    await terminal.until((s) => /unavailable/i.test(s));
    assert.ok(!(await terminal.screen()).includes('0/0 verified'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('document navigation stays in the input pane and the prior global bindings return after quit', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const previousBindings = getKeybindings();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('\x1b[200~first\nlast\x1b[201~');
    terminal.send('\x1b[1;5H');
    terminal.send('START ');
    terminal.send('\x1b[1;5F');
    terminal.send(' END');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    assert.equal(f.prompts[0], 'START first\nlast END');
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
  assert.equal(getKeybindings(), previousBindings);
});

test('leaving the interface restores the main screen without dumping conversation or drafts', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  f.messages.push({ role: 'user', content: 'PRIVATE-CONVERSATION-MARKER' });
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((screen) => screen.includes('PRIVATE-CONVERSATION-MARKER'));
    terminal.send('UNSENT-PRIVATE-DRAFT');
    await terminal.until((screen) => screen.includes('UNSENT-PRIVATE-DRAFT'));
    await quit(terminal, run);
    const main = Array.from(
      { length: terminal.vt.buffer.normal.length },
      (_, row) => terminal.vt.buffer.normal.getLine(row)?.translateToString(true) ?? '',
    ).join('\n');
    assert.ok(!main.includes('PRIVATE-CONVERSATION-MARKER'));
    assert.ok(!main.includes('UNSENT-PRIVATE-DRAFT'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('a rendering failure stops an active verifier through the controller before leaving', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const started = barrier<void>();
  const backend = barrier<void>();
  f.harness.verify = async () => {
    started.resolve();
    await backend.promise;
    throw new Error('Verification stopped');
  };
  let closed = false;
  f.harness.close = async () => {
    closed = true;
    backend.resolve();
  };
  const run = runOmsInterface(f.harness, { terminal });
  const outcome = run.then(
    () => undefined,
    (error) => error,
  );
  try {
    await terminal.screen();
    terminal.send('/verify R1');
    terminal.send('\r');
    await started.promise;
    f.harness.budget.snapshot = () => {
      throw new Error('Render state failed');
    };
    terminal.setSize(100, 29);
    await terminal.until(() => closed);
    const error = await outcome;
    assert.ok(error instanceof Error && error.message.includes('Render state failed'));
    assert.equal(terminal.active, false);
  } finally {
    backend.resolve();
    terminal.send('\x11');
    await outcome;
    terminal.vt.dispose();
  }
});

test('buffered submit and Escape retain the draft without starting a prompt', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('do not dispatch');
    terminal.send('\r');
    terminal.send('\x1b');
    await terminal.until((s) => idle(s) && s.includes('do not dispatch'));
    assert.deepEqual(f.prompts, []);
    terminal.send('\x01');
    terminal.send('corrected request');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    assert.equal(f.prompts[0], 'corrected request');
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('cancellation during delayed prompt preflight aborts the actual agent and remains busy through abort settlement', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const preflight = barrier<void>();
  const entered = barrier<void>();
  const stopped = barrier<void>();
  let streaming = false;
  let effectiveAborts = 0;
  let calls = 0;
  f.harness.session.prompt = async () => {
    calls++;
    entered.resolve();
    await preflight.promise;
    streaming = true;
    f.emit({ type: 'agent_start' });
    await stopped.promise;
    streaming = false;
    f.emit({ type: 'agent_settled' });
  };
  f.harness.session.abort = async () => {
    // Like the SDK, abort before agent_start has no effect on a later run.
    if (!streaming) return;
    effectiveAborts++;
    stopped.resolve();
    await f.abortGate.promise;
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('delayed request');
    terminal.send('\r');
    await entered.promise;
    terminal.send('\x1b');
    await terminal.until((s) => s.includes('Cancelling'));
    terminal.send('\x01');
    terminal.send('newer draft');
    preflight.resolve();
    await terminal.until(() => effectiveAborts === 1);
    terminal.send('\r');
    await terminal.until((s) => s.includes('Cancelling') && s.includes('newer draft'));
    assert.equal(calls, 1);
    f.abortGate.resolve();
    await terminal.until((s) => idle(s) && s.includes('newer draft'));
  } finally {
    preflight.resolve();
    stopped.resolve();
    f.abortGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

for (const newline of ['\x1b[13;2u', '\x1b\r']) {
  test(`modified Enter ${JSON.stringify(newline)} refuses a full draft without closing or losing subsequent edits`, async () => {
    const f = fixture();
    const terminal = new InterfaceTerminal();
    const run = runOmsInterface(f.harness, { terminal });
    const outcome = run.then(
      () => undefined,
      (error) => error,
    );
    const draft = 'x'.repeat(64 * 1024);
    try {
      await terminal.screen();
      terminal.send(`\x1b[200~${draft}\x1b[201~`);
      terminal.send(newline);
      await terminal.until((s) => /refused|limit/i.test(s));
      assert.equal(f.closed(), false);
      terminal.send('\x7f');
      terminal.send('y');
      terminal.send('\r');
      await terminal.until(() => f.prompts.length === 1);
      assert.equal(f.prompts[0], draft.slice(0, -1) + 'y');
    } finally {
      f.abortGate.resolve();
      f.promptGate.resolve();
      terminal.send('\x11');
      assert.equal(await outcome, undefined);
      terminal.vt.dispose();
    }
  });
}

test('real SDK missing-auth preflight hides internal guidance while retaining an editable draft', async () => {
  const base = mkdtempSync(join(tmpdir(), 'oms-ui-auth-'));
  let session: HarnessSession['session'] | undefined;
  let terminal: InterfaceTerminal | undefined;
  let run: Promise<void> | undefined;
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(base, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider('oms-missing-auth', {
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1',
      models: [
        {
          id: 'missing-auth',
          name: 'Missing auth',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
        },
      ],
    });
    const loader = new DefaultResourceLoader({
      cwd: base,
      agentDir: base,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: base,
      agentDir: base,
      modelRuntime: runtime,
      model: runtime.getModel('oms-missing-auth', 'missing-auth')!,
      resourceLoader: loader,
      tools: [],
      sessionManager: SessionManager.inMemory(base),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    }));
    const f = fixture();
    f.harness.session = session;
    terminal = new InterfaceTerminal();
    run = runOmsInterface(f.harness, { terminal });
    await terminal.screen();
    terminal.send('keep the auth-refused draft');
    terminal.send('\r');
    const screen = await terminal.until((s) => idle(s) && s.includes('keep the auth-refused draft'));
    assert.ok(!screen.includes('/login') && !screen.includes('pi-coding-agent') && !screen.includes('providers.md'));
    assert.equal(session.messages.length, 0);
    terminal.send('!');
    await terminal.until((s) => s.includes('keep the auth-refused draft!'));
  } finally {
    terminal?.send('\x11');
    await run;
    session?.dispose();
    terminal?.vt.dispose();
    rmSync(base, { recursive: true, force: true });
  }
});

test('the real SDK default placeholder cannot dispatch, mutate conversation, or prevent local work', async () => {
  const base = mkdtempSync(join(tmpdir(), 'oms-ui-unconfigured-'));
  let session: HarnessSession['session'] | undefined;
  let terminal: InterfaceTerminal | undefined;
  let run: Promise<void> | undefined;
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(base, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    // Isolate this no-model startup from credentials present in the test runner's environment.
    runtime.getAvailable = async () => [];
    runtime.streamSimple = () => {
      throw new Error('Unconfigured startup must never reach a provider');
    };
    const loader = new DefaultResourceLoader({
      cwd: base,
      agentDir: base,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: base,
      agentDir: base,
      modelRuntime: runtime,
      resourceLoader: loader,
      tools: [],
      sessionManager: SessionManager.inMemory(base),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    }));
    assert.equal(session.model?.provider, 'unknown');
    assert.equal(session.model?.id, 'unknown');
    let promptCalls = 0;
    const prompt = session.prompt.bind(session);
    session.prompt = async (...args) => {
      promptCalls++;
      return prompt(...args);
    };
    const f = fixture();
    f.harness.session = session;
    terminal = new InterfaceTerminal();
    run = runOmsInterface(f.harness, { terminal });
    const startup = await terminal.screen();
    assert.ok(!startup.includes('unknown/unknown'));
    terminal.send('retain default-model draft');
    terminal.send('\r');
    await terminal.until((s) => s.includes('retain default-model draft'));
    terminal.send('\r');
    terminal.send('!');
    const retained = await terminal.until((s) => s.includes('retain default-model draft!'));
    assert.equal(promptCalls, 0);
    assert.equal(session.messages.length, 0);
    assert.ok(!retained.includes('agent failed') && !terminal.output.includes('/login'));
    terminal.send('\x1b[12~');
    terminal.send('\t');
    terminal.send('\t');
    terminal.send('\x1b[H');
    const conversation = await terminal.screen();
    assert.equal(
      conversation.split('retain default-model draft!').length - 1,
      1,
      'the retained draft must not also be appended to conversation',
    );
    terminal.send('\t');
    terminal.send('\x01');
    terminal.send('/status');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Task: rent'));
    terminal.send('/verify R1');
    terminal.send('\r');
    await terminal.until(() => f.verified.length === 1);
    assert.deepEqual(f.verified, ['R1']);
    assert.equal(promptCalls, 0);
    assert.equal(session.messages.length, 0);
  } finally {
    terminal?.send('\x11');
    await run;
    session?.dispose();
    terminal?.vt.dispose();
    rmSync(base, { recursive: true, force: true });
  }
});

for (const identity of [
  { provider: '', id: 'configured-id' },
  { provider: 'local', id: '' },
  { provider: 'unknown', id: 'configured-id' },
  { provider: 'local', id: 'unknown' },
]) {
  test(`unconfigured model identity ${JSON.stringify(identity)} retains the editable draft`, async () => {
    const f = fixture();
    f.identity(identity);
    const terminal = new InterfaceTerminal();
    const run = runOmsInterface(f.harness, { terminal });
    try {
      await terminal.screen();
      terminal.send('draft');
      terminal.send('\r');
      terminal.send('!');
      await terminal.until((s) => s.includes('draft!'));
      assert.deepEqual(f.prompts, []);
      assert.deepEqual(f.messages, []);
    } finally {
      f.abortGate.resolve();
      f.promptGate.resolve();
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

test('an SDK missing-auth refusal keeps recovery instructions in the notice', async () => {
  const f = chatFixture();
  f.failPrompt(
    new Error(
      'No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n/internal/node_modules/pi-coding-agent/docs/providers.md',
    ),
  );
  const terminal = new InterfaceTerminal(80, 24);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('auth draft');
    terminal.send('\r');
    const screen = await terminal.until((s) =>
      s.split('\n').slice(-3, -1).join(' ').includes('Run /connect to sign in or /model to choose a model.'),
    );
    const notice = screen
      .split('\n')
      .slice(-3, -1)
      .map((line) => line.trim())
      .join(' ');
    assert.match(notice, /Your draft is kept\. Authentication is unavailable for local\./);
    assert.doesNotMatch(notice, /agent failed|\/login|\/internal\//);
    assert.deepEqual(f.prompts, []);
    terminal.send('!');
    await terminal.until((s) => s.includes('auth draft!'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

for (const diagnostic of [
  'No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /internal/node_modules/pi-coding-agent/docs/providers.md\n  /internal/node_modules/pi-coding-agent/docs/models.md',
  'Authentication failed for "local". Credentials may have expired or network is unavailable. Run \'/login local\' to re-authenticate.',
]) {
  test(`known SDK authentication refusal is projected as supported configuration guidance: ${diagnostic.split('\n')[0]}`, async () => {
    const f = fixture();
    f.failPrompt(new Error(diagnostic));
    const terminal = new InterfaceTerminal();
    const run = runOmsInterface(f.harness, { terminal });
    try {
      await terminal.screen();
      terminal.send('auth draft');
      terminal.send('\r');
      const screen = await terminal.until((s) => idle(s) && s.includes('auth draft'));
      assert.ok(!screen.includes('/login') && !screen.includes('/internal/') && !screen.includes('providers.md'));
      terminal.send('!');
      await terminal.until((s) => s.includes('auth draft!'));
      assert.deepEqual(f.messages, []);
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

test('a large multiline diagnostic stays once in contextual conversation, not in physical chrome rows', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(110, 30);
  const diagnostic = [
    'DIAGNOSTIC-BEGIN /project/login/problem.ts',
    ...Array.from({ length: 55 }, (_, i) => `detail-${i}`),
    'DIAGNOSTIC-END /project/models.md',
  ].join('\n');
  f.failPrompt(new Error(diagnostic));
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('editable diagnostic draft');
    terminal.send('\r');
    const summary = await terminal.until((s) => s.includes('DIAGNOSTIC-BEGIN') && s.includes('ctrl+o to expand'));
    assert.ok(!summary.includes('DIAGNOSTIC-END'), 'the error is a few rows until Ctrl+O opens it');
    terminal.send('\x0f');
    const screen = await terminal.until((s) => s.includes('DIAGNOSTIC-END'));
    const rows = screen.split('\n');
    assert.ok(rows[0]?.includes('rental-ledger'), 'workspace header must remain at the top of the parsed viewport');
    assert.ok(screen.includes('budget 0% left'), 'a nearly spent budget shows in the status row');
    assert.ok(screen.includes('editable diagnostic draft'));
    assert.equal(screen.split('DIAGNOSTIC-END').length - 1, 1);
    assert.ok(!rows.at(-1)?.includes('detail-') && !rows.at(-1)?.includes('DIAGNOSTIC'));
    terminal.send('!');
    await terminal.until((s) => s.includes('editable diagnostic draft!'));
    terminal.send('\x1b[12~');
    terminal.send('\t');
    terminal.send('\t');
    terminal.send('\x1b[H');
    const start = await terminal.until((s) => s.includes('DIAGNOSTIC-BEGIN'));
    assert.ok(start.includes('/project/login/problem.ts'), 'unrelated user paths must remain available');
    terminal.send('\x1b[F');
    assert.ok((await terminal.until((s) => s.includes('DIAGNOSTIC-END'))).includes('/project/models.md'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('untrusted metadata cannot add physical rows to the header, model badge, or requirement chrome', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(110, 30);
  f.identity({ provider: 'local\nprovider', id: 'test\nmodel' });
  Object.assign(f.harness.workspace, { root: '/fixtures/repo\nmetadata' });
  Object.assign(f.harness.task, { id: 'rent\ntask' });
  f.harness.session.sessionManager.getSessionId = () => 'session\nmetadata';
  const state = f.harness.evaluator.read();
  assert.ok(state.ok);
  Object.assign(state.value.items[0]!, { title: 'Calculate\nrent exactly', id: 'R1\nmetadata' });
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/requirements');
    terminal.send('\r');
    const screen = await terminal.until((s) => s.includes('Calculate'));
    assert.ok(screen.split('\n')[0]?.includes('repo metadata'));
    assert.ok(screen.includes('test model · ask'), 'the model name sits on the composer rule, on one row');
    assert.ok(screen.includes('Calculate rent exactly'));
    assert.ok(screen.includes('/ commands'));
    terminal.send('usable composer');
    await terminal.until((s) => s.includes('usable composer'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('an admitted error is displayed once and cannot replace a newer editable draft', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(110, 36);
  const diagnostic = 'ONCE-DIAGNOSTIC\n/project/login/source.ts\noriginal provider detail';
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('submitted request');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    terminal.send('newer draft');
    f.emit({
      type: 'message_start',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: diagnostic },
    });
    f.emit({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: diagnostic },
    });
    f.promptGate.resolve();
    const screen = await terminal.until(
      (s) => idle(s) && s.includes('newer draft') && s.includes('original provider detail'),
    );
    assert.equal(screen.split('ONCE-DIAGNOSTIC').length - 1, 1);
    assert.ok(!screen.split('\n').at(-1)?.includes('ONCE-DIAGNOSTIC'));
    terminal.send('!');
    await terminal.until((s) => s.includes('newer draft!'));
    assert.deepEqual(f.prompts, ['submitted request']);
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('palette switching during live work preserves the session, editable draft and request count', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const changes: string[] = [];
  const run = runOmsInterface(f.harness, { terminal, theme: 'gruvbox', onThemeChange: (theme) => changes.push(theme) });
  const liveSession = f.harness.session;
  const foreground = () =>
    terminal.vt.buffer.active
      .getLine(0)
      ?.getCell(terminal.columns - 1)
      ?.getFgColor();
  try {
    await terminal.until((screen) => screen.includes('rental-ledger'));
    assert.equal(foreground(), Number.parseInt(getTheme('gruvbox')!.colors.foreground.slice(1), 16));
    terminal.send('long request');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    terminal.send('next draft 界🌱');
    const messages = JSON.stringify(f.messages);
    terminal.send('\x1b[19~');
    const screen = await terminal.until(
      (s) =>
        s.includes('next draft 界🌱') &&
        foreground() === Number.parseInt(getTheme('catppuccin')!.colors.foreground.slice(1), 16),
    );
    assert.ok(screen.includes('test-model'));
    assert.equal(f.harness.session, liveSession);
    assert.equal(JSON.stringify(f.messages), messages);
    assert.deepEqual(f.prompts, ['long request']);
    assert.equal(f.closed(), false);
    assert.deepEqual(changes, ['catppuccin']);
    terminal.send('!');
    await terminal.until((s) => s.includes('next draft 界🌱!'));
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('theme commands and requirement toggles are local actions and invalid themes retain their editable command', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal, theme: 'nord' });
  const foreground = () =>
    terminal.vt.buffer.active
      .getLine(0)
      ?.getCell(terminal.columns - 1)
      ?.getFgColor();
  try {
    await terminal.screen();
    terminal.send('/theme dracula');
    terminal.send('\r');
    await terminal.until(() => foreground() === Number.parseInt(getTheme('dracula')!.colors.foreground.slice(1), 16));
    terminal.send('/theme not-a-theme');
    terminal.send('\r');
    await terminal.until((s) => s.includes('/theme not-a-theme'));
    terminal.send('!');
    await terminal.until((s) => s.includes('/theme not-a-theme!'));
    assert.equal(foreground(), Number.parseInt(getTheme('dracula')!.colors.foreground.slice(1), 16));
    terminal.send('\x01');
    terminal.send('/requirements');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Reject duplicate deposits'));
    terminal.send('/requirements');
    terminal.send('\r');
    await terminal.until((s) => !s.includes('Reject duplicate deposits'));
    assert.deepEqual(f.prompts, []);
    assert.deepEqual(f.messages, []);
    assert.equal(f.closed(), false);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

for (const [columns, rows] of [
  [40, 12],
  [80, 24],
  [120, 40],
] as const) {
  test(`themed frame at ${columns}x${rows} keeps workspace, budget warnings and the composer usable`, async () => {
    const f = fixture();
    const terminal = new InterfaceTerminal(columns, rows);
    const run = runOmsInterface(f.harness, { terminal });
    try {
      await terminal.screen();
      terminal.send('viewport draft');
      const screen = await terminal.until((s) => s.includes('viewport draft'));
      // The header names the workspace from 30 rows; on a shorter terminal the empty state (and the status row when
      // there is room) does.
      const rowsOnScreen = screen.split('\n');
      assert.ok((rows >= 30 ? rowsOnScreen[0] : screen)?.includes('rental-ledger'));
      assert.ok(screen.includes('budget 0% left'), 'a nearly spent budget shows in the status row');
      for (let row = 0; row < rows; row++) {
        const edge = terminal.vt.buffer.active.getLine(row)?.getCell(columns - 1);
        assert.ok(edge?.isBgRGB(), `row ${row} paints the theme background`);
        assert.equal(edge?.getBgColor(), Number.parseInt(getTheme('oms-ember')!.background.slice(1), 16));
      }
      terminal.send('\x1b[19~');
      terminal.send('!');
      await terminal.until((s) => s.includes('viewport draft!'));
      assert.deepEqual(f.prompts, []);
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

test('resumed authentication diagnostics are projected without rewriting canonical session history', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const diagnostic =
    'No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n/internal/node_modules/pi-coding-agent/docs/providers.md';
  f.messages.push({ role: 'assistant', content: [], stopReason: 'error', errorMessage: diagnostic });
  const history = JSON.stringify(f.messages);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    const screen = await terminal.until((s) => s.includes('rental-ledger'));
    assert.ok(!screen.includes('/login') && !screen.includes('/internal/') && !screen.includes('providers.md'));
    assert.equal(JSON.stringify(f.messages), history);
    terminal.send('history remains editable');
    await terminal.until((s) => s.includes('history remains editable'));
    assert.deepEqual(f.prompts, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

for (const restored of [false, true]) {
  test(`${restored ? 'restored' : 'streamed'} long assistant content reserves space for its failure diagnostic`, async () => {
    const f = fixture();
    const terminal = new InterfaceTerminal();
    const message = {
      role: 'assistant',
      provider: 'local',
      content: [{ type: 'text', text: 'body detail\n'.repeat(2400) }],
      stopReason: 'error',
      errorMessage: 'RESERVED-FAILURE: provider interrupted this request',
    };
    if (restored) f.messages.push(message);
    const run = runOmsInterface(f.harness, { terminal });
    try {
      if (!restored) {
        await terminal.screen();
        terminal.send('retry long output');
        terminal.send('\r');
        await terminal.until(() => f.prompts.length === 1);
        const canonical = JSON.stringify(f.messages);
        f.emit({ type: 'message_start', message: { ...message, errorMessage: undefined } });
        f.emit({ type: 'message_end', message });
        f.promptGate.resolve();
        await terminal.until((s) => idle(s));
        assert.equal(JSON.stringify(f.messages), canonical);
      }
      const screen = await terminal.until((s) => s.includes('RESERVED-FAILURE:'));
      assert.ok(screen.includes('provider interrupted this request'));
      assert.equal(screen.split('RESERVED-FAILURE:').length - 1, 1);
      if (restored) assert.deepEqual(f.messages, [message]);
    } finally {
      f.abortGate.resolve();
      f.promptGate.resolve();
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

test('assistant failure projection stays bounded while preserving body and diagnostic context', () => {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'BODY-CONTEXT ' + 'x'.repeat(24_000) }],
    errorMessage: 'FAILURE-CONTEXT ' + 'y'.repeat(24_000),
  };
  const canonical = JSON.stringify(message);
  const display = new Conversation([message])
    .render(120)
    .join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ');
  assert.ok(display.includes('BODY-CONTEXT'));
  assert.ok(display.includes('FAILURE-CONTEXT'));
  assert.ok(display.includes('[display truncated]'));
  assert.ok(display.length <= 12_300, `one displayed entry must remain bounded, received ${display.length} characters`);
  assert.equal(JSON.stringify(message), canonical);
});

for (const diagnostic of [
  'No API key found for anthropic.\n\nUse /login to log into a provider via OAuth or API key. See:\n/internal/node_modules/pi-coding-agent/docs/providers.md',
  'Authentication failed for "anthropic". Credentials may have expired or network is unavailable. Run \'/login anthropic\' to re-authenticate.',
]) {
  for (const restored of [false, true]) {
    test(`${restored ? 'restored' : 'live'} assistant authentication uses its recorded provider rather than the current model: ${diagnostic.split('\n')[0]}`, async () => {
      const f = fixture();
      f.identity({ provider: 'openai', id: 'current-model' });
      const terminal = new InterfaceTerminal(110, 36);
      const message = {
        role: 'assistant',
        provider: 'anthropic',
        content: [],
        stopReason: 'error',
        errorMessage: diagnostic,
      };
      if (restored) f.messages.push(message);
      const run = runOmsInterface(f.harness, { terminal });
      try {
        if (!restored) {
          await terminal.screen();
          terminal.send('current provider draft');
          terminal.send('\r');
          await terminal.until(() => f.prompts.length === 1);
          f.emit({ type: 'message_end', message });
          f.promptGate.resolve();
        }
        const screen = await terminal.until((s) => s.includes('anthropic'));
        assert.ok(screen.includes('current-model · ask'), 'the current model badge remains unchanged');
        assert.ok(!screen.includes('/login') && !screen.includes('/internal/') && !screen.includes('providers.md'));
        if (restored) assert.deepEqual(f.messages, [message]);
        else assert.deepEqual(f.messages, [{ role: 'user', content: 'current provider draft' }]);
        terminal.send('!');
        const typed = await terminal.until((s) => s.includes('!'));
        assert.ok(!typed.includes('current provider draft!'), 'a failed send leaves an empty input');
      } finally {
        f.abortGate.resolve();
        f.promptGate.resolve();
        await quit(terminal, run);
        terminal.vt.dispose();
      }
    });
  }
}

for (const accounting of ['unknown', 'exhausted'] as const) {
  test(`a ${accounting} budget ${accounting === 'exhausted' ? 'stays visible' : 'is left to /status'} in a narrow focused editor`, async () => {
    const f = fixture();
    const terminal = new InterfaceTerminal(40, 12);
    const original = f.harness.budget.snapshot();
    f.harness.budget.snapshot = () => ({
      ...original,
      accounting: accounting === 'unknown' ? 'unknown' : 'known',
      exhausted: accounting === 'exhausted',
    });
    const run = runOmsInterface(f.harness, { terminal });
    try {
      await terminal.screen();
      terminal.send('/workbench');
      terminal.send('\r');
      const screen = await terminal.until((value) => value.includes('No file open'));
      if (accounting === 'exhausted') assert.ok(screen.includes('budget used up'));
      else
        assert.ok(
          !/budget|unknown/i.test(screen.split('\n').at(-1) ?? ''),
          'unknown accounting is not steady-state chrome',
        );
      terminal.send('\x0b');
      terminal.send('harness');
      terminal.send('\r');
      terminal.send('still editable');
      await terminal.until((value) => value.includes('still editable'));
      assert.deepEqual(f.prompts, []);
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

test('palette commands cannot consume an identical pending composer draft', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/workbench');
    terminal.send('\x0b');
    terminal.send('workbench');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x0b');
    terminal.send('harness');
    terminal.send('\r');
    terminal.send('!');
    await terminal.until((screen) => screen.includes('/workbench!'));
    assert.deepEqual(f.prompts, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('Codex authentication choices stay visible inside the 40x12 interface viewport', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(40, 12);
  const hold = barrier<void>();
  let selected = '';
  f.harness.listProviders = () => [
    { id: 'openai-codex', name: 'Codex', configured: false, apiKey: false, oauth: true },
  ];
  f.harness.loginProvider = async (_provider, _method, interaction) => {
    selected = await interaction.prompt({
      type: 'select',
      message: 'Choose login method',
      options: [
        { id: 'browser', label: 'Browser sign-in' },
        { id: 'device', label: 'Device code' },
      ],
    });
    await hold.promise;
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((screen) => idle(screen));
    terminal.send('/connect');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('Codex'));
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('Browser sign-in') && screen.includes('Device code'));
    terminal.send('\x1b[B');
    terminal.send('\r');
    await terminal.until(() => selected === 'device');
    assert.deepEqual(f.prompts, []);
  } finally {
    hold.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('dismissed slash discovery reopens after clearing and retyping before another frame', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(80, 24);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((screen) => idle(screen));
    terminal.send('/');
    await terminal.until((screen) => screen.includes('/files'));
    terminal.send('\x1b');
    await terminal.until((screen) => !screen.includes('/files'));
    terminal.send('\x01');
    terminal.send('\x7f');
    terminal.send('/');
    await terminal.until((screen) => screen.includes('/files'));
    assert.deepEqual(f.prompts, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('dirty quit at 40 columns shows its confirmation key before allowing discard', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(40, 12);
  f.harness.files = { ...f.harness.files, read: async () => ({ bytes: Buffer.from('source'), revision: 'r1' }) };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((screen) => idle(screen));
    terminal.send('/open file.ts');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('source'));
    terminal.send('X');
    terminal.send('\x11');
    const screen = await terminal.until((value) => /unsaved/i.test(value));
    assert.ok(screen.includes('Ctrl+Q'), 'discard confirmation must expose its actionable key');
    assert.equal(f.closed(), false);
    terminal.send('\x1b');
    terminal.send('\x11');
    await terminal.screen();
    assert.equal(f.closed(), false);
    terminal.send('\x11');
    await run;
  } finally {
    terminal.send('\x11');
    terminal.send('\x11');
    await run;
    terminal.vt.dispose();
  }
});

test('plain slash navigates an empty workbench and file browser without consuming the agent draft', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(40, 12);
  f.harness.files = { ...f.harness.files, list: async () => [{ path: 'one.ts', kind: 'file' }] };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((screen) => idle(screen));
    terminal.send('keep this draft');
    terminal.send('\x0b');
    terminal.send('workbench');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('/');
    terminal.send('files');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('one.ts'));
    terminal.send('/');
    terminal.send('harness');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('keep this draft'));
    terminal.send('!');
    await terminal.until((screen) => screen.includes('keep this draft!'));
    assert.deepEqual(f.prompts, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('account controls retain the same session and draft, and login cannot interrupt active work', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(110, 30);
  let logins = 0;
  f.harness.account = {
    snapshot: () => ({ state: 'signed-out', origin: 'https://oms.barestate.xyz' }),
    async refresh() {},
    searchCredential: () => undefined,
    async login() {
      logins++;
    },
    async logout() {
      return { serverRevoked: false };
    },
  };
  const session = f.harness.session;
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('retained account draft');
    terminal.send('\x0b');
    terminal.send('account');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('OMS account: signed-out'));
    terminal.send('\x1b');
    await terminal.until((screen) => screen.includes('retained account draft'));
    terminal.send('\x0b');
    terminal.send('logout');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('revocation unconfirmed'));
    terminal.send('\x1b');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    terminal.send('\x0b');
    terminal.send('login');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('Wait for current work before signing in'));
    assert.equal(logins, 0);
    assert.equal(f.harness.session, session);
    assert.deepEqual(f.prompts, ['retained account draft']);
  } finally {
    f.promptGate.resolve();
    f.abortGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

const ART_INDEX = (
  JSON.parse(readFileSync(new URL('../art/index.json', import.meta.url), 'utf8')) as {
    number: number;
    title: string;
    width: number;
    height: number;
  }[]
).map((entry) => ({ ...entry, label: `${entry.number} / ${entry.title}` }));

/** The startup art on screen: its title row, picture and glyph span, found from the title line under it. */
const CANVAS = Number.parseInt(getTheme('oms-ember')!.background.slice(1), 16);
/** The conversation's width: a task shows its requirements sidebar (34 columns and a divider) from 120 columns. */
const conversationWidth = (terminal: InterfaceTerminal): number =>
  terminal.columns >= 120 ? terminal.columns - 35 : terminal.columns;
function artOnScreen(terminal: InterfaceTerminal, screen: string) {
  const rows = screen.split('\n');
  const entry = ART_INDEX.find((candidate) => screen.includes(candidate.label));
  if (!entry) return undefined;
  const titleRow = rows.findIndex((row) => row.includes(entry.label));
  const left = rows[titleRow]!.indexOf(entry.label);
  const buffer = terminal.vt.buffer.active;
  let top = titleRow - 1,
    right = left,
    glyphs = 0,
    coloured = 0;
  const colours = new Set<number>();
  for (let y = titleRow - 2; y >= 0; y--) {
    const line = buffer.getLine(y)!;
    let rowGlyphs = 0;
    for (let x = left; x < conversationWidth(terminal) - 2; x++) {
      // inside the conversation and its scrollbar; the theme canvas is empty space
      const cell = line.getCell(x)!;
      const painted = cell.isBgRGB() && cell.getBgColor() !== CANVAS;
      if (cell.getChars().trim() === '' && !painted) continue;
      rowGlyphs++;
      right = Math.max(right, x);
      if (painted) {
        coloured++;
        colours.add(cell.getBgColor());
      }
    }
    if (!rowGlyphs) break;
    glyphs += rowGlyphs;
    top = y;
  }
  return {
    entry,
    titleRow,
    rows: titleRow - 1 - top,
    left,
    width: right - left + 1,
    glyphs,
    coloured,
    colours: colours.size,
  };
}

function distinctColours(terminal: InterfaceTerminal): number {
  const colours = new Set<number>();
  for (let y = 0; y < terminal.rows; y++) {
    for (let x = 0; x < terminal.columns; x++) {
      const cell = terminal.vt.buffer.active.getLine(y)!.getCell(x)!;
      if (cell.isFgRGB() && cell.getChars().trim()) colours.add(cell.getFgColor());
      if (cell.isBgRGB()) colours.add(cell.getBgColor());
    }
  }
  return colours.size;
}

test('an empty session opens with startup art above the placeholder, and the art scrolls away with the conversation', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(160, 50);
  const run = runOmsInterface(f.harness, { terminal, firstRun: true });
  try {
    const screen = await terminal.until((s) => !!artOnScreen(terminal, s) && s.includes('Try:'));
    const art = artOnScreen(terminal, screen)!;
    assert.ok(art.titleRow < screen.split('\n').findIndex((row) => row.includes('Try:')));
    // A third of the window at most (50 rows), so the conversation keeps the rest.
    assert.ok(art.rows >= 12 && art.rows <= Math.floor(50 / 3), `art is ${art.rows} rows`);
    assert.ok(
      Math.abs(Math.round((art.width * art.entry.height) / art.entry.width / 2) - art.rows) <= 1,
      `a ${art.width}-column art block should be about ${art.rows} rows`,
    );
    assert.ok(
      art.width <= conversationWidth(terminal) - 4 &&
        Math.abs(art.left - (conversationWidth(terminal) - art.left - art.width)) <= 4,
      `art at ${art.left}+${art.width} is not centred`,
    );
    assert.ok(
      art.coloured > 0.95 * art.glyphs && art.colours > 100,
      `${art.coloured}/${art.glyphs} glyphs coloured, ${art.colours} colours`,
    );

    const text = Array.from({ length: 60 }, (_, line) => `conversation line ${line + 1}`).join('\n');
    const message = { role: 'assistant', content: [{ type: 'text', text }] };
    f.emit({ type: 'message_start', message });
    f.emit({ type: 'message_end', message });
    const after = await terminal.until((s) => s.includes('conversation line 60'));
    assert.equal(artOnScreen(terminal, after), undefined);
    assert.ok(distinctColours(terminal) < 30, `${distinctColours(terminal)} colours remain on screen`);

    terminal.send('/help');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Keyboard'));
    terminal.send('\x1b[H');
    await terminal.until((s) => s.includes(art.entry.label));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('startup art follows the window size and is hidden when under 44 columns of picture fit in a third of the window', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(160, 50);
  const run = runOmsInterface(f.harness, { terminal, firstRun: true });
  try {
    const wide = artOnScreen(terminal, await terminal.until((s) => !!artOnScreen(terminal, s)))!;
    terminal.setSize(100, 50);
    // Wait for art that fits the new window, not for art smaller than `wide`, which may have been measured mid-draw.
    const fits = (s: string) => {
      const art = artOnScreen(terminal, s);
      return !!art && art.width <= 98 && art.rows >= 10;
    };
    const narrow = artOnScreen(terminal, await terminal.until(fits))!;
    assert.ok(narrow.width <= 98 && narrow.rows >= 10, `${narrow.width}x${narrow.rows}`);
    for (const [columns, rows] of [
      [43, 50],
      [100, 15],
      [120, 24],
    ] as const) {
      terminal.setSize(columns, rows);
      const screen = await terminal.until((s) => s.includes('Try:') && !s.includes(wide.entry.label));
      assert.ok(distinctColours(terminal) < 30, `art still drawn at ${columns}x${rows}:\n${screen}`);
    }
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/art names the picture, /art next changes it, /art off and on change the setting', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(160, 50);
  const changes: string[] = [];
  const run = runOmsInterface(f.harness, {
    terminal,
    firstRun: true,
    onStartupArtChange: (mode) => changes.push(mode),
  });
  try {
    const first = artOnScreen(terminal, await terminal.until((s) => !!artOnScreen(terminal, s)))!;
    terminal.send('/art');
    terminal.send('\r');
    await terminal.until((s) => s.includes(`${first.entry.label} · /art next · /art off`));
    terminal.send('/art next');
    terminal.send('\r');
    const second = artOnScreen(
      terminal,
      await terminal.until((s) => !!artOnScreen(terminal, s) && !s.includes(first.entry.label)),
    )!;
    assert.notEqual(second.entry.number, first.entry.number);
    terminal.send('/art off');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Startup art off') && !artOnScreen(terminal, s));
    terminal.send('/art on');
    terminal.send('\r');
    await terminal.until(
      (s) => s.includes('Startup art on') && artOnScreen(terminal, s)?.entry.number === second.entry.number,
    );
    for (const mode of ['256', 'truecolor', 'auto']) {
      terminal.send(`/art ${mode}`);
      terminal.send('\r');
      await terminal.until((s) => s.includes(`Startup art ${mode}`) && !!artOnScreen(terminal, s));
    }
    terminal.send('/art toString');
    terminal.send('\r');
    assert.deepEqual(changes, ['off', 'auto', '256', 'truecolor', 'auto']);
    assert.deepEqual(f.prompts, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/art image uploads the real picture once over Kitty graphics, places what is left of it as it scrolls, and /art off removes it', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false });
  const f = fixture();
  const terminal = new InterfaceTerminal(160, 50);
  const run = runOmsInterface(f.harness, { terminal, startupArt: 'image' });
  const uploads = () => terminal.output.split('\x1b_Ga=T,f=100').length - 1;
  try {
    const art = artOnScreen(terminal, await terminal.until((s) => !!artOnScreen(terminal, s) && uploads() === 1))!;
    const label = art.entry.label;
    assert.equal(art.coloured, 0, 'no mosaic under the picture');

    // Enough lines that the top of the picture (a third of the 50 rows) scrolls away while its bottom stays.
    const text = Array.from({ length: 36 }, (_, line) => `conversation line ${line + 1}`).join('\n');
    const message = { role: 'assistant', content: [{ type: 'text', text }] };
    f.emit({ type: 'message_start', message });
    f.emit({ type: 'message_end', message });
    await terminal.until((s) => s.includes('conversation line 36'));
    assert.equal(uploads(), 1, 'scrolling re-places the uploaded picture instead of sending it again');
    // The picture's top scrolled away: the rest is placed again, cropped (the frame keeps pi-tui from doing it).
    assert.match(terminal.output, /\x1b_Ga=p,q=2,C=1,c=\d+,i=\d+,y=\d+,h=\d+,r=\d+\x1b\\/);

    const before = terminal.output.length;
    terminal.send('/art off');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Startup art off') && !s.includes(label));
    assert.ok(terminal.output.slice(before).includes('\x1b_Ga=d,d=a'), 'the placement is deleted');
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
    resetCapabilitiesCache();
  }
});

for (const [key, expected] of [
  ['y', true],
  ['n', false],
  ['\x1b', false],
] as const) {
  test(`host approval waits in the TUI and handles ${JSON.stringify(key)}`, async () => {
    const f = fixture();
    const terminal = new InterfaceTerminal(100, 30);
    let approve: Parameters<NonNullable<HarnessSession['setHostApproval']>>[0];
    f.harness.setHostApproval = (handler) => {
      approve = handler;
    };
    const run = runOmsInterface(f.harness, { terminal, view: 'workbench' });
    try {
      await terminal.until((screen) => screen.includes('No file open'));
      assert.ok(approve);
      let settled = false;
      const pending = approve({ command: 'cat ~/.ssh/example', reasons: ['credential or wallet files'] }).then(
        (value) => {
          settled = true;
          return value;
        },
      );
      await terminal.until((screen) => screen.includes('Allow host command?') && screen.includes('Allow once'));
      assert.equal(settled, false);
      terminal.send(key);
      assert.equal(await pending, expected);
      assert.deepEqual(f.prompts, []);
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

test('host approval denies on cancellation and shutdown', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(100, 30);
  let approve: Parameters<NonNullable<HarnessSession['setHostApproval']>>[0];
  f.harness.setHostApproval = (handler) => {
    approve = handler;
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((screen) => idle(screen));
    assert.ok(approve);
    const controller = new AbortController();
    const pending = approve({ command: 'sudo true', reasons: ['sudo'] }, controller.signal);
    await terminal.until((screen) => screen.includes('Allow host command?'));
    controller.abort();
    assert.equal(await pending, false);
    const onShutdown = approve({ command: 'sudo true', reasons: ['sudo'] });
    await terminal.until((screen) => screen.includes('Allow host command?'));
    terminal.send('\x11');
    assert.equal(await onShutdown, false);
    await run;
  } finally {
    if (terminal.active) await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('a host approval from a helper names the helper', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(100, 30);
  let approve: Parameters<NonNullable<HarnessSession['setHostApproval']>>[0];
  f.harness.setHostApproval = (handler) => {
    approve = handler;
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((screen) => idle(screen));
    const pending = approve!({ command: 'python x.py', reasons: ['sudo'], requester: 'build#2' });
    await terminal.until((screen) => screen.includes('Allow host command?') && screen.includes('from build#2'));
    terminal.send('y');
    assert.equal(await pending, true);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/review runs keyless Phase A and opens counts and disclaimer in a read-only report', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  const requests: string[][] = [];
  let writes = 0;
  f.harness.files = {
    ...f.harness.files,
    write: async () => {
      writes++;
      return 'r2';
    },
  };
  const run = runOmsInterface(f.harness, {
    terminal,
    review: async (args, io) => {
      requests.push([...args]);
      io!.stderr('Static checks complete.');
      io!.report!({
        reviewId: 'fixture-review',
        confirmed: 0,
        suspected: 2,
        markdown: 'Not a professional audit\nSecurity report fixture',
      });
      return 0;
    },
  });
  try {
    await terminal.until((screen) => idle(screen));
    terminal.send('/review');
    terminal.send('\r');
    const screen = await terminal.until((screen) => screen.includes('Security report fixture'));
    assert.match(screen, /Confirmed 0 · Suspected 2/);
    assert.match(screen, /Not a professional audit/);
    assert.deepEqual(requests, [['/fixtures/task', '--phase', 'A']]);
    terminal.send('EDIT');
    terminal.send('\x13');
    await terminal.until((screen) => screen.includes('read-only'));
    assert.equal(writes, 0);
    assert.deepEqual(f.prompts, []);
    assert.deepEqual(f.commands, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('Esc cancels only cancellable work: a command, not a review or verification', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  const reviewGate = barrier<void>();
  const run = runOmsInterface(f.harness, {
    terminal,
    review: async () => {
      await reviewGate.promise;
      return 0;
    },
  });
  try {
    await terminal.until((screen) => idle(screen));
    terminal.send('/review');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('Reviewing the code'));
    // A review runs to its backend timeout: Esc is refused and says so. (The first Esc closes the command menu the
    // running command's draft still opens.)
    terminal.send('\x1b');
    terminal.send('\x1b');
    await terminal.until((screen) => screen.includes('cancellation is unavailable'));
    reviewGate.resolve();
    await terminal.until((screen) => idle(screen));
    // A sandbox command is cancellable: Esc aborts it.
    terminal.send('/run sleep 1');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('Running a command'));
    terminal.send('\x1b');
    terminal.send('\x1b');
    await terminal.until((screen) => screen.includes('Cancellation requested'));
    f.commandGate.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: true, truncated: false });
  } finally {
    reviewGate.resolve();
    f.commandGate.resolve({ exitCode: 0, stdout: '', stderr: '' });
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/web off and /web on switch the session web tools and report the call counts; no web reports unavailable', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal();
  let enabled = true;
  const sets: boolean[] = [];
  (f.harness as { web?: HarnessSession['web'] }).web = {
    enabled: () => enabled,
    set(on) {
      sets.push(on);
      enabled = on;
    },
    usage: () => ({ webSearch: 2, webFetch: 1, solanaMcp: 3, searchBy: {}, fetchBy: {} }),
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/web off');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Web off · 2 searches, 1 fetches, 3 Solana MCP calls'));
    terminal.send('/web on');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Web on ·'));
    assert.deepEqual(sets, [false, true]);
    assert.deepEqual(f.prompts, [], 'the switch never prompts the model');
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }

  const g = fixture();
  const plain = new InterfaceTerminal();
  const other = runOmsInterface(g.harness, { terminal: plain });
  try {
    await plain.screen();
    plain.send('/web on');
    plain.send('\r');
    await plain.until((s) => s.includes('Web access is not available in this session.'));
  } finally {
    await quit(plain, other);
    plain.vt.dispose();
  }
});

// ---- /goal, /clear and the deterministic Solana and inspection commands

const ok = (exitCode: number, stderr = '') => ({
  exitCode,
  stdout: '',
  stderr,
  timedOut: false,
  cancelled: false,
  truncated: false,
});

test('/goal with --check loops agent turns until the sandbox check passes, feeding the failure back', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  f.promptGate.resolve();
  let checks = 0;
  f.harness.runCommand = async (command) => {
    f.commands.push(command);
    return ok(checks++ === 0 ? 1 : 0, checks === 1 ? '2 tests failing' : '');
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/goal make the tests pass --check "npm test"');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Goal reached'));
    assert.equal(f.prompts.length, 2);
    assert.match(f.prompts[0]!, /Goal: make the tests pass/);
    assert.match(f.prompts[1]!, /2 tests failing/);
    assert.deepEqual(f.commands, ['npm test', 'npm test']);
    terminal.send('/goal');
    terminal.send('\r');
    const shown = await terminal.until((s) => s.includes('checks used 2/5'));
    assert.ok(shown.includes('Check: npm test') && shown.includes('Status: reached'));
    terminal.send('/goal clear');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Goal cleared.'));
    terminal.send('/goal');
    terminal.send('\r');
    await terminal.until((s) => s.includes('No goal set.'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/goal stops visibly at the retry cap when the check never passes', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  f.promptGate.resolve();
  let n = 0;
  f.harness.runCommand = async (command) => {
    f.commands.push(command);
    return ok(1, `failure number ${n++}`);
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/goal never works --check "false"');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Goal stopped') && s.includes('retry cap reached'));
    assert.equal(f.prompts.length, 5);
    assert.equal(f.commands.length, 5);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/goal without --check uses the task verifier, and refuses when the task has none', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  f.promptGate.resolve();
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/goal satisfy the requirement');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Goal reached'));
    assert.deepEqual(f.verified, ['R1']);
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0]!, /pinned verifier/);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }

  const g = fixture();
  const bare = new InterfaceTerminal(120, 36);
  (g.harness as { evaluator: unknown }).evaluator = { read: () => ({ ok: true, value: { items: [] } }) };
  const other = runOmsInterface(g.harness, { terminal: bare });
  try {
    await bare.screen();
    bare.send('/goal do something');
    bare.send('\r');
    await bare.until((s) => s.includes('no open requirement') && s.includes('--check'));
    assert.deepEqual(g.prompts, []);
    bare.send('/goal do something --check');
    bare.send('\r');
    await bare.until((s) => s.includes('--check needs a command'));
    assert.deepEqual(g.prompts, []);
  } finally {
    await quit(bare, other);
    bare.vt.dispose();
  }
});

test('cancelling stops a goal loop before its check runs', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  f.harness.runCommand = async (command) => {
    f.commands.push(command);
    return ok(1, 'nope');
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/goal long job --check "npm test"');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    terminal.send('\x1b');
    await terminal.until(() => f.abortRequested());
    f.abortGate.resolve();
    f.promptGate.resolve();
    await terminal.until((s) => s.includes('Goal cancelled'));
    assert.deepEqual(f.commands, []);
    assert.equal(f.prompts.length, 1);
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('while work is running only the read-only commands run; every other new command refuses', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('long request');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    for (const command of [
      '/clear',
      '/goal x --check y',
      '/test',
      '/rewind confirm',
      '/airdrop 11111111111111111111111111111111 1',
    ]) {
      terminal.send('\x01');
      terminal.send(command);
      terminal.send('\r');
      await terminal.until((s) => s.includes('Work is running') && s.includes(command));
    }
    assert.equal(f.clears(), 0);
    assert.deepEqual(f.commands, []);
    assert.equal(f.prompts.length, 1);
    terminal.send('\x01');
    terminal.send('/usage');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Tokens:') && s.includes('Spend:'));
    terminal.send('/goal');
    terminal.send('\r');
    await terminal.until((s) => s.includes('No goal set.'));
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

for (const model of ['sonnet', 'opus', 'haiku'])
  test(`/model groups Claude Code separately and selects ${model} without sending a model request`, async () => {
    const f = chatFixture();
    const terminal = new InterfaceTerminal(120, 36);
    const selections: string[] = [];
    f.harness.listProviders = () => [
      { id: 'anthropic', name: 'Claude API', configured: true, apiKey: true, oauth: false },
      { id: 'claude-code', name: 'Claude Code', configured: true, apiKey: false, oauth: true },
    ];
    f.harness.listModels = () => [
      { provider: 'anthropic', id: 'api-sonnet', name: 'Claude API Sonnet', configured: true },
      ...['sonnet', 'opus', 'haiku'].map((id) => ({
        provider: 'claude-code',
        id,
        name: `Claude Code ${id}`,
        configured: true,
      })),
    ];
    f.harness.selectModel = async (provider, id) => {
      selections.push(`${provider}/${id}`);
      f.identity({ provider, id });
    };
    const run = runOmsInterface(f.harness, { terminal });
    try {
      await terminal.screen();
      terminal.send('/model');
      terminal.send('\r');
      await terminal.until((s) => s.includes('Claude Code') && s.includes('Claude API models'));
      terminal.send('Claude Code');
      terminal.send('\r');
      const screen = await terminal.until((s) => s.includes('claude-code/sonnet'));
      for (const id of ['sonnet', 'opus', 'haiku']) assert.ok(screen.includes(`claude-code/${id}`));
      assert.equal(screen.includes('anthropic/api-sonnet'), false);
      terminal.send(model);
      terminal.send('\r');
      const ready = await terminal.until((s) => s.includes(`Native Claude chat selected: claude-code/${model}`));
      assert.match(ready, new RegExp(`${model} · ask`), 'the composer rule names the chosen model');
      assert.doesNotMatch(ready, /\/connect|\/model/);
      assert.deepEqual(selections, [`claude-code/${model}`]);
      assert.deepEqual(f.prompts, []);
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });

test('removed Claude commands never select a model or reach native lifecycle controls', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  const calls: string[] = [];
  f.harness.selectModel = async () => {
    calls.push('model');
  };
  f.harness.nativeChat = {
    status: () => ({ sessionId: 'native-old', state: 'disconnected' }),
    async reconnect() {
      calls.push('reconnect');
    },
    async reset() {
      calls.push('reset');
    },
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    for (const command of ['/claude', '/claude status', '/claude reconnect', '/claude reset']) {
      terminal.send('\x01');
      terminal.send(command);
      terminal.send('\r');
      await terminal.until((s) => s.includes('Unknown or invalid OMS command') && s.includes(command));
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(f.prompts, []);
    assert.equal(f.clears(), 0);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/session reports native Claude identity while a turn runs and /clear keeps its busy guard', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  f.identity({ provider: 'claude-code', id: 'sonnet' });
  const calls: string[] = [];
  f.harness.nativeChat = {
    status: () => ({ sessionId: 'native-thread-one', state: 'ready' }),
    async reconnect() {
      calls.push('reconnect');
    },
    async reset() {
      calls.push('reset');
    },
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('sonnet · ask'));
    terminal.send('long native request');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    terminal.send('/session');
    terminal.send('\r');
    await terminal.until((s) => s.includes('native-thread-one') && s.includes('State: ready'));
    for (const command of ['/clear']) {
      terminal.send('\x01');
      terminal.send(command);
      terminal.send('\r');
      await terminal.until((s) => s.includes('Work is running') && s.includes(command));
    }
    assert.deepEqual(calls, []);
    assert.equal(f.clears(), 0);
    assert.equal(f.prompts.length, 1);
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('native clear awaits native reset before dropping the OMS branch', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  f.identity({ provider: 'claude-code', id: 'sonnet' });
  f.messages.push({ role: 'user', content: 'Earlier native conversation' });
  const resetGate = barrier<void>();
  let resets = 0;
  f.harness.nativeChat = {
    status: () => ({ sessionId: resets ? 'native-new' : 'native-old', state: 'new' }),
    async reconnect() {},
    async reset() {
      resets++;
      await resetGate.promise;
    },
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/clear');
    terminal.send('\r');
    await terminal.until(() => resets === 1);
    assert.equal(f.messages.length, 1);
    assert.equal(f.clears(), 0);
    resetGate.resolve();
    const screen = await terminal.until(
      (s) => s.includes('Fresh native chat boundary') && s.includes('verification are retained'),
    );
    await terminal.until(() => f.clears() === 1);
    assert.equal(screen.includes('Earlier native conversation'), false);
    assert.equal(f.messages.length, 0);
    assert.deepEqual(f.verified, []);
    assert.deepEqual(f.prompts, []);
  } finally {
    resetGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('failed native clear preserves the OMS transcript and session branch', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  f.identity({ provider: 'claude-code', id: 'sonnet' });
  f.messages.push({ role: 'user', content: 'Keep this native history' });
  f.harness.nativeChat = {
    status: () => ({ sessionId: 'native-old', state: 'disconnected' }),
    async reconnect() {},
    async reset() {
      throw new Error('Native reset refused');
    },
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/clear');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Native reset refused') && s.includes('Keep this native history'));
    assert.equal(f.clears(), 0);
    assert.equal(f.messages.length, 1);
    assert.equal(f.harness.nativeChat.status().sessionId, 'native-old');
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/clear starts a fresh conversation in the same task, keeping the session and dropping the goal', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  f.promptGate.resolve();
  const session = f.harness.session;
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('first question');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    await terminal.until((s) => idle(s));
    terminal.send('/clear extra');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Usage: /clear'));
    assert.equal(f.clears(), 0);
    terminal.send('\x01');
    terminal.send('/clear');
    terminal.send('\r');
    const screen = await terminal.until((s) => s.includes('Fresh conversation in the same task'));
    assert.equal(f.clears(), 1);
    assert.equal(screen.includes('first question'), false);
    assert.equal(f.harness.session, session);
    assert.equal(f.closed(), false);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('Solana commands use the local chain, and /airdrop refuses a chain that is not the task Surfpool', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  const calls: string[] = [];
  let url = 'http://127.0.0.1:20000';
  let rewinds = 0;
  let balance = 0;
  (f.harness as { chain?: unknown }).chain = {
    rpcUrl: () => url,
    mode: 'offline-snapshot',
    uptimeMs: () => 5000,
    health: async () => ({ ok: true }),
    async call(method: string, params: unknown[] = []) {
      calls.push(method);
      if (method === 'requestAirdrop') balance += Number(params[1]);
      return method === 'getSlot' ? 42 : method === 'getBalance' ? { value: balance } : 'signature';
    },
    async rewind() {
      rewinds++;
    },
  };
  const wallet = '11111111111111111111111111111111';
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/chain');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Slot: 42') && s.includes('http://127.0.0.1:20000'));
    terminal.send('/rewind');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Run /rewind confirm'));
    assert.equal(rewinds, 0);
    terminal.send('/rewind confirm');
    terminal.send('\r');
    await terminal.until((s) => s.includes('restored to its starting state'));
    assert.equal(rewinds, 1);
    terminal.send('/airdrop nonsense');
    terminal.send('\r');
    await terminal.until((s) => s.includes('not a valid Solana address'));
    assert.ok(!calls.includes('requestAirdrop'));
    terminal.send('\x01');
    terminal.send(`/airdrop ${wallet} 2`);
    terminal.send('\r');
    await terminal.until((s) => s.includes('Airdropped 2 SOL'));
    assert.ok(calls.includes('requestAirdrop'));
    url = 'https://api.devnet.solana.com';
    calls.length = 0;
    terminal.send(`/airdrop ${wallet} 2`);
    terminal.send('\r');
    await terminal.until((s) => s.includes('Refusing') && s.includes('devnet or'));
    assert.deepEqual(calls, []);
    terminal.send('\x01');
    terminal.send('/program system');
    terminal.send('\r');
    await terminal.until((s) => s.includes('createAccountWithSeed'));
    terminal.send('/error 3012');
    terminal.send('\r');
    await terminal.until((s) => s.includes('AccountNotInitialized'));
    assert.deepEqual(f.prompts, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/help lists the new commands under Solana; a bare /account still opens the OMS account pane', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 60);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/help');
    terminal.send('\r');
    const screen = await terminal.until((s) => s.includes('Solana') && s.includes('/airdrop'));
    assert.ok(screen.includes('/goal') && screen.includes('/diff') && screen.includes('/usage'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('a folder chat shows its folder in the header, no requirements sidebar or frames, and hides the task commands', async () => {
  const f = fixture();
  const chat = f.harness as unknown as Record<string, unknown>;
  for (const field of ['workspace', 'task', 'evaluator', 'verify']) delete chat[field];
  Object.assign(chat, {
    kind: 'chat',
    yolo: { enabled: () => false, set() {} },
    root: '/projects/solana-vault',
    folder: {
      path: '/projects/solana-vault',
      requested: '/projects/solana-vault',
      key: 'k',
      scratch: false,
      git: false,
    },
  });
  const terminal = new InterfaceTerminal(120, 36);
  const run = runOmsInterface(f.harness, {
    terminal,
    startNote: 'No project here, so this chat uses a scratch folder.',
  });
  try {
    const header = await terminal.until((screen) => screen.includes('solana-vault'));
    assert.match(header.split('\n')[0]!, /◆ oms +solana-vault/, 'the folder is named, not its path');
    assert.doesNotMatch(header, /\/projects\/solana-vault|requirements|╭|│/i);
    assert.match(header, /No project here, so this chat uses a scratch folder\./);
    terminal.send('/re');
    const menu = await terminal.until((screen) => screen.includes('/review'));
    assert.doesNotMatch(menu, /\/requirements/);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/yolo toggles unasked, unsandboxed commands and says so once', async () => {
  const f = fixture();
  let on = false;
  Object.assign(f.harness, {
    kind: 'chat',
    folder: { path: '/fixtures/rental-ledger', name: 'rental-ledger', key: 'k', scratch: false },
    yolo: {
      enabled: () => on,
      set: (value: boolean) => {
        on = value;
      },
    },
  });
  const terminal = new InterfaceTerminal(120, 36);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/yolo');
    terminal.send('\r');
    await terminal.until((s) => s.includes('YOLO: commands run without asking and without the sandbox.'));
    assert.equal(on, true);
    await terminal.until((s) => s.includes('YOLO'));
    terminal.send('/yolo');
    terminal.send('\r');
    await terminal.until((s) => s.includes('YOLO off'));
    assert.equal(on, false);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('a chat opens to a three-line empty state, a one-line composer and one status row', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    const screen = await terminal.until((s) => idle(s));
    assert.doesNotMatch(screen, /\/connect|\/model/);
    const rows = screen.split('\n');
    assert.match(rows[0]!, /^◆ oms +rental-ledger +chat +workbench\s*$/);
    const empty = rows.findIndex((row) => row.startsWith('◆ oms 0.'));
    assert.ok(empty > 0, 'the empty state names OMS and its version');
    assert.match(rows[empty + 1]!, /^ {2}test-model · rental-ledger\s*$/);
    assert.match(rows[empty + 2]!, /^ {2}Try: /);
    assert.match(screen, /^❯ Ask OMS to build, test or explain a program…\s*$/m);
    assert.match(screen, /^─+ test-model · ask ─\s*$/m, 'the composer rule names the model and the approval mode');
    assert.match(rows.at(-1)!, /^ {2}\/ commands · \? shortcuts · ctrl\+q quit/);
    assert.doesNotMatch(screen, /Press Enter|\[ |╭|╰|Conversation|Agent ·|input ·/);
    assert.ok(rows.filter((row) => row.trim()).length <= 9, 'header, three lines, two rules, the input and the status');
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('the footer shows YOLO and the model even when the folder path is long', async () => {
  const f = chatFixture(true, '/very/long/path/to/some/deeply/nested/project/folder/with/a/long/name/rental-ledger');
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    const screen = await terminal.until((s) => s.includes('YOLO'));
    assert.match(
      screen
        .split('\n')
        .filter((row) => row.trim())
        .at(-1)!,
      /YOLO/,
    );
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

for (const [columns, rows] of [
  [80, 24],
  [60, 18],
] as const) {
  test(`provider setup Back returns from the full list before closing at ${columns}x${rows}`, async () => {
    const f = chatFixture();
    f.model(false);
    f.harness.listProviders = () =>
      Array.from({ length: 5 }, (_, index) => ({
        id: `provider-${index}`,
        name: `Provider ${index}`,
        configured: false,
        apiKey: true,
        oauth: false,
      }));
    f.harness.listModels = () => [];
    const terminal = new InterfaceTerminal(columns, rows);
    const run = runOmsInterface(f.harness, { terminal });
    try {
      await terminal.until((s) => s.includes('/connect to sign in'));
      terminal.send('/connect');
      terminal.send('\r');
      await terminal.until((s) => s.includes('Other providers (2 more)'));
      for (let i = 0; i < 3; i++) terminal.send('\x1b[B');
      terminal.send('\r');
      const full = await terminal.until((s) => s.includes('Provider 4 API key'));
      assert.ok(full.includes('esc back'), 'the panel border says how to go back');
      terminal.send('\x1b');
      const short = await terminal.until((s) => s.includes('Other providers (2 more)'));
      assert.doesNotMatch(short, /Provider 4 API key/);
      terminal.send('\x1b');
      const home = await terminal.until(
        (s) => s.includes('/connect to sign in') && !s.includes('Choose how to sign in'),
      );
      assert.doesNotMatch(home, /Choose how to sign in/);
      assert.deepEqual(f.prompts, []);
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

test('with nothing connected the chat shows the full setup hint', async () => {
  const f = chatFixture();
  f.model(false);
  (f.harness as unknown as { listModels(): unknown[] }).listModels = () => [];
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    const screen = await terminal.until((s) => s.includes('/connect to sign in'));
    assert.ok(screen.replace(/\s+/g, ' ').includes('Run /connect to sign in, then /model to pick a model'));
    assert.match(screen, /No model connected · rental-ledger/);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('chat setup hint updates live after OAuth connection and model selection', async () => {
  const f = chatFixture();
  f.model(false);
  let connected = false;
  f.harness.listProviders = () => [
    { id: 'openai-codex', name: 'Codex', configured: connected, apiKey: false, oauth: true },
  ];
  f.harness.listModels = () => [
    { provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'Codex model', configured: connected },
  ];
  f.harness.loginProvider = async (_provider, method) => {
    assert.equal(method, 'oauth');
    connected = true;
  };
  f.harness.selectModel = async (provider, id) => {
    assert.equal(provider, 'openai-codex');
    assert.equal(id, 'gpt-6.1-sol');
    Object.defineProperty(f.harness.session, 'model', { get: () => ({ provider, id }) });
  };
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/connect to sign in'));
    terminal.send('/connect');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Codex'));
    terminal.send('\r');
    await terminal.until((s) => s.includes('Connected to openai-codex'));
    terminal.send('\x1b');
    const connectedScreen = await terminal.until((s) => s.includes('/model to pick a model'));
    assert.doesNotMatch(connectedScreen, /\/connect to sign in/);
    terminal.send('/model');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Codex'));
    terminal.send('\r');
    await terminal.until((s) => s.includes('Codex model'));
    terminal.send('\r');
    const ready = await terminal.until((s) => s.includes('Model: openai-codex/gpt-6.1-sol'));
    assert.match(ready, /gpt-6\.1-sol · ask/, 'the composer rule names the chosen model');
    assert.doesNotMatch(ready, /\/connect|\/model/);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

for (const [columns, rows] of [
  [80, 24],
  [60, 18],
] as const) {
  test(`the missing-model notice keeps recovery and draft status visible at ${columns}x${rows}`, async () => {
    const f = chatFixture();
    f.model(false);
    (f.harness as unknown as { listModels(): unknown[] }).listModels = () => [];
    const terminal = new InterfaceTerminal(columns, rows);
    const run = runOmsInterface(f.harness, { terminal });
    try {
      const initial = await terminal.until((s) => s.includes('/connect to sign in'));
      assert.doesNotMatch(initial, /Your draft is kept|No model is available/);
      terminal.send('Explain this folder.');
      terminal.send('\r');
      const screen = await terminal.until((s) => s.replace(/\s+/g, ' ').includes('Your draft is kept.'));
      const notice = 'Run /connect to sign in or /model to choose a model. Your draft is kept. No model is available.';
      assert.ok(
        screen
          .split('\n')
          .map((line) => line.trim())
          .join(' ')
          .includes(notice),
        screen,
      );
      assert.match(screen, /^! Run \/connect to sign in or \/model/m, 'a warning is marked and stays until replaced');
      assert.doesNotMatch(screen, /\.\.\.|…/);
      assert.deepEqual(f.prompts, []);
      terminal.send('!');
      await terminal.until((s) => s.includes('Explain this folder.!'));
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

for (const [columns, rows] of [
  [80, 24],
  [60, 18],
] as const) {
  test(`folder chat keeps its shortcuts hint and recovery visible at ${columns}x${rows}`, async () => {
    const f = chatFixture();
    f.model(false);
    (f.harness as unknown as { listModels(): unknown[] }).listModels = () => [];
    const terminal = new InterfaceTerminal(columns, rows);
    const run = runOmsInterface(f.harness, { terminal });
    const normalized = (screen: string) => screen.replace(/\s+/g, ' ');
    try {
      const initial = await terminal.until((s) => s.includes('/connect to sign in'));
      assert.ok(normalized(initial).includes('Run /connect to sign in, then /model to pick a model'), initial);
      assert.ok(initial.includes('/ commands'), 'the status row offers the command menu');
      assert.match(initial, /rental-ledger/);
      assert.doesNotMatch(initial, /Press Enter|Shift\+Enter/);
      terminal.send('Explain');
      terminal.send('\x1b[13;2u');
      terminal.send('this folder.');
      const draft = await terminal.until((s) => s.includes('this folder.'));
      assert.deepEqual(f.prompts, []);
      assert.match(draft, /^❯ Explain\s*$/m, 'the composer grew to two lines');
      terminal.send('\r');
      const refused = await terminal.until((s) => normalized(s).includes('Your draft is kept. No model is available.'));
      assert.match(refused, /this folder\./);
      assert.ok(normalized(refused).includes('Run /connect to sign in or /model to choose a model.'));
      assert.match(refused, /rental-ledger/);
      assert.deepEqual(f.prompts, []);
      assert.doesNotMatch(refused, /…|\.\.\./);
      f.model(true);
      f.promptGate.resolve();
      terminal.send('\r');
      await terminal.until(() => f.prompts.length === 1);
      assert.deepEqual(f.prompts, ['Explain\nthis folder.']);
    } finally {
      await quit(terminal, run);
      assert.equal(f.closed(), true);
      terminal.vt.dispose();
    }
  });
}

for (const [columns, rows] of [
  [80, 24],
  [60, 18],
] as const) {
  test(`successful commands replace stale notices without hiding new errors at ${columns}x${rows}`, async () => {
    const f = chatFixture();
    f.model(false);
    (f.harness as unknown as { listModels(): unknown[] }).listModels = () => [];
    const terminal = new InterfaceTerminal(columns, rows);
    const run = runOmsInterface(f.harness, { terminal });
    const missingModel = (screen: string) =>
      screen.replace(/\s+/g, ' ').includes('Your draft is kept. No model is available.');
    try {
      await terminal.until((s) => s.includes('/connect to sign in'));
      for (const command of ['/usage', '/harness', '/theme nord']) {
        terminal.send('Explain this folder.');
        terminal.send('\r');
        await terminal.until(missingModel);
        terminal.send('\x01');
        terminal.send('\x7f');
        terminal.send(command);
        terminal.send('\r');
        const screen = await terminal.until((s) => !missingModel(s));
        if (command === '/usage') {
          assert.match(screen, /Spend:/);
          assert.match(screen.replace(/\s+/g, ' '), /no model calls yet/);
        }
        if (command === '/theme nord') assert.match(screen, /Theme set to Nord/);
        assert.deepEqual(f.prompts, []);
      }
      terminal.send('/usage');
      terminal.send('\r');
      terminal.send('Explain this folder.');
      terminal.send('\r');
      await terminal.until(missingModel);
      terminal.send('\x01');
      terminal.send('\x7f');
      terminal.send('/not-a-command');
      terminal.send('\r');
      await terminal.until((s) => s.includes('Unknown or invalid OMS command.'));
      assert.deepEqual(f.prompts, []);
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

test('/exit leaves exactly as /quit does, cleanup included', async () => {
  for (const command of ['/exit', '/quit']) {
    const f = chatFixture();
    const terminal = new InterfaceTerminal(100, 30);
    const run = runOmsInterface(f.harness, { terminal });
    await terminal.until((s) => idle(s));
    terminal.send(command);
    terminal.send('\r');
    await run;
    assert.equal(f.closed(), true, command);
    assert.equal(terminal.active, false);
    terminal.vt.dispose();
  }
});

test('Ctrl+D leaves from an empty input and does nothing while there is a draft', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  await terminal.until((s) => idle(s));
  terminal.send('draft text');
  await terminal.until((s) => s.includes('draft text'));
  terminal.send('\x04');
  await terminal.screen();
  assert.equal(f.closed(), false);
  for (let i = 0; i < 'draft text'.length; i++) terminal.send('\x7f');
  await terminal.until((s) => !s.includes('draft text'));
  terminal.send('\x04');
  await run;
  assert.equal(f.closed(), true);
  terminal.vt.dispose();
});

for (const [columns, rows] of [
  [80, 24],
  [60, 18],
] as const) {
  test(`folder chat scrolls its transcript from the conversation and returns to the composer at ${columns}x${rows}`, async () => {
    const f = chatFixture();
    f.model(false);
    f.harness.listModels = () => [];
    const terminal = new InterfaceTerminal(columns, rows);
    const run = runOmsInterface(f.harness, { terminal });
    const normalized = (screen: string) => screen.replace(/\s+/g, ' ');
    try {
      await terminal.until((s) => s.includes('/connect to sign in'));
      terminal.send('/help');
      terminal.send('\r');
      await terminal.until((s) => s.includes('Look and account'));
      terminal.send('\t');
      for (let i = 0; i < 8; i++) {
        terminal.send('\x1b[5~');
        await terminal.screen();
      }
      const scrolled = await terminal.until((s) => /\/connect +Sign in/.test(s));
      assert.match(scrolled, /\/model +Pick a model/);
      terminal.send('\x1b');
      terminal.send('Explain this folder.');
      terminal.send('\r');
      const refused = await terminal.until((s) => normalized(s).includes('Your draft is kept. No model is available.'));
      assert.match(refused, /Explain this folder\./);
      assert.ok(refused.includes('rental-ledger'), refused);
      assert.deepEqual(f.prompts, []);
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

test('/help is a short list with one entry for leaving, and /help keys has the rest', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(110, 40);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => idle(s));
    terminal.send('/help');
    terminal.send('\r');
    const help = await terminal.until((s) => s.includes('/exit (or /quit)'));
    assert.match(help, /\/connect +Sign in or add an API key/);
    assert.match(help, /\/yolo +Run commands without asking/);
    assert.doesNotMatch(help, /\/requirements|\/verify|\/open |Keyboard\n|F6|Toolbar/);
    assert.match(help, /\/goal +/);
    assert.match(help, /\/team +Split a goal across helper agents/);
    assert.match(help, /\/agents +List helper agents/);
    assert.match(help, /\/rewind +/);
    assert.match(help, /\/connect +Sign in/, 'the whole list fits on one screen');
    terminal.send('/help keys');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Toolbar: F10'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/agents lists the agents with their source, then the helpers of this session', async () => {
  const f = chatFixture();
  withHelpers(f);
  const terminal = new InterfaceTerminal(130, 40);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => idle(s));
    terminal.send('/agents');
    terminal.send('\r');
    const screen = await terminal.until((s) => s.includes('This session'));
    assert.match(screen, /explore +read-only +Find code and facts, report file paths +built-in/);
    assert.match(screen, /build +edits +Make one scoped change/);
    assert.match(screen, /auditor +read-only +Check accounts +\.oms-agents \(this folder\)/);
    assert.match(screen, /explore#1 +"find vault PDA seeds" +done 14s +xai\/grok-4\.7 +22k tokens/);
    assert.match(screen, /build#2 +"add close_vault" +waiting for build#1/);
    assert.match(screen, /Skipped: project: broken\.md/);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/agents new writes the file and says where; a bad name is refused in the notice row', async () => {
  const f = chatFixture();
  const created = withHelpers(f);
  const terminal = new InterfaceTerminal(130, 40);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => idle(s));
    terminal.send('/agents new scanner --project --edit Scan programs for missing checks');
    terminal.send('\r');
    await terminal.until((s) => s.includes('/home/dev/.oms/agents/scanner.md'));
    assert.deepEqual(created, [
      { name: 'scanner', description: 'Scan programs for missing checks', scope: 'project', tools: 'edit' },
    ]);
    terminal.send('/agents new');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Usage: /agents new <name>'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/team hands the goal to the agent with the instruction to use helpers', async () => {
  const f = chatFixture();
  withHelpers(f);
  const terminal = new InterfaceTerminal(130, 40);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => idle(s));
    terminal.send('/team add a header comment to each module');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    assert.match(f.prompts[0]!, /add a header comment to each module/);
    assert.match(f.prompts[0]!, /agent tool/);
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('/team says plainly that helpers need a direct model when Claude Code is selected', async () => {
  const f = chatFixture();
  withHelpers(f, {
    ok: false,
    reason: 'Helpers need a direct model. Claude Code runs as one chat, so pick another model with /model.',
  });
  const terminal = new InterfaceTerminal(130, 40);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => idle(s));
    terminal.send('/team do something');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Helpers need a direct model'));
    assert.deepEqual(f.prompts, []);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});
