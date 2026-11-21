import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { dispatchMouseEvent } from '@earendil-works/pi-tui/dist/tui.js';
import { getLayoutBoxesAt, renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import { Explorer, sortEntries, type ChangeMarker, type SidebarSection } from '../src/tui/explorer.ts';
import { getTheme } from '../src/tui/theme.ts';
import { barrier } from '../test-support/interface-terminal.ts';

const theme = getTheme('gruvbox')!;
interface Fixture {
  explorer: Explorer;
  opened: Array<[string, boolean]>;
  created: string[];
  asked: string[];
  listed: string[];
  marks: Map<string, ChangeMarker>;
  touched: Set<string>;
  sections: Array<SidebarSection | undefined>;
  tree: Map<string, Array<{ path: string; kind: 'file' | 'directory' }>>;
  left: string[];
}
function fixture(files: Record<string, string[]> = {}): Fixture {
  const tree = new Map<string, Array<{ path: string; kind: 'file' | 'directory' }>>();
  const defaults: Record<string, string[]> = {
    '.': ['programs/', 'tests/', 'Anchor.toml', 'target/'],
    programs: ['programs/vault/'],
    'programs/vault': ['programs/vault/lib.rs', 'programs/vault/Cargo.toml'],
    ...files,
  };
  for (const [directory, entries] of Object.entries(defaults))
    tree.set(
      directory,
      entries.map((entry) => ({ path: entry.replace(/\/$/, ''), kind: entry.endsWith('/') ? 'directory' : 'file' })),
    );
  const state: Fixture = {
    opened: [],
    created: [],
    asked: [],
    listed: [],
    marks: new Map(),
    touched: new Set(),
    sections: [],
    tree,
    left: [],
  } as unknown as Fixture;
  state.explorer = new Explorer({
    theme: () => theme,
    render() {},
    files: {
      async list(path = '.') {
        state.listed.push(path);
        const entries = tree.get(path);
        if (!entries) throw new Error(`ENOENT: no such file or directory, scandir '/host/${path}'`);
        return entries;
      },
    },
    open: (path, focusEditor) => state.opened.push([path, focusEditor]),
    openFiles: () => [],
    marks: () => state.marks,
    touched: () => state.touched,
    sections: () => state.sections,
    newFile: (directory) => state.created.push(directory),
    ask: (path) => state.asked.push(path),
    requestFocus() {},
    leave: () => state.left.push('left'),
  });
  state.explorer.focus.focused = true;
  return state;
}
const screen = (f: Fixture, width = 30, height = 20) =>
  renderLayoutFrame(f.explorer.body, width, height, () => {}).lines.map((line) => stripTerminalSequences(line));
const press = (f: Fixture, ...keys: string[]) => keys.forEach((key) => f.explorer.focus.handleInput!(key));
const settle = () => setImmediate();

test('folders come first, in natural order', () => {
  assert.deepEqual(
    sortEntries([
      { path: 'file10', kind: 'file' },
      { path: 'file2', kind: 'file' },
      { path: 'zdir', kind: 'directory' },
      { path: 'Adir', kind: 'directory' },
    ]).map((entry) => entry.path),
    ['Adir', 'zdir', 'file2', 'file10'],
  );
});

test('the tree starts at the project root and expands a folder lazily with the keyboard', async () => {
  const f = fixture();
  screen(f);
  await settle();
  const first = screen(f);
  assert.match(first[0]!, /^▾ files\s+Ctrl\+P find/);
  assert.match(first.join('\n'), /▸ programs/);
  assert.match(first.join('\n'), /Anchor\.toml/);
  assert.deepEqual(f.listed, ['.']);
  press(f, '\x1b[B', '\x1b[C');
  await settle();
  assert.deepEqual(f.listed, ['.', 'programs']);
  assert.match(screen(f).join('\n'), /▾ programs *\n *▸ vault/);
  press(f, '\x1b[D');
  assert.doesNotMatch(screen(f).join('\n'), /▸ vault/);
  assert.deepEqual(f.listed, ['.', 'programs'], 'collapsing lists nothing');
});

test('Enter opens a file and takes the editor; Space previews it and keeps the explorer', async () => {
  const f = fixture();
  screen(f);
  await settle();
  screen(f);
  press(f, '\x1b[F');
  press(f, '\r');
  assert.deepEqual(f.opened, [['Anchor.toml', true]]);
  press(f, ' ');
  assert.deepEqual(f.opened.at(-1), ['Anchor.toml', false]);
});

test('Left goes to the parent folder; n creates in the folder of the selection; a asks about a file; Esc leaves', async () => {
  const f = fixture();
  screen(f);
  await settle();
  screen(f);
  press(f, '\x1b[B', '\x1b[C');
  await settle();
  screen(f);
  press(f, '\x1b[B', '\x1b[C');
  await settle();
  screen(f);
  press(f, '\x1b[B', '\x1b[B');
  assert.match(screen(f).join('\n'), /lib\.rs/);
  press(f, 'n');
  assert.deepEqual(f.created, ['programs/vault']);
  press(f, 'a');
  assert.deepEqual(f.asked, ['programs/vault/lib.rs']);
  press(f, '\x1b[D');
  press(f, 'n');
  assert.deepEqual(f.created.at(-1), 'programs/vault');
  press(f, '\x1b');
  assert.deepEqual(f.left, ['left']);
});

test('change and agent markers sit at the right; folders with changes get a dot', async () => {
  const f = fixture();
  f.marks.set('Anchor.toml', 'M');
  f.marks.set('programs/vault/lib.rs', 'A');
  f.touched.add('Anchor.toml');
  screen(f);
  await settle();
  screen(f);
  press(f, '\x1b[B', '\x1b[C');
  await settle();
  const shown = screen(f, 30);
  assert.match(
    shown.find((line) => line.includes('Anchor.toml'))!,
    /Anchor\.toml\s+● M $/,
  );
  assert.match(
    shown.find((line) => line.includes('programs'))!,
    /programs\s+● $/,
  );
  assert.ok(shown.every((line) => visibleWidth(line) <= 30));
});

test('the selected row is a filled bar, bright with focus and quiet without it', async () => {
  const f = fixture();
  screen(f);
  await settle();
  const painted = (focused: boolean) => {
    f.explorer.focus.focused = focused;
    return renderLayoutFrame(f.explorer.body, 24, 6, () => {}).lines[0]!;
  };
  assert.ok(painted(true).includes(`\x1b[${theme.sgr.bg.selection}m`));
  assert.ok(painted(false).includes(`\x1b[${theme.sgr.bg.surface}m`));
  assert.ok(!painted(false).includes(`\x1b[${theme.sgr.bg.selection}m`));
});

test('a stale listing is dropped, a failure shows a note and the 512-entry limit says what to do', async () => {
  const f = fixture();
  screen(f);
  await settle();
  const gate = barrier<void>();
  const slow = [{ path: 'old-entry', kind: 'file' as const }];
  const list = (f.explorer as unknown as { options: { files: { list: (p?: string) => Promise<unknown[]> } } }).options
    .files;
  const first = list.list;
  let calls = 0;
  list.list = async (path) => {
    if (++calls === 1) {
      await gate.promise;
      return slow;
    }
    return first(path);
  };
  const stale = f.explorer.load('.', true);
  const fresh = f.explorer.load('.', true);
  await fresh;
  gate.resolve();
  await stale;
  assert.doesNotMatch(screen(f).join('\n'), /old-entry/);
  assert.match(screen(f).join('\n'), /Anchor\.toml/);
  list.list = async () => {
    throw new Error('Directory exceeds the 512-entry listing limit; open a file by path');
  };
  await f.explorer.load('.', true);
  assert.match(screen(f, 50).join('\n'), /too many entries · Ctrl\+P opens by name/);
  list.list = async () => {
    throw new Error("ENOENT: no such file or directory, scandir '/Users/me/secret'");
  };
  await f.explorer.load('.', true);
  assert.doesNotMatch(screen(f).join('\n'), /Users|ENOENT/);
});

test('reveal expands every folder above a path and selects it', async () => {
  const f = fixture();
  screen(f);
  await settle();
  await f.explorer.reveal('programs/vault/lib.rs');
  const shown = screen(f).join('\n');
  assert.match(shown, /▾ programs/);
  assert.match(shown, /▾ vault/);
  assert.match(shown, /lib\.rs/);
  press(f, '\r');
  assert.deepEqual(f.opened.at(-1), ['programs/vault/lib.rs', true]);
});

test('sections from a provider appear below files, can be collapsed, and run their action', async () => {
  const f = fixture();
  const ran: string[] = [];
  f.sections = [
    undefined,
    {
      id: 'solana',
      title: 'solana',
      badge: 'localnet',
      items: [
        { id: 'build', label: 'Build', onActivate: () => ran.push('build') },
        { id: 'chain', label: 'chain', detail: 'slot 12', detailRole: 'success' },
      ],
    },
    { id: 'empty', title: 'nothing', items: [] },
  ];
  await settle();
  const shown = screen(f).join('\n');
  assert.match(shown, /▾ solana\s+localnet/);
  assert.match(shown, /chain\s+slot 12/);
  assert.doesNotMatch(shown, /nothing/);
  press(f, '\x1b[F', '\x1b[A', '\r');
  assert.deepEqual(ran, ['build']);
  press(f, '\x1b[A', '\r');
  assert.doesNotMatch(screen(f).join('\n'), /Build/);
});

test('clicking a file opens it and clicking a folder toggles it', async () => {
  const f = fixture();
  screen(f);
  await settle();
  const click = (row: number) => {
    const frame = renderLayoutFrame(f.explorer.body, 30, 12, () => {});
    for (const type of ['press', 'release', 'click'] as const) {
      const event: TuiMouseEvent = {
        type,
        button: 'left',
        x: 3,
        y: row,
        screenX: 3,
        screenY: row,
        width: 30,
        height: 12,
        shift: false,
        alt: false,
        ctrl: false,
      };
      for (const box of getLayoutBoxesAt(frame, 3, row)) {
        const result = dispatchMouseEvent(box.component, {
          ...event,
          x: 3 - box.rect.x,
          y: row - box.rect.y,
          width: box.rect.width,
          height: box.rect.height,
        });
        if (result) break;
      }
    }
  };
  click(1);
  await settle();
  assert.match(screen(f).join('\n'), /▾ programs/);
  const row = screen(f).findIndex((line) => line.includes('Anchor.toml'));
  click(row);
  assert.deepEqual(f.opened, [['Anchor.toml', true]]);
});
