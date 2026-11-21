import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { inGlyphs, type Glyphs } from './glyphs.ts';
import { colorText, type OmsTheme, type ThemeRole } from './theme.ts';
import { singleLine } from './transcript.ts';

/** A key and what it does, drawn as `key label` with the key a step brighter. */
export type Hint = readonly [key: string, label: string];

/** One session fact on the right of the status row. A chip with a `dot` draws a colored status dot before its text. */
export interface StatusFact {
  key: 'folder' | 'branch' | 'chip' | 'model' | 'context' | 'cost' | 'budget' | 'yolo';
  text: string;
  role: ThemeRole;
  dot?: ThemeRole;
  /** Marks emphasis: YOLO is bold. */
  bold?: boolean;
}
/** What a feature adds to the status row (the local chain, a connector). The text is cut to 24 columns. */
export interface StatusChip {
  text: string;
  /** Color of the dot drawn before the text; no dot when absent. */
  dot?: 'success' | 'warning' | 'error' | 'info';
  /** Color of the text; muted by default. */
  role?: 'muted' | 'success' | 'warning' | 'error' | 'info';
}

/** The row's own side margin: 2 columns, 1 on narrow terminals. */
export const edge = (width: number): number => (width < 80 ? 1 : 2);

/** `anthropic/claude-sonnet-4-5-20250929` becomes `sonnet-4.5`; ids without a vendor prefix or date are kept. */
export function shortModelName(id: string): string {
  const name = singleLine(id, 120)
    .replace(/^.*\//, '')
    .replace(/^claude-/, '')
    .replace(/-latest$/, '')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '')
    .replace(/(\d)-(\d)(?!\d)/g, '$1.$2');
  return name.length > 24 ? name.slice(0, 23) + '…' : name;
}

/** `23% ctx`: muted, warning from 80%, error from 95%. */
export function contextFact(percent: number): StatusFact {
  const rounded = Math.max(0, Math.round(percent));
  return {
    key: 'context',
    text: `${rounded}% ctx`,
    role: rounded >= 95 ? 'error' : rounded >= 80 ? 'warning' : 'muted',
  };
}

/** `$0.42`, hidden below half a cent. */
export function costFact(microUsd: number): StatusFact | undefined {
  return microUsd >= 5000 ? { key: 'cost', text: `$${(microUsd / 1e6).toFixed(2)}`, role: 'muted' } : undefined;
}

interface BudgetLike {
  caps: Record<'tokens' | 'spendMicroUsd' | 'wallClockMs', number>;
  remaining: Record<'tokens' | 'spendMicroUsd' | 'wallClockMs', number>;
  exhausted: boolean;
  executionMode: string;
}
/** Only a budget that is nearly spent shows: 'budget 8% left' (warning) or 'budget used up' (error). */
export function budgetFact(budget: BudgetLike): StatusFact | undefined {
  if (budget.exhausted) return { key: 'budget', text: 'budget used up', role: 'error' };
  const scope =
    budget.executionMode === 'interactive'
      ? (['tokens', 'wallClockMs'] as const)
      : (['tokens', 'spendMicroUsd', 'wallClockMs'] as const);
  let left = 1;
  for (const key of scope) if (budget.caps[key] > 0) left = Math.min(left, budget.remaining[key] / budget.caps[key]);
  return left <= 0.1
    ? { key: 'budget', text: `budget ${Math.max(0, Math.round(left * 100))}% left`, role: 'warning' }
    : undefined;
}

/** The branch a folder is on, read from `.git/HEAD` (also in a worktree); undefined outside git or when detached. */
export function gitBranch(folder: string): string | undefined {
  try {
    let git = join(folder, '.git');
    if (statSync(git).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, 'utf8'))?.[1];
      if (!pointer) return undefined;
      git = pointer.startsWith('/') ? pointer : join(folder, pointer);
    }
    const head = readFileSync(join(git, 'HEAD'), 'utf8');
    const branch = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim();
    return branch ? singleLine(branch, 80) : undefined;
  } catch {
    return undefined;
  }
}

/** A few seconds of memory so the branch is not read from disk on every frame. */
export function cachedBranch(folder: string, now = Date.now()): string | undefined {
  const known = branches.get(folder);
  if (known && now - known.at < 5000) return known.branch;
  const branch = gitBranch(folder);
  branches.set(folder, { at: now, branch });
  return branch;
}
const branches = new Map<string, { at: number; branch: string | undefined }>();

/** Facts drop in this order as the row narrows; hints go first of all, context, budget and YOLO never. */
const DROP_ORDER: readonly StatusFact['key'][] = ['cost', 'branch', 'chip', 'model', 'folder'];
const MINIMUM_GAP = 4;

export interface StatusRowInput {
  width: number;
  hints: readonly Hint[];
  /** A confirmation, shown in place of the hints. */
  toast?: string;
  facts: readonly StatusFact[];
}

