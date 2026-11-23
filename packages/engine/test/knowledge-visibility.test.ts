import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import {
  accountKnowledgeSource,
  createKnowledgeExtension,
  createKnowledgeVisibility,
  hideKnowledgeBlocks,
  hideKnowledgeInSession,
  KNOWLEDGE_TOOL_NAMES,
  wrapUntrusted,
  type KnowledgeConfig,
} from '../src/runtime/knowledge-service.ts';
import { createHarnessSettings } from '../src/runtime/settings-controls.ts';
import { knowledgeHint } from '../src/runtime/session.ts';

const ACCOUNT = 'synthetic-account-token-7c1d';
const ENV_TOKEN = 'synthetic-env-token-91ab';
const HINT = /look the fact up with search_docs/;

test('saved sessions retain literal prompt tags and omit private tool results', () => {
  const manager = hideKnowledgeInSession(SessionManager.inMemory(process.cwd()));
  const prompt = 'Explain the syntax <untrusted-knowledge tool="search_docs"> and <solana-knowledge-excerpt>';
  manager.appendMessage({ role: 'user', content: prompt, timestamp: 1 });
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'lookup',
    toolName: 'search_docs',
    content: [{ type: 'text', text: 'private lookup result' }],
    details: { reference: 'private lookup metadata' },
    isError: false,
    timestamp: 2,
  });
  const saved = JSON.stringify(manager.getEntries());
  assert.match(saved, /Explain the syntax.*and <solana-knowledge-excerpt>/);
  assert.match(saved, /fetched Solana knowledge: Solana/);
  assert.doesNotMatch(saved, /private lookup/);
  assert.equal(hideKnowledgeBlocks(prompt), prompt);
  assert.equal(hideKnowledgeBlocks(prompt, true), 'Explain the syntax fetched Solana knowledge: Solana');
});

test('a diagnosis keeps its visible context when a private error excerpt is cut short', () => {
  const diagnosis = wrapUntrusted(
    'solana_diagnosis',
    'Instruction 3 failed.\n<solana-knowledge-excerpt>' +
      'synthetic private error detail '.repeat(20) +
      '</solana-knowledge-excerpt>',
    400,
  );
  assert.match(diagnosis, /synthetic private error detail/);
  assert.doesNotMatch(diagnosis, /<\/solana-knowledge-excerpt>/);
  const safe = hideKnowledgeBlocks(diagnosis);
  assert.match(safe, /Instruction 3 failed/);
  assert.match(safe, /fetched Solana knowledge: error/);
  assert.match(safe, /\[truncated\]\n<\/untrusted-knowledge>/);
  assert.doesNotMatch(safe, /synthetic private/);
});

async function gateway(status = 200) {
  const calls: Array<{ path: string; auth: string | undefined; tool: string }> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw) as { id: number; params: { name: string } };
    calls.push({ path: req.url ?? '', auth: req.headers.authorization, tool: rpc.params.name });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'doc text' }] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A real pi session with the same extensions and prompt hooks the harness installs; the faux model records what it is shown. */
