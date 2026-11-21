import { colorText, type OmsTheme, type ThemeRole } from './theme.ts';

/** The languages the editor colors. Anything else is plain text. */
export type Language = 'rust' | 'ts' | 'toml' | 'json' | 'shell' | 'diff' | 'markdown';
export type SyntaxRole =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'type'
  | 'fn'
  | 'attribute'
  | 'constant'
  | 'pubkey'
  | 'diffAdd'
  | 'diffDel'
  | 'diffHunk'
  | 'diffMeta'
  | 'heading';
/** A colored stretch of the document text: UTF-16 offsets, sorted, never overlapping. */
export interface Span {
  start: number;
  end: number;
  role: SyntaxRole;
}

const ROLE_COLOR: Readonly<Record<SyntaxRole, ThemeRole>> = {
  keyword: 'syntaxKeyword',
  string: 'syntaxString',
  number: 'syntaxNumber',
  comment: 'syntaxComment',
  type: 'syntaxType',
  fn: 'syntaxFunction',
  attribute: 'info',
  constant: 'syntaxConstant',
  pubkey: 'accent',
  diffAdd: 'diffAdded',
  diffDel: 'diffRemoved',
  diffHunk: 'accent',
  diffMeta: 'muted',
  heading: 'accent',
};

/** The theme role that draws a syntax role. */
export const syntaxColor = (role: SyntaxRole): ThemeRole => ROLE_COLOR[role];
/** Controlled text in a syntax role's color. */
export const paintSyntax = (theme: OmsTheme, role: SyntaxRole, text: string): string =>
  colorText(theme, ROLE_COLOR[role], text);

const EXTENSIONS: Readonly<Record<string, Language>> = {
  rs: 'rust',
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'ts',
  jsx: 'ts',
  mjs: 'ts',
  cjs: 'ts',
  toml: 'toml',
  json: 'json',
  jsonc: 'json',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  diff: 'diff',
  patch: 'diff',
  md: 'markdown',
};

/** The language of a project path, by extension (and a few well-known names). */
export function languageOf(path: string): Language | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name === 'cargo.lock' || name === 'anchor.toml') return 'toml';
  if (name === '.gitignore' || name === 'dockerfile') return undefined;
  const dot = name.lastIndexOf('.');
  return dot < 0 ? undefined : EXTENSIONS[name.slice(dot + 1)];
}

/** What people call the language, for the status row. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  rust: 'Rust',
  ts: 'TypeScript',
  toml: 'TOML',
  json: 'JSON',
  shell: 'Shell',
  diff: 'Diff',
  markdown: 'Markdown',
};

/** The line-comment marker of a language, for toggling comments. */
export function commentMarker(language: Language | undefined): string | undefined {
  if (language === 'rust' || language === 'ts' || language === 'json') return '//';
  if (language === 'toml' || language === 'shell') return '#';
  return undefined;
}

const RUST_KEYWORDS = new Set(
  'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(
    ' ',
  ),
);
const TS_KEYWORDS = new Set(
  'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield'.split(
    ' ',
  ),
);
const SHELL_KEYWORDS = new Set(
  'case do done elif else esac exit export fi for function if in local return set then until while'.split(' '),
);
const LITERALS = new Set(['true', 'false', 'null']);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A 32-byte base58 address, as Solana programs write them in `declare_id!` and Anchor.toml. */
function isAddress(text: string): boolean {
  if (!BASE58.test(text)) return false;
  let value = 0n;
  for (const character of text) value = value * 58n + BigInt(ALPHABET.indexOf(character));
  let bytes = 0;
  for (; value > 0n; value >>= 8n) bytes++;
  for (let index = 0; text[index] === '1'; index++) bytes++;
  return bytes === 32;
}

const isIdentStart = (c: string | undefined): boolean => !!c && /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string | undefined): boolean => !!c && /[\w$]/.test(c);
const isDigit = (c: string | undefined): boolean => !!c && c >= '0' && c <= '9';

