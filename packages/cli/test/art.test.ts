import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import {
  getCapabilities,
  resetCapabilitiesCache,
  setCapabilities,
  stripTerminalSequences,
  visibleWidth,
} from '@earendil-works/pi-tui';
import { ART_DIR, artRows, decodeArt, nearest256, renderArt, type Pixels } from '../src/tui/art.ts';
import { StartupArt, artShow, queryKittyGraphics, settleKittyGraphics } from '../src/tui/startup-art.ts';

const BUDGET_BYTES = 2.5 * 1000 * 1000;
const kyoto = decodeArt(readFileSync(new URL('28-kyoto-after-rain.ycc', ART_DIR)), 640, 351);

test('every picture in the art index exists and the art folder stays within its size budget', () => {
  const index = JSON.parse(readFileSync(new URL('index.json', ART_DIR), 'utf8')) as {
    number: number;
    title: string;
    file: string;
    image: string;
  }[];
  assert.deepEqual(
    index.map((entry) => entry.number),
    [22, 28, 59, 62],
  );
  for (const entry of index) {
    for (const file of [entry.file, entry.image]) assert.ok(existsSync(new URL(file, ART_DIR)), `${file} is missing`);
  }
  const total = readdirSync(ART_DIR).reduce((sum, name) => sum + statSync(new URL(name, ART_DIR)).size, 0);
  assert.ok(total <= BUDGET_BYTES, `art folder is ${total} bytes, budget ${BUDGET_BYTES}`);
});

test('every picture is built from its rectangle in scripts/art/crops.json', () => {
  const crops = JSON.parse(readFileSync(new URL('../../../scripts/art/crops.json', import.meta.url), 'utf8')) as Record<
    string,
    number[]
  >;
  const index = JSON.parse(readFileSync(new URL('index.json', ART_DIR), 'utf8')) as {
    file: string;
    width: number;
    height: number;
  }[];
  assert.deepEqual(
    Object.keys(crops).map((name) => name.replace('.png', '.ycc')),
    index.map((entry) => entry.file),
  );
  for (const entry of index) {
    const [l, t, r, b] = crops[entry.file.replace('.ycc', '.png')]!;
    assert.equal(entry.height, Math.round(((b! - t!) * entry.width) / (r! - l!)), entry.file);
  }
});

// To regenerate: write decodeArt(...).data to k.rgb, then in scripts/art: python -c "import render5;
// open('k.ans','w').write('\n'.join(render5.render(open('k.rgb','rb').read(), 640, 351, 160, 44)) + '\n')"; sha256sum k.ans
test('truecolor output is byte-identical to the render5.py reference', () => {
  const text = renderArt(kyoto, 160, artRows(160, kyoto), 'truecolor').join('\n') + '\n';
  assert.equal(
    createHash('sha256').update(text).digest('hex'),
    '9070f42e6976712b74e543d6ca0eaa0b9a62b10f5872634c622924d09ee17d3f',
  );
});

function pixels(width: number, height: number, colour: (x: number, y: number) => [number, number, number]): Pixels {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(colour(x, y), (y * width + x) * 3);
  return { width, height, data };
}

test('a cell with one corner different shows a quadrant glyph in both colours, in both tiers', () => {
  const corner = pixels(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 0, 0] : [0, 0, 255]));
  assert.deepEqual(renderArt(corner, 1, 1, 'truecolor'), ['\x1b[48;2;0;0;255m\x1b[38;2;255;0;0m▘\x1b[0m']);
  assert.deepEqual(renderArt(corner, 1, 1, '256'), ['\x1b[48;5;21m\x1b[38;5;196m▘\x1b[0m']);
  const flat = pixels(2, 2, () => [95, 135, 175]);
  assert.deepEqual(renderArt(flat, 1, 1, '256'), ['\x1b[48;5;67m \x1b[0m']);
});