async function rig(inputs: {
  account: () => { origin: string; token: string } | undefined;
  env?: NodeJS.ProcessEnv;
  pinned?: KnowledgeConfig;
}) {
  const root = mkdtempSync(join(tmpdir(), 'oms-kv-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const seen: Array<{ tools: string[]; prompt: string; wire: string }> = [];
  const script: Array<ReturnType<typeof fauxAssistantMessage>> = [];
  const faux = createFauxCore({
    api: 'openai-completions',
    provider: 'oms-knowledge',
    models: [
      { id: 'm', contextWindow: 8192, maxTokens: 256, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
    ],
  });
  const runtime = await ModelRuntime.create({
    authPath: join(root, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider('oms-knowledge', {
    api: faux.api,
    apiKey: 'synthetic-offline',
    baseUrl: 'http://127.0.0.1:1',
    streamSimple: faux.streamSimple,
    models: faux.models.map((model) => ({
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
  const source = accountKnowledgeSource({ ...inputs, env: inputs.env ?? {} });
  const promptFor = (config: KnowledgeConfig | undefined) => `Base prompt.${knowledgeHint({}, config)}`;
  const settingsManager = createHarnessSettings(agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: [],
    extensionFactories: [
      createKnowledgeExtension(source)!,
      createKnowledgeVisibility(source, promptFor, () => source() !== undefined),
    ],
    systemPrompt: promptFor(source()),
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: runtime.getModel('oms-knowledge', 'm')!,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: 'builtin',
    tools: KNOWLEDGE_TOOL_NAMES,
  });
  await session.bindExtensions({});
  const turn = async (reply = fauxAssistantMessage('ok')) => {
    faux.setResponses([
      (context) => {
        seen.push({
          tools: session.getActiveToolNames(),
          prompt: session.systemPrompt,
          wire: JSON.stringify(context.messages),
        });
        return reply;
      },
    ]);
    await session.prompt('hello');
    return seen.at(-1)!;
  };
  return {
    session,
    seen,
    turn,
    faux,
    cleanup: () => {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('signed out: the model sees no knowledge tools and no look-it-up rules', async () => {
  const r = await rig({ account: () => undefined });
  try {
    const shown = await r.turn();
    assert.deepEqual(
      shown.tools.filter((name) => KNOWLEDGE_TOOL_NAMES.includes(name)),
      [],
    );
    assert.doesNotMatch(shown.prompt, HINT);
    assert.doesNotMatch(shown.prompt, /search_docs|knowledge/i);
    assert.doesNotMatch(
      shown.wire,
      /search_docs|api_lookup|untrusted reference/i,
      'nothing about the tools reaches the provider request',
    );
  } finally {
    r.cleanup();
  }
});

test('signed in: the tools call <origin>/api/knowledge/mcp with the account bearer token, and the rules are on by default', async () => {
  const gw = await gateway();
  const r = await rig({ account: () => ({ origin: gw.origin, token: ACCOUNT }) });
  try {
    const shown = await r.turn(
      fauxAssistantMessage(fauxToolCall('search_docs', { query: 'pda' }), { stopReason: 'toolUse' }),
    );
    assert.deepEqual(
      KNOWLEDGE_TOOL_NAMES.filter((name) => !shown.tools.includes(name)),
      [],
    );
    assert.match(shown.prompt, HINT);
    assert.match(shown.wire, /look the fact up with search_docs/, 'the rules reach the provider request');
    await r.turn();
    assert.deepEqual(gw.calls, [{ path: '/api/knowledge/mcp', auth: `Bearer ${ACCOUNT}`, tool: 'search_docs' }]);
    assert.match(JSON.stringify(r.session.messages), /Untrusted reference data/);
    assert.ok(!JSON.stringify(r.session.messages).includes(ACCOUNT));
  } finally {
    r.cleanup();
    await gw.close();
  }
});

test('OMS_KNOWLEDGE_URL plus OMS_KNOWLEDGE_TOKEN win over the account; one of the two alone does not', async () => {
  const account = { origin: 'http://127.0.0.1:1', token: ACCOUNT };
  const both = accountKnowledgeSource({
    env: { OMS_KNOWLEDGE_URL: 'http://svc.test/mcp', OMS_KNOWLEDGE_TOKEN: ENV_TOKEN },
    account: () => account,
  });
  assert.deepEqual(both(), { endpoint: 'http://svc.test/mcp', token: ENV_TOKEN });
  assert.deepEqual(accountKnowledgeSource({ env: { OMS_KNOWLEDGE_TOKEN: ENV_TOKEN }, account: () => account })(), {
    endpoint: 'http://127.0.0.1:1/api/knowledge/mcp',
    token: ACCOUNT,
    guidance: true,
  });
  assert.equal(
    accountKnowledgeSource({ env: { OMS_KNOWLEDGE_URL: 'http://svc.test/mcp' }, account: () => undefined })(),
    undefined,
  );
  const pinned = { endpoint: 'http://bench.test/mcp', token: 'pinned-token' };
  assert.deepEqual(
    accountKnowledgeSource({
      pinned,
      env: { OMS_KNOWLEDGE_URL: 'http://svc.test/mcp', OMS_KNOWLEDGE_TOKEN: ENV_TOKEN },
      account: () => account,
    })(),
    pinned,
    'a benchmark cell keeps its pinned service',
  );
  const gw = await gateway();
  const r = await rig({
    account: () => undefined,
    env: { OMS_KNOWLEDGE_URL: `${gw.origin}/mcp`, OMS_KNOWLEDGE_TOKEN: ENV_TOKEN },
  });
  try {
    const shown = await r.turn(fauxAssistantMessage(fauxToolCall('list_sources', {}), { stopReason: 'toolUse' }));
    assert.ok(shown.tools.includes('list_sources'), 'env credentials expose the tools with no account');
    await r.turn();
    assert.deepEqual(gw.calls, [{ path: '/mcp', auth: `Bearer ${ENV_TOKEN}`, tool: 'list_sources' }]);
  } finally {
    r.cleanup();
    await gw.close();
  }
});

test('a /login mid-session shows the tools and rules from the next turn, and a /logout hides them again', async () => {
  const gw = await gateway();
  let credential: { origin: string; token: string } | undefined;
  const r = await rig({ account: () => credential });
  try {
    const before = await r.turn();
    assert.deepEqual(
      before.tools.filter((name) => KNOWLEDGE_TOOL_NAMES.includes(name)),
      [],
    );
    credential = { origin: gw.origin, token: ACCOUNT };
    const during = await r.turn(
      fauxAssistantMessage(fauxToolCall('api_lookup', { name: 'invoke' }), { stopReason: 'toolUse' }),
    );
    assert.deepEqual(
      KNOWLEDGE_TOOL_NAMES.filter((name) => !during.tools.includes(name)),
      [],
    );
    assert.match(during.prompt, HINT);
    await r.turn();
    assert.equal(gw.calls.length, 1);
    assert.equal(gw.calls[0]!.auth, `Bearer ${ACCOUNT}`);
    credential = undefined;
    const after = await r.turn();
    assert.deepEqual(
      after.tools.filter((name) => KNOWLEDGE_TOOL_NAMES.includes(name)),
      [],
    );
    assert.doesNotMatch(after.prompt, HINT);
  } finally {
    r.cleanup();
    await gw.close();
  }
});

for (const status of [401, 403, 500]) {
  test(`HTTP ${status} from the route gives the model a short neutral error and never shows a token`, async () => {
    const gw = await gateway(status);
    const r = await rig({ account: () => ({ origin: gw.origin, token: ACCOUNT }) });
    try {
      await r.turn(fauxAssistantMessage(fauxToolCall('search_docs', { query: 'q' }), { stopReason: 'toolUse' }));
      await r.turn();
      const transcript = JSON.stringify(r.session.messages);
      assert.match(transcript, /Reference lookup is unavailable right now/);
      assert.ok(!transcript.includes(ACCOUNT));
      assert.doesNotMatch(transcript, /HTTP \d{3}|rejected the credential/);
    } finally {
      r.cleanup();
      await gw.close();
    }
  });
}

test('a call made after sign-out fails neutrally without any request', async () => {
  const gw = await gateway();
  const r = await rig({ account: () => undefined });
  try {
    const tool = r.session.getAllTools().find((entry) => entry.name === 'search_docs');
    assert.ok(tool, 'registered even while hidden');
    await r
      .turn(fauxAssistantMessage(fauxToolCall('search_docs', { query: 'q' }), { stopReason: 'toolUse' }))
      .catch(() => {});
    assert.equal(gw.calls.length, 0);
  } finally {
    r.cleanup();
    await gw.close();
  }
});
