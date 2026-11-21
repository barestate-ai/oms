import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveAccess, readConnectorsConfig, writeConnectorsConfig, emptyConfig } from '../src/connectors/config.ts';

const root = () => mkdtempSync(join(tmpdir(), 'oms-connectors-'));
const file = (dir: string) => join(dir, 'connectors.json');

test('a missing file means defaults and is writable', () => {
  const dir = root();
  const loaded = readConnectorsConfig(dir);
  assert.deepEqual(loaded.config, emptyConfig());
  assert.deepEqual(loaded.problems, []);
  assert.equal(loaded.writable, true);
  rmSync(dir, { recursive: true });
});

test('a malformed file turns connectors off with a notice, never throws, and is kept as it is', () => {
  for (const text of ['not json', '[]', '{"version":2}', '"x"', '']) {
    const dir = root();
    writeFileSync(file(dir), text);
    const loaded = readConnectorsConfig(dir);
    assert.deepEqual(loaded.config.connectors, {});
    assert.equal(loaded.writable, false);
    assert.equal(loaded.problems.length, 1, text);
    assert.match(loaded.problems[0]!, /connectors are off/);
    rmSync(dir, { recursive: true });
  }
});

test('an unreadable file is reported and not overwritten', () => {
  const dir = root();
  writeFileSync(file(dir), '{"version":1}');
  chmodSync(file(dir), 0o000);
  const loaded = readConnectorsConfig(dir);
  // root can read anything; the rest must report instead of throwing.
  if (process.getuid?.() !== 0) {
    assert.equal(loaded.writable, false);
    assert.match(loaded.problems[0]!, /could not be read/);
  }
  chmodSync(file(dir), 0o600);
  rmSync(dir, { recursive: true });
});

test('one bad entry turns only that connector off', () => {
  const dir = root();
  writeFileSync(
    file(dir),
    JSON.stringify({
      version: 1,
      connectors: {
        github: { enabled: true, access: 'ask' },
        docker: { enabled: true, access: 'root' },
        aws: { enabled: 'yes', access: 'read' },
        linear: { enabled: true, access: 'read' },
        nonsense: { enabled: true, access: 'allow' },
      },
    }),
  );
  const loaded = readConnectorsConfig(dir);
  assert.equal(effectiveAccess(loaded.config.connectors.github), 'ask');
  assert.equal(effectiveAccess(loaded.config.connectors.linear), 'read');
  assert.equal(effectiveAccess(loaded.config.connectors.docker), 'off');
  assert.equal(effectiveAccess(loaded.config.connectors.aws), 'off');
  assert.equal(Object.hasOwn(loaded.config.connectors, 'nonsense'), false);
  assert.equal(loaded.problems.length, 2);
  assert.equal(loaded.writable, true);
  rmSync(dir, { recursive: true });
});

test('a connector is off unless it is enabled, whatever its saved access', () => {
  assert.equal(effectiveAccess({ enabled: false, access: 'allow' }), 'off');
  assert.equal(effectiveAccess({ enabled: true, access: 'off' }), 'off');
  assert.equal(effectiveAccess(undefined), 'off');
  assert.equal(effectiveAccess({ enabled: true, access: 'allow' }), 'allow');
});

test('an RPC address may name its key as ${ENV} but never hold one', () => {
  const write = (rpc: string) => {
    const dir = root();
    writeFileSync(
      file(dir),
      JSON.stringify({ version: 1, connectors: { 'solana-rpc': { enabled: true, access: 'read', options: { rpc } } } }),
    );
    const loaded = readConnectorsConfig(dir);
    rmSync(dir, { recursive: true });
    return loaded;
  };
  const ok = write('https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}');
  assert.equal(ok.problems.length, 0);
  assert.equal(
    ok.config.connectors['solana-rpc']?.options?.rpc,
    'https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}',
  );
  for (const bad of [
    'https://mainnet.helius-rpc.com/?api-key=abc123abc123',
    'https://user:pass@rpc.example.com',
    'http://rpc.example.com',
    'ftp://rpc.example.com',
    'https://rpc.example.com/\nx',
  ]) {
    const loaded = write(bad);
    assert.equal(effectiveAccess(loaded.config.connectors['solana-rpc']), 'off', bad);
    assert.equal(loaded.problems.length, 1, bad);
  }
});

test('writing makes a private file atomically and leaves no temporary file', () => {
  const dir = join(root(), 'state');
  const config = emptyConfig();
  config.connectors.github = { enabled: true, access: 'ask' };
  assert.equal(writeConnectorsConfig(dir, config), true);
  assert.equal(statSync(file(dir)).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(dir), ['connectors.json']);
  assert.deepEqual(readConnectorsConfig(dir).config, config);
  // Never a token: the text holds flags and levels only.
  assert.doesNotMatch(readFileSync(file(dir), 'utf8'), /token|secret|password/i);
  assert.equal(writeConnectorsConfig(join(file(dir), 'inside-a-file'), config), false);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(existsSync(dir), false);
});

test('tip counters survive a round trip and bad numbers fall back to zero', () => {
  const dir = root();
  writeFileSync(
    file(dir),
    JSON.stringify({ version: 1, tips: { launches: 4, shown: -1, lastShown: 'x', dismissed: true } }),
  );
  assert.deepEqual(readConnectorsConfig(dir).config.tips, { launches: 4, shown: 0, lastShown: 0, dismissed: true });
  rmSync(dir, { recursive: true });
});
