import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandNamesEnvFile, isEnvFile, MASK, maskEnvFile, maskSecrets } from '../src/tui/secret-mask.ts';

test('an env file shows names and hides every value, keeping comments and blank lines', () => {
  const shown = maskEnvFile(
    '# rpc\nAPI_KEY=sk-test-1234567890abcdef\n\nRPC_URL=http://localhost:8899\nexport MODE="dev"\n',
  );
  assert.equal(shown, `# rpc\nAPI_KEY=${MASK}\n\nRPC_URL=${MASK}\nexport MODE=${MASK}\n`);
});

test('an env file value that spans lines is hidden on every line', () => {
  const shown = maskEnvFile('PEM="-----BEGIN\nabcdef\n-----END"\nNEXT=1');
  assert.equal(shown, `PEM=${MASK}\n${MASK}\n${MASK}\nNEXT=${MASK}`);
});

test('a secret-named assignment is hidden in any output, other assignments are not', () => {
  assert.equal(maskSecrets('export OPENAI_API_KEY=abc123 && PORT=3000'), `export OPENAI_API_KEY=${MASK} && PORT=3000`);
  assert.equal(maskSecrets('db_password="hunter 2"'), `db_password=${MASK}`);
  for (const name of ['SECRET_X', 'GH_TOKEN', 'PASSWD', 'PRIVATE_KEY', 'MNEMONIC', 'SEED_PHRASE', 'AWS_CREDENTIALS'])
    assert.equal(maskSecrets(`${name}=value`), `${name}=${MASK}`, name);
});

test('provider keys and keypair arrays are hidden wherever they appear', () => {
  const keypair = `[${Array.from({ length: 64 }, (_, i) => i * 3).join(',')}]`;
  const text = [
    'sk-test-1234567890abcdef',
    'xai-abcdefghijklmnop1234',
    `ghp_${'a'.repeat(36)}`,
    `gsk_${'b'.repeat(40)}`,
    'AKIAIOSFODNN7EXAMPLE',
    keypair,
  ].join('\n');
  assert.equal(maskSecrets(text), Array(6).fill(MASK).join('\n'));
});

test('GitLab, Slack, Linear and GitHub tokens are hidden wherever they appear', () => {
  const tokens = [
    `glpat-${'a1B2'.repeat(5)}`,
    'xo' + 'xb-123456789012-123456789012-abcdefghijklmnopqrstuvwx',
    'xo' + 'xa-2-123456789012-abcdefghij',
    'xo' + 'xp-123456789012-123456789012-abcdef123456',
    'xo' + 'xr-123456789012-abcdefghijkl',
    `lin_api_${'Z9y8'.repeat(10)}`,
    `github_pat_${'11AB'.repeat(5)}_${'c'.repeat(40)}`,
    ...['o', 'u', 's', 'r', 'p'].map((kind) => `gh${kind}_${'d'.repeat(36)}`),
  ];
  assert.equal(maskSecrets(tokens.join('\n')), Array(tokens.length).fill(MASK).join('\n'));
  assert.equal(
    maskSecrets(`remote: https://oauth2:glpat-${'x'.repeat(20)}@gitlab.com/a/b.git`),
    `remote: https://oauth2:${MASK}@gitlab.com/a/b.git`,
  );
  assert.equal(maskSecrets(`Authorization: Bearer lin_api_${'k'.repeat(40)}`), `Authorization: Bearer ${MASK}`);
});

test('short lookalikes of the new token prefixes stay visible', () => {
  const text = 'glpat-short xoxb-1 lin_api_x github_pat_ ghx_abc xox-abcdefghijklmnop ghp_';
  assert.equal(maskSecrets(text), text);
});

test('transaction signatures and program ids stay visible: they have the length of a secret key but are public', () => {
  const signature = ('5' + 'xY9kTqLmN3pR7sVbW2cZ8hJdFgE6aU1oK4'.repeat(3)).slice(0, 88);
  const text = `Signature: ${signature}\nProgram Id: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`;
  assert.equal(maskSecrets(text), text);
});

test('ordinary code, short arrays, hashes and comparisons stay as they are', () => {
  const code = [
    'const apiKey = process.env.API_KEY;',
    'if (token==null) return a=>b;',
    'const bytes = [1, 2, 3, 4];',
    `sha256 ${'a1b2c3d4'.repeat(8)}`,
    'task-key: sk-short',
    'PORT=3000 HOST=localhost',
    "awk '{key=$1; print key}'",
    'TOKEN=$OTHER',
  ].join('\n');
  assert.equal(maskSecrets(code), code);
});

test('env files are recognised by basename, and commands by naming one', () => {
  for (const path of ['.env', '/a/b/.env.local', 'sub/.env.example']) assert.ok(isEnvFile(path), path);
  for (const path of ['env', '.envrc', 'my.env', '/a/.environment']) assert.ok(!isEnvFile(path), path);
  for (const command of ['cat .env', 'source ./.env.local', 'grep X "$PWD/.env"', 'cat .env | head'])
    assert.ok(commandNamesEnvFile(command), command);
  for (const command of ['cat .envrc', 'ls', 'echo env']) assert.ok(!commandNamesEnvFile(command), command);
});
