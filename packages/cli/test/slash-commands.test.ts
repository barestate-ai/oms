import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession, HarnessSession, OmsSession } from '@oms/engine';
import {
  OMS_COMMANDS,
  chatHelp,
  closestCommand,
  commandHelp,
  commandMatches,
  commandProblem,
  keysHelp,
} from '../src/tui/commands.ts';
import {
  acceptsArgument,
  canRunWhileBusy,
  findCommand,
  parseCommand,
  type CommandContext,
} from '../src/tui/commands.ts';
import { budgetLine } from '../src/tui/inspect-commands.ts';
import { claudeChatStatus } from '../src/tui/claude-chat.ts';
import type { CommandOutput, Prepared } from '../src/tui/prepared.ts';
import {
  base58Decode,
  base58Encode,
  describeTokenData,
  describeTransactionError,
  isBase58Bytes,
} from '../src/tui/solana-commands.ts';
import { testCommand } from '../src/tui/work-commands.ts';
import {
  failurePrompt,
  newGoal,
  parseGoalArguments,
  runGoalCheck,
  runGoalLoop,
  taskVerifierItem,
  type CheckResult,
  type Goal,
} from '../src/tui/goal.ts';

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SIGNATURE = base58Encode(new Uint8Array(64).fill(7));
const WALLET = base58Encode(new Uint8Array(32).fill(9));

function chainFake(url = 'http://127.0.0.1:20000') {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  let balance = 5;
  const handlers: Record<string, (params: unknown[]) => unknown> = {
    getSlot: () => 321,
    getVersion: () => ({ 'solana-core': '2.3.1' }),
    getBalance: () => ({ value: balance }),
    requestAirdrop: (params) => {
      balance += Number(params[1]);
      return 'airdrop-signature';
    },
  };
  let rewinds = 0;
  return {
    calls,
    handlers,
    rewinds: () => rewinds,
    chain: {
      rpcUrl: () => url,
      mode: 'offline-snapshot' as const,
      uptimeMs: () => 125_000,
      health: async () => ({ ok: true }),
      async call(method: string, params: unknown[] = []) {
        calls.push({ method, params });
        const handler = handlers[method];
        if (!handler) throw new Error(`unexpected ${method}`);
        return handler(params);
      },
      async rewind() {
        rewinds++;
      },
    },
  };
}

function harnessFake(extra: Record<string, unknown> = {}): HarnessSession {
  const task = { id: 't', codeRoot: '/nonexistent', baseOid: 'a'.repeat(40), branch: 'oms/t' };
  return {
    kind: 'task',
    root: (extra.task as typeof task | undefined)?.codeRoot ?? task.codeRoot,
    task,
    budget: {
      snapshot: () => ({
        caps: { tokens: 1000, spendMicroUsd: 5_000_000, wallClockMs: 600_000 },
        used: { tokens: 120, spendMicroUsd: 2500, wallClockMs: 61_000 },
        remaining: { tokens: 880, spendMicroUsd: 4_997_500, wallClockMs: 539_000 },
        accounting: 'known',
        exhausted: false,
        executionMode: 'interactive',
        reasons: [],
      }),
      receipts: () => [
        {
          dispatchId: 'd1',
          outcome: 'known',
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 5 },
        },
        { dispatchId: 'd2', outcome: 'known' },
      ],
      reservations: () => [{ dispatchId: 'd1' }, { dispatchId: 'd2' }],
    },
    ...extra,
  } as unknown as HarnessSession;
}

/** The work or refusal a command prepares for an argument, as the interface's table hands it over. Undefined for a name it does not own. */
function prepareSlash(name: string, argument: string, harness: OmsSession): Prepared | undefined {
  return findCommand(name)?.run({ harness } as unknown as CommandContext, argument, undefined) as Prepared | undefined;
}

async function run(prepared: Prepared | undefined, signal = new AbortController().signal): Promise<CommandOutput> {
  assert.ok(prepared?.ok, prepared && !prepared.ok ? prepared.message : 'not a command');
  const output = await prepared.run(signal);
  assert.ok(output, 'the command showed nothing');
  return output;
}
const refusal = (prepared: Prepared | undefined): string => {
  assert.ok(prepared && !prepared.ok, 'expected a refusal');
  return prepared.message;
};

// ------------------------------------------------------------------ the command list

test('folder chat help lists its commands, then a few keys in aligned columns, in the terse house style', () => {
  const summary = chatHelp().split('\n\n').at(-1)!;
  assert.equal(
    summary,
    'Keys\n' +
      '  esc         cancel\n' +
      '  ctrl+c      cancel · twice to quit\n' +
      '  ctrl+k      commands\n' +
      '  /help keys  all keys',
  );
  assert.doesNotMatch(summary, /\b(Press|Use|Run) |\bleave\b/);
  assert.match(chatHelp(), /\/connect +Model provider sign-in or API key/);
  assert.match(chatHelp(), /\/connectors +Give the agent GitHub, Docker, AWS/);
  // Commands that need a connected service are listed only when one is on.
  assert.doesNotMatch(chatHelp(), /\/pr |\/issue |\/ci /);
  assert.match(chatHelp(['pr', 'issue', 'ci']), /\/pr +Have the agent review a pull request/);
  assert.match(chatHelp(['pr', 'issue', 'ci']), /\/ci +Have the agent fix failing checks/);
  assert.match(chatHelp(), /\/model +Pick a model/);
  assert.match(
    chatHelp(),
    /^\/connect {5}Model provider/,
    'names pad to the longest command, not to a long list of them',
  );
  assert.match(chatHelp(), /Also: \/theme \/art \/settings \/login \/logout · \/exit to quit/);
});

test('/help keys lists the keys of the current mode from one table, and names quit and cancel the same way everywhere', () => {
  const chat = keysHelp('chat');
  const task = keysHelp('task');
  for (const keys of [chat, task]) {
    assert.match(keys, /ctrl\+c +cancel work · twice to quit/);
    assert.match(keys, /ctrl\+q +quit \(ctrl\+d on an empty line\)/);
    for (const key of ['f3', 'f4', 'f8', 'pgup pgdn']) assert.match(keys, new RegExp(`^ {2}${key} `, 'm'), key);
    assert.doesNotMatch(keys, /\bleave\b|Press |Use /);
  }
  // A chat has no requirements panel; both have the header tabs (f10) and the workbench areas (f6).
  assert.doesNotMatch(chat, /^ {2}f2 /m);
  for (const key of ['f2', 'f6', 'f10']) assert.match(task, new RegExp(`^ {2}${key} `, 'm'), key);
  for (const key of ['f6', 'f10']) assert.match(chat, new RegExp(`^ {2}${key} `, 'm'), key);
});