class Lexer {
  readonly spans: Span[] = [];
  index = 0;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  add(start: number, end: number, role: SyntaxRole): void {
    if (end > start) this.spans.push({ start, end, role });
  }
  peek(offset = 0): string | undefined {
    return this.text[this.index + offset];
  }
  startsWith(value: string): boolean {
    return this.text.startsWith(value, this.index);
  }
  /** A string body from the opening quote at `index` to its closing quote (or the end of text). */
  quoted(quote: string, multiline = true): void {
    const start = this.index;
    this.index++;
    while (this.index < this.text.length) {
      const c = this.text[this.index]!;
      if (c === '\\') this.index += 2;
      else if (c === quote) {
        this.index++;
        break;
      } else if (c === '\n' && !multiline) break;
      else this.index++;
    }
    this.index = Math.min(this.index, this.text.length);
    this.string(start, this.index);
  }
  string(start: number, end: number): void {
    const inner = this.text.slice(start + 1, end - 1);
    this.add(start, end, isAddress(inner) ? 'pubkey' : 'string');
  }
  number(): void {
    const start = this.index;
    if (this.peek() === '0' && /[xXbBoO]/.test(this.peek(1) ?? '')) this.index += 2;
    while (/[\w.]/.test(this.peek() ?? '')) {
      // A dot is part of a number only when a digit follows: `1..2` and `x.0.y` keep their punctuation.
      if (this.peek() === '.' && !isDigit(this.peek(1))) break;
      this.index++;
    }
    this.add(start, this.index, 'number');
  }
  untilEndOfLine(): number {
    const end = this.text.indexOf('\n', this.index);
    return end < 0 ? this.text.length : end;
  }
  /** `/* ... *\/`, optionally nested (Rust). */
  blockComment(nested: boolean): void {
    const start = this.index;
    let depth = 1;
    this.index += 2;
    while (this.index < this.text.length && depth > 0) {
      if (nested && this.startsWith('/*')) {
        depth++;
        this.index += 2;
      } else if (this.startsWith('*/')) {
        depth--;
        this.index += 2;
      } else this.index++;
    }
    this.add(start, this.index, 'comment');
  }
  ident(): string {
    const start = this.index;
    while (isIdentPart(this.peek())) this.index++;
    return this.text.slice(start, this.index);
  }
}

function followedByCall(lexer: Lexer): boolean {
  let at = lexer.index;
  while (lexer.text[at] === ' ' || lexer.text[at] === '\t') at++;
  const next = lexer.text[at];
  // `name(` and generic calls such as `name::<T>(`; `name!(` is handled as a macro.
  return next === '(' || (next === ':' && lexer.text[at + 1] === ':' && lexer.text[at + 2] === '<');
}

function wordRole(lexer: Lexer, word: string, keywords: Set<string>, previousWord: string): SyntaxRole | undefined {
  if (keywords.has(word)) return 'keyword';
  if (lexer.text[lexer.index] === '!' && lexer.text[lexer.index + 1] !== '=') return 'fn';
  if (previousWord === 'fn' || previousWord === 'function' || followedByCall(lexer)) return 'fn';
  if (/^[A-Z]/.test(word)) return word === word.toUpperCase() && word.length > 1 ? 'constant' : 'type';
  return undefined;
}

