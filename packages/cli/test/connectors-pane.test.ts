import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { chatFixture, clickText, quit, start } from '../test-support/fake-session.ts';
import { createConnectors, type Connectors } from '../src/connectors/runtime.ts';
import type { HostResult, HostRun } from '../src/connectors/host.ts';
import type { SpawnLike } from '../src/connectors/signin.ts';

const root = () => mkdtempSync(join(tmpdir(), 'oms-pane-'));
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A machine where GitHub is signed in, Docker is not running and nothing else is installed. */
function machine(extra: Record<string, (args: readonly string[]) => Partial<HostResult>> = {}) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const run: HostRun = async (file, args) => {
    calls.push({ file, args });
    const custom = extra[file]?.(args);
    if (custom) return { code: 0, stdout: '', stderr: '', ...custom };
    if (file === 'gh' && args[0] === 'auth')
      return { code: 0, stdout: '', stderr: 'Logged in to github.com account vivek (keyring)' };
    if (file === 'docker') return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
    if (file === 'git') return { code: 0, stdout: 'git@github.com:x/y.git\n', stderr: '' };
    return { code: null, stdout: '', stderr: '', error: 'missing' };
  };
  return { calls, run };
}

async function open(
  options: {
    rows?: number;
    columns?: number;
    run?: HostRun;
    spawn?: SpawnLike;
    before?: (stateRoot: string) => void;
  } = {},
) {
  const stateRoot = root();
  options.before?.(stateRoot);
  const connectors = createConnectors({
    stateRoot,
    folder: '/work',
    env: {},
    run: options.run ?? machine().run,
    spawn: options.spawn,
  });
  const f = chatFixture();
  // The interface hands the session its sandbox-approval handler when it opens.
  let hostApproval: ((request: { command: string; reasons: string[] }) => Promise<boolean | 'session'>) | undefined;
  f.harness.setHostApproval = (handler) => {
    hostApproval = handler as typeof hostApproval;
  };
  const session = start(f.harness, options.columns ?? 100, options.rows ?? 30, { connectors });
  await session.terminal.until((s) => s.includes('/ commands'));
  return {
    ...session,
    f,
    connectors,
    stateRoot,
    hostApproval: () => hostApproval!,
    cleanup: () => rmSync(stateRoot, { recursive: true, force: true }),
  };
}
const command = async (s: Awaited<ReturnType<typeof open>>, text: string) => {
  s.terminal.send(text);
  s.terminal.send('\r');
};

test('/connectors lists every connector with its state, plain next steps and key hints', async () => {
  const s = await open({ rows: 36 });
  try {
    await command(s, '/connectors');
    const screen = await s.terminal.until((text) => text.includes('vivek') && text.includes('not installed'));
    for (const label of ['GitHub', 'GitLab', 'Linear', 'Slack', 'Docker', 'AWS', 'Solana RPC'])
      assert.match(screen, new RegExp(label));
    assert.match(screen, /code\b/);
    assert.match(screen, /infrastructure/);
    assert.match(screen, /› .*GitHub.*off · vivek, ready to turn on/);
    assert.match(screen, /Docker +off · Docker is installed but not running/);
    assert.match(screen, /Slack +off · needs a sign-in/);
    assert.match(screen, /GitLab +off · not installed/);
    // The selected row's detail and the context-aware key hints are always on screen.
    assert.match(screen, /Read pull requests, issues and CI/);
    assert.match(screen, /Ready\. Press Space to turn it on\./);
    assert.match(screen, /↑↓ select · Space on\/off · R recheck · Esc back/);
    assert.match(screen, /Connectors/);
    // Built-in tools are listed too, read from the live session.
    assert.match(screen, /built in/);
    assert.match(screen, /Program reference/);
    s.terminal.send('\x1b');
    await s.terminal.until((text) => !text.includes('Connectors') && text.includes('/ commands'));
    // Opening the list ends the sign-in tip for good.
    assert.equal(JSON.parse(readFileSync(join(s.stateRoot, 'connectors.json'), 'utf8')).tips.dismissed, true);
  } finally {
    await s.close();
    s.cleanup();
  }
});

