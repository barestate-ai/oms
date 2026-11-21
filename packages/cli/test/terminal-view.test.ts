import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CURSOR_MARKER, setKittyProtocolActive, visibleWidth } from '@earendil-works/pi-tui';
import { TerminalView, MAX_PENDING_VT_BYTES, MAX_TERMINAL_INPUT_BYTES } from '../src/tui/terminal-view.ts';

const plain = (lines: string[]) =>
  lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').replaceAll(CURSOR_MARKER, ''));
function screen(columns = 20, rows = 4) {
  const input: string[] = [];
  const sizes: Array<[number, number]> = [];
  let frames = 0;
  const view = new TerminalView({
    columns,
    rows,
    requestRender: () => frames++,
    input: (data) => input.push(data),
    resize: (c, r) => sizes.push([c, r]),
  });
  return { view, input, sizes, frames: () => frames };
}

test('VT parser applies carriage overwrite, cursor positioning and erase instead of forwarding controls', async () => {
  const { view } = screen();
  try {
    await view.write(Buffer.from('long line\rOK\x1b[K\r\nsecond\x1b[1;4H!'));
    assert.deepEqual(
      plain(view.render(20))
        .slice(0, 2)
        .map((s) => s.trimEnd()),
      ['OK !', 'second'],
    );
    assert.ok(!view.render(20).join('').includes('\x1b[K'));
  } finally {
    view.dispose();
  }
});

test('alternate screen restores the normal buffer and Unicode survives split UTF-8 writes', async () => {
  const { view } = screen();
  try {
    const data = Buffer.from('界é🙂');
    await view.write(data.subarray(0, 2));
    await view.write(data.subarray(2));
    assert.ok(plain(view.render(20)).join('').includes('界é🙂'));
    await view.write(Buffer.from('\x1b[?1049h\x1b[Hfull screen'));
    assert.ok(plain(view.render(20))[0]!.startsWith('full screen'));
    await view.write(Buffer.from('\x1b[?1049l'));
    assert.ok(plain(view.render(20))[0]!.startsWith('界é🙂'));
  } finally {
    view.dispose();
  }
});

test('parsed Unicode cells fit the outer viewport without clipping CJK, emoji, combining or ZWJ text', async () => {
  for (const text of ['界é🙂', 'e\u0301', '👩‍💻', '👨‍👩‍👧‍👦', '❤️', '🇮🇳']) {
    const { view } = screen(20, 4);
    try {
      await view.write(Buffer.from(text));
      const rows = plain(view.render(20));
      assert.ok(rows[0]!.startsWith(text), `Unicode content changed: ${JSON.stringify(text)}`);
      for (const row of rows)
        assert.ok(visibleWidth(row) <= 20, `outer width=${visibleWidth(row)} exceeds 20 for ${JSON.stringify(text)}`);
    } finally {
      view.dispose();
    }
  }
});

test('Unicode graphemes at the right edge wrap the following character without losing either', async () => {
  for (const grapheme of ['界', '🙂', 'e\u0301', '👩‍💻', '👨‍👩‍👧‍👦', '❤️', '🇮🇳']) {
    const columns = 8;
    const prefix = 'x'.repeat(columns - visibleWidth(grapheme));
    const { view } = screen(columns, 4);
    try {
      await view.write(Buffer.from(`${prefix}${grapheme}Z`));
      const rows = plain(view.render(columns));
      assert.equal(
        rows[0]!.trimEnd(),
        `${prefix}${grapheme}`,
        `right-edge grapheme changed: ${JSON.stringify(grapheme)}`,
      );
      assert.ok(
        rows[1]!.startsWith('Z'),
        `following character did not wrap for ${JSON.stringify(grapheme)}: ${JSON.stringify(rows)}`,
      );
      for (const row of rows) assert.ok(visibleWidth(row) <= columns, `overflow after ${JSON.stringify(grapheme)}`);
    } finally {
      view.dispose();
    }
  }
});

