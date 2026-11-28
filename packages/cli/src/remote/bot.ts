import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

/**
 * A session's face: a body and two eyes on a 28 by 28 grid, picked from the session id. The same id always gives the same
 * bot, so the page, the home-screen icon and the terminal agree on who this session is.
 */
type Part =
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'box'; cx: number; cy: number; w: number; h: number; r: number }
  | { kind: 'poly'; points: [number, number][]; r: number };

export interface Bot {
  body: Part;
  eyes: [Part, Part];
  /** Degrees the whole bot leans, about its middle. */
  tilt: number;
  color: string;
  /** The tile behind it on an app icon. */
  tile: string;
}

const EYE = '#F3EEE4';
const COLORS = ['#2A2520', '#9A4A2C', '#B07A2A', '#6B7A5A', '#5D6670', '#7A4E6B', '#3F6F73', '#4A5A8A', '#A4573F'];
const TILES = ['#F3EEE4', '#EAE3D5', '#E3EAE0', '#E2E7EE', '#F1E3DA', '#EAE4F0'];
const hexagon = (radius: number): [number, number][] =>
  [30, 90, 150, 210, 270, 330].map((angle) => [
    14 + radius * Math.cos((angle * Math.PI) / 180),
    14 + radius * Math.sin((angle * Math.PI) / 180),
  ]);
const BODIES: { part: Part; tilts: number[]; eyeY: number; eyeX: number }[] = [
  { part: { kind: 'ellipse', cx: 14, cy: 14, rx: 11, ry: 11 }, tilts: [0], eyeY: 13, eyeX: 3.5 },
  { part: { kind: 'ellipse', cx: 14, cy: 14.5, rx: 11.5, ry: 9.5 }, tilts: [-12, 12], eyeY: 14, eyeX: 3.4 },
  { part: { kind: 'box', cx: 14, cy: 14, w: 21, h: 21, r: 7.5 }, tilts: [-8, 0, 8], eyeY: 13, eyeX: 3.2 },
  { part: { kind: 'box', cx: 14, cy: 14, w: 23, h: 17, r: 8.5 }, tilts: [-6, 6], eyeY: 13.6, eyeX: 3.6 },
  {
    part: {
      kind: 'poly',
      points: [
        [14, 6.5],
        [22, 20.5],
        [6, 20.5],
      ],
      r: 3,
    },
    tilts: [0],
    eyeY: 16.4,
    eyeX: 2.9,
  },
  { part: { kind: 'poly', points: hexagon(8.5), r: 2.5 }, tilts: [0, 30], eyeY: 13.4, eyeX: 3.2 },
];
const EYES: ((x: number, y: number) => Part)[] = [
  (cx, cy) => ({ kind: 'box', cx, cy, w: 2.6, h: 5.6, r: 1.3 }),
  (cx, cy) => ({ kind: 'ellipse', cx, cy: cy + 0.4, rx: 1.9, ry: 1.9 }),
  (cx, cy) => ({ kind: 'box', cx, cy: cy + 0.3, w: 2.2, h: 4.2, r: 1.1 }),
];

export function botFor(seed: string): Bot {
  const bytes = createHash('sha256').update(seed).digest();
  const pick = <T>(list: readonly T[], at: number): T => list[bytes[at]! % list.length]!;
  const body = pick(BODIES, 0);
  const eye = pick(EYES, 1);
  return {
    body: body.part,
    eyes: [eye(14 - body.eyeX, body.eyeY), eye(14 + body.eyeX, body.eyeY)],
    tilt: pick(body.tilts, 2),
    color: pick(COLORS, 3),
    tile: pick(TILES, 4),
  };
}

const n = (value: number): string => String(Math.round(value * 100) / 100);

function svgPart(part: Part, fill: string): string {
  if (part.kind === 'ellipse')
    return `<ellipse cx="${n(part.cx)}" cy="${n(part.cy)}" rx="${n(part.rx)}" ry="${n(part.ry)}" fill="${fill}"/>`;
  if (part.kind === 'box')
    return `<rect x="${n(part.cx - part.w / 2)}" y="${n(part.cy - part.h / 2)}" width="${n(part.w)}" height="${n(part.h)}" rx="${n(part.r)}" fill="${fill}"/>`;
  // A polygon grown by r on every side: the round join of a stroke in its own color draws exactly that.
  return `<polygon points="${part.points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" fill="${fill}" stroke="${fill}" stroke-width="${n(part.r * 2)}" stroke-linejoin="round"/>`;
}

/** How much of the tile an app icon's bot fills, so a round or squircle mask never cuts it. */
const ICON_SCALE = 0.62;

/**
 * The bot as SVG. With `tile` it is a full square app icon; without, only the bot, with the groups the page animates:
 * `whole` bobs, `eyes` looks around and `lids` blinks.
 */
export function botSvg(bot: Bot, tile = false): string {
  // The lean sits on its own group: the page animates `whole`, and a CSS transform would replace one set here.
  const face = `<g class="whole"><g transform="rotate(${bot.tilt} 14 14)">${svgPart(bot.body, bot.color)}<g class="eyes"><g class="lids">${bot.eyes.map((eye) => svgPart(eye, EYE)).join('')}</g></g></g></g>`;
  return tile
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" fill="${bot.tile}"/><g transform="translate(14 14) scale(${ICON_SCALE}) translate(-14 -14)">${face}</g></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" class="bot" aria-hidden="true">${face}</svg>`;
}

function inside(part: Part, x: number, y: number): boolean {
  if (part.kind === 'ellipse') return ((x - part.cx) / part.rx) ** 2 + ((y - part.cy) / part.ry) ** 2 <= 1;
  if (part.kind === 'box') {
    const qx = Math.abs(x - part.cx) - (part.w / 2 - part.r);
    const qy = Math.abs(y - part.cy) - (part.h / 2 - part.r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= part.r;
  }
  let within = false;
  let nearest = Infinity;
  for (let i = 0, j = part.points.length - 1; i < part.points.length; j = i++) {
    const [ax, ay] = part.points[i]!;
    const [bx, by] = part.points[j]!;
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) within = !within;
    const t = Math.max(
      0,
      Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)),
    );
    nearest = Math.min(nearest, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)));
  }
  return within || nearest <= part.r;
}

const rgb = (hex: string): [number, number, number] =>
  [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as never;

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** The app icon as a PNG, for home screens that take no SVG. Edges are smoothed by sampling each pixel 16 times. */
export function botPng(bot: Bot, size: number): Buffer {
  const colors = [rgb(bot.tile), rgb(bot.color), rgb(EYE)];
  const turn = (-bot.tilt * Math.PI) / 180;
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  const which = (px: number, py: number): number => {
    // From the icon back to the bot's own grid: undo the icon's scale, then the lean.
    const sx = (px / size - 0.5) * (28 / ICON_SCALE);
    const sy = (py / size - 0.5) * (28 / ICON_SCALE);
    const x = 14 + sx * cos - sy * sin;
    const y = 14 + sx * sin + sy * cos;
    if (!inside(bot.body, x, y)) return 0;
    return bot.eyes.some((eye) => inside(eye, x, y)) ? 2 : 1;
  };
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let py = 0; py < size; py++) {
    const row = py * (size * 3 + 1);
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      for (let s = 0; s < 16; s++) {
        const color = colors[which(px + ((s % 4) + 0.5) / 4, py + (Math.floor(s / 4) + 0.5) / 4)]!;
        for (let c = 0; c < 3; c++) sum[c]! += color[c]!;
      }
      for (let c = 0; c < 3; c++) rows[row + 1 + px * 3 + c] = Math.round(sum[c]! / 16);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
