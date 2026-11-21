import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OmsSession } from '@oms/engine';
import { chatFixture, start } from '../test-support/fake-session.ts';
import { createConnectors } from '../src/connectors/runtime.ts';
import type { ConnectorsConfig } from '../src/connectors/config.ts';
import type { HostResult, HostRun } from '../src/connectors/host.ts';
import { findCommand, type CommandContext } from '../src/tui/commands.ts';
import { base58Encode } from '../src/tui/solana-commands.ts';
import type { Prepared } from '../src/tui/prepared.ts';

const WALLET = base58Encode(new Uint8Array(32).fill(9));
const SIGNATURE = base58Encode(new Uint8Array(64).fill(7));

function setup(config: Partial<ConnectorsConfig> = {}, replies: Record<string, Partial<HostResult>[]> = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'oms-commands-'));
  writeFileSync(
    join(stateRoot, 'connectors.json'),
    JSON.stringify({ version: 1, connectors: {}, tips: {}, ...config }),
  );
  const calls: Array<{ file: string; args: readonly string[]; cwd?: string }> = [];
  const run: HostRun = async (file, args, options) => {
    calls.push({ file, args, cwd: options?.cwd });
    const next = replies[file]?.shift();
    if (next) return { code: 0, stdout: '', stderr: '', ...next };
    if (file === 'git') return { code: 0, stdout: 'git@github.com:x/y.git\n', stderr: '' };
    return { code: null, stdout: '', stderr: '', error: 'missing' };
  };
  const connectors = createConnectors({ stateRoot, folder: '/work', env: {}, run });
  const f = chatFixture();
  return { stateRoot, calls, run, connectors, f, cleanup: () => rmSync(stateRoot, { recursive: true, force: true }) };
}
const github = { github: { enabled: true, access: 'ask' as const } };

async function typed(
  f: ReturnType<typeof chatFixture>,
  connectors: ReturnType<typeof createConnectors>,
  text: string,
  until: (screen: string) => boolean,
  extra: { startNote?: string } = {},
) {
  const session = start(f.harness, 110, 34, { connectors, ...extra });
  await session.terminal.until((s) => s.includes('/ commands'));
  session.terminal.send(text);
  session.terminal.send('\r');
  const screen = await session.terminal.until(until);
  return { session, screen };
}