test('untrusted OSC clipboard, hyperlink, title and APC never reach the outer terminal', async () => {
  const { view } = screen();
  try {
    await view.write(
      Buffer.from(
        '\x1b]52;c;c2VjcmV0\x07\x1b]0;bad-title\x07\x1b]8;;https://bad.invalid\x1b\\safe\x1b]8;;\x1b\\\x1b_bad-apc\x07\x1b[38;2;1;2;3m!',
      ),
    );
    const output = view.render(20).join('');
    assert.ok(plain([output])[0]!.includes('safe!'));
    assert.ok(!/bad|https|c2VjcmV0|\x1b\]/.test(output));
    assert.match(output, /\x1b\[38;2;1;2;3m/);
  } finally {
    view.dispose();
  }
});

test('cursor marker reflects parsed cursor only while focused', async () => {
  const { view } = screen();
  try {
    await view.write(Buffer.from('abc\x1b[2D'));
    assert.ok(!view.render(20).join('').includes(CURSOR_MARKER));
    view.focused = true;
    assert.equal(plain(view.render(20))[0]!.slice(0, 3), 'abc');
    assert.match(view.render(20)[0]!, new RegExp(`a${CURSOR_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}b`));
  } finally {
    view.dispose();
  }
});

test('cursor visibility follows DECSTR and RIS resets without swallowing their normal effects', async () => {
  const { view } = screen();
  view.focused = true;
  try {
    for (const reset of ['\x1b[!p', '\x1bc']) {
      await view.write(Buffer.from('old\x1b[?25l\x1b[31m'));
      assert.ok(!view.render(20).join('').includes(CURSOR_MARKER), 'DECTCEM hides the cursor');
      await view.write(Buffer.from(`${reset}X`));
      const rows = view.render(20);
      assert.ok(rows.join('').includes(CURSOR_MARKER), `${JSON.stringify(reset)} restores cursor visibility`);
      assert.ok(!rows.join('').includes('\x1b[38;5;1m'), 'reset still clears the child rendition');
      if (reset === '\x1bc') assert.equal(plain(rows)[0]!.trimEnd(), 'X', 'RIS still clears the screen');
    }
  } finally {
    view.dispose();
  }
});

test('initial allocated viewport reaches the child after render-then-layout without input or output', () => {
  const { view, sizes, frames } = screen(20, 4);
  try {
    let layoutRequests = 0;
    let renderedRequests = frames();
    for (let pass = 0; pass < 4; pass++) {
      const content = view.render(20);
      view.view.updateLayout(content.length, 7, () => layoutRequests++);
      if (frames() + layoutRequests === renderedRequests) break;
      renderedRequests = frames() + layoutRequests;
    }
    assert.deepEqual(sizes.at(-1), [20, 7]);
    assert.equal(view.render(20).length, 7);
  } finally {
    view.dispose();
  }
});

test('silent height-only allocation updates child rows after render-then-layout without unrelated events', () => {
  const { view, sizes, frames } = screen(20, 4);
  try {
    let layoutRequests = 0;
    view.view.updateLayout(view.render(20).length, 4, () => layoutRequests++);
    let renderedRequests = frames() + layoutRequests;
    for (let pass = 0; pass < 4; pass++) {
      const content = view.render(20);
      view.view.updateLayout(content.length, 2, () => layoutRequests++);
      if (frames() + layoutRequests === renderedRequests) break;
      renderedRequests = frames() + layoutRequests;
    }
    assert.deepEqual(sizes.at(-1), [20, 2]);
    assert.equal(view.render(20).length, 2);
  } finally {
    view.dispose();
  }
});

test('Kitty outer input is decoded to legacy child bytes and respects child application cursor/paste modes', async () => {
  const { view, input } = screen();
  setKittyProtocolActive(true);
  try {
    view.handleInput('\x1b[99;5u');
    view.handleInput('\x1b[233u');
    view.handleInput('\x1b[1;1A');
    await view.write(Buffer.from('\x1b[?1h\x1b[?2004h'));
    view.handleInput('\x1b[A');
    view.handleInput('\x1b[200~a\nb\x1b[201~');
    assert.deepEqual(input, ['\x03', 'é', '\x1b[A', '\x1bOA', '\x1b[200~a\nb\x1b[201~']);
    view.handleInput('\x1b[63743u');
    view.handleInput('\x1b[57352u');
    assert.equal(input.length, 5, 'unknown Kitty functional keys must not pass through');
    view.handleInput('x\x1b[99;5u\x1b[233u');
    assert.deepEqual(input.slice(5), ['x', '\x03', 'é']);
  } finally {
    setKittyProtocolActive(false);
    view.dispose();
  }
});