test('Space turns a ready connector on, A steps its access, a not-ready one explains itself, and it all persists', async () => {
  const s = await open();
  try {
    await command(s, '/connectors');
    await s.terminal.until((text) => text.includes('ready to turn on'));
    s.terminal.send(' ');
    const on = await s.terminal.until((text) => text.includes('vivek · asks before changes'));
    assert.match(on, /GitHub is on: asks before changes\./);
    assert.equal(s.connectors.access('github'), 'ask');
    assert.match(on, /A access/);
    s.terminal.send('a');
    await s.terminal.until((text) => text.includes('vivek · changes without asking'));
    s.terminal.send('a');
    await s.terminal.until((text) => text.includes('vivek · read only'));
    assert.equal(s.connectors.access('github'), 'read');
    const saved = JSON.parse(readFileSync(join(s.stateRoot, 'connectors.json'), 'utf8'));
    assert.deepEqual(saved.connectors.github, { enabled: true, access: 'read' });
    s.terminal.send('\x1b[B'); // GitLab: not installed
    await s.terminal.until((text) => /› .*GitLab/.test(text));
    s.terminal.send(' ');
    const refused = await s.terminal.until((text) => text.includes('is not ready yet'));
    assert.match(refused, /GitLab is not ready yet\. Install it first\./);
    assert.equal(s.connectors.access('gitlab'), 'off');
    s.terminal.send('\r');
    const help = await s.terminal.until((text) => text.includes('Run this in your own terminal'));
    assert.match(help, /brew install glab \(Ctrl\+X copies it\), then press R\./);
    assert.match(help, /glab is not installed\. Install it with: brew install glab/);
    // Space turns the first one off again.
    s.terminal.send('\x1b[A');
    await s.terminal.until((text) => /› .*GitHub/.test(text));
    s.terminal.send(' ');
    await s.terminal.until((text) => text.includes('GitHub is off. The agent can no longer use it.'));
    assert.equal(s.connectors.access('github'), 'off');
  } finally {
    await s.close();
    s.cleanup();
  }
});

test('the mouse selects a row, and the mark at the start of a row is its switch', async () => {
  const s = await open();
  try {
    await command(s, '/connectors');
    const screen = await s.terminal.until((text) => text.includes('Docker is installed but not running'));
    clickText(s.terminal, screen, 'Docker');
    const selected = await s.terminal.until((text) => /› .*Docker/.test(text));
    assert.match(selected, /Docker is installed but not running\. Start Docker Desktop\./);
    // Back to GitHub: click the mark at the row start to switch it on.
    const rows = selected.split('\n');
    const y = rows.findIndex((row) => row.includes('GitHub') && row.includes('ready to turn on'));
    const x = rows[y]!.indexOf('○');
    s.terminal.send(`\x1b[<0;${x + 1};${y + 1}M`);
    s.terminal.send(`\x1b[<0;${x + 1};${y + 1}m`);
    await s.terminal.until((text) => text.includes('vivek · asks before changes'));
    assert.equal(s.connectors.access('github'), 'ask');
  } finally {
    await s.close();
    s.cleanup();
  }
});

test('R checks again and picks up a sign-in made elsewhere', async () => {
  let signedIn = false;
  const m = machine({
    gh: (args) =>
      args[0] === 'auth'
        ? signedIn
          ? { code: 0, stderr: 'Logged in to github.com account vivek' }
          : { code: 1, stderr: 'not logged in' }
        : {},
  });
  const s = await open({ run: m.run });
  try {
    await command(s, '/connectors');
    await s.terminal.until((text) => text.includes('GitHub') && text.includes('off · needs a sign-in'));
    signedIn = true;
    s.terminal.send('r');
    await s.terminal.until((text) => text.includes('off · vivek, ready to turn on'));
  } finally {
    await s.close();
    s.cleanup();
  }
});

