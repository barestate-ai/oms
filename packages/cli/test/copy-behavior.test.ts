import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HarnessSession } from '@oms/engine';
import { runOmsInterface } from '../src/tui/interface.ts';
import { InterfaceTerminal } from '../test-support/interface-terminal.ts';
import { chatFixture, fixture, quit } from '../test-support/fake-session.ts';

const CTRL_C = '\x03';
const F10 = '\x1b[21~';
const PAGE_UP = '\x1b[5~';
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test('Ctrl+C on an idle prompt only warns; a second press quits, and a draft is never lost on one press', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('my important draft');
    await terminal.until((s) => s.includes('my important draft'));
    terminal.send(CTRL_C);
    const screen = await terminal.until((s) => s.includes('ctrl+c again to quit · unsent text is lost'));
    assert.ok(screen.includes('my important draft'));
    assert.equal(f.closed(), false);
    terminal.send(CTRL_C);
    await run;
    assert.equal(f.closed(), true);
  } finally {
    terminal.vt.dispose();
  }
});

test('Ctrl+C twice on an empty prompt quits; any other key in between starts over', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send(CTRL_C);
    await terminal.until((s) => s.includes('ctrl+c again to quit') && !s.includes('unsent'));
    terminal.send('a');
    await terminal.until((s) => !s.includes('ctrl+c again'));
    terminal.send(CTRL_C);
    await terminal.until((s) => s.includes('ctrl+c again to quit · unsent text is lost'));
    assert.equal(f.closed(), false, 'a key between the presses disarms quitting');
    terminal.send(CTRL_C);
    await run;
    assert.equal(f.closed(), true);
  } finally {
    terminal.vt.dispose();
  }
});

test('the Ctrl+C warning goes away by itself after a couple of seconds, and quitting is disarmed with it', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send(CTRL_C);
    await terminal.until((s) => s.includes('ctrl+c again to quit'));
    await terminal.until((s) => !s.includes('ctrl+c again to quit'), 3500);
    terminal.send(CTRL_C);
    await terminal.until((s) => s.includes('ctrl+c again to quit'));
    assert.equal(f.closed(), false, 'a late second press is a first press');
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('Ctrl+C cancels running work instead of quitting, and the prompt then needs two presses again', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('long request');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    terminal.send(CTRL_C);
    await terminal.until(() => f.abortRequested());
    await terminal.until((s) => s.includes('Cancelling…'));
    assert.equal(f.closed(), false);
    f.abortGate.resolve();
    f.promptGate.resolve();
    await terminal.until((s) => !s.includes('Cancelling…'));
    terminal.send(CTRL_C);
    await terminal.until((s) => s.includes('ctrl+c again to quit'));
    assert.equal(f.closed(), false);
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('Ctrl+C twice never discards unsaved files: the discard still takes Ctrl+Q', async () => {
  const f = fixture();
  f.harness.files = { ...f.harness.files, read: async () => ({ bytes: Buffer.from('source'), revision: 'r1' }) };
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.screen();
    terminal.send('/open file.ts');
    terminal.send('\r');
    await terminal.until((s) => s.includes('source'));
    terminal.send('X');
    terminal.send('\x0c');
    terminal.send(CTRL_C);
    await terminal.until((s) => s.includes('ctrl+c again to quit'));
    terminal.send(CTRL_C);
    await terminal.until((s) => s.includes('Unsaved files · ctrl+q again to discard · ctrl+s to save'));
    terminal.send(CTRL_C);
    await terminal.until((s) => s.includes('ctrl+c again to quit'));
    assert.equal(f.closed(), false);
    terminal.send('\x11');
    await terminal.until((s) => s.includes('Unsaved files'));
    terminal.send('\x11');
    await run;
    assert.equal(f.closed(), true);
  } finally {
    terminal.vt.dispose();
  }
});

test('Ctrl+D quits from an empty prompt only, and Ctrl+Q quits from anywhere', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('x');
    await terminal.until((s) => s.includes('x'));
    terminal.send('\x04');
    await terminal.screen();
    assert.equal(f.closed(), false);
    terminal.send('\x11');
    await run;
    assert.equal(f.closed(), true);
  } finally {
    terminal.vt.dispose();
  }
});

