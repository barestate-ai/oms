import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import {
  CURSOR_MARKER,
  HStack,
  ScrollView,
  TuiAltScreen,
  stripTerminalSequences,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui';
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import type { OmsSession, TaskTerminal } from '@oms/engine';
import type { SandboxResult } from '@oms/sandbox';
import { runOmsInterface } from '../src/tui/interface.ts';
import { PaneFrame } from '../src/tui/chrome.ts';
import { createFileEditorPane, type FileEditorPane } from '../src/tui/file-editor.ts';
import { TerminalView } from '../src/tui/terminal-view.ts';
import { getTheme } from '../src/tui/theme.ts';
import { barrier, InterfaceTerminal } from '../test-support/interface-terminal.ts';

Object.assign(process.env, { COLORTERM: 'truecolor', TERM: 'xterm-256color' });
delete process.env.NO_COLOR;
delete process.env.TMUX;

const theme = () => getTheme('gruvbox')!;
const plain = (line: string) => stripTerminalSequences(line.replaceAll(CURSOR_MARKER, ''));

function counted(rows: number) {
  const widths: number[] = [];
  const component: Component = {
    invalidate() {},
    render(width) {
      widths.push(width);
      return Array.from({ length: rows }, (_, row) => `row ${row}`);
    },
  };
  return { component, widths };
}

test('a framed pane inside a row layout draws its content once per frame', () => {
  const content = counted(5000);
  const frame = new PaneFrame(new ScrollView(content.component), {
    theme,
    title: () => 'Pane',
    focused: () => false,
    rows: () => 24,
  });
  const root = new HStack([{ component: frame, basis: 0, grow: 1, minSize: 1 }]);
  const screen = renderLayoutFrame(root, 40, 24, () => {}).lines.map(plain);
  assert.deepEqual(content.widths, [38], 'measuring the frame must not draw the transcript or file again');
  assert.equal(screen[0], '╭ Pane ' + '─'.repeat(32) + '╮');
  for (let row = 1; row < 23; row++) assert.equal(screen[row], `│row ${row - 1}`.padEnd(39) + '│');
  assert.equal(screen[23], '╰' + '─'.repeat(38) + '╯');
});

function layout(pane: FileEditorPane, width: number, height: number): string[] {
  pane.view.updateLayout(pane.focus.render(width).length, height, () => {});
  return pane.focus.render(width);
}

test('the editor draws only the rows around its viewport and the cursor', () => {
  const text = Array.from({ length: 3000 }, (_, n) => `line ${n}`).join('\n');
  const pane = createFileEditorPane(text, () => {}, { lineNumbers: true });
  pane.focus.focused = true;
  let lines = layout(pane, 30, 10);
  assert.equal(lines.length, 3000, 'content height stays the line count');
  // The drawn window reaches one host-terminal height (64 rows without a TTY) past the viewport, so a resize never
  // shows undrawn rows.
  assert.ok(lines.filter(Boolean).length <= 10 + 2 * 64, 'rows far from the viewport are not drawn');
  assert.equal(plain(lines[0]!), '   1 │line 0');
  assert.equal(lines[2999], '');
  pane.focus.handleInput!('\x1b[1;5F');
  lines = layout(pane, 30, 10);
  assert.ok(pane.view.scrollTop > 2980);
  assert.equal(plain(lines[2999]!), '3000 │line 2999 ', 'the end-of-line cursor cell');
  assert.equal(lines[0], '');
  assert.equal(lines.filter((line) => line.includes(CURSOR_MARKER)).length, 1);
  assert.ok(lines.every((line) => visibleWidth(line) <= 30));
  pane.view.scrollTo(1500);
  lines = pane.focus.render(30);
  for (let row = 1500; row < 1510; row++)
    assert.equal(plain(lines[row]!), `${String(row + 1).padStart(4)} │line ${row}`);
});

test('an editor whose viewport outgrows the drawn rows asks for one more frame', () => {
  const pane = createFileEditorPane(Array.from({ length: 3000 }, (_, n) => `line ${n}`).join('\n'), () => {});
  let requests = 0;
  pane.view.updateLayout(pane.focus.render(30).length, 5, () => requests++);
  pane.focus.render(30);
  requests = 0;
  pane.view.updateLayout(3000, 200, () => requests++);
  assert.equal(requests, 1);
  const lines = pane.focus.render(30);
  for (let row = 0; row < 200; row++) assert.equal(plain(lines[row]!), `line ${row}`);
});

test('the terminal view reuses its rows until new output arrives', async () => {
  const view = new TerminalView({ columns: 40, rows: 5, requestRender() {}, input() {}, resize() {} });
  try {
    view.view.updateLayout(0, 5, () => {});
    await view.write(Buffer.from('one\r\ntwo\r\n'));
    const first = view.render(40);
    assert.equal(view.render(40), first, 'an unchanged terminal returns the same rows');
    await view.write(Buffer.from('three'));
    const next = view.render(40);
    assert.notEqual(next, first);
    assert.deepEqual(
      next.slice(0, 3).map((line) => plain(line).trimEnd()),
      ['one', 'two', 'three'],
    );
    view.focused = true;
    assert.ok(
      view.render(40).some((line) => line.includes(CURSOR_MARKER)),
      'focus redraws the cursor',
    );
  } finally {
    await view.flush();
    view.dispose();
  }
});

/** A chat or task session with no provider: counts model-list reads and records the shutdown order. */
function fakeSession(kind: 'chat' | 'task') {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const order: string[] = [];
  let listModels = 0;
  const exit = barrier<SandboxResult>();
  const terminal: TaskTerminal = {
    write() {},
    resize() {},
    subscribe: () => () => {},
    exited: exit.promise,
    async close() {
      order.push('terminal closed');
      exit.resolve({ exitCode: 130, stdout: '', stderr: '', cancelled: true, timedOut: false, truncated: false });
      await exit.promise;
    },
  };
  const harness = {
    kind,
    root: '/fixtures/demo',
    folder: { path: '/fixtures/demo', requested: '/fixtures/demo', key: 'k', scratch: false },
    yolo: { enabled: () => false, set() {} },
    helpers: { messages: () => [] },
    workspace: { root: '/fixtures/demo' },
    task: { id: 'demo', codeRoot: '/fixtures/demo', branch: 'oms/demo' },
    evaluator: { read: () => ({ ok: true, value: { items: [] } }) },
    session: {
      messages: [],
      model: { id: 'test-model', provider: 'local' },
      isStreaming: false,
      sessionManager: { getSessionId: () => 'session-fixture' },
      agent: { reset() {} },
      subscribe(listener: (event: AgentSessionEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {},
      async abort() {},
    },
    listModels() {
      listModels++;
      return [{ provider: 'local', id: 'test-model', name: 'Local model', configured: true }];
    },
    listProviders: () => [],
    budget: {
      receipts: () => [],
      reservations: () => [],
      snapshot: () => ({
        caps: { tokens: 9000, spendMicroUsd: 3000000, wallClockMs: 120000 },
        used: { tokens: 0, spendMicroUsd: 0, wallClockMs: 0 },
        remaining: { tokens: 9000, spendMicroUsd: 3000000, wallClockMs: 120000 },
        accounting: 'known',
        exhausted: false,
        executionMode: 'interactive',
      }),
    },
    files: { list: async () => [], read: async () => ({ bytes: Buffer.from(''), revision: 'r' }) },
    startTerminal: async () => terminal,
    async close() {
      order.push('session closed');
    },
  } as unknown as OmsSession;
  return {
    harness,
    order,
    listModels: () => listModels,
    emit(event: unknown) {
      for (const listener of listeners) listener(event as AgentSessionEvent);
    },
  };
}

/** Count drawn frames; restore the renderer afterwards. */
function countFrames() {
  const original = TuiAltScreen.prototype['doRender' as keyof TuiAltScreen] as unknown as () => void;
  const counter = { frames: 0, restore() {} };
  Object.assign(TuiAltScreen.prototype, {
    doRender(this: TuiAltScreen) {
      counter.frames++;
      original.call(this);
    },
  });
  counter.restore = () => Object.assign(TuiAltScreen.prototype, { doRender: original });
  return counter;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

for (const kind of ['chat', 'task'] as const) {
  test(`a ${kind} frame reads the model list at most once`, async () => {
    const f = fakeSession(kind);
    const frames = countFrames();
    const terminal = new InterfaceTerminal(100, 30);
    const run = runOmsInterface(f.harness, { terminal, startupArt: 'off' });
    try {
      await terminal.until((screen) => screen.includes('/ commands'));
      for (const key of 'hello') {
        terminal.send(key);
        await settle();
      }
      assert.ok(frames.frames > 0);
      assert.ok(f.listModels() <= frames.frames, `${f.listModels()} model-list reads in ${frames.frames} frames`);
    } finally {
      frames.restore();
      terminal.send('\x11');
      await run;
      terminal.vt.dispose();
    }
  });
}

test('an idle interface stops redrawing every second, and a running agent keeps the clock', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fakeSession('chat');
  const frames = countFrames();
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((screen) => screen.includes('/ commands'));
    await settle();
    const idle = frames.frames;
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(frames.frames, idle, 'nothing on screen changes with time while idle');
    f.emit({ type: 'agent_start' });
    await settle();
    const busy = frames.frames;
    t.mock.timers.tick(1000);
    await settle();
    assert.ok(frames.frames > busy, 'the clock ticks while work is running');
  } finally {
    frames.restore();
    f.emit({ type: 'agent_settled' });
    terminal.send('\x11');
    await run;
    terminal.vt.dispose();
  }
});

test('quitting with the workbench terminal running stops the shell before closing the session', async () => {
  const f = fakeSession('chat');
  const terminal = new InterfaceTerminal(100, 30);
  const run = runOmsInterface(f.harness, { terminal });
  try {
    await terminal.until((screen) => screen.includes('/ commands'));
    terminal.send('/terminal');
    terminal.send('\r');
    await terminal.until((screen) => screen.includes('■ stop'));
    terminal.send('\x0c');
    // A running shell is lost on quit: the first Ctrl+Q asks, the second stops the shell and quits.
    terminal.send('\x11');
    await terminal.until((screen) => screen.includes('Shell is running · ctrl+q again to stop it and quit'));
    assert.deepEqual(f.order, [], 'the first Ctrl+Q closed nothing');
    terminal.send('\x11');
    await run;
    assert.deepEqual(f.order, ['terminal closed', 'session closed']);
  } finally {
    terminal.send('\x11');
    await run;
    terminal.vt.dispose();
  }
});