test('a mistyped command names itself and the nearest command; a bad argument says what the command takes', () => {
  assert.equal(commandProblem({ name: 'thme', argument: '' }, 'chat'), '/thme not found · did you mean /theme?');
  assert.equal(commandProblem({ name: 'mdoel', argument: '' }, 'chat'), '/mdoel not found · did you mean /model?');
  assert.equal(commandProblem({ name: 'xyzzy', argument: '' }, 'chat'), '/xyzzy not found · /help');
  // A task-only command is not offered to a chat.
  assert.equal(closestCommand('verfy', 'chat'), undefined);
  assert.equal(closestCommand('verfy', 'task')?.name, 'verify');
  assert.equal(commandProblem({ name: 'terminal', argument: 'x' }, 'chat'), 'Usage: /terminal [start|stop|hide]');
  assert.equal(commandProblem({ name: 'clear', argument: 'x' }, 'chat'), '/clear takes no arguments');
  assert.equal(commandProblem({ name: 'open', argument: '' }, 'chat'), 'Usage: /open <path>');
});

test('a chat lists the commands its /help shows first, and /quit stays out of the full list', () => {
  const names = commandMatches('/', 'chat')!.map((command) => command.name);
  assert.deepEqual(names.slice(0, 4), ['connect', 'connectors', 'model', 'yolo']);
  assert.ok(!names.includes('quit'));
  assert.ok(names.includes('exit'));
  assert.deepEqual(
    commandMatches('/qu', 'chat')!.map((command) => command.name),
    ['quit'],
  );
});

test('the menu and help list every new command, with Solana after Work, and no planned ones', () => {
  const names: string[] = OMS_COMMANDS.map((command) => command.name);
  for (const name of [
    'model',
    'goal',
    'clear',
    'diff',
    'usage',
    'test',
    'chain',
    'rewind',
    'airdrop',
    'account',
    'tx',
    'program',
    'error',
  ]) {
    assert.ok(names.includes(name), name);
  }
  for (const name of ['claude', 'deploy', 'undo', 'compact', 'resume']) assert.equal(names.includes(name), false, name);
  assert.equal(new Set(names).size, names.length, 'no duplicate command names');
  const help = commandHelp();
  assert.ok(help.indexOf('\nWork\n') < help.indexOf('\nSolana\n'));
  assert.match(help, /\/airdrop <address> \[sol\]/);
  assert.match(help, /\/account <address>/);
  assert.doesNotMatch(help, /\/claude/);
  assert.deepEqual(commandMatches('/claude'), []);
  for (const argument of ['', 'status', 'reconnect', 'reset']) {
    assert.equal(prepareSlash('claude', argument, harnessFake()), undefined);
    assert.equal(findCommand('claude'), undefined);
  }
  assert.equal(OMS_COMMANDS.find((command) => command.name === 'goal')?.group, 'Work');
  assert.equal(OMS_COMMANDS.find((command) => command.name === 'diff')?.group, 'Inspect');
  assert.equal(prepareSlash('unknown', '', harnessFake()), undefined);
});

// ------------------------------------------------------------------ /goal parsing and loop

test('/goal arguments: show, clear, text, quoted and bare checks, and bad input', () => {
  assert.deepEqual(parseGoalArguments(''), { kind: 'show' });
  assert.deepEqual(parseGoalArguments(' clear '), { kind: 'clear' });
  assert.deepEqual(parseGoalArguments('make tests pass'), { kind: 'set', text: 'make tests pass', check: undefined });
  assert.deepEqual(parseGoalArguments('make tests pass --check "npm test -- --grep \\"x\\""'), {
    kind: 'set',
    text: 'make tests pass',
    check: 'npm test -- --grep "x"',
  });
  assert.deepEqual(parseGoalArguments("fix it --check 'cargo test'"), {
    kind: 'set',
    text: 'fix it',
    check: 'cargo test',
  });
  assert.deepEqual(parseGoalArguments('fix it --check npm test'), { kind: 'set', text: 'fix it', check: 'npm test' });
  assert.equal(parseGoalArguments('fix it --check').kind, 'error');
  assert.equal(parseGoalArguments('--check "npm test"').kind, 'error');
  assert.equal(parseGoalArguments('x'.repeat(5000)).kind, 'error');
  assert.deepEqual(parseGoalArguments('fix --checkout main'), {
    kind: 'set',
    text: 'fix --checkout main',
    check: undefined,
  });
});

function loopFixture(results: CheckResult[], options: { exhaustAfter?: number; abortAfterTurn?: number } = {}) {
  const goal = newGoal('make it pass', 'npm test');
  const prompts: string[] = [];
  const said: string[] = [];
  const controller = new AbortController();
  let checks = 0;
  const snapshot = () => ({
    caps: { tokens: 1, spendMicroUsd: 1, wallClockMs: 1 },
    used: { tokens: 0, spendMicroUsd: 0, wallClockMs: 0 },
    remaining: { tokens: 1, spendMicroUsd: 1, wallClockMs: 1 },
    exhausted: options.exhaustAfter !== undefined && checks >= options.exhaustAfter,
    reasons: ['tokens' as const],
  });
  return {
    goal,
    prompts,
    said,
    controller,
    loop: {
      goal,
      signal: controller.signal,
      budget: snapshot,
      say: (text: string) => {
        said.push(text);
      },
      async turn(prompt: string) {
        prompts.push(prompt);
        if (options.abortAfterTurn === prompts.length) controller.abort();
      },
      async check() {
        return results[Math.min(checks++, results.length - 1)]!;
      },
    },
  };
}
const fail = (output: string): CheckResult => ({ status: 'fail', output, summary: 'check failed (exit 1)' });
const pass: CheckResult = { status: 'pass', output: '', summary: 'check passed (exit 0)' };

