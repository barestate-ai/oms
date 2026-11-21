import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  commentMarker,
  firstSpanFrom,
  highlight,
  languageOf,
  spanAt,
  type Language,
  type SyntaxRole,
} from '../src/tui/syntax.ts';

/** Every token of `role` in `text`, so a test reads as "these words are keywords". */
function tokens(text: string, language: Language, role: SyntaxRole): string[] {
  return highlight(text, language)
    .filter((span) => span.role === role)
    .map((span) => text.slice(span.start, span.end));
}

test('languages come from the extension and a few well-known names', () => {
  assert.equal(languageOf('programs/vault/src/lib.rs'), 'rust');
  assert.equal(languageOf('tests/vault.ts'), 'ts');
  assert.equal(languageOf('Anchor.toml'), 'toml');
  assert.equal(languageOf('Cargo.lock'), 'toml');
  assert.equal(languageOf('target/idl/vault.json'), 'json');
  assert.equal(languageOf('LICENSE'), undefined);
  assert.equal(languageOf('a/b.unknown'), undefined);
  assert.equal(commentMarker('rust'), '//');
  assert.equal(commentMarker('toml'), '#');
  assert.equal(commentMarker('diff'), undefined);
});

test('Rust: nested block comments, raw strings, lifetimes and char literals', () => {
  const text = [
    '/* outer /* inner */ still comment */ let a = 1;',
    'let raw = r#"quote " inside"#;',
    "fn first<'a>(x: &'a str) -> char { 'z' }",
    "let nl = '\\n';",
  ].join('\n');
  assert.deepEqual(tokens(text, 'rust', 'comment'), ['/* outer /* inner */ still comment */']);
  assert.deepEqual(tokens(text, 'rust', 'string'), ['r#"quote " inside"#', "'z'", "'\\n'"]);
  assert.deepEqual(tokens(text, 'rust', 'constant'), ["'a", "'a"]);
  assert.ok(tokens(text, 'rust', 'keyword').includes('let'));
  assert.deepEqual(tokens(text, 'rust', 'number'), ['1']);
});

test('Rust: Anchor attributes, macros, functions, types and program ids', () => {
  const id = 'Vau1t11111111111111111111111111111111111111';
  const text = [
    `declare_id!("${id}");`,
    '#[program]',
    'pub mod vault {',
    '    #[account(mut)]',
    '    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> { require!(amount > 0, E::Zero); Ok(()) }',
    '}',
    '#![allow(dead_code)]',
  ].join('\n');
  assert.deepEqual(tokens(text, 'rust', 'attribute'), ['#[program]', '#[account(mut)]', '#![allow(dead_code)]']);
  assert.deepEqual(tokens(text, 'rust', 'fn'), ['declare_id', 'deposit', 'require', 'Ok']);
  assert.ok(tokens(text, 'rust', 'type').includes('Context'));
  assert.ok(tokens(text, 'rust', 'type').includes('Deposit'));
  assert.deepEqual(tokens('let s = "vault";', 'rust', 'string'), ['"vault"']);
  const real = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  assert.deepEqual(tokens(`declare_id!("${real}");`, 'rust', 'pubkey'), [`"${real}"`]);
});

test('TypeScript: templates, decorators, numbers and calls', () => {
  const text =
    'const total = await program.methods.deposit(0x10).rpc(); // done\nconst s = `a ${b} c`;\n@Injectable class Foo {}';
  assert.deepEqual(tokens(text, 'ts', 'comment'), ['// done']);
  assert.deepEqual(tokens(text, 'ts', 'string'), ['`a ${b} c`']);
  assert.deepEqual(tokens(text, 'ts', 'number'), ['0x10']);
  assert.deepEqual(tokens(text, 'ts', 'attribute'), ['@Injectable']);
  assert.ok(tokens(text, 'ts', 'fn').includes('deposit'));
  assert.ok(tokens(text, 'ts', 'keyword').includes('await'));
  assert.ok(tokens(text, 'ts', 'type').includes('Foo'));
});

test('TOML: sections, keys, strings, numbers and comments', () => {
  const text = '[programs.localnet]\nvault = "Vau1t"\n# note\nport = 8899\n[[test.validator.account]]\nflag = true';
  assert.deepEqual(tokens(text, 'toml', 'type'), ['[programs.localnet]', '[[test.validator.account]]']);
  assert.deepEqual(tokens(text, 'toml', 'fn'), ['vault', 'port', 'flag']);
  assert.deepEqual(tokens(text, 'toml', 'string'), ['"Vau1t"']);
  assert.deepEqual(tokens(text, 'toml', 'comment'), ['# note']);
  assert.deepEqual(tokens(text, 'toml', 'number'), ['8899']);
  assert.deepEqual(tokens(text, 'toml', 'keyword'), ['true']);
});

test('JSON: keys differ from values; literals and numbers are colored', () => {
  const text = '{"name": "vault", "n": -3.5, "ok": true, "none": null}';
  assert.deepEqual(tokens(text, 'json', 'fn'), ['"name"', '"n"', '"ok"', '"none"']);
  assert.deepEqual(tokens(text, 'json', 'string'), ['"vault"']);
  assert.deepEqual(tokens(text, 'json', 'number'), ['3.5']);
  assert.deepEqual(tokens(text, 'json', 'keyword'), ['true', 'null']);
});

test('diff lines are colored by their marker', () => {
  const text = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n context\n-old\n+new';
  assert.deepEqual(tokens(text, 'diff', 'diffAdd'), ['+new']);
  assert.deepEqual(tokens(text, 'diff', 'diffDel'), ['-old']);
  assert.deepEqual(tokens(text, 'diff', 'diffHunk'), ['@@ -1,2 +1,2 @@']);
  assert.equal(tokens(text, 'diff', 'diffMeta').length, 3);
});

test('shell: comments, variables and keywords', () => {
  const text = 'if [ -n "$HOME" ]; then echo $HOME # home\nfi';
  assert.deepEqual(tokens(text, 'shell', 'comment'), ['# home']);
  assert.deepEqual(tokens(text, 'shell', 'constant'), ['$HOME']);
  assert.deepEqual(tokens(text, 'shell', 'keyword'), ['if', 'then', 'fi']);
});

test('spans are sorted, never overlap and a lexer never throws on odd input', () => {
  const samples = ['"unterminated', "'a", '/* open', 'r#"open', '#[never closed', '`${', '\u0000\ud83d', '[', '"""'];
  for (const language of ['rust', 'ts', 'toml', 'json', 'shell', 'diff', 'markdown'] as const) {
    for (const text of samples) {
      const spans = highlight(text, language);
      for (let index = 0; index < spans.length; index++) {
        const span = spans[index]!;
        assert.ok(span.start >= 0 && span.end <= text.length && span.start < span.end, `${language} ${text}`);
        if (index > 0) assert.ok(spans[index - 1]!.end <= span.start, `${language} overlap in ${text}`);
      }
    }
  }
});

test('spanAt walks a line as one linear merge', () => {
  const text = 'let x = "a";';
  const spans = highlight(text, 'rust');
  let from = firstSpanFrom(spans, 0);
  const roles: Array<SyntaxRole | undefined> = [];
  for (let offset = 0; offset < text.length; offset++) {
    const found = spanAt(spans, offset, from);
    from = found.next;
    roles.push(found.role);
  }
  assert.equal(roles[0], 'keyword');
  assert.equal(roles[3], undefined);
  assert.equal(roles[8], 'string');
});
