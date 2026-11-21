import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HarnessSession } from '@oms/engine';
import { chatFixture, start } from '../test-support/fake-session.ts';

type Approve = Parameters<NonNullable<HarnessSession['setHostApproval']>>[0];

test('a message that starts with a file path is sent as a message, not run as a command', async () => {
  const f = chatFixture();
  const { terminal, close } = start(f.harness, 120, 30);
  try {
    await terminal.until((screen) => screen.includes('/ commands'));
    const message = '/Users/me/app/src/lib.rs fails to compile, can you fix it?';
    terminal.send(message);
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    assert.deepEqual(f.prompts, [message]);
  } finally {
    f.promptGate.resolve();
    f.abortGate.resolve();
    await close();
  }
});

test('a long or multi-line message that starts with a slash keeps its draft; a short mistyped command is dropped', async () => {
  const f = chatFixture();
  const { terminal, close } = start(f.harness, 120, 30);
  try {
    await terminal.until((screen) => screen.includes('/ commands'));
    terminal.send('/zzz please look at the failing test');
    terminal.send('\x1b[13;2u');
    terminal.send('and then explain what is wrong');
    terminal.send('\r');
    let screen = await terminal.until((s) => /\/zzz not found/.test(s));
    assert.match(screen, /❯ \/zzz please look at the failing test/, 'the long message is still in the composer');
    assert.match(screen, /and then explain what is wrong/);
    assert.deepEqual(f.prompts, [], 'and nothing was sent to the model');
    terminal.send('\x01');
    terminal.send('\x7f');
    terminal.send('/modle');
    terminal.send('\r');
    screen = await terminal.until((s) => /did you mean \/model\?/.test(s));
    assert.doesNotMatch(screen, /❯ \/modle/, 'a short typo is dropped so the next command is not joined to it');
  } finally {
    await close();
  }
});

test('the note after an approval keeps the whole command that was decided on', async () => {
  const f = chatFixture();
  let approve: Approve;
  f.harness.setHostApproval = (handler) => {
    approve = handler;
  };
  const { terminal, close } = start(f.harness, 120, 40);
  try {
    await terminal.until((screen) => screen.includes('/ commands'));
    const command = `echo start\n${'x'.repeat(400)}\nrm -rf ~/project`;
    const pending = approve!({ command, reasons: ['network'] });
    await terminal.until((s) => s.includes('╭─ Allow host command?'));
    terminal.send('\x1b[F');
    terminal.send('n');
    assert.equal(await pending, false);
    const screen = await terminal.until((s) => /Denied: echo start/.test(s));
    assert.match(screen, /rm -rf ~\/project/, 'the end of a long command is in the record');
  } finally {
    await close();
  }
});

test('a login that fails part-way still says credentials may already be saved', async () => {
  const { SetupPane } = await import('../src/tui/setup.ts');
  const { getTheme } = await import('../src/tui/theme.ts');
  const pane = new SetupPane(
    {
      listProviders: () => [{ id: 'openai', name: 'OpenAI', configured: false, apiKey: true, oauth: false }],
      listModels: () => [],
      async selectModel() {},
      async loginProvider() {
        throw new Error('network went away after the key was stored');
      },
      async importEnvironment() {
        throw new Error('unused');
      },
    } as never,
    {
      mode: 'connect',
      query: 'openai',
      theme: () => getTheme('gruvbox')!,
      rows: () => 30,
      render() {},
      close() {},
      notice() {},
      selectTheme: () => false,
    },
  );
  pane.handleInput('\r');
  await new Promise((done) => setTimeout(done, 20));
  pane.handleInput('x');
  pane.handleInput('\r');
  await new Promise((done) => setTimeout(done, 20));
  assert.match(pane.body.render(120).join('\n'), /credentials may already be saved/);
  pane.dispose();
});

for (const [work, how, keys] of [
  ['/review', 'Esc', ['\x1b', '\x1b']],
  ['/review', 'Ctrl+C', ['\x03']],
  ['/review', '/cancel', ['\x01', '\x7f', '/cancel', '\r']],
  ['/verify R1', 'Esc', ['\x1b', '\x1b']],
  ['/verify R1', 'Ctrl+C', ['\x03']],
  ['/verify R1', '/cancel', ['\x01', '\x7f', '/cancel', '\r']],
] as const) {
  test(`${how} during ${work} is refused with an explanation and the work goes on`, async () => {
    const { fixture } = await import('../test-support/fake-session.ts');
    const { barrier } = await import('../test-support/interface-terminal.ts');
    const f = fixture();
    const gate = barrier<void>();
    let finished = false;
    f.harness.verify = async () => {
      await gate.promise;
      finished = true;
      return { itemId: 'R1', result: { closed: true } } as never;
    };
    const { terminal, close } = start(f.harness, 120, 36, {
      review: async () => {
        await gate.promise;
        finished = true;
        return 0;
      },
    });
    try {
      await terminal.screen();
      terminal.send(work);
      terminal.send('\r');
      await terminal.until((s) => /Verifying the requirements|Reviewing the code/.test(s));
      for (const key of keys) terminal.send(key);
      await terminal.until((s) => s.includes("Can't cancel this · it stops on its own"));
      assert.equal(finished, false, 'nothing stopped the work');
      assert.match(await terminal.screen(), /Verifying the requirements|Reviewing the code/);
    } finally {
      gate.resolve();
      await close();
    }
  });
}