test('/goal loop: a failing check feeds its output back, then a passing check reaches the goal', async () => {
  const f = loopFixture([fail('expected 2, got 3'), pass]);
  await runGoalLoop(f.loop);
  assert.equal(f.goal.status, 'reached');
  assert.equal(f.goal.attempts, 2);
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[0]!, /Goal: make it pass/);
  assert.match(f.prompts[0]!, /Your own claim that it is done is never enough/);
  assert.match(f.prompts[1]!, /expected 2, got 3/);
  assert.match(f.prompts[1]!, /1 of 5/);
  assert.ok(f.said.some((line) => line.startsWith('Goal reached')));
});

test('/goal loop: the retry cap stops it visibly after five checks', async () => {
  let n = 0;
  const f = loopFixture([]);
  f.loop.check = async () => fail(`different failure ${n++}`);
  await runGoalLoop(f.loop);
  assert.equal(f.goal.status, 'stopped');
  assert.equal(f.goal.attempts, 5);
  assert.equal(f.prompts.length, 5);
  assert.ok(
    f.said.some((line) => /Goal stopped: retry cap reached/.test(line)),
    f.said.join('\n'),
  );
});

test('/goal loop: the same failure twice, an exhausted budget and an unavailable check each stop it', async () => {
  const repeated = loopFixture([fail('same'), fail('same')]);
  await runGoalLoop(repeated.loop);
  assert.equal(repeated.goal.status, 'stopped');
  assert.match(repeated.goal.summary, /same failure twice/);
  assert.equal(repeated.prompts.length, 2);

  const broke = loopFixture([fail('a'), fail('b')], { exhaustAfter: 1 });
  await runGoalLoop(broke.loop);
  assert.match(broke.goal.summary, /budget exhausted/);
  assert.equal(broke.prompts.length, 1);

  const unavailable = loopFixture([{ status: 'unavailable', output: '', summary: 'verifier could not run' }]);
  await runGoalLoop(unavailable.loop);
  assert.equal(unavailable.goal.status, 'stopped');
  assert.match(unavailable.goal.summary, /unavailable/);
});

test('/goal loop: cancelling ends it at the next boundary without running the check', async () => {
  const f = loopFixture([pass], { abortAfterTurn: 1 });
  let checked = false;
  f.loop.check = async () => {
    checked = true;
    return pass;
  };
  await runGoalLoop(f.loop);
  assert.equal(f.goal.status, 'cancelled');
  assert.equal(checked, false);
});

test('/goal loop: a failed agent turn marks the goal stopped and rethrows', async () => {
  const f = loopFixture([pass]);
  f.loop.turn = async () => {
    throw new Error('provider failed');
  };
  await assert.rejects(runGoalLoop(f.loop), /provider failed/);
  assert.equal(f.goal.status, 'stopped');
  assert.equal(f.goal.summary, 'provider failed');
});

test('failure feedback is bounded to the tail of the output', () => {
  const goal: Goal = newGoal('g', 'c');
  const prompt = failurePrompt(goal, fail('x'.repeat(20_000) + 'THE-END'));
  assert.ok(prompt.length < 5_000);
  assert.match(prompt, /THE-END/);
});

test('/goal check: a sandbox command decides by exit code; the task verifier decides when there is no command', async () => {
  const goal = { check: 'npm test' };
  const commands: string[] = [];
  const result = (exitCode: number, extra = {}) =>
    harnessFake({
      async runCommand(command: string) {
        commands.push(command);
        return {
          exitCode,
          stdout: 'out',
          stderr: 'err',
          timedOut: false,
          cancelled: false,
          truncated: false,
          ...extra,
        };
      },
    });
  assert.equal((await runGoalCheck(result(0), goal, new AbortController().signal)).status, 'pass');
  const failed = await runGoalCheck(result(2), goal, new AbortController().signal);
  assert.deepEqual([failed.status, failed.output], ['fail', 'out\nerr']);
  assert.equal((await runGoalCheck(result(0, { timedOut: true }), goal, new AbortController().signal)).status, 'fail');
  assert.equal(
    (await runGoalCheck(result(1, { cancelled: true }), goal, new AbortController().signal)).status,
    'unavailable',
  );
  assert.deepEqual(commands, ['npm test', 'npm test', 'npm test', 'npm test']);

  const verified: Array<string | undefined> = [];
  let outcome: unknown = { closed: true, reason: 'verified' };
  const withTask = (items: Array<{ id: string; status: string }>) =>
    harnessFake({
      evaluator: { read: () => ({ ok: true, value: { items } }) },
      async verify(id?: string) {
        verified.push(id);
        return { itemId: id, result: outcome };
      },
    });
  const open = withTask([{ id: 'R1', status: 'active' }]);
  assert.equal(taskVerifierItem(open), 'R1');
  assert.equal((await runGoalCheck(open, { check: undefined }, new AbortController().signal)).status, 'pass');
  outcome = { closed: false, reason: 'failed', detail: 'test X failed' };
  const verdict = await runGoalCheck(open, { check: undefined }, new AbortController().signal);
  assert.deepEqual([verdict.status, verdict.output], ['fail', 'test X failed']);
  outcome = { closed: false, reason: 'reopen-cap', detail: 'cap' };
  assert.equal((await runGoalCheck(open, { check: undefined }, new AbortController().signal)).status, 'unavailable');
  assert.deepEqual(verified, ['R1', 'R1', 'R1']);
  const closed = withTask([{ id: 'R1', status: 'closed' }]);
  assert.equal(taskVerifierItem(closed), undefined);
  assert.equal((await runGoalCheck(closed, { check: undefined }, new AbortController().signal)).status, 'pass');
  assert.equal(
    (await runGoalCheck(withTask([]), { check: undefined }, new AbortController().signal)).status,
    'unavailable',
  );
});

// ------------------------------------------------------------------ Solana commands

test('base58 helpers round-trip and validate lengths', () => {
  assert.equal(base58Decode(SYSTEM)?.length, 32);
  assert.deepEqual(base58Decode(base58Encode(Uint8Array.from([0, 0, 1, 2, 255]))), Uint8Array.from([0, 0, 1, 2, 255]));
  assert.ok(isBase58Bytes(TOKEN, 32));
  assert.ok(isBase58Bytes(SIGNATURE, 64));
  assert.equal(isBase58Bytes('not an address!', 32), false);
  assert.equal(isBase58Bytes('0OIl', 32), false);
  assert.equal(isBase58Bytes('', 32), false);
  assert.equal(isBase58Bytes('abc', 32), false);
});

