import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemoryTransportPair } from '@earendil-works/pi-mcp/testing';
import { connectorSpec } from '../src/connectors/catalog.ts';
import {
  callHostedTool,
  classifyMcpTool,
  credentialsFile,
  mcpServerConfig,
  mcpToolPrefix,
  McpCredentials,
  safeAuthorizationUrl,
  signInMcp,
  toolExposure,
} from '../src/connectors/mcp.ts';

const preset = (id: string) => connectorSpec(id)!.mcp!;
const store = () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-mcp-'));
  return { dir, credentials: new McpCredentials(credentialsFile(dir)) };
};
const URL_LINEAR = preset('linear').url;
const TOKENS = { access_token: 'secret-access-token', token_type: 'Bearer' };

test('tool names and exposure: reads at read, curated writes at ask and allow, nothing else', () => {
  assert.equal(mcpToolPrefix('linear'), 'mcp__linear__');
  assert.equal(mcpToolPrefix('gitlab-remote'), 'mcp__gitlab_remote__');
  const linear = preset('linear');
  assert.deepEqual(Object.keys(toolExposure(linear, 'read')).sort(), [...linear.read].sort());
  for (const access of ['ask', 'allow'] as const) {
    assert.deepEqual(Object.keys(toolExposure(linear, access)).sort(), [...linear.read, ...linear.write].sort());
  }
  assert.deepEqual(toolExposure(linear, 'off'), toolExposure(linear, 'read'));
  for (const id of ['linear', 'slack', 'gitlab-remote']) {
    const config = mcpServerConfig(preset(id), 'ask') as {
      exposure: string;
      url: string;
      toolExposure: Record<string, string>;
    };
    assert.equal(config.exposure, 'hidden');
    assert.match(config.url, /^https:\/\//);
    assert.ok(Object.values(config.toolExposure).every((value) => value === 'direct'));
    // Destructive tools are never offered at any level.
    assert.ok(!Object.keys(config.toolExposure).some((name) => /(^|_)(delete|remove|archive)(_|$)/.test(name)));
  }
  assert.ok(Object.keys(toolExposure(linear, 'allow')).length <= 9);
});

test('classification fails closed: only named reads, or tools the server marks read-only, are reads', () => {
  const linear = preset('linear');
  assert.equal(classifyMcpTool(linear, 'get_issue'), 'read');
  assert.equal(classifyMcpTool(linear, 'list_issues'), 'read');
  assert.equal(classifyMcpTool(linear, 'save_issue'), 'write');
  assert.equal(classifyMcpTool(linear, 'delete_comment'), 'write');
  assert.equal(classifyMcpTool(linear, 'brand_new_tool'), 'write');
  assert.equal(classifyMcpTool(linear, 'brand_new_tool', { readOnlyHint: true }), 'read');
  assert.equal(classifyMcpTool(linear, 'get_issue', { readOnlyHint: false }), 'write');
  assert.equal(classifyMcpTool(linear, 'get_issue', { destructiveHint: true }), 'write');
  assert.equal(classifyMcpTool(linear, 'save_issue', { readOnlyHint: true }), 'write');
  const slack = preset('slack');
  assert.equal(classifyMcpTool(slack, 'slack_search_public'), 'read');
  assert.equal(classifyMcpTool(slack, 'slack_read_channel'), 'read');
  assert.equal(classifyMcpTool(slack, 'slack_send_message'), 'write');
  assert.equal(classifyMcpTool(slack, 'slack_read_and_send_message'), 'write');
});

test('sign-ins live in one private file, are reported by presence only, and can be removed', () => {
  const { dir, credentials } = store();
  assert.equal(credentials.has('linear', URL_LINEAR), false);
  const server = credentials.forServer('linear', URL_LINEAR);
  assert.equal(server.load(), undefined);
  server.save({ serverUrl: URL_LINEAR, tokens: TOKENS });
  assert.equal(credentials.has('linear', URL_LINEAR), true);
  assert.equal(credentials.has('slack', URL_LINEAR), false);
  assert.equal(statSync(credentials.path).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'agent')).mode & 0o777, 0o700);
  assert.equal(credentials.tokens('linear', URL_LINEAR)?.access_token, TOKENS.access_token);
  assert.equal(credentials.remove('linear', URL_LINEAR), true);
  assert.equal(credentials.has('linear', URL_LINEAR), false);
  assert.equal(credentials.remove('linear', URL_LINEAR), false);
  rmSync(dir, { recursive: true });
});

test('a damaged credentials file reads as no sign-in, and refresh locks run one at a time', async () => {
  const { dir, credentials } = store();
  credentials.forServer('linear', URL_LINEAR).save({ serverUrl: URL_LINEAR, tokens: TOKENS });
  writeFileSync(credentials.path, 'garbage');
  assert.equal(credentials.has('linear', URL_LINEAR), false);
  const order: string[] = [];
  const lock = credentials.forServer('linear', URL_LINEAR).withRefreshLock;
  await Promise.all([
    lock(async () => {
      order.push('a1');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('a2');
    }),
    lock(async () => {
      order.push('b1');
    }),
  ]);
  assert.deepEqual(order, ['a1', 'a2', 'b1']);
  rmSync(dir, { recursive: true });
});

test('the authorization address must be https without embedded credentials', () => {
  assert.equal(safeAuthorizationUrl(new URL('https://linear.app/oauth/authorize?x=1')).hostname, 'linear.app');
  for (const bad of [
    'http://linear.app/x',
    'javascript:alert(1)',
    'https://user:pw@linear.app/x',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => safeAuthorizationUrl(new URL(bad)), /safe https/, bad);
  }
});

