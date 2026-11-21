/**
 * Pure text edits behind the editor's code-editing keys: indentation, comments and Enter. Each takes the document text
 * and the selection (UTF-16 offsets on grapheme boundaries) and returns one replacement, so the editor applies it as a
 * single undo step.
 */
export type Indent = { kind: 'tab' } | { kind: 'spaces'; size: number };
export interface Edit {
  /** Replace [from, to) with `text`. */
  from: number;
  to: number;
  text: string;
  /** The selection afterwards. */
  anchor: number;
  cursor: number;
}

export const indentText = (indent: Indent): string => (indent.kind === 'tab' ? '\t' : ' '.repeat(indent.size));

/** The indentation a file uses: tabs, or the most common step between leading-space depths (2 or 4), from its first 200 lines. */
export function detectIndent(text: string, fallback: Indent = { kind: 'spaces', size: 4 }): Indent {
  const lines = text.split('\n', 200);
  let tabs = 0;
  const steps = new Map<number, number>();
  let previous = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('\t')) {
      tabs++;
      continue;
    }
    const depth = /^ */.exec(line)![0].length;
    const step = Math.abs(depth - previous);
    if (depth > 0 || previous > 0) {
      if (step === 2 || step === 4 || step === 8) steps.set(step, (steps.get(step) ?? 0) + 1);
    }
    previous = depth;
  }
  const spaces = [...steps.values()].reduce((sum, count) => sum + count, 0);
  if (tabs > spaces) return { kind: 'tab' };
  let best = 0;
  let size = 0;
  for (const [step, count] of steps) {
    // Prefer the smaller unit on a tie: a 4-space file also contains 8-space jumps.
    if (count > best || (count === best && step < size)) {
      best = count;
      size = step;
    }
  }
  return size ? { kind: 'spaces', size: size === 8 ? 4 : size } : fallback;
}

/** Start of the line holding `offset`. */
export function lineStart(text: string, offset: number): number {
  const at = Math.max(text.lastIndexOf('\n', offset - 1), text.lastIndexOf('\r', offset - 1));
  return at + 1;
}
/** End of the line holding `offset` (before its line break). */
export function lineEnd(text: string, offset: number): number {
  const lf = text.indexOf('\n', offset);
  const cr = text.indexOf('\r', offset);
  const ends = [lf, cr].filter((value) => value >= 0);
  return ends.length ? Math.min(...ends) : text.length;
}

/** The whole lines a selection touches. A selection that ends at the very start of a line leaves that line out. */
export function selectedLineRange(text: string, anchor: number, cursor: number): { from: number; to: number } {
  const start = Math.min(anchor, cursor);
  const end = Math.max(anchor, cursor);
  const from = lineStart(text, start);
  const last = end > start && end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r') ? end - 1 : end;
  return { from, to: lineEnd(text, Math.max(from, last)) };
}

function mapLines(text: string, from: number, to: number, change: (line: string) => string): string {
  return text
    .slice(from, to)
    .split(/(\r\n|\r|\n)/)
    .map((part, index) => (index % 2 === 1 ? part : change(part)))
    .join('');
}

/** Indent (or outdent) every line of the selection by one unit. */
export function shiftLines(
  text: string,
  anchor: number,
  cursor: number,
  indent: Indent,
  outdent: boolean,
): Edit | undefined {
  const { from, to } = selectedLineRange(text, anchor, cursor);
  const unit = indentText(indent);
  const removed = (line: string): number => {
    if (line.startsWith('\t')) return 1;
    const spaces = /^ */.exec(line)![0].length;
    return Math.min(spaces, indent.kind === 'spaces' ? indent.size : 4);
  };
  const next = mapLines(text, from, to, (line) =>
    outdent ? line.slice(removed(line)) : line.trim() ? unit + line : line,
  );
  if (next === text.slice(from, to)) return undefined;
  return { from, to, text: next, anchor: from, cursor: from + next.length };
}

/** Comment or uncomment the selected lines with `marker`; every non-blank line must carry it to uncomment. */
export function toggleComment(text: string, anchor: number, cursor: number, marker: string): Edit | undefined {
  const { from, to } = selectedLineRange(text, anchor, cursor);
  const lines = text.slice(from, to).split(/\r\n|\r|\n/);
  const content = lines.filter((line) => line.trim());
  if (!content.length) return undefined;
  const commented = content.every((line) => line.trimStart().startsWith(marker));
  const depth = Math.min(...content.map((line) => /^[ \t]*/.exec(line)![0].length));
  const next = mapLines(text, from, to, (line) => {
    if (!line.trim()) return line;
    if (commented) {
      const lead = /^[ \t]*/.exec(line)![0];
      const rest = line.slice(lead.length + marker.length);
      return lead + (rest.startsWith(' ') ? rest.slice(1) : rest);
    }
    return line.slice(0, depth) + marker + ' ' + line.slice(depth);
  });
  return { from, to, text: next, anchor: from, cursor: from + next.length };
}

const OPENERS: Readonly<Record<string, string>> = { '{': '}', '(': ')', '[': ']' };

/** Enter: keep the line's indentation, one deeper after an opener, and split `{|}` onto three lines. */
export function newlineEdit(text: string, cursor: number, newline: string, indent: Indent): Edit {
  const start = lineStart(text, cursor);
  const before = text.slice(start, cursor);
  const lead = /^[ \t]*/.exec(before)![0];
  const trimmed = before.trimEnd();
  const opens = /[{(\[]$/.test(trimmed) || trimmed.endsWith('=>');
  const unit = indentText(indent);
  const inner = lead + (opens ? unit : '');
  const closer = OPENERS[trimmed.slice(-1)];
  // Whitespace left at the end of the previous line is trimmed away, like most editors do.
  const dropped = before.length - trimmed.length;
  const next = text[cursor];
  if (closer && next === closer) {
    const insert = newline + inner + newline + lead;
    return {
      from: cursor - dropped,
      to: cursor,
      text: insert,
      anchor: cursor - dropped + newline.length + inner.length,
      cursor: cursor - dropped + newline.length + inner.length,
    };
  }
  const insert = newline + inner;
  return {
    from: cursor - dropped,
    to: cursor,
    text: insert,
    anchor: cursor - dropped + insert.length,
    cursor: cursor - dropped + insert.length,
  };
}

/** Typing a closing bracket on a whitespace-only line first removes one indentation unit. */
export function closerOutdent(text: string, cursor: number, indent: Indent): { from: number; to: number } | undefined {
  const start = lineStart(text, cursor);
  const before = text.slice(start, cursor);
  if (!before || /[^ \t]/.test(before)) return undefined;
  if (indent.kind === 'tab') return before.endsWith('\t') ? { from: cursor - 1, to: cursor } : undefined;
  const size = Math.min(indent.size, before.length);
  return before.endsWith(' '.repeat(size)) ? { from: cursor - size, to: cursor } : undefined;
}

/** Backspace inside leading spaces removes back to the previous indentation stop, like a tab character would. */
export function softBackspace(text: string, cursor: number, indent: Indent): { from: number; to: number } | undefined {
  if (indent.kind !== 'spaces') return undefined;
  const start = lineStart(text, cursor);
  const before = text.slice(start, cursor);
  if (before.length < 2 || !/^ +$/.test(before)) return undefined;
  const drop = before.length % indent.size || indent.size;
  return drop > 1 ? { from: cursor - drop, to: cursor } : undefined;
}
