import { hostSandbox } from '@oms/sandbox';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { AgentSession, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { modelReadiness } from '../src/runtime/usage.ts';
import { HELPER_LIMITS } from '../src/runtime/helpers/runner.ts';
import { helperRunnerFixture } from '../test-support/helper-runner-fixture.ts';
import { call, say } from '../test-support/helper-fixture.ts';

test('M4: cancelling a helper during authentication prevents dispatch and charges nothing', async (t) => {
  const f = await helperRunnerFixture(t);
  let entered!: () => void;
  let release!: () => void;
  const authenticating = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const auth = new Promise<void>((resolve) => {
    release = resolve;
  });
  const check = f.modelRuntime.checkAuth.bind(f.modelRuntime);
  t.mock.method(f.modelRuntime, 'hasConfiguredAuth', () => false);
  t.mock.method(f.modelRuntime, 'checkAuth', async (...args: Parameters<typeof check>) => {
    entered();
    await auth;
    return check(...args);
  });
  let requests = 0;
  f.faux.setResponses([
    () => {
      requests++;
      return fauxAssistantMessage('Late.');
    },
  ]);
  const done = f.execute();
  await authenticating;
  const cancelled = f.helpers.api.cancel();
  release();
  await cancelled;
  await done;
  assert.equal(requests, 0);
  assert.equal(f.helpers.api.list()[0]!.tokens, 0);
});

for (const spelling of ['symlink', 'case', '@'] as const) {
  test(`S1: helper file writes respect claims with ${spelling} paths`, async (t) => {
    const f = await helperRunnerFixture(t);
    mkdirSync(join(f.folder, 'src'));
    writeFileSync(join(f.folder, 'src/x.ts'), 'original');
    symlinkSync('src', join(f.folder, 'alias'));
    if (spelling === 'case' && !existsSync(join(f.folder, 'SRC/x.ts'))) return t.skip('case-sensitive volume');
    const path = spelling === '@' ? '@src/x.ts' : `${spelling === 'case' ? 'SRC' : 'alias'}/x.ts`;
    const files = spelling === '@' ? ['src/**'] : [spelling === 'case' ? 'SRC/**' : 'alias/**'];
    f.faux.setResponses([call('write', { path, content: 'changed' }), say('Done.')]);
    await f.execute('build', 'Write.', files);
    assert.equal(f.text('src/x.ts'), spelling === '@' ? 'changed' : 'original');
  });
}

test('S3: helpers leave room for the parent request before starting', async (t) => {
  const f = await helperRunnerFixture(t, 7_000);
  // Each model request fits individually, but a helper and the following chat request do not.
  f.faux.setResponses([say('done')]);
  await assert.rejects(f.execute(), /room|remaining.*limit/i);
  assert.equal(f.parts.env.budget.reservations().length, 0);
  assert.equal(
    modelReadiness(f.model, f.parts.env.budget, 128).ready,
    true,
    JSON.stringify({ snapshot: f.parts.env.budget.snapshot(), receipts: f.parts.env.budget.receipts() }),
  );
});

test('S3: helper continuations also preserve the parent request allowance', async (t) => {
  const f = await helperRunnerFixture(t, 105_000);
  f.model.contextWindow = 50_000;
  let requests = 0;
  const step = () => {
    requests++;
    return call('write', { path: 'x.ts', content: String(requests) })({ messages: [] });
  };
  f.faux.setResponses([...Array.from({ length: 8 }, () => step), say('Done.')]);
  await assert.rejects(f.execute('build', 'Write.', ['x.ts']), /remaining.*limit/);
  // A few continuations run, then the bound plus the parent's allowance stops the run.
  assert.ok(requests > 0 && requests < 8, `expected the allowance to stop the run early, got ${requests}`);
  assert.equal(modelReadiness(f.model, f.parts.env.budget, 128).ready, true);
});

test('S4: each user message resets the bounded chat helper allowance', async (t) => {
  const f = await helperRunnerFixture(t);
  f.faux.setResponses(Array.from({ length: 14 }, () => say('ok')));
  for (let turn = 0; turn < 2; turn++) {
    f.start();
    for (let i = 0; i < 7; i++) await f.execute();
  }
  assert.equal(f.helpers.api.list().length, 14);
});

test('S6: helper history trims against its own model window', async (t) => {
  const f = await helperRunnerFixture(t);
  f.parts.life.liveSession = { model: { ...f.model, contextWindow: 1_000_000 } } as AgentSession;
  // Inspect the actual context hook installed on a helper, with a short-window helper model.
  const bind = AgentSession.prototype.bindExtensions;
  let trimmed = false;
  t.mock.method(
    AgentSession.prototype,
    'bindExtensions',
    async function (this: AgentSession, ...args: Parameters<typeof bind>) {
      await bind.apply(this, args);
      const messages = Array.from({ length: 8 }, (_, i) => ({
        role: 'toolResult',
        toolCallId: String(i),
        toolName: 'read',
        content: [{ type: 'text', text: 'x'.repeat(3000) }],
        isError: false,
        timestamp: Date.now(),
      }));
      const result = await this.agent.transformContext!(messages as never);
      trimmed = JSON.stringify(result).includes('[earlier read result removed');
    },
  );
  f.faux.setResponses([say('ok')]);
  await f.execute();
  assert.equal(trimmed, true);
});

for (const stage of ['reload', 'bindExtensions'] as const) {
  test(`S7: a failed helper ${stage} closes its lane and disposes any created session`, async (t) => {
    const f = await helperRunnerFixture(t);
    let disposed = 0;
    const dispose = AgentSession.prototype.dispose;
    t.mock.method(AgentSession.prototype, 'dispose', function (this: AgentSession) {
      disposed++;
      return dispose.call(this);
    });
    if (stage === 'reload')
      t.mock.method(DefaultResourceLoader.prototype, 'reload', async () => {
        throw new Error('startup failed');
      });
    else
      t.mock.method(AgentSession.prototype, 'bindExtensions', async () => {
        throw new Error('startup failed');
      });
    await assert.rejects(f.execute(), /startup failed/);
    assert.equal(f.closed(), 1);
    assert.equal(disposed, stage === 'reload' ? 0 : 1);
  });
}

test('S8: helper text is labelled after the harness status', async (t) => {
  const f = await helperRunnerFixture(t);
  f.faux.setResponses([say('Authored by helper.')]);
  const result = await f.execute();
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  assert.match(text, /^\[explore \|[^\n]+\]\n[^]*Helper report:\nAuthored by helper\./);
});

test('S9: a time limit lets an in-flight request settle before stopping the helper', async (t) => {
  const f = await helperRunnerFixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const answer = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.faux.setResponses([
    async () => {
      entered();
      await answer;
      return fauxAssistantMessage('Settled.');
    },
  ]);
  const done = f.execute();
  await started;
  t.mock.timers.tick(HELPER_LIMITS.ms);
  release();
  await assert.rejects(done, /stopped after 10 minutes/);
  assert.equal(f.parts.env.budget.snapshot().accounting, 'known');
  assert.equal(f.parts.env.budget.receipts()[0]!.outcome, 'known');
  assert.equal(
    modelReadiness(f.model, f.parts.env.budget, 128).ready,
    true,
    JSON.stringify({ snapshot: f.parts.env.budget.snapshot(), receipts: f.parts.env.budget.receipts() }),
  );
});

test('M1: another claim alone cannot hide a shell write in the helper result', async (t) => {
  const f = await helperRunnerFixture(t);
  let held!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    held = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.faux.setResponses([
    async () => {
      held();
      await wait;
      return fauxAssistantMessage('B done.');
    },
    () => {
      writeFileSync(join(f.folder, 'b.ts'), 'shell write');
      return fauxAssistantMessage('A done.');
    },
  ]);
  const b = f.execute('build', 'Hold b.', ['b.ts']);
  await ready;
  const a = await f.execute('build', 'Write b through a command.', ['a.ts']);
  release();
  await b;
  const text = JSON.stringify(a.content);
  assert.match(text, /touched outside claim: b\.ts/);
  assert.match(text, /claims are not enforced for commands here/);
});

test(
  'S5: a sandboxed reader is not blamed for another helper shell write',
  { skip: hostSandbox() !== 'seatbelt' && 'needs macOS sandbox-exec' },
  async (t) => {
    const f = await helperRunnerFixture(t);
    f.parts.options.hostTrust!.yolo = false;
    let held!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      held = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.faux.setResponses([
      async () => {
        held();
        await wait;
        return fauxAssistantMessage('Read only.');
      },
      () => {
        writeFileSync(join(f.folder, 'Cargo.lock'), 'shell write');
        return fauxAssistantMessage('Build done.');
      },
    ]);
    const read = f.execute();
    await ready;
    await f.execute('build', 'Write lock.', ['a.ts']);
    release();
    assert.doesNotMatch(JSON.stringify((await read).content), /changed files/);
  },
);

test('M2: the agent tool describes loaded definitions, including personal overrides', async (t) => {
  const f = await helperRunnerFixture(t);
  const dir = join(f.agentRoot, '../personal');
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'explore.md'),
    '---\nname: explore\ndescription: Edit exports\ntools: edit\n---\nEdit exports.',
  );
  f.start();
  assert.match(f.description(), /explore \(edits[^)]*Edit exports/);
  assert.doesNotMatch(f.description(), /explore \(read-only/);
});

for (const spelling of ['file URL', 'Unicode space'] as const) {
  test(`S1: helper claims resolve ${spelling} paths exactly like the file tools`, async (t) => {
    const f = await helperRunnerFixture(t);
    const path = spelling === 'file URL' ? pathToFileURL(join(f.folder, 'two words.ts')).href : 'two\u00a0words.ts';
    f.faux.setResponses([call('write', { path, content: 'authorized' }), say('Done.')]);
    await f.execute('build', 'Write.', ['two words.ts']);
    assert.equal(f.text('two words.ts'), 'authorized');
  });
}
