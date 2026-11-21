import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import { convertToPng } from '@earendil-works/pi-coding-agent';
import { cropKittyImageLine } from '@earendil-works/pi-tui/dist/terminal-image.js';
import {
  allocateImageId,
  getCapabilities,
  getCellDimensions,
  getPngDimensions,
  renderImage,
  setCapabilities,
  type ImageDimensions,
} from '@earendil-works/pi-tui';
import { ART_DIR, artRows, decodeArt, renderArt, type ArtTier, type Pixels } from './art.ts';

/** The startup picture setting: detect the best way to draw it, force one, or show nothing. */
export type StartupArtMode = 'auto' | ArtShowPicture | 'off';
/** The real picture (Kitty graphics), or the mosaic in a colour tier. */
type ArtShowPicture = 'image' | ArtTier;
/** What the startup screen shows: the picture, the title alone, or nothing. */
export type ArtShow = ArtShowPicture | 'title' | 'off';

/** `file` is the mosaic's pixels (.ycc), `image` the real picture (JPEG); width and height are the .ycc's. */
interface ArtEntry {
  number: number;
  title: string;
  file: string;
  image: string;
  width: number;
  height: number;
}
/** Narrower than this the picture reads as noise; wider than this adds bytes, not detail (the assets are 640 px). */
const MIN_COLS = 60;
const MAX_COLS = 220;
const INDEX = JSON.parse(readFileSync(new URL('index.json', ART_DIR), 'utf8')) as ArtEntry[];
const TRUECOLOR_PROGRAMS = new Set(['ghostty', 'iTerm.app', 'WezTerm', 'vscode']);

/** Facts about the host that the environment does not carry. None of them asks the terminal anything. */
export interface ArtHost {
  /** Whether the terminal draws Kitty graphics: pi-tui's answer, from the environment or the query over SSH. */
  readonly kitty: boolean;
  /** Whether tmux reports RGB for this client; only called inside tmux. */
  tmuxRgb(): boolean;
  /** Darwin major version, 0 off macOS. Terminal.app draws 24-bit colour from Darwin 25 (macOS 26). */
  darwin: number;
}