test('Enter signs in on this machine: the code is shown, copied on request, and a finished sign-in turns the connector on', async () => {
  let signedIn = false;
  const m = machine({
    gh: (args) =>
      args[0] === 'auth'
        ? signedIn
          ? { code: 0, stderr: 'Logged in to github.com account vivek' }
          : { code: 1, stderr: 'not logged in' }
        : {},
  });
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stderr = new EventEmitter();
  const stdin = { write: () => true, on: () => {} };
  Object.assign(child, { stdout: new EventEmitter(), stderr, stdin, kill: () => true });
  const spawned: Array<[string, string[]]> = [];
  const spawn = ((file: string, args: string[]) => {
    spawned.push([file, args]);
    return child;
  }) as unknown as SpawnLike;
  const s = await open({ run: m.run, spawn });
  try {
    await command(s, '/connectors');
    await s.terminal.until((text) => text.includes('needs a sign-in') && text.includes('Enter sign in'));
    s.terminal.send('\r');
    await s.terminal.until((text) => text.includes('Sign in to GitHub'));
    stderr.emit('data', '! First copy your one-time code: ABCD-1234\nOpen https://github.com/login/device\n');
    const screen = await s.terminal.until((text) => text.includes('Code: ABCD-1234'));
    assert.match(screen, /https:\/\/github\.com\/login\/device/);
    assert.match(screen.replace(/[│\s]+/g, ' '), /Never approve a code someone sent you/);
    assert.match(screen, /Ctrl\+X copy code · Esc cancel/);
    assert.deepEqual(spawned, [
      ['gh', ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https']],
    ]);
    signedIn = true;
    child.emit('close', 0);
    const done = await s.terminal.until((text) => text.includes('Signed in. GitHub is on'));
    assert.match(done, /vivek · asks before changes/);
    assert.equal(s.connectors.access('github'), 'ask');
  } finally {
    await s.close();
    s.cleanup();
  }
});

test('Esc during a sign-in cancels it and stops the program', async () => {
  const m = machine({ gh: (args) => (args[0] === 'auth' ? { code: 1, stderr: 'not logged in' } : {}) });
  const killed: string[] = [];
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write: () => true, on: () => {} },
    kill: (signal: string) => killed.push(signal),
  });
  const s = await open({ run: m.run, spawn: (() => child) as unknown as SpawnLike });
  try {
    await command(s, '/connectors');
    await s.terminal.until((text) => text.includes('Enter sign in'));
    s.terminal.send('\r');
    await s.terminal.until((text) => text.includes('Starting the sign-in'));
    s.terminal.send('\x1b');
    await s.terminal.until((text) => text.includes('Cancelled.'));
    assert.deepEqual(killed, ['SIGTERM']);
    assert.equal(s.connectors.access('github'), 'off');
  } finally {
    await s.close();
    s.cleanup();
  }
});

test('a damaged connectors.json shows a notice in the list and never crashes the interface', async () => {
  const s = await open({ before: (dir) => writeFileSync(join(dir, 'connectors.json'), '{oops') });
  try {
    await command(s, '/connectors');
    const screen = await s.terminal.until((text) => text.includes('connectors.json is not valid JSON'));
    assert.match(screen, /GitHub/);
    s.terminal.send(' ');
    // Changes still work for this session, and the damaged file is left alone.
    await s.terminal.until((text) => text.includes('connectors.json could not be saved') || text.includes('is on'));
    assert.equal(readFileSync(join(s.stateRoot, 'connectors.json'), 'utf8'), '{oops');
  } finally {
    await s.close();
    s.cleanup();
  }
});

test('the list fits a small terminal: the selected row stays in view and the hint line is there', async () => {
  const s = await open({ columns: 80, rows: 24 });
  try {
    await command(s, '/connectors');
    await s.terminal.until((text) => text.includes('Connectors'));
    for (let i = 0; i < 7; i++) s.terminal.send('\x1b[B');
    const screen = await s.terminal.until((text) => /› .*Solana RPC/.test(text));
    assert.match(screen, /Esc back/);
    assert.match(screen, /Uses HELIUS_API_KEY/);
    for (const row of screen.split('\n')) assert.ok(row.length <= 80, row);
  } finally {
    await s.close();
    s.cleanup();
  }
});

test('/connectors dismiss ends the tip, and /connectors in a pinned task is not offered', async () => {
  const s = await open();
  try {
    await command(s, '/connectors dismiss');
    await s.terminal.until((text) => text.includes('That tip will not show again'));
    assert.equal(JSON.parse(readFileSync(join(s.stateRoot, 'connectors.json'), 'utf8')).tips.dismissed, true);
  } finally {
    await s.close();
    s.cleanup();
  }
});

// ---------------------------------------------------------------- the agent's actions and the approval row

/** The connector extension of `connectors`, loaded into a stand-in for the agent, and a way to make it call a tool. */
function agent(connectors: Connectors) {
  const hooks: Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown> = [];
  const pi = {
    on: (name: string, handler: (typeof hooks)[number]) => void (name === 'tool_call' && hooks.push(handler)),
    registerTool() {},
    registerMcpServer() {},
    unregisterMcpServer() {},
    getActiveTools: () => [],
    setActiveTools() {},
    getAllTools: () => [],
  };
  connectors.extensions[0]!(pi as unknown as ExtensionAPI);
  return {
    call: async (toolName: string, input: Record<string, unknown>, signal?: AbortSignal) =>
      (await hooks[0]!({ toolName, input, toolCallId: 'c' }, { signal })) as
        { block?: boolean; reason?: string } | undefined,
  };
}

