export const MAX_DOCUMENT_BYTES = 64 * 1024;
export const MAX_HISTORY_ENTRIES = 1000;
const MAX_HISTORY_BYTES = 1024 * 1024;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface Selection {
  anchor: number;
  cursor: number;
}
/** What kind of keystroke made an edit; the next keystroke of the same kind joins it into one undo step. */
type Grouping = 'type' | 'backspace' | 'delete';
interface Edit {
  start: number;
  removed: string;
  inserted: string;
  before: Selection;
  after: Selection;
  bytes: number;
  grouping?: Grouping;
}
const isSpace = (text: string): boolean => /^\s+$/.test(text);
const isWord = (character: string): boolean => /[\p{L}\p{N}_]/u.test(character);

function validateText(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid Unicode surrogate');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('Invalid Unicode surrogate');
    }
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new RangeError('Document exceeds the 64 KiB UTF-8 limit');
  }
}

/** Exact source text; offsets are UTF-16 indices at grapheme boundaries. */
export class FileDocument {
  private value: string;
  private saved: string;
  private selection: Selection = { anchor: 0, cursor: 0 };
  /** The kind of keystroke that made the newest undo step, while nothing else has happened since. */
  private open: Grouping | undefined;
  private boundaries: number[] = [];
  private readonly past: Edit[] = [];
  private readonly future: Edit[] = [];
  private historyBytes = 0;
  readonly newline: string;

  constructor(text: string) {
    validateText(text);
    this.value = text;
    this.saved = text;
    this.newline = /\r\n|\r|\n/.exec(text)?.[0] ?? '\n';
    this.indexGraphemes();
  }

  get text(): string {
    return this.value;
  }
  get dirty(): boolean {
    return this.value !== this.saved;
  }
  get cursor(): number {
    return this.selection.cursor;
  }
  get anchor(): number {
    return this.selection.anchor;
  }
  get selectedText(): string {
    return this.value.slice(Math.min(this.anchor, this.cursor), Math.max(this.anchor, this.cursor));
  }

  markSaved(text: string): void {
    validateText(text);
    this.saved = text;
  }

  select(anchor: number, cursor: number): void {
    if (!this.boundaries.includes(anchor) || !this.boundaries.includes(cursor)) {
      throw new RangeError('Selection must use grapheme boundaries');
    }
    this.selection = { anchor, cursor };
    this.open = undefined;
  }

  move(direction: 'left' | 'right', extend = false): void {
    if (!extend && this.anchor !== this.cursor) {
      const cursor = direction === 'left' ? Math.min(this.anchor, this.cursor) : Math.max(this.anchor, this.cursor);
      this.select(cursor, cursor);
      return;
    }
    const index = this.boundaries.indexOf(this.cursor);
    const target = Math.max(0, Math.min(this.boundaries.length - 1, index + (direction === 'left' ? -1 : 1)));
    const cursor = this.boundaries[target]!;
    this.select(extend ? this.anchor : cursor, cursor);
  }

  /**
   * Replace the selection. With `group`, a keystroke that continues the previous typing (the same word, no cursor
   * move in between) joins its undo step, so Undo takes back a word instead of a character.
   */
  insert(text: string, group = false): void {
    const start = Math.min(this.anchor, this.cursor);
    const end = Math.max(this.anchor, this.cursor);
    this.edit(start, end, text, undefined, group && text.length > 0 && !/[\r\n]/.test(text) ? 'type' : undefined);
  }

  /** Replace [start, end) as one undo step; the selection afterwards is `after`, or the caret after the new text. */
  replaceRange(start: number, end: number, text: string, after?: Selection): void {
    if (start > end || !this.boundaries.includes(start) || !this.boundaries.includes(end)) {
      throw new RangeError('Range must use grapheme boundaries');
    }
    this.edit(start, end, text, after);
  }

  /** Swap in new text from outside (a file changed on disk) without an undo step; the caret stays near where it was. */
  reload(text: string): void {
    validateText(text);
    const anchor = Math.min(this.anchor, text.length);
    const cursor = Math.min(this.cursor, text.length);
    this.value = text;
    this.saved = text;
    this.indexGraphemes();
    const snap = (offset: number) => this.boundaries.find((boundary) => boundary >= offset) ?? text.length;
    this.selection = { anchor: snap(anchor), cursor: snap(cursor) };
    for (const edit of this.past) this.historyBytes -= edit.bytes;
    for (const edit of this.future) this.historyBytes -= edit.bytes;
    this.past.length = 0;
    this.future.length = 0;
    this.open = undefined;
  }

  /** Where the previous or next word boundary lies from `offset` (letters and digits, or a run of punctuation). */
  wordBoundary(offset: number, direction: 'left' | 'right'): number {
    let index = this.boundaries.indexOf(offset);
    if (index < 0) throw new RangeError('Offset must be a grapheme boundary');
    const last = this.boundaries.length - 1;
    const step = direction === 'left' ? -1 : 1;
    const canStep = (at: number) => (direction === 'left' ? at > 0 : at < last);
    const grapheme = (at: number) =>
      direction === 'left'
        ? this.value.slice(this.boundaries[at - 1], this.boundaries[at])
        : this.value.slice(this.boundaries[at], this.boundaries[at + 1]);
    // Skip separators first, then the run of word characters or of punctuation.
    while (canStep(index) && isSpace(grapheme(index))) index += step;
    if (!canStep(index)) return this.boundaries[index]!;
    const word = isWord(grapheme(index));
    while (canStep(index) && !isSpace(grapheme(index)) && isWord(grapheme(index)) === word) index += step;
    return this.boundaries[index]!;
  }