test('256 colours map to the nearest xterm cube or grey entry, never the theme-coloured 0..15', () => {
  const index = (r: number, g: number, b: number) => nearest256(r / 255, g / 255, b / 255);
  assert.equal(index(0, 0, 0), 16);
  assert.equal(index(255, 255, 255), 231);
  assert.equal(index(255, 0, 0), 196);
  assert.equal(index(0, 255, 0), 46);
  assert.equal(index(0, 0, 255), 21);
  assert.equal(index(95, 135, 175), 67);
  assert.equal(index(128, 128, 128), 244);
  assert.equal(index(250, 130, 10), 208);
  const used = renderArt(kyoto, 160, artRows(160, kyoto), '256')
    .join('')
    .match(/\x1b\[[0-9;]*m/g)!;
  for (const sgr of used) assert.match(sgr, /^\x1b\[(?:(?:38|48);5;(?:1[6-9]|[2-9]\d|1\d\d|2[0-4]\d|25[0-5])|0)m$/);
});

test('every picture line is exactly the picture width, and background colour stays inside the picture', () => {
  const art = new StartupArt(() => 0.3);
  for (const show of ['truecolor', '256'] as const) {
    for (const width of [62, 100, 160, 240]) {
      const lines = art.block(width, 200, show, (text) => text);
      const picture = lines.slice(0, -3),
        cols = Math.min(width - 2, 220),
        pad = Math.floor((width - cols) / 2);
      assert.equal(picture.length, artRows(cols, { width: 640, height: 351 }));
      for (const line of picture) {
        assert.equal(visibleWidth(line), pad + cols);
        assert.ok(line.startsWith(' '.repeat(pad) + '\x1b[48;'), 'the margin left of the picture is unpainted');
        assert.ok(line.endsWith('\x1b[0m'), 'colour is reset at the picture edge');
      }
      for (const line of lines.slice(-3)) assert.equal(line.includes('\x1b[48'), false);
    }
  }
});

test('the picture keeps its aspect, stops at 220 columns, and is skipped under 60 columns', () => {
  const art = new StartupArt(() => 0.3); // 28 Kyoto, 640x351
  const width = (lines: string[]) =>
    lines.length ? Math.max(...lines.map((line) => [...stripTerminalSequences(line).trimStart()].length)) : 0;
  assert.equal(width(art.block(300, 200, 'truecolor', (t) => t).slice(0, -3)), 220);
  const limited = art.block(160, 25, 'truecolor', (t) => t).slice(0, -3);
  assert.ok(limited.length <= 25 && limited.length >= 24, `${limited.length} rows`);
  assert.equal(Math.abs(artRows(width(limited), { width: 640, height: 351 }) - limited.length), 0);
  assert.deepEqual(
    art.block(61, 200, 'truecolor', (t) => t),
    [],
  );
  assert.deepEqual(
    art.block(160, 15, 'truecolor', (t) => t),
    [],
  );
  assert.deepEqual(
    art
      .block(160, 200, 'title', (t) => t)
      .filter(Boolean)
      .map((line) => line.trim()),
    ['28 / Kyoto after rain'],
  );
  assert.deepEqual(
    art.block(160, 200, 'off', (t) => t),
    [],
  );
});

test('automatic art uses native graphics or a plain title, and explicit colour modes still work', () => {
  const TMUX = '/tmp/tmux-1/default,1,0';
  const konsole = { KONSOLE_VERSION: '211203', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  assert.equal(artShow('auto', konsole, false), 'title');
  assert.equal(artShow('auto', konsole, true), 'image');
  assert.equal(artShow('auto', { NO_COLOR: '1' }, true), 'title');
  assert.equal(artShow('auto', { TMUX }, true), 'title');
  assert.equal(artShow('auto', { STY: '1234.pts-0.host' }, true), 'title');
  assert.equal(artShow('256', { COLORTERM: 'truecolor' }), '256');
  assert.equal(artShow('truecolor', { TERM: 'xterm' }), 'truecolor');
  assert.equal(artShow('off', { COLORTERM: 'truecolor' }), 'off');
  assert.equal(artShow('image', { TMUX, TERM: 'tmux-256color' }), 'image');
});

/** A terminal on the far end of SSH: records what is written, replies with `answer` (if any) to the query. */
function sshTerminal(answer?: string) {
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    modes: [] as boolean[],
    setRawMode(raw: boolean) {
      input.isRaw = raw;
      input.modes.push(raw);
    },
  });
  const written: string[] = [];
  const output = {
    write(data: string) {
      written.push(data);
      if (answer !== undefined) setImmediate(() => input.write(answer));
    },
  };
  return { input, output, written };
}

test('over SSH one Kitty graphics query decides the image tier: OK yes, DA1 alone or silence no', async () => {
  const kitty = sshTerminal('\x1b_Gi=31;OK\x1b\\\x1b[?62;22;52c');
  assert.equal(await queryKittyGraphics(kitty.input, kitty.output), true);
  assert.deepEqual(kitty.written, ['\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c']);
  assert.deepEqual(kitty.input.modes, [true, false], 'raw mode is restored');

  const other = sshTerminal('\x1b[?1;2c');
  assert.equal(await queryKittyGraphics(other.input, other.output), false);
  const silent = sshTerminal(),
    start = performance.now();
  assert.equal(await queryKittyGraphics(silent.input, silent.output, 50), false);
  assert.ok(performance.now() - start < 500);
});

test('a Kitty OK and the DA1 that follows it in a later chunk are both consumed by the query, not left for the interface', async () => {
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    setRawMode(raw: boolean) {
      input.isRaw = raw;
    },
  });
  const output = {
    write() {
      setImmediate(() => {
        input.write('\x1b_Gi=31;OK\x1b\\');
        setTimeout(() => input.write('\x1b[?62;22;52c'), 20);
      });
    },
  };
  assert.equal(await queryKittyGraphics(input, output), true);
  assert.equal(input.read(), null, 'DA1 must not be left in the input stream');
});