test('/chain reports RPC, health, slot, fork state and uptime from the local chain only', async () => {
  const fake = chainFake();
  const out = await run(prepareSlash('chain', '', harnessFake({ chain: fake.chain })));
  assert.match(out.text, /RPC: http:\/\/127\.0\.0\.1:20000/);
  assert.match(out.text, /Health: ok/);
  assert.match(out.text, /Slot: 321/);
  assert.match(out.text, /not a mainnet fork/);
  assert.match(out.text, /Uptime: 2m5s/);
  assert.match(refusal(prepareSlash('chain', 'now', harnessFake())), /Usage/);
  await assert.rejects(run(prepareSlash('chain', '', harnessFake())), /no local chain/);
});

test('/rewind explains itself, restores only on confirm, and rejects other arguments', async () => {
  const fake = chainFake();
  const harness = harnessFake({ chain: fake.chain });
  assert.match((await run(prepareSlash('rewind', '', harness))).text, /\/rewind confirm/);
  assert.equal(fake.rewinds(), 0);
  assert.match((await run(prepareSlash('rewind', 'confirm', harness))).text, /starting state/);
  assert.equal(fake.rewinds(), 1);
  assert.match(refusal(prepareSlash('rewind', 'yes', harness)), /confirm/);
});

test('/airdrop validates the address and amount, caps at 100 SOL, and shows the new balance', async () => {
  const fake = chainFake();
  const harness = harnessFake({ chain: fake.chain });
  assert.match(refusal(prepareSlash('airdrop', '', harness)), /Usage/);
  assert.match(refusal(prepareSlash('airdrop', 'nope', harness)), /valid Solana address/);
  assert.match(refusal(prepareSlash('airdrop', `${WALLET} 0`, harness)), /positive/);
  assert.match(refusal(prepareSlash('airdrop', `${WALLET} -1`, harness)), /positive/);
  assert.match(refusal(prepareSlash('airdrop', `${WALLET} 1.2.3`, harness)), /positive/);
  assert.match(refusal(prepareSlash('airdrop', `${WALLET} 100.000000001`, harness)), /capped at 100/);
  assert.match(refusal(prepareSlash('airdrop', `${WALLET} 1 2`, harness)), /Usage/);
  assert.equal(fake.calls.length, 0);
  const out = await run(prepareSlash('airdrop', WALLET, harness));
  assert.match(out.text, /Airdropped 1 SOL to /);
  assert.match(out.text, /Balance: 1\.000000005 SOL/);
  assert.deepEqual(fake.calls.find((call) => call.method === 'requestAirdrop')?.params, [WALLET, 1_000_000_000]);
  const big = await run(prepareSlash('airdrop', `${WALLET} 100`, harness));
  assert.match(big.text, /Airdropped 100 SOL/);
});

test('/airdrop and every chain command refuse an RPC that is not the task loopback Surfpool', async () => {
  for (const url of [
    'https://api.devnet.solana.com',
    'https://api.mainnet-beta.solana.com',
    'http://10.0.0.5:8899',
    'http://127.0.0.1.evil.example:8899',
    'http://user:pw@127.0.0.1:8899',
    'ftp://127.0.0.1:8899',
    'not a url',
  ]) {
    const fake = chainFake(url);
    const harness = harnessFake({ chain: fake.chain });
    for (const [name, argument] of [
      ['airdrop', WALLET],
      ['account', WALLET],
      ['tx', SIGNATURE],
      ['chain', ''],
    ] as const) {
      await assert.rejects(run(prepareSlash(name, argument, harness)), /Refusing/, `${name} ${url}`);
    }
    assert.equal(fake.calls.length, 0, url);
  }
  const down = chainFake();
  down.chain.rpcUrl = () => undefined as unknown as string;
  await assert.rejects(run(prepareSlash('airdrop', WALLET, harnessFake({ chain: down.chain }))), /not running/);
});

test('/account shows owner with its program name, lamports in SOL, data length, executable and a hex preview', async () => {
  const fake = chainFake();
  fake.handlers.getAccountInfo = () => ({
    value: {
      lamports: 1_500_000_000,
      owner: SYSTEM,
      executable: false,
      data: [Buffer.from('hello').toString('base64'), 'base64'],
    },
  });
  const harness = harnessFake({ chain: fake.chain });
  assert.match(refusal(prepareSlash('account', 'bad', harness)), /Usage/);
  const out = await run(prepareSlash('account', WALLET, harness));
  assert.match(out.text, new RegExp(`Owner: ${SYSTEM} \\(System\\)`));
  assert.match(out.text, /Lamports: 1500000000 \(1\.5 SOL\)/);
  assert.match(out.text, /Data: 5 bytes/);
  assert.match(out.text, /Executable: false/);
  assert.match(out.text, /Preview: 68656c6c6f/);
  fake.handlers.getAccountInfo = () => ({ value: null });
  assert.match((await run(prepareSlash('account', WALLET, harness))).text, /No account/);
});

test('/account decodes a token mint and a token account owned by the Token program', async () => {
  const mint = Buffer.alloc(82);
  mint.writeUInt32LE(1, 0);
  Buffer.from(new Uint8Array(32).fill(4)).copy(mint, 4);
  mint.writeBigUInt64LE(1_000_000n, 36);
  mint[44] = 6;
  mint[45] = 1;
  const account = Buffer.alloc(165);
  Buffer.from(new Uint8Array(32).fill(1)).copy(account, 0);
  Buffer.from(new Uint8Array(32).fill(2)).copy(account, 32);
  account.writeBigUInt64LE(42n, 64);
  account[108] = 1;
  const fake = chainFake();
  const harness = harnessFake({ chain: fake.chain });
  fake.handlers.getAccountInfo = () => ({
    value: { lamports: 1, owner: TOKEN, executable: false, data: [mint.toString('base64'), 'base64'] },
  });
  const minted = (await run(prepareSlash('account', WALLET, harness))).text;
  assert.match(minted, /Owner: Tokenkeg\S+ \(SPL Token\)/);
  assert.match(minted, /Token mint:/);
  assert.match(minted, /decimals: 6/);
  assert.match(minted, /supply: 1000000/);
  assert.match(minted, new RegExp(`mint authority: ${base58Encode(new Uint8Array(32).fill(4))}`));
  fake.handlers.getAccountInfo = () => ({
    value: { lamports: 1, owner: TOKEN, executable: false, data: [account.toString('base64'), 'base64'] },
  });
  const held = (await run(prepareSlash('account', WALLET, harness))).text;
  assert.match(held, /Token account:/);
  assert.match(held, /amount: 42/);
  assert.match(held, /state: initialized/);
  assert.match(held, new RegExp(`owner: ${base58Encode(new Uint8Array(32).fill(2))}`));
  assert.deepEqual(describeTokenData(new Uint8Array(10)), []);
  const extended = Buffer.alloc(170);
  extended[165] = 2;
  assert.equal(describeTokenData(extended)[0], 'Token account:');
});

