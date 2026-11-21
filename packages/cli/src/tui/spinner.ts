import { Loader, truncateToWidth, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import type { Glyphs } from './glyphs.ts';
import { edge } from './status-row.ts';
import { colorText, type OmsTheme } from './theme.ts';
import { clipLine } from './transcript.ts';

/** `12s`, `1m 04s`, `1h 02m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** `412`, `1.2k`, `12k`, `1.3M`. */
export function formatCount(tokens: number): string {
  const short = (value: number) => (value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value)));
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
  return tokens < 999_500 ? `${short(tokens / 1e3)}k` : `${short(tokens / 1e6)}M`;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const lastSegments = (path: string): string => path.split('/').filter(Boolean).slice(-2).join('/');

/** What the agent is doing, from the tool it is running: `Reading lib.rs`, `Running anchor test`, `Thinking`. */
export function toolVerb(name: string | undefined, args: unknown): string {
  if (!name) return 'Thinking';
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  // The last two segments first, then the cut: a long absolute path must not lose its tail.
  const path = clipLine(lastSegments(text(a.path ?? a.file_path ?? a.file)), 80);
  switch (name) {
    case 'read':
      return path ? `Reading ${path}` : 'Reading';
    case 'write':
      return path ? `Writing ${path}` : 'Writing';
    case 'edit':
      return path ? `Editing ${path}` : 'Editing';
    case 'bash':
      return `Running ${clipLine(text(a.command), 48) || 'a command'}`;
    case 'grep':
    case 'find':
    case 'ls':
      return 'Searching the project';
    case 'web_search':
      return 'Searching the web';
    case 'web_fetch':
    case 'source_fetch':
      return 'Fetching a page';
    case 'agent':
      return 'Running a helper agent';
    case 'propose_done':
      return 'Checking the requirements';
    case 'decode_error':
      return 'Decoding a program error';
    default:
      return /solana|docs?|idl|api_lookup|topic/.test(name)
        ? 'Searching Solana docs'
        : `Running ${name.replaceAll('_', ' ')}`;
  }
}

export interface SpinnerFacts {
  verb: string;
  elapsedMs: number;
  /** Output tokens this turn; hidden when unknown or zero. */
  tokens: number;
  /** False when Esc does not stop the work here (a verification or review, or the shell has the keys); the hint goes. */
  canStop?: boolean;
}

/**
 * The one row above the composer while work runs: an animated frame and what is happening on the left, time, tokens and
 * how to stop on the right. pi-tui's Loader owns the frames and the timer; it draws nothing but its own row here.
 */
export class SpinnerRow extends Loader {
  private readonly facts: () => SpinnerFacts;
  private readonly palette: () => OmsTheme;
  private readonly glyphs: Glyphs;
  constructor(ui: TUI, palette: () => OmsTheme, glyphs: Glyphs, facts: () => SpinnerFacts) {
    super(
      ui,
      (frame) => colorText(palette(), 'accentFill', frame),
      (message) => message,
      '',
      { frames: [...glyphs.spinner], intervalMs: glyphs.spinnerMs },
    );
    this.palette = palette;
    this.glyphs = glyphs;
    this.facts = facts;
    // The Loader starts animating on construction; it runs only while work does.
    this.stop();
  }
  /** `⠹ Reading lib.rs… 12s`: the left label and the time, for a short terminal's merged rule. */
  compact(width: number): string {
    const { verb, elapsedMs } = this.facts();
    const time = formatElapsed(elapsedMs);
    const text = truncateToWidth(verb + this.glyphs.ellipsis, Math.max(1, width - visibleWidth(time) - 3), '');
    return `${this.getRenderedIndicator()} ${colorText(this.palette(), 'foreground', text)} ${colorText(this.palette(), 'faint', time)}`;
  }
  override render(width: number): string[] {
    const theme = this.palette();
    const { verb, elapsedMs, tokens, canStop = true } = this.facts();
    // Glyphs sit in the left gutter (column 0), text from column 2; the right edge keeps the row margin.
    const room = Math.max(0, width - edge(width));
    const frame = this.getRenderedIndicator();
    const stats = [formatElapsed(elapsedMs), ...(tokens > 0 ? [`${this.glyphs.down} ${formatCount(tokens)}`] : [])];
    const separator = this.glyphs.separator;
    // Right side: time and tokens always; the stop hint only when it fits.
    let right = stats.join(separator);
    const withStop = `${right}${separator}esc to interrupt`;
    const verbRoom = (candidate: string) => room - visibleWidth(candidate) - 4;
    if (canStop && verbRoom(withStop) >= 12) right = withStop;
    const left = `${frame} ${colorText(theme, 'foreground', truncateToWidth(verb + this.glyphs.ellipsis, Math.max(1, verbRoom(right) - 2), ''))}`;
    const gap = Math.max(1, room - visibleWidth(left) - visibleWidth(right));
    // A single row, so a start with no content yet (empty verb) still shows the frame.
    return [left + ' '.repeat(gap) + colorText(theme, 'faint', right)];
  }
}