test('Kitty graphics are queried for SSH and Konsole outside multiplexers, and the image setting forces them', async () => {
  const cases: [string, Record<string, string>, boolean, boolean][] = [
    // mode, env, the terminal's answer, asked
    ['auto', { SSH_TTY: '/dev/pts/1', TERM: 'xterm-256color' }, true, true],
    ['auto', { SSH_CONNECTION: '10.0.0.2 5 10.0.0.1 22', TERM: 'xterm-256color' }, false, true],
    ['auto', { KONSOLE_VERSION: '211203' }, false, true],
    ['auto', { KONSOLE_VERSION: '260401' }, true, true],
    ['auto', { TERM: 'xterm-256color' }, true, false],
    ['auto', { SSH_TTY: '/dev/pts/1', TMUX: '/tmp/tmux-1/default,1,0' }, true, false],
    ['auto', { SSH_TTY: '/dev/pts/1', STY: '1.pts-0.host' }, true, false],
    ['auto', { SSH_TTY: '/dev/pts/1', NO_COLOR: '1' }, true, false],
    ['truecolor', { SSH_TTY: '/dev/pts/1' }, true, false],
    ['image', { TMUX: '/tmp/tmux-1/default,1,0' }, false, false],
  ];
  try {
    for (const [mode, env, answer, asked] of cases) {
      setCapabilities({ images: null, trueColor: true, hyperlinks: false });
      let queried = false;
      await settleKittyGraphics(mode as 'auto', env, async () => {
        queried = true;
        return answer;
      });
      const label = `${mode} ${JSON.stringify(env)}`;
      assert.equal(queried, asked, label);
      assert.equal(getCapabilities().images, mode === 'image' || (asked && answer) ? 'kitty' : null, label);
    }
  } finally {
    resetCapabilitiesCache();
  }
});

test('the image tier places the real picture with Kitty graphics and uses a plain title until it can', async () => {
  const art = new StartupArt(() => 0.3); // 28 Kyoto
  try {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false });
    assert.deepEqual(art.block(160, 40, 'image', (t) => t), art.block(160, 40, 'title', (t) => t));
    await art.loadImage();
    const lines = art.block(160, 40, 'image', (t) => t);
    const sequence = lines[0]!.trimStart(),
      pad = lines[0]!.length - sequence.length;
    const controls = /^\x1b_G([^;]*);/.exec(sequence)![1]!.split(',');
    assert.ok(controls.includes('a=T') && controls.includes('f=100') && controls.includes('C=1'), controls.join(','));
    const cols = Number(controls.find((c) => c.startsWith('c='))!.slice(2)),
      rows = Number(controls.find((c) => c.startsWith('r='))!.slice(2));
    assert.ok(cols >= 60 && cols <= 158 && rows <= 40, `${cols}x${rows}`);
    assert.equal(pad, Math.floor((160 - cols) / 2));
    assert.equal(lines.length, rows + 3);
    assert.ok(lines.slice(1, rows).every((line) => line.trim() === ''));
    assert.equal(lines[rows + 1]!.trim(), '28 / Kyoto after rain');
    assert.ok(
      Buffer.from(sequence.match(/;([A-Za-z0-9+/=]{16})/)![1]!, 'base64')
        .subarray(1, 4)
        .toString() === 'PNG',
    );
    assert.deepEqual(
      art.block(61, 40, 'image', (t) => t),
      [],
    );

    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    assert.deepEqual(art.block(160, 40, 'image', (t) => t), art.block(160, 40, 'title', (t) => t));
  } finally {
    resetCapabilitiesCache();
  }
});

// Best of three: the suite runs files in parallel, and one slow run measures the machine, not the renderer.
test('a 200x60 picture renders in under 150 ms in both tiers', () => {
  for (const tier of ['truecolor', '256'] as const) {
    const ms = Math.min(
      ...[0, 1, 2].map(() => {
        const start = performance.now();
        renderArt(kyoto, 200, 60, tier);
        return performance.now() - start;
      }),
    );
    assert.ok(ms < 150, `${tier} took ${ms.toFixed(1)} ms`);
  }
});
