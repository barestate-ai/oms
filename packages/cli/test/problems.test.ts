import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProblems } from '../src/tui/problems.ts';

test('rustc errors and warnings become located problems, with noise dropped', () => {
  const output = [
    '\x1b[1m\x1b[31merror[E0433]\x1b[0m: failed to resolve: use of undeclared type `VaultError`',
    ' --> /work/programs/vault/src/lib.rs:9:38',
    '  |',
    '9 |         require!(amount >= MIN, VaultError::Zero);',
    '',
    'warning: unused variable: `ctx`',
    '  --> programs/vault/src/lib.rs:8:24',
    '',
    'warning: `vault` (lib) generated 1 warning',
    'error: could not compile `vault` (lib) due to 1 previous error',
  ].join('\n');
  assert.deepEqual(parseProblems(output), [
    {
      severity: 'error',
      code: 'E0433',
      message: 'failed to resolve: use of undeclared type `VaultError`',
      path: 'programs/vault/src/lib.rs',
      line: 9,
      column: 38,
    },
    {
      severity: 'warning',
      code: undefined,
      message: 'unused variable: `ctx`',
      path: 'programs/vault/src/lib.rs',
      line: 8,
      column: 24,
    },
  ]);
});

test('tsc output in both layouts, with absolute paths made relative to the project', () => {
  const output = [
    "tests/vault.ts(41,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "/proj/src/b.ts:3:1 - error TS2304: Cannot find name 'x'.",
  ].join('\n');
  const problems = parseProblems(output, '/proj');
  assert.deepEqual(
    problems.map((problem) => [problem.path, problem.line, problem.column, problem.code]),
    [
      ['tests/vault.ts', 41, 7, 'TS2322'],
      ['src/b.ts', 3, 1, 'TS2304'],
    ],
  );
});

test('Anchor and program errors become rows that explain themselves with /error', () => {
  const output = [
    'AnchorError thrown in programs/vault/src/lib.rs:9. Error Code: Zero. Error Number: 6000. Error Message: Amount must be positive.',
    'Program 11111111111111111111111111111111 failed: custom program error: 0x1770',
  ].join('\n');
  const [anchor, custom] = parseProblems(output);
  assert.equal(anchor!.path, 'programs/vault/src/lib.rs');
  assert.equal(anchor!.line, 9);
  assert.equal(anchor!.command, '/error 6000');
  assert.match(anchor!.message, /Zero \(6000\): Amount must be positive/);
  assert.equal(custom!.command, '/error 0x1770');
});

test('plain output has no problems, repeats collapse and the list is bounded', () => {
  assert.deepEqual(parseProblems('Exit: 0\nall good'), []);
  const same = 'a.ts(1,1): error TS1: bad\na.ts(1,1): error TS1: bad';
  assert.equal(parseProblems(same).length, 1);
  const many = Array.from({ length: 500 }, (_, n) => `a.ts(${n + 1},1): error TS1: bad`).join('\n');
  assert.equal(parseProblems(many).length, 200);
});