test('legacy C0 and DEL input keeps its exact bytes, especially US rather than command-submitting CR', () => {
  const { view, input } = screen();
  setKittyProtocolActive(true);
  try {
    const controls = [...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)), '\x7f'];
    for (const control of controls) view.handleInput(control);
    assert.deepEqual(Buffer.concat(input.map((value) => Buffer.from(value))), Buffer.from(controls.join('')));
    assert.equal(input[31], '\x1f', 'Ctrl+_ must not become Enter');
  } finally {
    setKittyProtocolActive(false);
    view.dispose();
  }
});

test('enhanced control punctuation maps explicitly while unsupported and functional Kitty keys stay refused', () => {
  const { view, input } = screen();
  setKittyProtocolActive(true);
  try {
    for (const code of [64, 91, 92, 93, 94, 95, 45, 63]) view.handleInput(`\x1b[${code};5u`);
    assert.deepEqual(input, ['\x00', '\x1b', '\x1c', '\x1d', '\x1e', '\x1f', '\x1f', '\x7f']);
    for (const key of ['\x1b[49;5u', '\x1b[33;5u', '\x1b[57352;5u', '\x1b[63743;5u']) view.handleInput(key);
    assert.equal(input.length, 8, 'unsupported control combinations cannot be masked into unrelated bytes');
  } finally {
    setKittyProtocolActive(false);
    view.dispose();
  }
});

test('split UTF-16 input is encoded as complete Unicode scalars before reaching the child', () => {
  const { view, input } = screen();
  try {
    const text = '界🌱👩‍💻';
    for (const unit of text.split('')) view.handleInput(unit);
    assert.deepEqual(Buffer.concat(input.map((value) => Buffer.from(value))), Buffer.from(text));
    input.length = 0;
    view.handleInput('\ud83c');
    view.stopInput();
    view.handleInput('\udf31');
    assert.deepEqual(input, [], 'closing cannot emit an incomplete or newly completed character');
  } finally {
    view.dispose();
  }
});

test('pending parser writes and input are bounded; disposal refuses later work', async () => {
  const { view, input, frames } = screen();
  const first = view.write(Buffer.from('a'.repeat(4096)));
  const second = view.write(Buffer.from('b'.repeat(4096)));
  await assert.rejects(view.write(Buffer.alloc(MAX_PENDING_VT_BYTES + 1)), /pending|limit|large/i);
  view.handleInput('x'.repeat(MAX_TERMINAL_INPUT_BYTES + 1));
  assert.equal(input.length, 0);
  await Promise.all([first, second]);
  await view.flush();
  assert.ok(frames() <= 2, 'parser completion must coalesce frame work');
  view.dispose();
  await assert.rejects(view.write(Buffer.from('later')), /closed|disposed/i);
  view.handleInput('later');
  assert.equal(input.length, 0);
});

test('a disposed view in the layout stops asking for frames', async () => {
  const { view } = screen(40, 10);
  await view.write(Buffer.from(Array.from({ length: 100 }, (_, i) => `l${i}\r\n`).join('')));
  await view.flush();
  view.render(40);
  view.view.updateLayout(view.render(40).length, 10, () => {});
  view.dispose();
  let requests = 0;
  view.view.updateLayout(view.render(40).length, 10, () => requests++);
  view.view.updateLayout(view.render(40).length, 10, () => requests++);
  assert.equal(requests, 0);
});

test('a viewport that grows past the overdraw is drawn in the same frame', async () => {
  const { view } = screen(20, 4);
  try {
    await view.write(Buffer.from(Array.from({ length: 200 }, (_, i) => `l${i}\r\n`).join('')));
    await view.flush();
    view.view.updateLayout(view.render(20).length, 4, () => {});
    view.view.updateLayout(view.render(20).length, 4, () => {});
    const lines = plain(view.render(20));
    view.view.updateLayout(lines.length, 30, () => {});
    const shown = lines.slice(view.view.scrollTop, view.view.scrollTop + 30);
    assert.equal(shown.filter((line) => !line.trim()).length, 1, 'only the empty line after the last newline');
  } finally {
    view.dispose();
  }
});