function lexRust(text: string): Span[] {
  const lexer = new Lexer(text);
  let previous = '';
  while (lexer.index < text.length) {
    const c = lexer.peek()!;
    if (lexer.startsWith('//')) {
      const start = lexer.index;
      lexer.index = lexer.untilEndOfLine();
      lexer.add(start, lexer.index, 'comment');
    } else if (lexer.startsWith('/*')) lexer.blockComment(true);
    else if (c === '#' && (lexer.peek(1) === '[' || (lexer.peek(1) === '!' && lexer.peek(2) === '['))) {
      const start = lexer.index;
      let depth = 0;
      for (; lexer.index < text.length; lexer.index++) {
        const d = text[lexer.index];
        if (d === '[') depth++;
        else if (d === ']' && --depth === 0) {
          lexer.index++;
          break;
        } else if (d === '"') {
          // Attribute strings may hold brackets.
          lexer.index++;
          while (lexer.index < text.length && text[lexer.index] !== '"')
            lexer.index += text[lexer.index] === '\\' ? 2 : 1;
        }
      }
      lexer.index = Math.min(lexer.index, text.length);
      lexer.add(start, lexer.index, 'attribute');
    } else if (
      (c === 'r' || (c === 'b' && lexer.peek(1) === 'r')) &&
      /^b?r#*"/.test(text.slice(lexer.index, lexer.index + 12))
    ) {
      // Raw string: r"..." or r#"..."# with matching hashes; no escapes.
      const start = lexer.index;
      const match = /^b?r(#*)"/.exec(text.slice(lexer.index, lexer.index + 12))!;
      const close = '"' + match[1]!;
      const from = lexer.index + match[0].length;
      const end = text.indexOf(close, from);
      lexer.index = end < 0 ? text.length : end + close.length;
      lexer.add(start, lexer.index, 'string');
    } else if (c === '"' || (c === 'b' && lexer.peek(1) === '"')) {
      if (c === 'b') lexer.index++;
      const start = c === 'b' ? lexer.index - 1 : lexer.index;
      lexer.quoted('"');
      if (c === 'b' && lexer.spans.at(-1)) lexer.spans.at(-1)!.start = start;
    } else if (c === "'") {
      // A char literal ('x', '\n') or a lifetime ('a): a lifetime has no closing quote right after one character.
      if (lexer.peek(1) === '\\') lexer.quoted("'", false);
      else if (lexer.peek(2) === "'" && lexer.peek(1) !== "'") {
        lexer.add(lexer.index, lexer.index + 3, 'string');
        lexer.index += 3;
      } else if (isIdentStart(lexer.peek(1))) {
        const start = lexer.index;
        lexer.index++;
        lexer.ident();
        lexer.add(start, lexer.index, 'constant');
      } else lexer.index++;
    } else if (isDigit(c)) lexer.number();
    else if (isIdentStart(c)) {
      const start = lexer.index;
      const word = lexer.ident();
      const role = wordRole(lexer, word, RUST_KEYWORDS, previous);
      if (role) lexer.add(start, lexer.index, role);
      previous = word;
      continue;
    } else lexer.index++;
    previous = '';
  }
  return lexer.spans;
}

function lexTs(text: string): Span[] {
  const lexer = new Lexer(text);
  let previous = '';
  while (lexer.index < text.length) {
    const c = lexer.peek()!;
    if (lexer.startsWith('//')) {
      const start = lexer.index;
      lexer.index = lexer.untilEndOfLine();
      lexer.add(start, lexer.index, 'comment');
    } else if (lexer.startsWith('/*')) lexer.blockComment(false);
    else if (c === '"' || c === "'") lexer.quoted(c, false);
    else if (c === '`') lexer.quoted('`');
    else if (c === '@' && isIdentStart(lexer.peek(1))) {
      const start = lexer.index;
      lexer.index++;
      lexer.ident();
      lexer.add(start, lexer.index, 'attribute');
    } else if (isDigit(c)) lexer.number();
    else if (isIdentStart(c)) {
      const start = lexer.index;
      const word = lexer.ident();
      const role = wordRole(lexer, word, TS_KEYWORDS, previous);
      if (role) lexer.add(start, lexer.index, role);
      previous = word;
      continue;
    } else lexer.index++;
    previous = '';
  }
  return lexer.spans;
}

function lexShell(text: string): Span[] {
  const lexer = new Lexer(text);
  while (lexer.index < text.length) {
    const c = lexer.peek()!;
    if (c === '#' && (lexer.index === 0 || /[\s;]/.test(text[lexer.index - 1]!))) {
      const start = lexer.index;
      lexer.index = lexer.untilEndOfLine();
      lexer.add(start, lexer.index, 'comment');
    } else if (c === '"' || c === "'") lexer.quoted(c);
    else if (c === '$' && (isIdentStart(lexer.peek(1)) || lexer.peek(1) === '{')) {
      const start = lexer.index;
      lexer.index++;
      if (lexer.peek() === '{') lexer.index = Math.max(lexer.index, text.indexOf('}', lexer.index) + 1 || lexer.index);
      else lexer.ident();
      lexer.add(start, lexer.index, 'constant');
    } else if (isIdentStart(c)) {
      const start = lexer.index;
      const word = lexer.ident();
      if (SHELL_KEYWORDS.has(word)) lexer.add(start, lexer.index, 'keyword');
    } else lexer.index++;
  }
  return lexer.spans;
}

function lexJson(text: string): Span[] {
  const lexer = new Lexer(text);
  while (lexer.index < text.length) {
    const c = lexer.peek()!;
    if (c === '"') {
      const start = lexer.index;
      lexer.quoted('"', false);
      let at = lexer.index;
      while (text[at] === ' ' || text[at] === '\t') at++;
      // An object key is a name, not data.
      if (text[at] === ':') {
        lexer.spans.pop();
        lexer.add(start, lexer.index, 'fn');
      }
    } else if (lexer.startsWith('//')) {
      const start = lexer.index;
      lexer.index = lexer.untilEndOfLine();
      lexer.add(start, lexer.index, 'comment');
    } else if (isDigit(c) || (c === '-' && isDigit(lexer.peek(1)))) {
      if (c === '-') lexer.index++;
      lexer.number();
    } else if (isIdentStart(c)) {
      const start = lexer.index;
      if (LITERALS.has(lexer.ident())) lexer.add(start, lexer.index, 'keyword');
    } else lexer.index++;
  }
  return lexer.spans;
}

function lexToml(text: string): Span[] {
  const lexer = new Lexer(text);
  let lineStart = true;
  while (lexer.index < text.length) {
    const c = lexer.peek()!;
    if (c === '\n') {
      lineStart = true;
      lexer.index++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      lexer.index++;
      continue;
    }
    if (c === '#') {
      const start = lexer.index;
      lexer.index = lexer.untilEndOfLine();
      lexer.add(start, lexer.index, 'comment');
    } else if (lineStart && c === '[') {
      const start = lexer.index;
      lexer.index = lexer.untilEndOfLine();
      const line = text.slice(start, lexer.index);
      const header = /^\[\[?[^\]\n]*\]\]?/.exec(line)?.[0] ?? line;
      lexer.add(start, start + header.length, 'type');
      // Anything after the header on its line (a comment) is lexed as usual.
      lexer.index = start + header.length;
    } else if (lexer.startsWith('"""') || lexer.startsWith("'''")) {
      const start = lexer.index;
      const close = text.indexOf(c.repeat(3), start + 3);
      lexer.index = close < 0 ? text.length : close + 3;
      lexer.add(start, lexer.index, 'string');
    } else if (c === '"' || c === "'") {
      const start = lexer.index;
      lexer.quoted(c, false);
      if (lineStart) {
        lexer.spans.pop();
        lexer.add(start, lexer.index, 'fn');
      }
    } else if (isDigit(c)) lexer.number();
    else if (isIdentStart(c) || c === '-') {
      const start = lexer.index;
      while (/[\w.-]/.test(lexer.peek() ?? '')) lexer.index++;
      const word = text.slice(start, lexer.index);
      if (lineStart) lexer.add(start, lexer.index, 'fn');
      else if (word === 'true' || word === 'false') lexer.add(start, lexer.index, 'keyword');
      if (lexer.index === start) lexer.index++;
    } else lexer.index++;
    lineStart = false;
  }
  return lexer.spans;
}

