import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ArgumentError,
  awsCall,
  buildCall,
  readActionsOf,
  writeActionsOf,
  type CliConnector,
} from '../src/connectors/argv.ts';

const refuses = (run: () => unknown, pattern?: RegExp) =>
  assert.throws(run, (error) => error instanceof ArgumentError && (!pattern || pattern.test(error.message)));

test('values that look like shell or options never reach an argument list', () => {
  for (const bad of ['1; rm', '1 && ls', '$(id)', '`id`', '-1', '--help', '../../etc', 'a b', '1|2', '']) {
    if (bad === '') continue;
    refuses(() => buildCall('github', 'issue_view', { number: bad }), /number/);
    refuses(() => buildCall('github', 'pr_view', { number: bad }), /number or a branch/);
  }
  refuses(() => buildCall('github', 'run_failed_log', { run_id: '12; ls' }), /run_id/);
  refuses(() => buildCall('docker', 'logs', { container: '--privileged' }), /container/);
  refuses(() => buildCall('docker', 'logs', { container: 'web; rm -rf /' }), /container/);
  refuses(() => buildCall('docker', 'run', { image: '-v/:/host alpine' }), /image/);
  refuses(() => buildCall('docker', 'compose_up', { services: ['web', '--build'] }), /names/);
});

test('every github action builds a fixed argument list with the right classification', () => {
  const read = buildCall('github', 'pr_view', { number: '#42' });
  assert.equal(read.program, 'gh');
  assert.deepEqual(read.args.slice(0, 3), ['pr', 'view', '42']);
  assert.equal(read.write, false);
  const noNumber = buildCall('github', 'pr_view', {});
  assert.deepEqual(noNumber.args.slice(0, 2), ['pr', 'view']);
  assert.equal(noNumber.args[2], '--json');
  assert.deepEqual(buildCall('github', 'pr_files', { number: 7 }).args, ['pr', 'diff', '7', '--name-only']);
  const log = buildCall('github', 'run_failed_log', { run_id: '1234567' });
  assert.deepEqual(log.args, ['run', 'view', '1234567', '--log-failed']);
  assert.equal(log.tail, 200);
  const comment = buildCall('github', 'pr_comment', { number: '42', body: '--delete-branch looks good\nthanks' });
  assert.equal(comment.write, true);
  // Free text is attached to its flag, so it can never be read as another option.
  assert.deepEqual(comment.args, ['pr', 'comment', '42', '--body=--delete-branch looks good\nthanks']);
  const create = buildCall('github', 'pr_create', { title: 'Fix it', body: 'Because', base: 'main', draft: true });
  assert.deepEqual(create.args, ['pr', 'create', '--title=Fix it', '--body=Because', '--base=main', '--draft']);
  assert.ok(create.timeoutMs > buildCall('github', 'pr_list', {}).timeoutMs);
});

test('classification: every action is exactly one of read or write, and writes are the changing ones', () => {
  for (const connector of ['github', 'gitlab', 'docker'] as CliConnector[]) {
    const reads = new Set(readActionsOf(connector));
    const writes = new Set(writeActionsOf(connector));
    assert.ok(reads.size > 0 && writes.size > 0);
    for (const action of writes) assert.equal(reads.has(action), false, action);
  }
  assert.deepEqual([...writeActionsOf('github')].sort(), ['issue_comment', 'issue_create', 'pr_comment', 'pr_create']);
  assert.deepEqual([...writeActionsOf('docker')].sort(), ['compose_down', 'compose_up', 'run']);
  assert.ok(!readActionsOf('docker').includes('exec'));
});

test('text is bounded and refuses control characters; unknown actions are named', () => {
  refuses(() => buildCall('github', 'issue_create', { title: 'x'.repeat(201) }), /longer than 200/);
  refuses(() => buildCall('github', 'issue_create', { title: 'ok\u0000' }), /control/);
  refuses(() => buildCall('github', 'issue_create', { title: 'ok', body: 'y'.repeat(8001) }), /longer than 8000/);
  refuses(() => buildCall('github', 'pr_list', { limit: 500 }), /limit/);
  refuses(() => buildCall('github', 'pr_list', { state: 'everything' }), /state/);
  refuses(() => buildCall('github', 'delete_repo', {}), /Choose one of/);
  refuses(() => buildCall('github', 'constructor', {}), /Choose one of/);
  refuses(() => buildCall('github', undefined, {}), /Choose one of/);
});

test('docker: no mounts, no extra privileges, inspect never prints the environment', () => {
  const run = buildCall('docker', 'run', { image: 'node:22', command: ['node', '-v'] });
  assert.deepEqual(run.args, ['run', '--rm', 'node:22', 'node', '-v']);
  assert.equal(run.write, true);
  assert.deepEqual(buildCall('docker', 'compose_down', {}).args, ['compose', 'down']);
  const inspect = buildCall('docker', 'inspect', { container: 'web-1' });
  assert.doesNotMatch(inspect.args.join(' '), /Env/);
  assert.deepEqual(buildCall('docker', 'logs', { container: 'web-1', tail: 50 }).args, [
    'logs',
    '--tail',
    '50',
    'web-1',
  ]);
});

test('aws: only describe, list and get on known services, with refused operations, flags and values', () => {
  const ok = awsCall(
    { service: 'ec2', operation: 'describe-instances', args: { 'max-items': '10' }, region: 'us-east-1' },
    'dev',
  );
  assert.deepEqual(ok.args, [
    'ec2',
    'describe-instances',
    '--max-items',
    '10',
    '--output',
    'json',
    '--no-cli-pager',
    '--region',
    'us-east-1',
    '--profile',
    'dev',
  ]);
  assert.equal(ok.write, false);
  assert.equal(ok.program, 'aws');
  for (const [service, operation] of [
    ['ec2', 'terminate-instances'],
    ['ec2', 'describe-instances; rm -rf /'],
    ['iam', 'delete-user'],
    ['iam', 'create-access-key'],
    ['s3api', 'put-object'],
    ['secretsmanager', 'get-secret-value'],
    ['ssm', 'get-parameter'],
    ['kms', 'decrypt'],
    ['ecr', 'get-login-password'],
    ['lambda', 'get-function'],
    ['s3api', 'get-object'],
    ['sts', 'get-session-token'],
    ['sts', 'assume-role'],
    ['ec2', '--help'],
    ['', 'describe-instances'],
  ] as const) {
    refuses(() => awsCall({ service, operation }), /./);
  }
  assert.equal(awsCall({ service: 'sts', operation: 'get-caller-identity' }).program, 'aws');
  for (const flag of [
    'profile',
    'region',
    'endpoint-url',
    'cli-input-json',
    'with-decryption',
    'debug',
    'Profile',
    'x y',
  ]) {
    refuses(() => awsCall({ service: 'ec2', operation: 'describe-instances', args: { [flag]: 'v' } }), /not allowed/);
  }
  for (const value of [
    'file:///etc/passwd',
    'fileb://~/.aws/credentials',
    'https://evil.example/x',
    'HTTP://x',
    '--profile',
    '',
  ]) {
    refuses(() => awsCall({ service: 'ec2', operation: 'describe-instances', args: { filters: value } }), /--filters/);
  }
  refuses(() => awsCall({ service: 'ec2', operation: 'describe-instances', region: 'us east' }), /region/);
  refuses(() => awsCall({ service: 'ec2', operation: 'describe-instances' }, '--profile=x'), /profile/);
  refuses(() => awsCall({ service: 'ec2', operation: 'describe-instances', args: ['--x'] }), /args/);
});