function fakeOAuth(options: { immediate?: boolean } = {}) {
  const shown: string[] = [];
  const events: string[] = [];
  let release: (value: { code: string; state: string }) => void = () => {};
  const callback = {
    redirectUrl: 'http://127.0.0.1:5555/callback',
    waitForCallback: (state: string) => {
      events.push(`wait ${state}`);
      return new Promise<{ code: string; state: string }>((resolve) => {
        release = resolve;
        setTimeout(() => resolve({ code: 'the-code', state }), 5);
      });
    },
    close: async () => void events.push('closed'),
  };
  const authorize = async (
    provider: { redirectToAuthorization(url: URL): Promise<void>; saveTokens(t: unknown): Promise<void> },
    flow: { authorizationCode?: string },
  ) => {
    if (options.immediate) return 'AUTHORIZED' as const;
    if (flow.authorizationCode) {
      events.push(`code ${flow.authorizationCode}`);
      await provider.saveTokens(TOKENS);
      return 'AUTHORIZED' as const;
    }
    await provider.redirectToAuthorization(new URL('https://linear.app/oauth/authorize?client_id=c&state=s'));
    return 'REDIRECT' as const;
  };
  return { shown, events, callback, authorize, release: () => release };
}

test('sign-in shows an https address, waits on a loopback callback, stores tokens, and always closes the callback', async () => {
  const { dir, credentials } = store();
  const fake = fakeOAuth();
  await signInMcp(
    {
      name: 'linear',
      url: URL_LINEAR,
      credentials,
      signal: new AbortController().signal,
      show: (url) => fake.shown.push(url.href),
    },
    { authorize: fake.authorize as never, listen: (async () => fake.callback) as never },
  );
  assert.deepEqual(fake.shown, ['https://linear.app/oauth/authorize?client_id=c&state=s']);
  assert.ok(fake.events.includes('code the-code'));
  assert.equal(fake.events.at(-1), 'closed');
  assert.equal(credentials.has('linear', URL_LINEAR), true);
  assert.equal(credentials.tokens('linear', URL_LINEAR)?.access_token, TOKENS.access_token);
  rmSync(dir, { recursive: true });
});

test('sign-in that needs no browser step shows nothing, and a cancelled or unsafe sign-in stores nothing', async () => {
  const { dir, credentials } = store();
  const quick = fakeOAuth({ immediate: true });
  await signInMcp(
    {
      name: 'linear',
      url: URL_LINEAR,
      credentials,
      signal: new AbortController().signal,
      show: () => assert.fail('nothing to show'),
    },
    { authorize: quick.authorize as never, listen: (async () => quick.callback) as never },
  );
  assert.equal(quick.events.at(-1), 'closed');
  const unsafe = fakeOAuth();
  const insecure = async (provider: { redirectToAuthorization(url: URL): Promise<void> }) => {
    await provider.redirectToAuthorization(new URL('http://evil.example/authorize'));
    return 'REDIRECT' as const;
  };
  await assert.rejects(
    signInMcp(
      {
        name: 'linear',
        url: URL_LINEAR,
        credentials,
        signal: new AbortController().signal,
        show: () => assert.fail('never shown'),
      },
      { authorize: insecure as never, listen: (async () => unsafe.callback) as never },
    ),
    /safe https/,
  );
  assert.equal(unsafe.events.at(-1), 'closed');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    signInMcp({ name: 'linear', url: URL_LINEAR, credentials, signal: controller.signal, show: () => {} }),
    /cancelled/,
  );
  assert.equal(credentials.has('linear', URL_LINEAR), false);
  rmSync(dir, { recursive: true });
});

test('a host-side call reaches the hosted tool and returns only its text; failures are plain sentences', async () => {
  const { dir, credentials } = store();
  credentials.forServer('linear', URL_LINEAR).save({ serverUrl: URL_LINEAR, tokens: TOKENS });
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const serve = (reply: (name: string) => unknown) => (url: string) => {
    assert.equal(url, URL_LINEAR);
    const { client, server } = createInMemoryTransportPair();
    server.onMessage((message) => {
      const request = message as {
        id?: number;
        method?: string;
        params?: { name: string; arguments: unknown; protocolVersion?: string };
      };
      if (request.method === 'initialize') {
        void server.send({
          jsonrpc: '2.0',
          id: request.id!,
          result: {
            protocolVersion: request.params!.protocolVersion!,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1' },
          },
        });
      } else if (request.method === 'tools/call') {
        calls.push({ name: request.params!.name, arguments: request.params!.arguments });
        void server.send({ jsonrpc: '2.0', id: request.id!, result: reply(request.params!.name) as never });
      }
    });
    void server.start();
    return client;
  };
  const text = await callHostedTool(
    { name: 'linear', url: URL_LINEAR, credentials, tool: 'get_issue', args: { id: 'LIN-12' } },
    {
      transport: serve(() => ({
        content: [
          { type: 'text', text: 'LIN-12: Fix rent' },
          { type: 'image', data: 'AA', mimeType: 'image/png' },
        ],
      })) as never,
    },
  );
  assert.equal(text, 'LIN-12: Fix rent');
  assert.deepEqual(calls, [{ name: 'get_issue', arguments: { id: 'LIN-12' } }]);
  await assert.rejects(
    callHostedTool(
      { name: 'linear', url: URL_LINEAR, credentials, tool: 'get_issue', args: { id: 'LIN-12' } },
      { transport: serve(() => ({ isError: true, content: [{ type: 'text', text: 'private details' }] })) as never },
    ),
    (error: Error) => error.message === 'The service answered with an error.' && !/private/.test(error.message),
  );
  rmSync(dir, { recursive: true });
});