  /** Ends the current undo group: the next keystroke starts a new step. */
  breakGroup(): void {
    this.open = undefined;
  }

  private edit(
    start: number,
    end: number,
    text: string,
    after: Selection | undefined,
    grouping?: Grouping,
    caret?: Selection,
  ): void {
    const next = this.value.slice(0, start) + text + this.value.slice(end);
    validateText(next);
    if (next === this.value) {
      this.selection = after ?? { anchor: end, cursor: end };
      this.open = undefined;
      return;
    }
    const removed = this.value.slice(start, end);
    const before = caret ?? this.selection;
    const previous = this.past.at(-1);
    // Typing continues the last step when it starts exactly where that step ended; so do repeated Backspace and Delete.
    const joins =
      grouping !== undefined &&
      previous !== undefined &&
      this.open === grouping &&
      previous.grouping === grouping &&
      this.future.length === 0 &&
      (grouping === 'type'
        ? removed === '' &&
          start === previous.start + previous.inserted.length &&
          !(isSpace(text) && !isSpace(previous.inserted.slice(-1)) && previous.inserted !== '')
        : grouping === 'backspace'
          ? end === previous.start && text === ''
          : start === previous.start && text === '');
    this.value = next;
    this.indexGraphemes();
    // An insertion can join surrounding combining marks/ZWJ into one grapheme.
    const cursor = this.boundaries.find((offset) => offset >= start + text.length) ?? next.length;
    this.selection = after ?? { anchor: cursor, cursor };
    for (const edit of this.future) this.historyBytes -= edit.bytes;
    this.future.length = 0;
    const bytes = Buffer.byteLength(removed, 'utf8') + Buffer.byteLength(text, 'utf8');
    if (joins && previous) {
      if (grouping === 'type') previous.inserted += text;
      else if (grouping === 'backspace') {
        previous.removed = removed + previous.removed;
        previous.start = start;
      } else previous.removed += removed;
      previous.after = this.selection;
      previous.bytes += bytes;
    } else {
      this.past.push({ start, removed, inserted: text, before, after: this.selection, bytes, grouping });
    }
    this.historyBytes += bytes;
    this.open = grouping;
    while (this.past.length > MAX_HISTORY_ENTRIES || this.historyBytes > MAX_HISTORY_BYTES) {
      this.historyBytes -= this.past.shift()!.bytes;
    }
  }

  backspace(group = false): void {
    this.removeAdjacent('left', group ? 'backspace' : undefined);
  }

  deleteForward(group = false): void {
    this.removeAdjacent('right', group ? 'delete' : undefined);
  }

  /** Delete from the caret to the previous or next word boundary (or the selection, if there is one). */
  deleteWord(direction: 'left' | 'right'): void {
    if (this.anchor !== this.cursor) {
      this.insert('');
      return;
    }
    const target = this.wordBoundary(this.cursor, direction);
    this.replaceRange(Math.min(target, this.cursor), Math.max(target, this.cursor), '');
  }

  /** Move or extend the selection by a word. */
  moveWord(direction: 'left' | 'right', extend = false): void {
    const target = this.wordBoundary(this.cursor, direction);
    this.select(extend ? this.anchor : target, target);
  }

  undo(): void {
    const edit = this.past.pop();
    if (!edit) return;
    this.value = this.value.slice(0, edit.start) + edit.removed + this.value.slice(edit.start + edit.inserted.length);
    this.selection = edit.before;
    this.open = undefined;
    this.indexGraphemes();
    this.future.push(edit);
  }

  redo(): void {
    const edit = this.future.pop();
    if (!edit) return;
    this.value = this.value.slice(0, edit.start) + edit.inserted + this.value.slice(edit.start + edit.removed.length);
    this.selection = edit.after;
    this.open = undefined;
    this.indexGraphemes();
    this.past.push(edit);
  }

  private removeAdjacent(direction: 'left' | 'right', grouping?: Grouping): void {
    if (this.anchor !== this.cursor) {
      this.insert('');
      return;
    }
    const index = this.boundaries.indexOf(this.cursor);
    const target =
      this.boundaries[Math.max(0, Math.min(this.boundaries.length - 1, index + (direction === 'left' ? -1 : 1)))]!;
    if (target === this.cursor) return;
    // Undo restores the original caret.
    this.edit(Math.min(target, this.cursor), Math.max(target, this.cursor), '', undefined, grouping, this.selection);
  }

  private indexGraphemes(): void {
    this.boundaries = Array.from(segmenter.segment(this.value), (part) => part.index);
    this.boundaries.push(this.value.length);
  }
}
