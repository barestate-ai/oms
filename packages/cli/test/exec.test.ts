import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createChatSession, type ChatSession, type ChatSessionOptions } from '@oms/engine';
import { createChatFixture } from '../../engine/test-support/chat-fixture.ts';
import { runExec, type ExecDeps } from '../src/exec.ts';

const surfpool = process.env.SURFPOOL_BINARY ?? join(homedir(), '.local/bin/surfpool');
const live = { skip: !existsSync(surfpool) && 'needs Surfpool', timeout: 120_000 };

async function setup(t: TestContext) {
  const f = await createChatFixture();
  t.after(() => rmSync(f.base, { recursive: true, force: true }));
  const out: string[] = [];
  const notes: string[] = [];
  const opened: ChatSessionOptions[] = [];
  const deps: ExecDeps = {
    folder: f.project,
    stateRoot: f.stateRoot,
    environment: f.options.environment,
    prepare: async () => {},
    readStdin: async () => assert.fail('stdin is read only for -'),
    out: (text) => out.push(text),
    note: (line) => notes.push(line),
    // The real session, with the scripted model in place of a provider.
    start: (options) => {
      opened.push(options);
      return createChatSession({ ...options, modelRuntime: f.options.modelRuntime, model: f.options.model });
    },
  };
  return { ...f, deps, out, notes, opened };
}

test('exec runs one prompt in the folder and prints only the reply', live, async (t) => {
  const f = await setup(t);
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('edit', {
        path: join(f.project, 'notes.txt'),
        edits: [{ oldText: 'draft', newText: 'final' }],
      }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Edited\u001b[2J the\tnotes.'),
  ]);
  assert.equal(await runExec(['Finish', 'the', 'notes.'], f.deps), 0, f.notes.join('\n'));
  assert.equal(readFileSync(join(f.project, 'notes.txt'), 'utf8'), 'final\n');
  assert.deepEqual(f.out, ['Edited the\tnotes.']);
  assert.ok(f.notes.includes('· edit'), f.notes.join('\n'));
});

test('exec --continue resumes the folder conversation; without it each run is separate', live, async (t) => {
  const f = await setup(t);
  f.faux.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two'), fauxAssistantMessage('three')]);
  const run = async (args: string[]) => {
    assert.equal(await runExec([...args, '--json'], f.deps), 0, f.notes.join('\n'));
    return JSON.parse(f.out.at(-1)!) as { ok: boolean; text: string; sessionId: string; model: string };
  };
  const first = await run(['hello']);
  assert.deepEqual([first.ok, first.text, first.model], [true, 'one', 'oms-controlled/controlled']);
  const resumed = await run(['--continue', 'again']);
  assert.equal(resumed.sessionId, first.sessionId);
  assert.notEqual((await run(['fresh'])).sessionId, first.sessionId);
});

test('exec - reads the rest of the prompt from standard input', live, async (t) => {
  const f = await setup(t);
  let asked = '';
  f.faux.setResponses([
    (context) => {
      asked = JSON.stringify(context.messages.at(-1));
      return fauxAssistantMessage('ok');
    },
  ]);
  f.deps.readStdin = async () => 'error: custom program error 0xbc4\n';
  assert.equal(await runExec(['Explain this', '-'], f.deps), 0, f.notes.join('\n'));
  assert.match(asked, /Explain this\\n\\nerror: custom program error 0xbc4/);
});

test('a failed model request is an error with nothing on stdout', live, async (t) => {
  const f = await setup(t);
  f.faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'invalid request: boom' })]);
  assert.equal(await runExec(['hello'], f.deps), 1);
  assert.deepEqual(f.out, []);
  assert.match(f.notes.join('\n'), /^oms: The request failed/m);
});

function fakeChat(options: ChatSessionOptions, log: string[], model: unknown) {
  return {
    folder: options.folder,
    session: {
      model,
      sessionManager: { getSessionId: () => 's' },
      subscribe: () => () => {},
      async prompt() {
        log.push('prompt');
      },
      async abort() {},
    },
    budget: { snapshot: () => ({ used: { tokens: 0, spendMicroUsd: 0 } }) },
    setHostApproval(approve: (request: { command: string; reasons: string[] }) => Promise<boolean>) {
      log.push('approval');
      void approve({ command: 'rm -rf /\u001b[2J', reasons: ['recursive removal'] }).then((answer) =>
        log.push(`answered ${answer}`),
      );
    },
    async close() {
      log.push('close');
    },
  } as unknown as ChatSession;
}

test('exec refuses commands that need approval, and --yolo reaches the session', async (t) => {
  const f = await setup(t);
  const log: string[] = [];
  f.deps.start = async (options) => {
    f.opened.push(options);
    return fakeChat(options, log, { provider: 'p', id: 'm' });
  };
  await runExec(['hi'], f.deps);
  assert.ok(log.includes('answered false'));
  assert.match(f.notes.join('\n'), /denied.*recursive removal.*--yolo/s);
  assert.equal(f.notes.join('').includes('\u001b'), false);
  assert.equal(f.opened[0]!.yolo, undefined);
  await runExec(['--yolo', '--no-web', '--spend-usd', '1', 'hi'], f.deps);
  assert.equal(f.opened[1]!.yolo, true);
  assert.equal(f.opened[1]!.web?.enabled, false);
  assert.equal(f.opened[1]!.caps.spendMicroUsd, 1_000_000);
  assert.equal(log.filter((entry) => entry === 'close').length, 2);
});

test('exec stops before prompting when no model is set up', async (t) => {
  const f = await setup(t);
  const log: string[] = [];
  f.deps.start = async (options) => fakeChat(options, log, undefined);
  assert.equal(await runExec(['hi'], f.deps), 1);
  assert.deepEqual(log, ['close']);
  assert.match(f.notes.join('\n'), /No model is set up/);
});

test('exec rejects a missing prompt, unknown options and half a model choice before starting', async (t) => {
  const f = await setup(t);
  f.deps.start = async () => assert.fail('must not start');
  f.deps.readStdin = async () => '  \n';
  for (const args of [[], ['--bogus', 'hi'], ['--provider', 'openai', 'hi'], ['hi', '--spend-usd'], ['-']]) {
    assert.equal(await runExec(args, f.deps), 2, args.join(' '));
  }
  assert.match(f.notes.join('\n'), /Usage:[\s\S]*oms exec/);
});