function factText(theme: OmsTheme, glyphs: Glyphs, fact: StatusFact): string {
  const shown = inGlyphs(glyphs, fact.text);
  const text = colorText(theme, fact.role, fact.bold ? `\x1b[1m${shown}\x1b[22m` : shown);
  return fact.dot ? `${colorText(theme, fact.dot, glyphs.dot)} ${text}` : text;
}

/**
 * The one status row: contextual hints on the left (or a toast), session facts on the right. The left side always keeps
 * its first hint, or the whole toast, by dropping the right side's least important facts first; context, budget and
 * YOLO are never dropped.
 */
export function statusRow(theme: OmsTheme, glyphs: Glyphs, input: StatusRowInput): string {
  const margin = edge(input.width);
  const room = Math.max(0, input.width - 2 * margin);
  const separator = colorText(theme, 'faint', glyphs.separator);
  const joined = (parts: readonly string[]) => parts.join(separator);
  const toast = input.toast === undefined ? undefined : inGlyphs(glyphs, singleLine(input.toast, 400));
  const hints = input.hints.map(([key, label]) => [inGlyphs(glyphs, key), inGlyphs(glyphs, label)] as const);
  const first = hints[0];
  const needed = toast !== undefined ? visibleWidth(toast) : first ? visibleWidth(`${first[0]} ${first[1]}`) : 0;
  const shown = [...input.facts];
  const rightWidth = () => visibleWidth(joined(shown.map((fact) => factText(theme, glyphs, fact))));
  for (const key of DROP_ORDER) {
    if (rightWidth() + MINIMUM_GAP + needed <= room) break;
    for (let index = shown.length - 1; index >= 0; index--) if (shown[index]!.key === key) shown.splice(index, 1);
  }
  const right = joined(shown.map((fact) => factText(theme, glyphs, fact)));
  const rightSize = visibleWidth(right);
  const leftRoom = Math.max(0, room - rightSize - MINIMUM_GAP);
  let left = '';
  if (toast !== undefined) {
    left = leftRoom > 0 ? colorText(theme, 'accent', truncateToWidth(toast, leftRoom, glyphs.ellipsis)) : '';
  } else {
    const parts: string[] = [];
    let used = 0;
    for (const [key, label] of hints) {
      const text = `${colorText(theme, 'muted', key)} ${colorText(theme, 'faint', label)}`;
      const size = visibleWidth(`${key} ${label}`) + (parts.length ? visibleWidth(glyphs.separator) : 0);
      if (used + size > leftRoom) break;
      parts.push(text);
      used += size;
    }
    left = joined(parts);
  }
  const gap = Math.max(1, room - visibleWidth(left) - rightSize);
  return truncateToWidth(' '.repeat(margin) + left + ' '.repeat(gap) + right, input.width, '');
}

/** What the status row's left side says for the current state. */
export interface HintState {
  /** `read`: the command is taller than the card and has not been scrolled to its end, so Allow is locked. */
  approval?: 'once-or-session' | 'once' | 'read';
  /** A yes/no question from a command (/yolo) is waiting for a key. */
  confirm?: boolean;
  overlay: boolean;
  busy: boolean;
  /** Esc stops the running work from here (default true); false for a verification or review, or the shell's focus. */
  canInterrupt?: boolean;
  popup: boolean;
  /** `/error <code> [program]` when the draft is a command that still needs its argument. */
  usage?: string;
  view: 'harness' | 'workbench';
  focus: 'input' | 'editor' | 'terminal' | 'conversation' | 'requirements' | 'actions';
}
export function statusHints(state: HintState): readonly Hint[] {
  if (state.approval === 'read')
    return [
      ['↑↓', 'read the whole command to allow'],
      ['n / esc', 'deny'],
    ];
  if (state.approval)
    return [
      ['y', 'allow once'],
      ...(state.approval === 'once-or-session' ? ([['s', 'allow for this session']] as const) : []),
      ['n / esc', 'deny'],
    ];
  if (state.confirm)
    return [
      ['y', 'yes'],
      ['n / esc', 'no'],
    ];
  if (state.overlay) return [];
  if (state.popup)
    return [
      ['↑↓', 'choose'],
      ['tab', 'complete'],
      ['enter', 'run'],
    ];
  if (state.usage)
    return [
      ['usage', state.usage],
      ['enter', 'run'],
    ];
  if (state.busy && state.canInterrupt !== false)
    return [
      ['esc', 'interrupt'],
      ['/', 'commands'],
    ];
  if (state.view === 'workbench' && state.focus === 'editor')
    return [
      ['ctrl+k', 'commands'],
      ['ctrl+p', 'files'],
      ['ctrl+s', 'save'],
    ];
  if (state.focus === 'terminal')
    return [
      ['ctrl+l', 'chat'],
      ['ctrl+k', 'commands'],
    ];
  if (state.focus === 'conversation' || state.focus === 'requirements')
    return [
      ['esc', 'back to chat'],
      ['↑↓', 'scroll'],
    ];
  return [
    ['/', 'commands'],
    ['?', 'shortcuts'],
    ['ctrl+q', 'quit'],
  ];
}