test('/tx shows status, decoded error, compute units, fee and bounded logs', async () => {
  const fake = chainFake();
  const logs = Array.from({ length: 60 }, (_, i) => `Program log: line ${i}${'x'.repeat(i === 0 ? 400 : 0)}`);
  fake.handlers.getTransaction = () => ({
    slot: 77,
    transaction: { message: { accountKeys: [WALLET, TOKEN], instructions: [{ programIdIndex: 1 }] } },
    meta: { err: { InstructionError: [0, { Custom: 1 }] }, fee: 5000, computeUnitsConsumed: 4321, logMessages: logs },
  });
  const harness = harnessFake({ chain: fake.chain });
  assert.match(refusal(prepareSlash('tx', 'abc', harness)), /Usage/);
  const out = (await run(prepareSlash('tx', SIGNATURE, harness))).text;
  assert.match(out, /Status: failed/);
  assert.match(out, /SPL Token: InsufficientFunds/);
  assert.match(out, /Compute units: 4321/);
  assert.match(out, /Fee: 5000 lamports \(0\.000005 SOL\)/);
  assert.match(out, /Slot: 77/);
  assert.match(out, /\[20 more lines\]/);
  assert.equal(out.includes('x'.repeat(400)), false);
  fake.handlers.getTransaction = () => ({
    slot: 1,
    transaction: { message: { accountKeys: [WALLET], instructions: [] } },
    meta: { err: null, fee: 0, logMessages: [] },
  });
  assert.match((await run(prepareSlash('tx', SIGNATURE, harness))).text, /Status: success/);
  fake.handlers.getTransaction = () => null;
  assert.match((await run(prepareSlash('tx', SIGNATURE, harness))).text, /No transaction/);
  assert.match(describeTransactionError('AccountNotFound', [], [], []), /AccountNotFound/);
  assert.match(
    describeTransactionError({ InstructionError: [0, { Custom: 3012 }] }, [WALLET], [0], []),
    /AccountNotInitialized/,
  );
});

test('/program prints the program reference text without a network or chain', async () => {
  const out = await run(prepareSlash('program', 'system transfer', harnessFake()));
  assert.match(out.text, /System/);
  assert.match(out.text, /ransfer/);
  assert.match((await run(prepareSlash('program', 'no-such-program-zzz', harnessFake()))).text, /No program matches/);
  assert.match(refusal(prepareSlash('program', '  ', harnessFake())), /Usage/);
});

test('/web counts read as plain English at every number', () => {
  const notices: string[] = [];
  const say = (searches: number, fetches: number, lookups: number) => {
    const ctx = {
      harness: {
        web: {
          enabled: () => true,
          set() {},
          usage: () => ({ webSearch: searches, webFetch: fetches, solanaMcp: lookups }),
        },
      },
      clearDraft() {},
      setNotice: (text: string) => notices.push(text),
    } as unknown as CommandContext;
    findCommand('web')!.run(ctx, '', undefined);
    return notices.at(-1);
  };
  assert.equal(say(0, 0, 0), 'Web on · 0 searches · 0 fetches · 0 docs lookups · /web off');
  assert.equal(say(1, 1, 1), 'Web on · 1 search · 1 fetch · 1 docs lookup · /web off');
  assert.equal(say(2, 12, 3), 'Web on · 2 searches · 12 fetches · 3 docs lookups · /web off');
});

test('/program reads for a person: no tool-call syntax, a table of instructions, correct plurals', async () => {
  const list = (await run(prepareSlash('program', 'token', harnessFake()))).text;
  assert.doesNotMatch(list, /source_fetch|ask for one instruction for accounts/);
  assert.match(list, /^Instructions · \/program token <name> for accounts and arguments, \/program token \* for all$/m);
  assert.match(list, /^ {2}Instruction +Tag +Accounts$/m);
  assert.match(list, /^ {2}transfer +03 +3 accounts$/m);
  assert.match(list, /^ {2}initializeMultisig2 +13 +1 account$/m);
  assert.doesNotMatch(list, /\b1 accounts\b/);
  // One instruction keeps its account listing and loses only the tool-call line.
  const detail = (await run(prepareSlash('program', 'token transfer', harnessFake()))).text;
  assert.match(detail, /Accounts in order:\n {2}0\. source \(writable\)/);
  assert.doesNotMatch(detail, /source_fetch/);
});

test('/error decodes locally across Anchor, System and Token tables, local IDLs, and says when nothing answers', async () => {
  const harness = harnessFake();
  const text = async (argument: string, h: HarnessSession = harness) =>
    (await run(prepareSlash('error', argument, h))).text;
  assert.match(await text('3012'), /Anchor framework: AccountNotInitialized/);
  assert.match(await text('0xbc4'), /AccountNotInitialized/);
  assert.match(await text('custom program error: 0x1 token'), /SPL Token: InsufficientFunds/);
  assert.match(await text('0 system'), /System: AccountAlreadyInUse/);
  assert.match(await text('0 ata'), /Associated Token: InvalidOwner/);
  assert.match(await text('1'), /InsufficientFunds/);
  assert.match(await text('6001'), /defined by the program itself/);
  const missing = await text('4242');
  assert.match(missing, /not in built-in tables or local IDLs/);
  assert.match(missing, /IDL or source/);
  assert.doesNotMatch(missing, /knowledge|configured|enabled/i);
  assert.match(refusal(prepareSlash('error', 'abc', harness)), /Usage/);
  assert.match(refusal(prepareSlash('error', '', harness)), /Usage/);
  assert.match(refusal(prepareSlash('error', '1 2 3', harness)), /Usage/);
  assert.match(refusal(prepareSlash('error', '-5', harness)), /Usage/);

  const asked: string[][] = [];
  const served = harnessFake({
    knowledge: {
      config: () => undefined,
      async decodeError(code: string, program?: string) {
        asked.push([code, program ?? '']);
        return 'ProgramX: BadThing';
      },
    },
  });
  assert.match(await text('4242 ProgramX', served), /BadThing/);
  assert.deepEqual(asked, [['4242', 'ProgramX']]);
  await text('3012', served);
  assert.equal(asked.length, 1, 'a locally known code never calls the service');
  const broken = harnessFake({
    knowledge: {
      config: () => undefined,
      async decodeError() {
        throw new Error('service down');
      },
    },
  });
  const failed = await text('4242', broken);
  assert.match(failed, /not in built-in tables or local IDLs/);
  assert.doesNotMatch(failed, /service down|knowledge/i, 'a failed lookup shows no service text');
});