test('a refused command is dropped from the composer, so the next one is not joined to it', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(110, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('/error abc');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Usage: /error <code> [program] · decimal or 0x hex'));
    terminal.send('/clear');
    const screen = await terminal.until((s) => s.includes('/clear'));
    assert.doesNotMatch(screen, /\/error ?\/clear/);
    assert.doesNotMatch(screen, /[Dd]raft retained|draft is kept/);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('a failed review is not left in the composer to run a second time, and says where the failure is', async () => {
  const f = fixture();
  const terminal = new InterfaceTerminal(120, 36);
  let reviews = 0;
  const run = runOmsInterface(f.harness, {
    terminal,
    review: async () => {
      reviews++;
      return 1;
    },
  });
  try {
    await terminal.screen();
    terminal.send('/review');
    terminal.send('\r');
    const screen = await terminal.until((s) => s.includes('/review failed · see above'));
    assert.ok(screen.includes('Review produced no report'));
    assert.doesNotMatch(screen, /\/review\s*$/m);
    terminal.send('\r');
    await terminal.screen();
    assert.equal(reviews, 1);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('a failing /run shows its output once, then a notice that points at it', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(110, 30);
  f.commandGate.resolve({ exitCode: 3, stdout: 'boom', stderr: '', timedOut: false, cancelled: false });
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('/run false');
    terminal.send('\r');
    const screen = await terminal.until((s) => s.includes('/run failed · see above'));
    assert.equal(screen.split('\n').filter((row) => row.includes('Exit: 3')).length, 1);
    assert.doesNotMatch(screen, /Sandbox command did not succeed|Exit 3\b|draft/i);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('a message the agent never received stays in the composer: it is the user’s own text', async () => {
  const f = chatFixture();
  f.model(false);
  (f.harness as unknown as { listModels(): unknown[] }).listModels = () => [];
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/connect'));
    terminal.send('Explain this folder.');
    terminal.send('\r');
    const screen = await terminal.until((s) =>
      s.includes('No model selected · /connect to sign in, /model to pick one'),
    );
    assert.ok(screen.includes('Explain this folder.'));
    assert.doesNotMatch(screen, /[Dd]raft/);
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('a command typed while work runs stays for later, with a notice that says how to stop the work', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('long request');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    terminal.send('next question');
    terminal.send('\r');
    const screen = await terminal.until((s) => s.includes('Still working · esc to cancel'));
    assert.ok(screen.includes('next question'));
    assert.doesNotMatch(screen, /Work is running|\/cancel/);
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('PgUp and PgDn scroll the conversation from the composer without moving the draft', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(100, 24);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/ commands'));
    const text = Array.from({ length: 80 }, (_, line) => `scroll line ${line + 1}`).join('\n');
    const message = { role: 'assistant', content: [{ type: 'text', text }] };
    f.emit({ type: 'message_start', message });
    f.emit({ type: 'message_end', message });
    await terminal.until((s) => s.includes('scroll line 80'));
    terminal.send('draft');
    await terminal.until((s) => s.includes('draft'));
    terminal.send(PAGE_UP);
    const up = await terminal.until((s) => !s.includes('scroll line 80'));
    assert.ok(up.includes('draft'), 'the composer keeps its text and focus');
    terminal.send(PAGE_UP);
    await terminal.screen();
    terminal.send('\x1b[6~');
    terminal.send('\x1b[6~');
    await terminal.until((s) => s.includes('scroll line 80'));
    terminal.send('!');
    await terminal.until((s) => s.includes('draft!'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('sending a message after scrolling up brings the conversation back to its end', async () => {
  const f = chatFixture();
  f.promptGate.resolve();
  const terminal = new InterfaceTerminal(100, 24);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/ commands'));
    const text = Array.from({ length: 80 }, (_, line) => `scroll line ${line + 1}`).join('\n');
    const message = { role: 'assistant', content: [{ type: 'text', text }] };
    f.emit({ type: 'message_start', message });
    f.emit({ type: 'message_end', message });
    await terminal.until((s) => s.includes('scroll line 80'));
    terminal.send(PAGE_UP);
    terminal.send(PAGE_UP);
    await terminal.until((s) => !s.includes('scroll line 80'));
    terminal.send('hello again');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    await terminal.until((s) => s.includes('scroll line 80'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

test('F10 focuses the header tabs when they show, in a chat and in a task, and does nothing without a header', async () => {
  for (const f of [chatFixture(), fixture()]) {
    const terminal = new InterfaceTerminal(110, 30);
    const run = runOmsInterface(f.harness, { terminal });
    try {
      await terminal.until((s) => s.includes('/ commands'));
      terminal.send(F10);
      terminal.send('\x1b[C');
      terminal.send('\r');
      await terminal.until((s) => s.includes('No file open'));
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  }
  const f = chatFixture();
  const short = new InterfaceTerminal(100, 24);
  const run = runOmsInterface(f.harness, { terminal: short });
  try {
    await short.until((s) => s.includes('/ commands'));
    short.send(F10);
    short.send('hello');
    await short.until((s) => /^❯ hello/m.test(s));
  } finally {
    await quit(short, run);
    short.vt.dispose();
  }
});

test('a bad argument says what the command takes', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(110, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('/terminal sideways');
    terminal.send('\r');
    await terminal.until((s) => s.includes('Usage: /terminal [start|stop|hide]'));
    terminal.send('/clear now');
    terminal.send('\r');
    await terminal.until((s) => s.includes('/clear takes no arguments'));
  } finally {
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});

for (const [key, outcome] of [
  ['y', 'Allowed once: cat ~/.ssh/example'],
  ['s', 'Allowed for this session: cat ~/.ssh/example'],
  ['n', 'Denied: cat ~/.ssh/example'],
] as const) {
  test(`a host approval answered ${JSON.stringify(key)} leaves one note saying what was decided`, async () => {
    const f = chatFixture();
    const terminal = new InterfaceTerminal(110, 30);
    let approve: Parameters<NonNullable<HarnessSession['setHostApproval']>>[0];
    f.harness.setHostApproval = (handler) => {
      approve = handler;
    };
    const run = runOmsInterface(f.harness, { terminal });
    try {
      await terminal.until((s) => s.includes('/ commands'));
      const pending = approve!({ command: 'cat ~/.ssh/example', reasons: ['credential or wallet files'] });
      const asked = await terminal.until((s) => s.includes('Allow host command?'));
      assert.match(asked, /\$ cat ~\/\.ssh\/example/);
      assert.match(asked, /y +Allow once/);
      assert.match(asked, /s +Allow for this session/);
      assert.match(asked, /n +Deny/);
      assert.doesNotMatch(asked, /Run on host|Host approval required/);
      terminal.send(key);
      assert.equal(await pending, key === 'y' ? true : key === 's' ? 'session' : false);
      await terminal.until((s) => s.includes(outcome) && !s.includes('Allow host command?'));
    } finally {
      await quit(terminal, run);
      terminal.vt.dispose();
    }
  });
}

test('Ctrl+C with a host approval pending denies it and cancels the work, but does not quit', async () => {
  const f = chatFixture();
  const terminal = new InterfaceTerminal(110, 30);
  let approve: Parameters<NonNullable<HarnessSession['setHostApproval']>>[0];
  f.harness.setHostApproval = (handler) => {
    approve = handler;
  };
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((s) => s.includes('/ commands'));
    terminal.send('go');
    terminal.send('\r');
    await terminal.until(() => f.prompts.length === 1);
    const pending = approve!({ command: 'sudo true', reasons: ['sudo'] });
    await terminal.until((s) => s.includes('Allow host command?'));
    terminal.send(CTRL_C);
    assert.equal(await pending, false);
    await wait(20);
    assert.equal(f.closed(), false);
  } finally {
    f.abortGate.resolve();
    f.promptGate.resolve();
    await quit(terminal, run);
    terminal.vt.dispose();
  }
});
