/** Every drawing glyph chrome uses, in Unicode or in plain ASCII for terminals that cannot show it. */
export interface Glyphs {
  ascii: boolean;
  /** The OMS mark. */
  mark: string;
  /** The composer prompt and the user-turn prefix. */
  prompt: string;
  dot: string;
  /** Selection marker in menus. */
  pointer: string;
  rule: string;
  vertical: string;
  corners: { topLeft: string; topRight: string; bottomLeft: string; bottomRight: string };
  separator: string;
  ellipsis: string;
  down: string;
  queued: string;
  spinner: readonly string[];
  spinnerMs: number;
}

const UNICODE: Glyphs = {
  ascii: false,
  mark: '◆',
  prompt: '❯',
  dot: '●',
  pointer: '›',
  rule: '─',
  vertical: '│',
  corners: { topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯' },
  separator: ' · ',
  ellipsis: '…',
  down: '↓',
  queued: '↳',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  spinnerMs: 80,
};
const ASCII: Glyphs = {
  ascii: true,
  mark: '*',
  prompt: '>',
  dot: '*',
  pointer: '>',
  rule: '-',
  vertical: '|',
  corners: { topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+' },
  separator: ' - ',
  ellipsis: '...',
  down: 'v',
  queued: '>',
  spinner: ['|', '/', '-', '\\'],
  spinnerMs: 120,
};

const on = (value: string | undefined) => value !== undefined && /^(?:1|true|yes|on)$/i.test(value);

/** Plain ASCII when OMS_ASCII is on or the terminal is a Linux console or dumb. OMS_REDUCED_MOTION holds the spinner still. */
export function glyphsFor(env: Readonly<Record<string, string | undefined>> = process.env): Glyphs {
  const base = on(env.OMS_ASCII) || env.TERM === 'linux' || env.TERM === 'dumb' ? ASCII : UNICODE;
  return on(env.OMS_REDUCED_MOTION) ? { ...base, spinner: [base.dot] } : base;
}

/** Chrome text in the glyph set: Unicode as written, or plain ASCII (arrows, dots, ellipses, pointers) without Unicode. */
export function inGlyphs(glyphs: Glyphs, text: string): string {
  return glyphs.ascii
    ? text
        .replaceAll('↑↓', 'up/down')
        .replaceAll('↓', 'v')
        .replaceAll('↑', '^')
        .replaceAll(' · ', glyphs.separator)
        .replaceAll('…', glyphs.ellipsis)
        .replaceAll('›', glyphs.pointer)
    : text;
}