test('/error reads the task IDLs for program-defined codes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-error-'));
  try {
    mkdirSync(join(root, 'target', 'idl'), { recursive: true });
    writeFileSync(
      join(root, 'target', 'idl', 'vault.json'),
      JSON.stringify({
        address: WALLET,
        metadata: { name: 'vault' },
        errors: [{ code: 6001, name: 'Locked', msg: 'Vault is locked' }],
      }),
    );
    const harness = harnessFake({ task: { id: 't', codeRoot: root, baseOid: 'a'.repeat(40), branch: 'b' } });
    const out = (await run(prepareSlash('error', '6001', harness))).text;
    assert.match(out, /vault: Locked · Vault is locked \(local IDL\)/);
    assert.match((await run(prepareSlash('error', `6001 ${WALLET}`, harness))).text, /Locked/);
    assert.match(
      (await run(prepareSlash('error', '3012 vault', harness))).text,
      /Anchor framework: AccountNotInitialized/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ work commands

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'oms-diff-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      encoding: 'utf8',
    }).trim();
  git('init', '-q');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'b.txt'), 'two\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  return { root, git, base: git('rev-parse', 'HEAD') };
}

test('/diff shows staged, unstaged and untracked changes against the base, scoped by path, with bounded output', async () => {
  const repo = gitRepo();
  try {
    const harness = harnessFake({ task: { id: 't', codeRoot: repo.root, baseOid: repo.base, branch: 'oms/t' } });
    assert.match((await run(prepareSlash('diff', '', harness))).text, /No changes/);
    writeFileSync(join(repo.root, 'a.txt'), 'one\nchanged\n');
    repo.git('add', 'a.txt');
    writeFileSync(join(repo.root, 'src', 'b.txt'), 'two\nmore\n');
    writeFileSync(join(repo.root, 'new.txt'), 'fresh\n');
    const all = await run(prepareSlash('diff', '', harness));
    assert.match(all.text, /\+changed/);
    assert.match(all.text, /\+more/);
    assert.match(all.text, /Untracked \(1\):\n  new\.txt/);
    assert.match(all.text, new RegExp(`Against base ${repo.base.slice(0, 12)}`));
    assert.equal(all.report, undefined);
    const scoped = (await run(prepareSlash('diff', 'src', harness))).text;
    assert.match(scoped, /\+more/);
    assert.equal(scoped.includes('+changed'), false);
    for (const bad of ['../outside', '/etc/passwd', '.git/config', 'a\nb']) {
      await assert.rejects(run(prepareSlash('diff', bad, harness)), /inside the project folder/, bad);
    }
    writeFileSync(join(repo.root, 'big.txt'), 'line\n'.repeat(20_000));
    repo.git('add', 'big.txt');
    const long = await run(prepareSlash('diff', '', harness));
    assert.ok(long.text.length < 9_500);
    assert.match(long.text, /opened in the workbench/);
    assert.ok(long.report && long.report.text.includes('+line') && long.report.id.startsWith('diff-'));
    assert.ok(Buffer.byteLength(long.report.text) <= 61 * 1024);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('/usage displays dollars consistently without changing micro-USD values', async () => {
  for (const [used, cap, left, dollars] of [
    [0, 0, 0, ['$0', '$0', '$0']],
    [0, 5_000_000, 5_000_000, ['$0', '$5', '$5']],
    [2500, 5_000_000, 4_997_500, ['$0.0025', '$5', '$4.9975']],
    [0, 1, 1, ['$0', '$0.000001', '$0.000001']],
    [0, 1_234_567_890, 1_234_567_890, ['$0', '$1,234.56789', '$1,234.56789']],
  ] as const) {
    const base = harnessFake().budget.snapshot();
    const snapshot = {
      ...base,
      used: { ...base.used, spendMicroUsd: used },
      caps: { ...base.caps, spendMicroUsd: cap },
      remaining: { ...base.remaining, spendMicroUsd: left },
    };
    const original = structuredClone(snapshot);
    const harness = harnessFake({
      budget: { snapshot: () => snapshot, receipts: () => [], reservations: () => [] },
    });
    const out = await run(prepareSlash('usage', '', harness));
    assert.deepEqual(out.text.match(/\$[\d,.]+/g), dollars);
    assert.match(out.text, /no model calls yet/);
    assert.deepEqual(snapshot, original);
  }
});

test('/usage reports tokens, spend, time and calls as aligned label and value rows', async () => {
  const usageHarness = harnessFake();
  const out = await run(prepareSlash('usage', '', usageHarness));
  assert.equal(
    out.text,
    [
      'Tokens  120 of 1,000',
      'Detail  input 100 · cached 50 read / 5 written · output 20 · 1 earlier call has no breakdown',
      'Spend   $0.0025 of $5 · $4.9975 left',
      'Time    1m1s of 10m',
      'Calls   2 · cache 50 read / 5 written',
    ].join('\n'),
  );
  assert.match(refusal(prepareSlash('usage', 'x', harnessFake())), /Usage/);
});

test('/usage says so when usage is unconfirmed or the budget is used up, and only then', async () => {
  const base = harnessFake().budget.snapshot();
  for (const [change, line] of [
    [{ accounting: 'unknown' }, 'Usage unconfirmed · a failed request may not be counted'],
    [{ exhausted: true }, 'Budget used up'],
  ] as const) {
    const harness = harnessFake({
      budget: { snapshot: () => ({ ...base, ...change }), receipts: () => [], reservations: () => [] },
    });
    assert.ok((await run(prepareSlash('usage', '', harness))).text.endsWith(`\n${line}`), line);
  }
  assert.doesNotMatch((await run(prepareSlash('usage', '', harnessFake()))).text, /unconfirmed|used up/);
});

test('/test picks Anchor, then an npm test script, then Cargo, and refuses when none exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-test-'));
  try {
    assert.equal(testCommand(root), undefined);
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="x"\n');
    assert.equal(testCommand(root), 'cargo test');
    writeFileSync(join(root, 'package.json'), '{"scripts":{"build":"x"}}');
    assert.equal(testCommand(root), 'cargo test');
    writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
    assert.equal(testCommand(root), 'npm test');
    writeFileSync(join(root, 'package.json'), '{not json');
    assert.equal(testCommand(root), 'cargo test');
    writeFileSync(join(root, 'Anchor.toml'), '[provider]\n');
    assert.match(testCommand(root)!, /^anchor test --skip-local-validator --provider\.cluster "\$SURFNET_RPC_URL"$/);

    const ran: string[] = [];
    const harness = harnessFake({
      task: { id: 't', codeRoot: root, baseOid: 'a'.repeat(40), branch: 'b' },
      async runCommand(command: string) {
        ran.push(command);
        return {
          exitCode: 3,
          stdout: 'x'.repeat(20_000) + 'END',
          stderr: 'boom',
          timedOut: false,
          cancelled: false,
          truncated: true,
        };
      },
    });
    const out = await run(prepareSlash('test', '', harness));
    assert.match(out.text, /^\$ anchor test/);
    assert.match(out.text, /Exit: 3/);
    assert.match(out.text, /END\nboom/);
    assert.match(out.text, /\[output truncated\]/);
    assert.ok(out.text.length < 8_400);
    assert.equal(ran.length, 1);
    assert.match(refusal(prepareSlash('test', 'extra', harness)), /Usage/);
    rmSync(join(root, 'Anchor.toml'));
    rmSync(join(root, 'package.json'));
    rmSync(join(root, 'Cargo.toml'));
    assert.match(refusal(prepareSlash('test', '', harness)), /No tests found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only the read-only commands may run while work is busy', () => {
  const runsWhileBusy = (name: string, argument: string) => canRunWhileBusy(findCommand(name)!, argument);
  for (const name of ['usage', 'diff', 'chain', 'account', 'tx', 'program', 'error', 'status', 'session'])
    assert.ok(runsWhileBusy(name, ''), name);
  for (const name of ['airdrop', 'rewind', 'test', 'goal', 'clear', 'run', 'verify', 'review'])
    assert.equal(runsWhileBusy(name, 'x'), false, name);
  // /goal alone only shows the goal; with text or "clear" it changes state.
  assert.equal(runsWhileBusy('goal', ''), true);
  // Interface-only commands run while busy for the arguments they accept, and no others.
  assert.equal(runsWhileBusy('theme', 'dark'), true);
  assert.equal(runsWhileBusy('save', ''), true);
  assert.equal(runsWhileBusy('save', 'x'), false);
  assert.equal(runsWhileBusy('login', ''), true);
  assert.equal(runsWhileBusy('login', 'x'), false);
});

test('arguments a command does not accept are refused the same way whether or not work is busy', () => {
  const command = (name: string) => findCommand(name)!;
  // An interface-only command with a bad argument is not "read-only": busy work refuses it, idle work calls it unknown.
  assert.equal(acceptsArgument(command('art'), 'bogus'), false);
  assert.equal(canRunWhileBusy(command('art'), 'bogus'), false);
  assert.equal(acceptsArgument(command('art'), 'next'), true);
  assert.equal(canRunWhileBusy(command('art'), 'next'), true);
  // A read keeps running while busy, so a bad argument reaches the "unknown or invalid" answer.
  assert.equal(acceptsArgument(command('status'), 'x'), false);
  assert.equal(canRunWhileBusy(command('status'), 'x'), true);
  assert.equal(acceptsArgument(command('run'), ''), false);
  assert.equal(acceptsArgument(command('verify'), 'R1 R2'), false);
  assert.equal(acceptsArgument(command('verify'), 'R1'), true);
  assert.equal(acceptsArgument(command('open'), ''), false);
  assert.deepEqual(parseCommand('/Run echo  hi'), { name: 'run', argument: 'echo  hi' });
  assert.equal(parseCommand('/'), undefined);
  assert.equal(parseCommand('plain text'), undefined);
});

test('the command table is one registry: unique names, review and verification are the only uncancellable work', () => {
  assert.deepEqual(
    OMS_COMMANDS.filter((command) => command.cancellable === false)
      .map((command) => command.name)
      .sort(),
    ['review', 'verify'],
  );
  for (const command of OMS_COMMANDS) {
    assert.equal(typeof command.run, 'function', command.name);
    assert.ok(command.description && command.group, command.name);
  }
});

// ------------------------------------------------------------------ a folder chat has no pinned task

function chatFake(root: string, git: boolean): ChatSession {
  return {
    kind: 'chat',
    root,
    folder: { path: root, requested: root, key: 'k', scratch: false, git },
    budget: { ...harnessFake().budget, reservations: () => [] },
    session: { sessionManager: { getSessionId: () => 'chat-session-id' } },
  } as unknown as ChatSession;
}

test('a chat hides the task-only commands from the menu and /help, and a task keeps them', () => {
  assert.deepEqual(commandMatches('/verify', 'chat'), []);
  assert.deepEqual(commandMatches('/requirements', 'chat'), []);
  assert.ok(commandMatches('/di', 'chat')?.some((command) => command.name === 'diff'));
  const help = commandHelp('chat');
  assert.doesNotMatch(help, /\/verify|\/requirements/);
  assert.match(help, /\/goal|\/diff|\/test/);
  assert.match(commandHelp(), /\/verify/);
  assert.match(commandHelp(), /\/requirements/);
  assert.ok(commandMatches('/verify')?.some((command) => command.name === 'verify'));
  assert.doesNotMatch(commandHelp('chat'), /task worktree|worktree/);
});

test('typing a task-only command in a chat says what to use instead', () => {
  const chat = chatFake('/nonexistent', false);
  assert.equal(
    refusal(prepareSlash('verify', '', chat)),
    'Nothing to verify here · /test, or /goal <text> --check "<command>"',
  );
  assert.equal(
    refusal(prepareSlash('requirements', '', chat)),
    'Requirements come with a task made by oms task create.',
  );
});

test('/status in a chat shows the model and budget as label and value rows, without a task or proof line', async () => {
  const chat = chatFake('/nonexistent', false);
  (chat.session as unknown as { model: unknown }).model = { provider: 'local', id: 'test-model' };
  const text = (
    await run(
      findCommand('status')?.run(
        { harness: chat, modelDetail: () => 'Ready · spending limit applies' } as unknown as CommandContext,
        '',
        undefined,
      ) as Prepared,
    )
  ).text;
  assert.equal(
    text,
    [
      'Model   local/test-model',
      '        Ready · spending limit applies',
      'Budget  880 tokens and 8m59s per turn · $4.9975 left',
    ].join('\n'),
  );
  assert.doesNotMatch(text, /Task:|Proof:|Token allowance|known/);
});

test('/status says when no model is selected, and flags unconfirmed or used-up budgets', async () => {
  const chat = chatFake('/nonexistent', false);
  const snapshot = { ...chat.budget.snapshot(), accounting: 'unknown' as const, exhausted: true };
  const noModel = { ...chat, budget: { ...chat.budget, snapshot: () => snapshot } } as ChatSession;
  const text = (
    await run(
      findCommand('status')?.run(
        { harness: noModel, modelDetail: () => undefined } as unknown as CommandContext,
        '',
        undefined,
      ) as Prepared,
    )
  ).text;
  assert.match(text, /^Model {3}none selected · \/model\n/);
  // The session's placeholder model is not a pick the user made.
  (noModel.session as unknown as { model: unknown }).model = { provider: 'unknown', id: 'unknown' };
  const placeholder = (
    await run(
      findCommand('status')?.run(
        { harness: noModel, modelDetail: () => undefined } as unknown as CommandContext,
        '',
        undefined,
      ) as Prepared,
    )
  ).text;
  assert.match(placeholder, /^Model {3}none selected · \/model\n/);
  assert.match(text, /\$4\.9975 left · exhausted · usage unconfirmed$/);
});

test('/session in a chat shows the folder and its git state, never a task or worktree', async () => {
  const repo = gitRepo();
  try {
    const inRepo = (await run(prepareSlash('session', '', chatFake(repo.root, true)))).text;
    assert.match(inRepo, new RegExp(`OMS session: chat-session-id\\nFolder: ${repo.root}`));
    assert.match(inRepo, /Git: (main|master)/);
    const plain = (await run(prepareSlash('session', '', chatFake(repo.root, false)))).text;
    assert.match(plain, /Git: not a git repository/);
    assert.doesNotMatch(inRepo + plain, /Task:|Worktree:|Repository:/);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('/session retains session facts and native status without the internal design note', async () => {
  const chat = chatFake('/requested', false);
  const scratch = {
    ...chat,
    folder: { ...chat.folder, scratch: true, path: '/scratch' },
  };
  const task = harnessFake({
    workspace: { root: '/repository' },
    session: chat.session,
  });
  for (const [harness, place] of [
    [chat, 'Folder: /requested\nGit: not a git repository'],
    [scratch, 'Folder: /requested (this chat works in the scratch folder /scratch)\nGit: not a git repository'],
    [task, 'Repository: /repository\nTask: t\nWorktree: /nonexistent\nBranch: oms/t'],
  ] as const) {
    for (const nativeChat of [
      undefined,
      { status: () => ({ state: 'idle', sessionId: undefined }) },
      { status: () => ({ state: 'error', sessionId: 'native-id', detail: 'Transport failed.' }) },
    ]) {
      const session = { ...harness, nativeChat } as OmsSession;
      const output = await run(prepareSlash('session', '', session));
      assert.deepEqual(output, {
        title: 'session',
        clearNotice: true,
        text: `OMS session: chat-session-id\n${place}` + (nativeChat ? `\n${claudeChatStatus(session)}` : ''),
      });
      assert.doesNotMatch(output.text, /Changing focus does not dispatch work\./);
    }
  }
});

test('/diff in a chat compares the folder with HEAD, or says why there is nothing to compare', async () => {
  const repo = gitRepo();
  try {
    const chat = chatFake(repo.root, true);
    assert.match((await run(prepareSlash('diff', '', chat))).text, /Against HEAD · (main|master)\nNo changes\./);
    writeFileSync(join(repo.root, 'a.txt'), 'one\nuncommitted\n');
    writeFileSync(join(repo.root, 'new.txt'), 'fresh\n');
    const text = (await run(prepareSlash('diff', '', chat))).text;
    assert.match(text, /\+uncommitted/);
    assert.match(text, /Untracked \(1\):\n  new\.txt/);
    const plain = mkdtempSync(join(tmpdir(), 'oms-nogit-'));
    try {
      assert.equal(
        (await run(prepareSlash('diff', '', chatFake(plain, false)))).text,
        'Not a git repository · nothing to compare',
      );
      execFileSync('git', ['-C', plain, 'init', '-q']);
      assert.equal(
        (await run(prepareSlash('diff', '', chatFake(plain, true)))).text,
        'No commits yet · nothing to compare',
      );
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('/clear and /goal in a chat never mention a task or its verifier', async () => {
  const chat = chatFake('/nonexistent', false);
  const shown: string[] = [];
  const ctx = {
    harness: chat,
    goal: { get: () => undefined, set() {} },
    show: (_title: string, text: string) => shown.push(text),
  } as unknown as CommandContext;
  findCommand('goal')?.run(ctx, '', undefined);
  assert.match(shown[0]!, /^No goal set\. Start one with \/goal <text> --check "<command>"\.\nBudget:/);
  assert.doesNotMatch(shown[0]!, /verifier/);
});

test('/help never runs a long command into its description', () => {
  for (const kind of ['task', 'chat'] as const) {
    const help = commandHelp(kind);
    for (const command of OMS_COMMANDS) {
      const usage = `/${command.name}${command.argument ? ' ' + command.argument : ''}`;
      if (usage.length > 26 && help.includes(usage)) assert.ok(help.includes(`${usage}\n`), `${kind}: ${usage}`);
    }
    for (const line of help.split('\n')) assert.doesNotMatch(line, /[\]>]\p{Lu}/u, `${kind}: ${line}`);
  }
});