test('/pr, /issue and /ci say so when nothing is connected, and ask nothing of the agent', async () => {
  const t = setup();
  try {
    for (const text of ['/pr', '/issue 7', '/ci']) {
      const { session, screen } = await typed(t.f, t.connectors, text, (s) =>
        s.includes("GitHub or GitLab isn't connected · /connectors"),
      );
      assert.match(screen, /isn't connected/);
      await session.close();
    }
    const linear = await typed(t.f, t.connectors, '/issue LIN-12', (s) => s.includes("Linear isn't connected"));
    await linear.session.close();
    assert.deepEqual(t.f.prompts, []);
    assert.deepEqual(
      t.calls.filter((call) => call.file !== 'git'),
      [],
    );
  } finally {
    t.cleanup();
  }
});

test('/pr 12 fetches on the host, shows a one-line note, and sends the request and the framed text to the agent', async () => {
  const t = setup({ connectors: github }, { gh: [{ stdout: '{"title":"Add vault"}' }, { stdout: 'src/lib.rs\n' }] });
  const session = start(t.f.harness, 110, 34, { connectors: t.connectors });
  try {
    await session.terminal.until((s) => s.includes('/ commands'));
    session.terminal.send('/pr 12 only check the tests');
    session.terminal.send('\r');
    const screen = await session.terminal.until((s) => s.includes('Fetched pull request #12 from GitHub'));
    assert.match(screen, /Sending it to the agent\./);
    await session.terminal.until(() => t.f.prompts.length >= 1);
    assert.ok(t.f.prompts[0]!.startsWith('only check the tests\n\n[Untrusted reference data from GitHub through gh.'));
    assert.match(t.f.prompts[0]!, /<untrusted-knowledge tool="gh">[\s\S]*Add vault/);
    assert.deepEqual(t.calls.find((call) => call.file === 'gh')!.args.slice(0, 3), ['pr', 'view', '12']);
    assert.equal(t.calls.find((call) => call.file === 'gh')!.cwd, '/work');
  } finally {
    t.f.promptGate.resolve();
    t.f.abortGate.resolve();
    await session.close();
    t.cleanup();
  }
});

test('/ci and /issue use their default requests; a bad issue reference never reaches a program', async () => {
  const checks = JSON.stringify([{ bucket: 'fail', link: 'https://github.com/o/r/actions/runs/55/job/1' }]);
  const t = setup(
    { connectors: github },
    { gh: [{ code: 8, stdout: checks }, { stdout: 'boom' }, { stdout: '{"title":"Crash"}' }] },
  );
  try {
    const ci = start(t.f.harness, 110, 34, { connectors: t.connectors });
    await ci.terminal.until((s) => s.includes('/ commands'));
    ci.terminal.send('/ci');
    ci.terminal.send('\r');
    await ci.terminal.until(() => t.f.prompts.length === 1);
    assert.match(t.f.prompts[0]!, /^Find and fix the cause of these failing checks\./);
    assert.match(t.f.prompts[0]!, /Failed log of run 55:\nboom/);
    t.f.promptGate.resolve();
    t.f.abortGate.resolve();
    await ci.close();

    const bad = await typed(t.f, t.connectors, '/issue 1; rm -rf /', (s) => s.includes('Say which issue'));
    assert.equal(t.calls.filter((call) => call.file === 'gh').length, 2);
    await bad.session.close();
  } finally {
    t.cleanup();
  }
});

test('/help lists /pr, /issue and /ci only when a service for them is connected', async () => {
  const none = setup();
  const some = setup({ connectors: github });
  try {
    const off = await typed(none.f, none.connectors, '/help', (s) => s.includes('/exit to quit'));
    assert.doesNotMatch(off.screen, /\/pr |\/ci /);
    await off.session.close();
    const on = await typed(some.f, some.connectors, '/help', (s) => s.includes('/exit to quit'));
    assert.match(on.screen, /\/pr +Have the agent review a pull request/);
    assert.match(on.screen, /\/issue +Have the agent work on an issue/);
    await on.session.close();
  } finally {
    none.cleanup();
    some.cleanup();
  }
});

// ---------------------------------------------------------------- the sign-in tip

const tipSetup = (launches: number, extra: Partial<ConnectorsConfig['tips']> = {}) =>
  setup({ tips: { launches, shown: 0, lastShown: 0, dismissed: false, ...extra } });
const TIP = /Tip: connect GitHub so the agent can read issues, pull requests and CI\. Run \/connectors\./;

test('the tip shows once in the empty conversation from the third launch, never earlier', async () => {
  const early = tipSetup(1);
  const due = tipSetup(3);
  try {
    early.connectors.recordLaunch();
    const first = start(early.f.harness, 100, 30, { connectors: early.connectors });
    await first.terminal.until((s) => s.includes('/ commands'));
    await early.connectors.prime();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.doesNotMatch(await first.terminal.screen(), /Tip:/);
    await first.close();

    due.connectors.recordLaunch(); // launch 4
    const session = start(due.f.harness, 100, 30, { connectors: due.connectors });
    const screen = await session.terminal.until((s) => TIP.test(s.replace(/\s+/g, ' ')));
    assert.match(screen.replace(/\s+/g, ' '), TIP);
    // It is drawn with the empty state only: it was never added to the conversation.
    assert.equal(due.connectors.config().tips.shown, 1);
    await session.close();
  } finally {
    early.cleanup();
    due.cleanup();
  }
});

test('the tip stays away when dismissed, when a service is connected, or when the screen is short', async () => {
  const cases: Array<[string, ReturnType<typeof setup>, { rows?: number }]> = [
    ['dismissed', tipSetup(5, { dismissed: true }), {}],
    [
      'connected',
      setup({
        connectors: { gitlab: { enabled: true, access: 'read' } },
        tips: { launches: 5, shown: 0, lastShown: 0, dismissed: false },
      }),
      {},
    ],
    ['short', tipSetup(5), { rows: 17 }],
  ];
  for (const [name, t, size] of cases) {
    try {
      const session = start(t.f.harness, 100, size.rows ?? 30, { connectors: t.connectors });
      await session.terminal.until((s) => s.includes('/ commands'));
      await t.connectors.prime();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.doesNotMatch(await session.terminal.screen(), /Tip:/, name);
      await session.close();
    } finally {
      t.cleanup();
    }
  }
});

test('after /login succeeds, one optional line points to /connectors', async () => {
  const t = tipSetup(3);
  let state: 'signed-out' | 'signed-in' = 'signed-out';
  Object.assign(t.f.harness, {
    account: {
      snapshot: () => ({ state, origin: 'https://oms.example', email: 'a@b.c' }),
      refresh: async () => {},
      logout: async () => ({ serverRevoked: true }),
      login: async () => {
        state = 'signed-in';
      },
    },
  });
  try {
    // A note in the conversation keeps the empty state, and its own copy of the tip, out of the way.
    const { session, screen } = await typed(
      t.f,
      t.connectors,
      '/login',
      (s) => s.includes('Optional: connect GitHub, GitLab, Linear or Slack in /connectors.'),
      { startNote: 'hello' },
    );
    assert.match(screen, /Signed in as a@b\.c/);
    await session.close();
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------- explorer links and remote lookups

function fakeContext(extra: Record<string, unknown> = {}): { ctx: CommandContext; chain: Array<[string, unknown[]]> } {
  const chain: Array<[string, unknown[]]> = [];
  const harness = {
    chain: {
      rpcUrl: () => 'http://127.0.0.1:20000',
      async call(method: string, params: unknown[] = []) {
        chain.push([method, params]);
        if (method === 'getAccountInfo') return { value: null };
        return null;
      },
    },
  } as unknown as OmsSession;
  return { ctx: { harness, ...extra } as unknown as CommandContext, chain };
}
const prepare = (ctx: CommandContext, name: string, argument: string) =>
  findCommand(name)!.run(ctx, argument, undefined) as Prepared;
const output = async (prepared: Prepared) => {
  assert.ok(prepared.ok, prepared.ok ? '' : prepared.message);
  return (await prepared.run(new AbortController().signal))!;
};

test('local /account, /tx and /program results end with a plain explorer link that names the local chain', async () => {
  const { ctx } = fakeContext();
  const account = (await output(prepare(ctx, 'account', WALLET))).text;
  assert.match(
    account,
    new RegExp(
      `Explorer: https://explorer\\.solana\\.com/address/${WALLET}\\?cluster=custom&customUrl=http%3A%2F%2F127\\.0\\.0\\.1%3A20000$`,
    ),
  );
  const tx = (await output(prepare(ctx, 'tx', SIGNATURE))).text;
  assert.match(
    tx,
    /No transaction with this signature on the local chain\.\nExplorer: https:\/\/explorer\.solana\.com\/tx\//,
  );
  const program = (await output(prepare(ctx, 'program', '11111111111111111111111111111111'))).text;
  assert.match(program, /Explorer: https:\/\/explorer\.solana\.com\/address\/11111111111111111111111111111111$/);
  assert.doesNotMatch((await output(prepare(ctx, 'program', 'system'))).text, /Explorer:/);
});

test('--cluster needs the Solana RPC connector, is read-only, and never shows the address or key', async () => {
  const off = setup();
  const on = setup({ connectors: { 'solana-rpc': { enabled: true, access: 'read' } } });
  const original = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (url: unknown, init: { body: string }) => {
    requests.push({ url: String(url), method: JSON.parse(init.body).method });
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          value: {
            lamports: 2_500_000_000,
            owner: '11111111111111111111111111111111',
            data: ['', 'base64'],
            executable: false,
          },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const refused = prepare(fakeContext({ connectors: off.connectors }).ctx, 'account', `${WALLET} --cluster devnet`);
    assert.ok(!refused.ok);
    assert.match(refused.message, /Looking up devnet needs Solana RPC\. Turn it on in \/connectors\./);
    assert.ok(!prepare(fakeContext().ctx, 'account', `${WALLET} --cluster devnet`).ok);
    assert.match(
      (
        prepare(fakeContext({ connectors: on.connectors }).ctx, 'account', `${WALLET} --cluster testnet`) as {
          message: string;
        }
      ).message,
      /devnet or mainnet/,
    );
    const { ctx, chain } = fakeContext({ connectors: on.connectors });
    const result = await output(prepare(ctx, 'account', `${WALLET} --cluster devnet`));
    assert.deepEqual(requests, [{ url: 'https://api.devnet.solana.com', method: 'getAccountInfo' }]);
    assert.deepEqual(chain, [], 'the local chain was not asked');
    assert.match(result.text, /Lamports: 2500000000 \(2\.5 SOL\)/);
    assert.match(
      result.text,
      new RegExp(`Explorer: https://explorer\\.solana\\.com/address/${WALLET}\\?cluster=devnet$`),
    );
    assert.doesNotMatch(result.text, /api\.devnet\.solana|api-key/);
    const tx = prepare(ctx, 'tx', `${SIGNATURE} --cluster mainnet`);
    assert.ok(tx.ok);
  } finally {
    globalThis.fetch = original;
    off.cleanup();
    on.cleanup();
  }
});