function lexDiff(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  while (start <= text.length) {
    const found = text.indexOf('\n', start);
    const end = found < 0 ? text.length : found;
    const line = text.slice(start, end);
    let role: SyntaxRole | undefined;
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity |rename )/.test(line))
      role = 'diffMeta';
    else if (line.startsWith('@@')) role = 'diffHunk';
    else if (line.startsWith('+')) role = 'diffAdd';
    else if (line.startsWith('-')) role = 'diffDel';
    if (role && end > start) spans.push({ start, end, role });
    if (found < 0) break;
    start = found + 1;
  }
  return spans;
}

function lexMarkdown(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  let fenced = false;
  while (start <= text.length) {
    const found = text.indexOf('\n', start);
    const end = found < 0 ? text.length : found;
    const line = text.slice(start, end);
    if (/^```/.test(line)) {
      fenced = !fenced;
      spans.push({ start, end, role: 'comment' });
    } else if (!fenced && /^#{1,6}\s/.test(line)) spans.push({ start, end, role: 'heading' });
    if (found < 0) break;
    start = found + 1;
  }
  return spans;
}

const LEXERS: Readonly<Record<Language, (text: string) => Span[]>> = {
  rust: lexRust,
  ts: lexTs,
  toml: lexToml,
  json: lexJson,
  shell: lexShell,
  diff: lexDiff,
  markdown: lexMarkdown,
};

/** Documents are at most 64 KiB, so one linear pass per edit is cheap; the last result is reused for the same text. */
let last: { text: string; language: Language; spans: Span[] } | undefined;

/**
 * The colored spans of `text`, sorted and non-overlapping. A lexer that fails leaves the text plain: highlighting
 * must never get in the way of editing.
 */
export function highlight(text: string, language: Language): Span[] {
  if (last?.text === text && last.language === language) return last.spans;
  let spans: Span[];
  try {
    spans = LEXERS[language](text);
  } catch {
    spans = [];
  }
  last = { text, language, spans };
  return spans;
}

/** The span covering `offset`, searching forward from `from` (an index into `spans`) so a line is one linear merge. */
export function spanAt(
  spans: readonly Span[],
  offset: number,
  from: number,
): { role: SyntaxRole | undefined; next: number } {
  let index = from;
  while (index < spans.length && spans[index]!.end <= offset) index++;
  const span = spans[index];
  return { role: span && span.start <= offset ? span.role : undefined, next: index };
}

/** The first span that may touch `offset` or lies after it (binary search), to start a line's merge. */
export function firstSpanFrom(spans: readonly Span[], offset: number): number {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (spans[middle]!.end <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}