const HOST: ArtHost = {
  get kitty() {
    return getCapabilities().images === 'kitty';
  },
  tmuxRgb() {
    try {
      return /\bRGB\b/.test(
        execFileSync('tmux', ['display-message', '-p', '#{client_termfeatures}'], {
          encoding: 'utf8',
          timeout: 200,
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      );
    } catch {
      return false;
    }
  },
  darwin: process.platform === 'darwin' ? Number.parseInt(release(), 10) || 0 : 0,
};

/**
 * From the environment, so it can never wait on the terminal. The real picture needs Kitty graphics, and never
 * inside tmux or screen (their passthrough is unreliable) unless the setting forces it. SSH forwards TERM but not
 * COLORTERM, so a 256color TERM means truecolor: every current terminal that sets it draws 24-bit colour. The 256
 * tier is for the hosts known to turn 24-bit colour grey: Terminal.app before macOS 26, tmux without RGB, and GNU
 * screen. A 16-colour picture is never clean, so those terminals get the title only. A non-TTY never gets here:
 * interactive.ts refuses to start without one.
 */
export function artShow(mode: StartupArtMode, env: Record<string, string | undefined>, host: ArtHost = HOST): ArtShow {
  if (mode !== 'auto') return mode;
  if (env.NO_COLOR) return 'title';
  const term = env.TERM ?? '',
    truecolor = env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit';
  if (env.TMUX) return truecolor || host.tmuxRgb() ? 'truecolor' : '256';
  if (env.STY) return '256';
  if (host.kitty) return 'image';
  if (env.TERM_PROGRAM === 'Apple_Terminal') return host.darwin >= 25 ? 'truecolor' : '256';
  if (truecolor || TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM ?? '') || /kitty|ghostty|wezterm|256color/.test(term))
    return 'truecolor';
  return 'title';
}

const KITTY_QUERY = '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\';
/** Primary device attributes: every terminal answers it, so its reply ends the wait early. */
const DA1 = '\x1b[c';

/**
 * Over SSH the environment does not say which terminal is on the other end, so ask once whether it draws Kitty
 * graphics (the protocol's own capability query). True only for an OK followed by the DA1 reply; DA1 alone or
 * `timeoutMs` (1 s, for slow SSH links) without DA1 means no. Run before the interface starts reading the terminal.
 */
export function queryKittyGraphics(
  input: NodeJS.ReadableStream & { isRaw?: boolean; setRawMode?(raw: boolean): unknown },
  output: { write(data: string): unknown },
  timeoutMs = 1000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const wasRaw = input.isRaw ?? false;
    let reply = '';
    const done = (ok: boolean) => {
      clearTimeout(timer);
      input.off('data', onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      resolve(ok);
    };
    const onData = (chunk: Buffer | string) => {
      reply += chunk.toString();
      // Wait for DA1 even after an OK: the terminal sends it next, and a late DA1 would reach the interface's input.
      if (/\x1b\[\?[\d;]*c/.test(reply)) done(reply.includes('\x1b_Gi=31;OK'));
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    input.setRawMode?.(true);
    input.on('data', onData);
    input.resume();
    output.write(KITTY_QUERY + DA1);
  });
}

/**
 * Settle Kitty graphics before the renderer starts (it decides there how image lines are uploaded and placed):
 * forced by the setting, or, over SSH where pi-tui's environment check cannot see the terminal, one query.
 */
export async function settleKittyGraphics(
  mode: StartupArtMode,
  env: Record<string, string | undefined>,
  query = () => queryKittyGraphics(process.stdin, process.stdout),
): Promise<void> {
  const capabilities = getCapabilities();
  if (capabilities.images === 'kitty' || (mode !== 'auto' && mode !== 'image')) return;
  const ssh = !!(env.SSH_TTY || env.SSH_CONNECTION) && !capabilities.images && !env.TMUX && !env.STY && !env.NO_COLOR;
  if (mode === 'image' || (ssh && (await query()))) setCapabilities({ ...capabilities, images: 'kitty' });
}

/** A picture's lines and the columns it covers; an image is one Kitty placement on the first line. */
interface Picture {
  cols: number;
  lines: string[];
  image?: true;
}

/** One picture per launch: the real picture over Kitty graphics, or a quadrant mosaic, cached per size and tier. */
export class StartupArt {
  private entry: ArtEntry;
  private pixels: Pixels | undefined;
  /** The current entry as PNG (Kitty graphics takes only PNG), once loadImage() has converted it. */
  private png: { entry: ArtEntry; data: string; size: ImageDimensions; id: number } | undefined;
  private readonly cache = new Map<string, Picture>();
  private readonly random: () => number;
  /** The narrowest picture worth drawing; the interface lowers it because it caps the art at a third of the screen. */
  private readonly minCols: number;

  constructor(random = Math.random, minCols = MIN_COLS) {
    this.random = random;
    this.minCols = minCols;
    this.entry = INDEX[Math.floor(random() * INDEX.length)]!;
  }

  get title(): string {
    return `${this.entry.number} / ${this.entry.title}`;
  }

  /** Switch to a different picture. */
  next(): void {
    const others = INDEX.filter((entry) => entry !== this.entry);
    this.entry = others[Math.floor(this.random() * others.length)]!;
    this.pixels = undefined;
    this.png = undefined;
    this.cache.clear();
  }

  /** Convert the current picture to PNG for the image tier (about 100 ms). Until then the image tier draws the mosaic. */
  async loadImage(): Promise<void> {
    const entry = this.entry;
    if (this.png?.entry === entry) return;
    const png = await convertToPng(readFileSync(new URL(entry.image, ART_DIR)).toString('base64'), 'image/jpeg');
    const size = png && getPngDimensions(png.data);
    if (entry !== this.entry || !png || !size) return;
    this.png = { entry, data: png.data, size, id: allocateImageId() };
    this.cache.clear();
  }

  /**
   * The picture centred in `width` (up to `width - 2` and MAX_COLS columns, at most `maxRows` rows, aspect kept),
   * then a blank line, the title styled by `muted` under its left edge, and a blank line. 'title' leaves out
   * the picture. Empty when off or when the picture would be under MIN_COLS columns. 'image' draws the mosaic in
   * truecolor while the PNG is not ready or the terminal turns out not to draw Kitty graphics. `hidden` is how many
   * of the block's rows are scrolled above the viewport: pi-tui crops a placement whose top is hidden only for a
   * box at column 0, so the cropped placement moves to the first visible row here.
   */
  block(width: number, maxRows: number, show: ArtShow, muted: (text: string) => string, hidden = 0): string[] {
    if (show === 'off') return [];
    const picture =
      show === 'image'
        ? (this.image(width, maxRows) ?? this.mosaic(width, maxRows, 'truecolor'))
        : this.mosaic(width, maxRows, show);
    if (!picture) return [];
    const pad = ' '.repeat(Math.floor((width - picture.cols) / 2));
    const title = [pad + muted(this.title), ''];
    if (show === 'title') return title;
    const lines = picture.lines.map((line) => pad + line);
    if (picture.image && hidden > 0 && hidden < lines.length) {
      lines[hidden] = pad + cropKittyImageLine(picture.lines[0]!, hidden, lines.length - hidden);
      lines[0] = pad;
    }
    return [...lines, '', ...title];
  }

  private mosaic(width: number, maxRows: number, tier: ArtTier | 'title'): Picture | undefined {
    let cols = Math.min(width - 2, MAX_COLS);
    while (cols >= this.minCols && artRows(cols, this.entry) > maxRows) cols--;
    if (cols < this.minCols) return undefined;
    if (tier === 'title') return { cols, lines: [] };
    let picture = this.cache.get(`${tier} ${cols}`);
    if (!picture) {
      this.pixels ??= decodeArt(readFileSync(new URL(this.entry.file, ART_DIR)), this.entry.width, this.entry.height);
      picture = { cols, lines: renderArt(this.pixels, cols, artRows(cols, this.entry), tier) };
      this.cache.set(`${tier} ${cols}`, picture);
    }
    return picture;
  }

  /**
   * pi-tui's Kitty placement: the escape sequence on the first line, then blank lines for the rows it covers.
   * The renderer uploads it once and then only places it, and crops it as it scrolls away.
   */
  private image(width: number, maxRows: number): Picture | undefined {
    if (!this.png || getCapabilities().images !== 'kitty' || maxRows < 1) return undefined;
    const cell = getCellDimensions(),
      key = `image ${width} ${maxRows} ${cell.widthPx}x${cell.heightPx}`;
    let picture = this.cache.get(key);
    if (!picture) {
      const placed = renderImage(this.png.data, this.png.size, {
        maxWidthCells: Math.min(width - 2, MAX_COLS),
        maxHeightCells: maxRows,
        imageId: this.png.id,
        moveCursor: false,
      });
      if (!placed) return undefined;
      picture = {
        cols: placed.columns,
        lines: [placed.sequence, ...Array.from({ length: placed.rows - 1 }, () => '')],
        image: true,
      };
      this.cache.set(key, picture);
    }
    return picture.cols >= this.minCols ? picture : undefined;
  }
}