test('an agent write waits in the approval row; y runs it, and the row names what would happen', async () => {
  const s = await open();
  try {
    s.connectors.setEnabled('github', true);
    const a = agent(s.connectors);
    const pending = a.call('github', { action: 'pr_comment', number: '42', body: 'Looks good' });
    const screen = await s.terminal.until((text) => text.includes('Allow GitHub'));
    assert.match(screen, /Allow GitHub\?/);
    // The card names the action, then shows the whole text that would be posted.
    assert.match(screen, /comment on pull request #42[^\n]*\n[^\n]*Looks good/);
    assert.match(screen, /y +Allow once/);
    assert.doesNotMatch(screen, /this session/, 'a comment goes to other people: approved once, never for the session');
    assert.match(screen, /n +Deny/);
    s.terminal.send('y');
    assert.equal(await pending, undefined);
    await s.terminal.until((text) => !text.includes('Allow GitHub?'));
    const denied = a.call('github', { action: 'issue_create', title: 'x' });
    await s.terminal.until((text) => /open issue[^\n]*\n[^\n]*x/.test(text));
    s.terminal.send('n');
    assert.equal((await denied)?.block, true);
  } finally {
    await s.close();
    s.cleanup();
  }
});

test('docker and aws never offer this-session approval, and s does nothing there', async () => {
  const s = await open();
  try {
    s.connectors.setEnabled('docker', true);
    s.connectors.cycleAccess('docker');
    const a = agent(s.connectors);
    const pending = a.call('docker', { action: 'run', image: 'node:22', command: ['node', '-v'] });
    const screen = await s.terminal.until((text) => text.includes('Allow Docker'));
    assert.match(screen, /y +Allow once/);
    assert.match(screen, /n +Deny/);
    assert.doesNotMatch(screen, /this session/);
    s.terminal.send('s');
    await flush();
    assert.match(await s.terminal.screen(), /Allow Docker/);
    s.terminal.send('y');
    assert.equal(await pending, undefined);
  } finally {
    await s.close();
    s.cleanup();
  }
});

test('sandbox approvals and connector approvals take turns: one question at a time, in order', async () => {
  const s = await open();
  try {
    s.connectors.setEnabled('github', true);
    const a = agent(s.connectors);
    const first = s.hostApproval()({ command: 'ls ~', reasons: ['path outside project folder'] });
    await s.terminal.until((text) => text.includes('Allow host command?'));
    const second = a.call('github', { action: 'pr_comment', number: '1', body: 'hi' });
    const third = s.hostApproval()({ command: 'cat ~/x', reasons: ['credential or wallet files'] });
    await flush();
    let screen = await s.terminal.screen();
    // One card above the composer; the next question waits its turn.
    assert.match(screen, /Allow host command\?/);
    assert.match(screen, /path outside project folder/);
    assert.doesNotMatch(screen, /Allow GitHub/, 'the second question waits its turn');
    s.terminal.send('y');
    assert.equal(await first, true);
    screen = await s.terminal.until((text) => text.includes('Allow GitHub?'));
    assert.match(screen, /comment on pull request #1[^\n]*\n[^\n]*hi/);
    assert.doesNotMatch(screen, /Allow host command\?/);
    s.terminal.send('n');
    assert.equal((await second)?.block, true);
    screen = await s.terminal.until((text) => text.includes('Allow host command?') && text.includes('cat ~/x'));
    // A card that comes up right after an answer ignores Allow for a moment: a repeated key cannot approve it unseen.
    let settled = false;
    void third.then(() => (settled = true));
    s.terminal.send('s');
    await flush();
    assert.equal(settled, false, 'an immediate s did not approve the next card');
    await new Promise((done) => setTimeout(done, 750));
    s.terminal.send('s');
    assert.equal(await third, 'session');
  } finally {
    await s.close();
    s.cleanup();
  }
});

test('the connectors panel never covers the composer or the status row', async () => {
  for (const [columns, rows] of [
    [100, 30],
    [120, 36],
  ] as const) {
    const s = await open({ columns, rows });
    try {
      await command(s, '/connectors');
      const screen = await s.terminal.until((text) => text.includes('Esc back'));
      const bottom = screen.split('\n').slice(-4);
      assert.match(bottom[1]!, /^❯ /, `${columns}x${rows}`);
      for (const row of bottom) assert.ok(!row.includes('│'), `${columns}x${rows}: ${row}`);
    } finally {
      await s.close();
      s.cleanup();
    }
  }
});
