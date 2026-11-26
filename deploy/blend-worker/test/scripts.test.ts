import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/put-secrets.sh', import.meta.url));
const names = ['ANTHROPIC_API_KEY', 'XAI_API_KEY', 'OPENCODE_API_KEY', 'MUSE_API_KEY'];
function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'blend-secret-script-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const capture = join(root, 'calls.jsonl');
  writeFileSync(
    join(root, 'npx'),
    `#!${process.execPath}\nconst fs=require('node:fs'),crypto=require('node:crypto');(async()=>{let value='';for await(const c of process.stdin)value+=c;fs.appendFileSync(process.env.CAPTURE_FILE,JSON.stringify({args:process.argv.slice(2),sha256:crypto.createHash('sha256').update(value).digest('hex')})+'\\n');})();\n`,
    { mode: 0o700 },
  );
  const secrets = Object.fromEntries(names.map((name, i) => [name, `fixture-secret-${i}`]));
  const env = { ...process.env, ...secrets, PATH: root + delimiter + process.env.PATH, CAPTURE_FILE: capture };
  return { capture, env, secrets };
}
test('secret upload script pipes each env value to the oms-blend config, without echoing values even under shell tracing', (t) => {
  const { capture, env, secrets } = fixture(t);
  const result = spawnSync('bash', ['-x', script], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.status, 0);
  const output = result.stdout + result.stderr;
  for (const value of Object.values(secrets)) assert.ok(!output.includes(value));
  const calls = readFileSync(capture, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 4);
  for (const [i, name] of names.entries()) {
    assert.deepEqual(calls[i].args, ['--no-install', 'wrangler', 'secret', 'put', name, '--config', 'wrangler.jsonc']);
    assert.equal(calls[i].sha256, createHash('sha256').update(secrets[name]!).digest('hex'));
  }
});
test('secret upload script validates all env variables before any remote write', (t) => {
  const { capture, env } = fixture(t);
  env.MUSE_API_KEY = '';
  assert.throws(
    () => execFileSync('bash', [script], { env, stdio: ['ignore', 'pipe', 'pipe'] }),
    (error: unknown) => {
      const failure = error as { status: number; stderr: Buffer };
      assert.equal(failure.status, 1);
      assert.match(failure.stderr.toString(), /Missing required environment variable: MUSE_API_KEY/);
      return true;
    },
  );
  assert.equal(existsSync(capture), false);
});
