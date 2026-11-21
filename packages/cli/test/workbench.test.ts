import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { TaskFileAccess } from '@oms/engine';
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { dispatchMouseEvent } from '@earendil-works/pi-tui/dist/tui.js';
import { getLayoutBoxesAt, renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import { WorkbenchPane } from '../src/tui/workbench.ts';
import { getTheme } from '../src/tui/theme.ts';
import { barrier } from '../test-support/interface-terminal.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(initial: Record<string, string> = { 'a.ts': 'alpha\r\n界🌱', 'src/b.ts': 'beta' }, hostRows = 24) {
  const disk = new Map(Object.entries(initial));
  const notices: string[] = [];
  const files: TaskFileAccess = {
    async list(path = '.') {
      const prefix = path === '.' ? '' : path + '/';
      const entries = new Map<string, 'file' | 'directory'>();
      for (const key of disk.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const name = rest.split('/')[0]!;
        entries.set(prefix + name, rest.includes('/') ? 'directory' : 'file');
      }
      return [...entries].map(([path, kind]) => ({ path, kind })).sort((a, b) => a.path.localeCompare(b.path));
    },
    async read(path) {
      const text = disk.get(path);
      if (text === undefined) throw new Error('file not found');
      return { bytes: Buffer.from(text), revision: digest(text) };
    },
    async write(path, bytes, revision) {
      if (revision !== digest(disk.get(path)!)) throw new Error('file changed after the edit read');
      const text = Buffer.from(bytes).toString('utf8');
      disk.set(path, text);
      return digest(text);
    },
    async create(path, bytes) {
      if (disk.has(path)) throw new Error('file already exists');
      const text = Buffer.from(bytes).toString('utf8');
      disk.set(path, text);
      return digest(text);
    },
    async access() {},
    async makeDirectory() {},
  };
  const pane = new WorkbenchPane(
    { files },
    {
      theme: () => getTheme('gruvbox')!,
      render() {},
      notice: (message) => notices.push(message),
      focusChanged() {},
      rows: () => hostRows,
    },
  );
  pane.focus.focused = true;
  return { pane, files, disk, notices };
}
const rows = (pane: WorkbenchPane, width = 100) =>
  renderLayoutFrame(pane.body, width, 24, () => {})
    .lines.map((line) => stripTerminalSequences(line))
    .join('\n');

function click(
  pane: WorkbenchPane,
  text: string,
  options: { width?: number; height?: number; count?: number; occurrence?: number } = {},
): void {
  const width = options.width ?? 100;
  const height = options.height ?? 24;
  const frame = renderLayoutFrame(pane.body, width, height, () => {});
  let occurrence = options.occurrence ?? 0;
  for (let y = 0; y < frame.lines.length; y++) {
    const line = stripTerminalSequences(frame.lines[y]!);
    let from = 0;
    for (;;) {
      const index = line.indexOf(text, from);
      if (index < 0) break;
      from = index + text.length;
      if (occurrence-- > 0) continue;
      const x = visibleWidth(line.slice(0, index));
      for (const type of ['press', 'release', 'click'] as const) {
        const event: TuiMouseEvent = {
          type,
          button: 'left',
          x,
          y,
          screenX: x,
          screenY: y,
          width,
          height,
          shift: false,
          alt: false,
          ctrl: false,
          clickCount: options.count ?? 1,
        };
        for (const box of getLayoutBoxesAt(frame, x, y)) {
          const result = dispatchMouseEvent(box.component, {
            ...event,
            x: x - box.rect.x,
            y: y - box.rect.y,
            width: box.rect.width,
            height: box.rect.height,
          });
          if (!result) continue;
          if (result.focus) {
            const target = pane.resolveMouseFocus(result.focusTarget ?? result.target.component);
            if (target === pane.focus) pane.focus.focused = true;
          }
          break;
        }
      }
      return;
    }
  }
  assert.fail(`No visible text to click: ${text}`);
}

test('clickable buffer tabs preserve drafts and the close prompt stays bound to its target', async () => {
  const { pane, disk } = fixture();
  await pane.open('a.ts');
  pane.handleInput('draft');
  await pane.open('src/b.ts');
  click(pane, 'a.ts');
  assert.match(rows(pane), /draftalpha/);
  pane.closeBuffer();
  assert.match(rows(pane), /Save changes to a\.ts/);
  click(pane, 'b.ts');
  assert.match(rows(pane), /Save changes to a\.ts/);
  pane.handleInput('d');
  assert.equal(pane.dirty, false);
  assert.match(rows(pane), /beta/);
  await pane.save();
  assert.equal(disk.get('src/b.ts'), 'beta');
  await pane.open('a.ts');
  assert.doesNotMatch(rows(pane), /draftalpha/);
});

test('the welcome rows are clickable and a missing name is offered as a list', async () => {
  const picked: Array<[string, readonly string[]]> = [];
  const { files } = fixture();
  const opened: string[] = [];
  const pane = new WorkbenchPane(
    { files },
    {
      theme: () => getTheme('gruvbox')!,
      render() {},
      notice() {},
      focusChanged() {},
      pick: (query, matches) => picked.push([query, matches]),
      suggest: async (name) => (name === 'b.ts' ? ['src/b.ts'] : name === 'dup.ts' ? ['x/dup.ts', 'y/dup.ts'] : []),
      welcome: () => [{ label: 'Open a file', keys: 'Ctrl+P', run: () => opened.push('open') }],
    },
  );
  pane.focus.focused = true;
  assert.match(rows(pane), /No file open/);
  click(pane, 'Open a file');
  assert.deepEqual(opened, ['open']);
  await pane.open('b.ts');
  assert.match(rows(pane), /beta/);
  await pane.open('dup.ts');
  assert.deepEqual(picked, [['dup.ts', ['x/dup.ts', 'y/dup.ts']]]);
  await pane.open('nothing.ts');
  assert.match(pane.message!.text, /nothing\.ts doesn't exist/);
  assert.equal(pane.message!.kind, 'error');
});

test('pointer selects the active split and preserves editing Tab and slash keys', async () => {
  const { pane, disk } = fixture({ 'a.ts': 'alpha', 'b.ts': 'beta' });
  await pane.open('a.ts');
  pane.split();
  pane.handleInput('\x1c');
  await pane.open('b.ts');
  click(pane, 'alpha');
  pane.handleInput('\t');
  pane.handleInput('/');
  await pane.save();
  assert.equal(disk.get('a.ts'), '  /alpha');
  assert.equal(disk.get('b.ts'), 'beta');
});

test('save and close are inert with no buffer, and a second save while saving does nothing', async () => {
  const { pane, files, disk } = fixture();
  let writes = 0;
  const write = files.write;
  const gate = barrier<void>();
  files.write = async (...args) => {
    writes++;
    await gate.promise;
    return write(...args);
  };
  await pane.save();
  pane.closeBuffer();
  assert.equal(writes, 0);
  await pane.open('a.ts');
  pane.handleInput('X');
  const first = pane.save();
  void pane.save();
  pane.closeBuffer();
  assert.equal(writes, 1);
  assert.doesNotMatch(rows(pane), /Save changes to/);
  gate.resolve();
  await first;
  assert.equal(disk.get('a.ts'), 'Xalpha\r\n界🌱');
  assert.match(rows(pane), /Xalpha/);
});

test('compact empty and split editors keep useful content visible with Unicode tabs bounded', async () => {
  const { pane } = fixture({ '界🌱.ts': 'visible source', 'b.ts': 'second' }, 12);
  const compact = () => renderLayoutFrame(pane.body, 40, 6, () => {}).lines.map((line) => stripTerminalSequences(line));
  assert.match(compact().join('\n'), /No file open/);
  await pane.open('界🌱.ts');
  pane.split();
  assert.match(compact().join('\n'), /visible source/);
  assert.ok(compact().every((line) => visibleWidth(line) <= 40));
  await pane.open('b.ts');
  assert.match(compact().join('\n'), /second/);
  assert.ok(compact().every((line) => visibleWidth(line) <= 40));
});

test('explicit pointer split change invalidates a delayed file activation', async () => {
  const { pane, files, disk } = fixture({ 'a.ts': 'alpha', 'b.ts': 'beta', 'c.ts': 'charlie' });
  await pane.open('a.ts');
  pane.split();
  pane.handleInput('\x1c');
  await pane.open('b.ts');
  const gate = barrier<void>();
  const read = files.read;
  files.read = async (...args) => {
    if (args[0] === 'c.ts') await gate.promise;
    return read(...args);
  };
  const pending = pane.open('c.ts');
  click(pane, 'alpha');
  pane.handleInput('X');
  gate.resolve();
  await pending;
  assert.doesNotMatch(rows(pane), /charlie/);
  await pane.save();
  assert.equal(disk.get('a.ts'), 'Xalpha');
  assert.equal(disk.get('b.ts'), 'beta');
});

test('find modal blocks background pointer selection and tab mutations', async () => {
  const { pane, disk } = fixture({ 'a.ts': 'alpha', 'b.ts': 'beta' });
  await pane.open('b.ts');
  await pane.open('a.ts');
  pane.find();
  click(pane, 'pha');
  click(pane, 'b.ts');
  pane.newFile();
  pane.handleInput('\x1b');
  pane.handleInput('X');
  await pane.save();
  assert.equal(disk.get('a.ts'), 'Xalpha');
  assert.equal(disk.get('b.ts'), 'beta');
});

test('async activation rebuilds without issuing a pointer focus request', async () => {
  const { files } = fixture();
  let requests = 0;
  let rebuilds = 0;
  const pane = new WorkbenchPane(
    { files },
    {
      theme: () => getTheme('gruvbox')!,
      render() {},
      notice() {},
      focusChanged() {
        rebuilds++;
      },
      requestFocus() {
        requests++;
      },
    },
  );
  await pane.open('a.ts');
  assert.ok(rebuilds > 0);
  assert.equal(requests, 0);
  click(pane, 'alpha');
  assert.ok(requests > 0);
});

test('a clipped Unicode tab is still a target and never widens the row', async () => {
  const longName = '界'.repeat(30) + '.ts';
  const { pane, disk } = fixture({ 'a.ts': 'alpha', [longName]: 'other' });
  await pane.open('a.ts');
  await pane.open(longName);
  await pane.open('a.ts');
  click(pane, '界界界', { width: 40 });
  pane.handleInput('X');
  await pane.save();
  assert.equal(disk.get('a.ts'), 'alpha');
  assert.equal(disk.get(longName), 'Xother');
  assert.ok(renderLayoutFrame(pane.body, 40, 24, () => {}).lines.every((line) => visibleWidth(line) <= 40));
});

test('late reads cannot dismiss a pending dirty close confirmation', async () => {
  const { pane, files } = fixture({ 'a.ts': 'alpha', 'b.ts': 'beta' });
  await pane.open('a.ts');
  pane.handleInput('draft');
  const gate = barrier<void>();
  const read = files.read;
  files.read = async (...args) => {
    await gate.promise;
    return read(...args);
  };
  const pending = pane.open('b.ts');
  pane.closeBuffer();
  gate.resolve();
  await pending;
  assert.match(rows(pane), /Save changes to a\.ts/);
  assert.doesNotMatch(rows(pane), /beta/);
  pane.handleInput('d');
  assert.equal(pane.dirty, false);
  assert.match(rows(pane), /No file open/);
});

test('empty workbench does no IO; opening a file shows it and its position', async () => {
  const { pane, files } = fixture();
  let reads = 0;
  const read = files.read;
  files.read = async (...args) => {
    reads++;
    return read(...args);
  };
  assert.match(rows(pane), /Ctrl\+P/);
  assert.equal(reads, 0);
  await pane.open('src/b.ts');
  assert.match(rows(pane), /b\.ts/);
  assert.match(rows(pane), /beta/);
  assert.deepEqual(pane.active && { line: pane.active.line, column: pane.active.column }, { line: 1, column: 1 });
  assert.equal(pane.active?.language, 'TypeScript');
  assert.equal(reads, 1);
  await pane.open('src/b.ts:1:3');
  assert.equal(pane.active?.column, 3);
  assert.equal(reads, 1);
});

test('save preserves BOM, mixed EOL, Unicode and revisions; conflicts stay visible and dirty', async () => {
  const original = '\ufeffalpha\r\n界🌱\nlast';
  const { pane, disk, notices } = fixture({ 'a.ts': original });
  await pane.open('a.ts');
  await pane.save();
  assert.equal(disk.get('a.ts'), original);
  pane.handleInput('\x1b[1;5F');
  pane.handleInput('!');
  await pane.save();
  assert.equal(disk.get('a.ts'), original + '!');
  assert.equal(pane.dirty, false);
  pane.handleInput('draft');
  disk.set('a.ts', 'external');
  await pane.save();
  assert.equal(disk.get('a.ts'), 'external');
  assert.equal(pane.dirty, true);
  assert.match(notices.at(-1)!, /changed/);
  assert.match(pane.message!.text, /changed/);
  assert.equal(pane.message!.kind, 'error');
});

test('tabs and split views share documents and never discard a dirty draft on reopen', async () => {
  const { pane, disk } = fixture();
  const focus = pane.focus;
  await pane.open('a.ts');
  pane.handleInput('X');
  await pane.open('src/b.ts');
  pane.handleInput('Y');
  pane.nextBuffer();
  pane.split();
  assert.match(rows(pane), /Xalpha/);
  assert.equal(rows(pane).split('Xalpha').length - 1, 2);
  pane.handleInput('Z');
  assert.equal(rows(pane).split('XZalpha').length - 1, 2);
  await pane.open('./a.ts');
  await pane.save();
  assert.equal(disk.get('a.ts'), 'XZalpha\r\n界🌱');
  assert.equal(pane.focus, focus);
  pane.nextBuffer();
  await pane.save();
  assert.equal(disk.get('src/b.ts'), 'Ybeta');
  pane.dispose();
});

test('find and replace operate on graphemes and replacement is undoable', async () => {
  const { pane, disk } = fixture({ 'a.ts': '界🌱 alpha alpha' });
  await pane.open('a.ts');
  pane.find();
  pane.handleInput('界🌱');
  pane.handleInput('\r');
  pane.handleInput('\x1b');
  pane.handleInput('garden');
  pane.handleInput('\x1a');
  pane.replace();
  pane.handleInput('\x01');
  pane.handleInput('alpha');
  pane.handleInput('\r');
  pane.handleInput('beta');
  pane.handleInput('\r');
  pane.handleInput('\x1b');
  await pane.save();
  assert.equal(disk.get('a.ts'), '界🌱 beta alpha');
  pane.handleInput('\x1a');
  await pane.save();
  assert.equal(disk.get('a.ts'), '界🌱 alpha alpha');
});

test('closing a dirty file asks; Escape keeps it, S saves and closes, D discards', async () => {
  const { pane, disk } = fixture();
  await pane.open('a.ts');
  pane.handleInput('draft');
  pane.closeBuffer();
  assert.equal(pane.dirty, true);
  assert.match(rows(pane), /Save changes to a\.ts/);
  pane.handleInput('x');
  assert.equal(pane.dirty, true);
  pane.handleInput('\x1b');
  assert.match(rows(pane), /draftalpha/);
  pane.closeBuffer();
  pane.handleInput('d');
  assert.equal(pane.dirty, false);
  pane.handleInput('ignored without a buffer');
  await pane.open('a.ts');
  assert.doesNotMatch(rows(pane), /draftalpha|ignored without a buffer/);
  pane.handleInput('kept');
  pane.closeBuffer();
  pane.handleInput('s');
  await setImmediate();
  await setImmediate();
  assert.equal(disk.get('a.ts'), 'keptalpha\r\n界🌱');
  assert.equal(pane.dirty, false);
  assert.match(rows(pane), /No file open/);
});

test('typing during save remains dirty and close cannot race an outstanding save', async () => {
  const { pane, files, disk } = fixture();
  await pane.open('a.ts');
  pane.handleInput('X');
  const write = files.write;
  const gate = barrier<void>();
  files.write = async (...args) => {
    await gate.promise;
    return write(...args);
  };
  const saved = pane.save();
  pane.handleInput('Y');
  pane.closeBuffer();
  assert.match(pane.message!.text, /saving/i);
  gate.resolve();
  await saved;
  assert.equal(disk.get('a.ts'), 'Xalpha\r\n界🌱');
  assert.equal(pane.dirty, true);
  await pane.save();
  assert.equal(disk.get('a.ts'), 'XYalpha\r\n界🌱');
});

test('late file reads cannot replace a newer open or resurrect after disposal', async () => {
  const { pane, files } = fixture();
  const read = files.read;
  const gate = barrier<void>();
  files.read = async (...args) => {
    if (args[0] === 'a.ts') await gate.promise;
    return read(...args);
  };
  const first = pane.open('a.ts');
  await pane.open('src/b.ts');
  gate.resolve();
  await first;
  assert.match(rows(pane), /beta/);
  assert.doesNotMatch(rows(pane), /alpha/);
  pane.dispose();
  await pane.open('a.ts');
  assert.doesNotMatch(rows(pane), /alpha/);
});

test('read-only verifier errors are visible and do not mark the document saved', async () => {
  const { pane, files, notices } = fixture();
  await pane.open('a.ts');
  pane.handleInput('X');
  files.write = async () => {
    throw new Error('Verifier files are read-only');
  };
  await pane.save();
  assert.equal(pane.dirty, true);
  assert.match(pane.message!.text, /read-only/);
  assert.match(notices.at(-1)!, /read-only/);
});

test('split source and captions remain bounded and only the active editor emits a cursor', async () => {
  const { pane } = fixture();
  await pane.open('a.ts');
  pane.split();
  for (const width of [1, 8, 40, 100]) {
    const rendered = renderLayoutFrame(pane.body, width, 24, () => {}).lines;
    assert.ok(rendered.every((line) => visibleWidth(line) <= width));
    assert.equal(rendered.filter((line) => line.includes(CURSOR_MARKER)).length, 1);
  }
});

test('split focus opens another file without changing the first pane or losing Unicode input', async () => {
  const { pane, disk } = fixture();
  await pane.open('a.ts');
  pane.split();
  pane.handleInput('\x1c');
  await pane.open('src/b.ts');
  pane.handleInput('\ud83c');
  pane.handleInput('\udf31');
  pane.handleInput('界');
  await pane.save();
  assert.equal(disk.get('src/b.ts'), '🌱界beta');
  assert.match(rows(pane), /alpha/);
  assert.match(rows(pane), /🌱界beta/);
  pane.handleInput('\x1c');
  pane.handleInput('X');
  await pane.save();
  assert.equal(disk.get('a.ts'), 'Xalpha\r\n界🌱');
  assert.equal(disk.get('src/b.ts'), '🌱界beta');
});

test('filename and query metadata never produce multiline or control-bearing chrome', async () => {
  const { pane } = fixture({ 'line\nname.ts': 'alpha' });
  await pane.open('line\nname.ts');
  assert.ok(
    renderLayoutFrame(pane.body, 80, 24, () => {}).lines.every((line) => !line.includes('\n') && !line.includes('\r')),
  );
  pane.replace();
  pane.handleInput('\x1b[200~alpha\nbeta\x1b[201~');
  pane.handleInput('\r');
  assert.ok(
    renderLayoutFrame(pane.body, 80, 24, () => {}).lines.every((line) => !line.includes('\n') && !line.includes('\r')),
  );
});

test('new file prompt creates only an unsaved buffer; first save preserves Unicode bytes', async () => {
  const { pane, disk } = fixture();
  pane.handleInput('\x0e');
  pane.handleInput('new.ts');
  pane.handleInput('\r');
  assert.equal(disk.has('new.ts'), false);
  assert.equal(pane.dirty, true);
  pane.handleInput('\x1b[200~\ufeff界🌱\r\nlast\x1b[201~');
  await pane.save();
  assert.equal(disk.get('new.ts'), '\ufeff界🌱\r\nlast');
  assert.equal(pane.dirty, false);
  pane.handleInput('!');
  await pane.save();
  assert.equal(disk.get('new.ts'), '\ufeff界🌱\r\nlast!');
});

test('new-file save never overwrites an existing or concurrently created file', async () => {
  const { pane, disk, notices } = fixture();
  pane.newFile('a.ts');
  pane.handleInput('draft');
  await pane.save();
  assert.equal(disk.get('a.ts'), 'alpha\r\n界🌱');
  assert.equal(pane.dirty, true);
  assert.match(notices.at(-1)!, /exists/);
  pane.newFile('raced.ts');
  pane.handleInput('draft');
  disk.set('raced.ts', 'external creation');
  await pane.save();
  assert.equal(disk.get('raced.ts'), 'external creation');
  assert.equal(pane.dirty, true);
});

test('empty new buffers need discard confirmation and open-buffer names cannot be replaced', async () => {
  const { pane, notices } = fixture();
  await pane.open('a.ts');
  pane.handleInput('keep');
  pane.newFile('./a.ts');
  assert.match(notices.at(-1)!, /already open/);
  assert.match(rows(pane), /keepalpha/);
  pane.newFile('empty.ts');
  pane.closeBuffer();
  assert.equal(pane.dirty, true);
  assert.match(rows(pane), /Save changes to empty\.ts/);
  pane.handleInput('\x1b');
  await pane.save();
  pane.closeBuffer();
  assert.match(rows(pane), /keepalpha/);
});

test('new-file path prompt rejects multiline, private and escaping names without disk writes', () => {
  const { pane, disk, notices } = fixture();
  for (const path of ['../escape', '.oms/private', '.keys/new', '.env.agent', 'line\nname']) pane.newFile(path);
  assert.equal(disk.size, 2);
  assert.equal(pane.dirty, false);
  assert.equal(notices.length, 5);
});

test('typing during first creation stays dirty and subsequent save uses the returned revision', async () => {
  const { pane, files, disk } = fixture();
  pane.newFile('new.ts');
  pane.handleInput('first');
  const create = files.create;
  const gate = barrier<void>();
  files.create = async (...args) => {
    await gate.promise;
    return create(...args);
  };
  const saving = pane.save();
  pane.handleInput(' later');
  gate.resolve();
  await saving;
  assert.equal(disk.get('new.ts'), 'first');
  assert.equal(pane.dirty, true);
  await pane.save();
  assert.equal(disk.get('new.ts'), 'first later');
  assert.equal(pane.dirty, false);
});

test('switching split sides invalidates a delayed file activation', async () => {
  const { pane, files, disk } = fixture({ 'a.ts': 'alpha', 'b.ts': 'beta', 'c.ts': 'charlie' });
  await pane.open('a.ts');
  pane.split();
  pane.handleInput('\x1c');
  await pane.open('b.ts');
  const gate = barrier<void>();
  const read = files.read;
  files.read = async (...args) => {
    if (args[0] === 'c.ts') await gate.promise;
    return read(...args);
  };
  try {
    const opening = pane.open('c.ts');
    pane.handleInput('\x1c');
    gate.resolve();
    await opening;
    pane.handleInput('X');
    await pane.save();
    assert.equal(disk.get('a.ts'), 'Xalpha');
    assert.equal(disk.get('b.ts'), 'beta');
    assert.equal(disk.get('c.ts'), 'charlie');
    assert.doesNotMatch(rows(pane), /charlie/);
  } finally {
    gate.resolve();
    pane.dispose();
  }
});

test('report tabs are read-only across typing, paste, replace, save and split without task IO', async () => {
  const { pane, disk, files } = fixture();
  const before = [...disk];
  let reads = 0;
  files.read = async () => {
    reads++;
    throw new Error('report must not read task files');
  };
  pane.openReport('review-1', 'Confirmed 0 · Suspected 1\nNot a professional audit\nREPORT TEXT');
  assert.match(rows(pane), /Not a professional audit/);
  for (const input of ['changed', '\x1b[200~PASTE\x1b[201~', '\x7f', '\r', '\x1a']) pane.handleInput(input);
  pane.replace();
  pane.handleInput('replacement');
  await pane.save();
  pane.split();
  pane.handleInput('\x1c');
  pane.handleInput('changed split');
  await pane.save();
  assert.equal(pane.dirty, false);
  assert.match(rows(pane), /REPORT TEXT/);
  assert.doesNotMatch(rows(pane), /PASTE|changed split|replacement/);
  assert.deepEqual([...disk], before);
  assert.equal(reads, 0);
  pane.closeBuffer();
  assert.equal(pane.dirty, false);
  pane.dispose();
});

test('report completion during a prompt preserves input and opens after the prompt closes', () => {
  const { pane, disk } = fixture();
  pane.newFile();
  pane.handleInput('draft-path');
  pane.openReport('queued-review', 'Not a professional audit\nQueued report');
  assert.match(rows(pane), /draft-path/);
  assert.match(pane.message!.text, /close this prompt/);
  pane.handleInput('\x1b');
  assert.match(rows(pane), /Queued report/);
  assert.equal(pane.dirty, false);
  assert.equal(disk.has('draft-path'), false);
  pane.dispose();
});

test('save with no changes is a no-op, never rewriting the file', async () => {
  const { pane, files } = fixture();
  let writes = 0;
  const write = files.write;
  files.write = async (...args) => {
    writes++;
    return write(...args);
  };
  await pane.open('a.ts');
  await pane.save();
  assert.equal(writes, 0);
  assert.equal(pane.message?.text, 'Nothing to save.');
  pane.handleInput('X');
  await pane.save();
  assert.equal(writes, 1);
  assert.equal(pane.message?.kind, 'success');
});

test('a new file in a folder that does not exist yet creates the folder first', async () => {
  const { pane, files, disk } = fixture();
  const made: string[] = [];
  files.makeDirectory = async (path) => {
    made.push(path);
  };
  pane.newFile('notes/deep/todo.md');
  pane.handleInput('hello');
  await pane.save();
  assert.deepEqual(made, ['notes/deep']);
  assert.equal(disk.get('notes/deep/todo.md'), 'hello');
  pane.newFile('top.md');
  pane.handleInput('x');
  await pane.save();
  assert.deepEqual(made, ['notes/deep']);
});

test('errors read as product wording, with no host path and a next step', async () => {
  const { pane, files } = fixture();
  files.read = async (path) => {
    if (path === 'logo.png') throw new Error('Binary task files are unavailable in this text editor');
    if (path === 'big.ts') throw new Error('read requires a regular file no larger than 64 KiB');
    if (path === 'busy.ts') throw new Error('Stop the host terminal before running task tools');
    throw new Error("ENOENT: no such file or directory, open '/private/tmp/secret-host-dir/proj/lib.rs'");
  };
  for (const [path, pattern] of [
    ['logo.png', /logo\.png is a binary file/],
    ['big.ts', /big\.ts is larger than 64 KiB/],
    ['busy.ts', /terminal is running.*\/terminal stop/],
    ['programs/lib.rs', /lib\.rs doesn't exist/],
  ] as const) {
    await pane.open(path);
    assert.match(pane.message!.text, pattern, path);
    assert.doesNotMatch(pane.message!.text, /secret-host-dir|ENOENT|task/);
    assert.equal(pane.message!.kind, 'error');
  }
});

test('messages have a kind; success and info fade, errors stay until the next key', async () => {
  const { pane } = fixture();
  const message = () => pane.message as { kind: string } | undefined;
  await pane.open('a.ts');
  pane.handleInput('X');
  await pane.save();
  assert.equal(message()?.kind, 'success');
  pane.handleInput('y');
  assert.equal(message(), undefined);
  await pane.open('missing.ts');
  assert.equal(message()?.kind, 'error');
  pane.handleInput('z');
  assert.equal(message(), undefined);
  pane.dispose();
});

test('same-named files get their folder in the tab, and quit lists the unsaved ones', async () => {
  const { pane } = fixture({ 'a/mod.rs': 'one', 'b/mod.rs': 'two', 'lib.rs': 'three' });
  await pane.open('a/mod.rs');
  await pane.open('b/mod.rs');
  await pane.open('lib.rs');
  const shown = rows(pane);
  assert.match(shown, /a\/mod\.rs/);
  assert.match(shown, /b\/mod\.rs/);
  assert.match(shown, / lib\.rs /);
  pane.handleInput('x');
  pane.nextBuffer();
  pane.handleInput('y');
  assert.deepEqual(pane.dirtyNames, ['a/mod.rs', 'lib.rs']);
  assert.deepEqual(
    pane.openFiles.map((file) => [file.label, file.dirty, file.active]),
    [
      ['a/mod.rs', true, true],
      ['b/mod.rs', false, false],
      ['lib.rs', true, false],
    ],
  );
});

test('tabs switch with Ctrl+PageUp/PageDown, Alt+brackets and Alt+digits, and close with the cross', async () => {
  const { pane } = fixture({ 'a.ts': 'A', 'b.ts': 'B', 'c.ts': 'C' });
  for (const name of ['a.ts', 'b.ts', 'c.ts']) await pane.open(name);
  assert.equal(pane.active?.path, 'c.ts');
  pane.handleInput('\x1b[5;5~');
  assert.equal(pane.active?.path, 'b.ts');
  pane.handleInput('\x1b[6;5~');
  pane.handleInput('\x1b[6;5~');
  assert.equal(pane.active?.path, 'a.ts');
  pane.handleInput('\x1b]');
  assert.equal(pane.active?.path, 'b.ts');
  pane.handleInput('\x1b[');
  assert.equal(pane.active?.path, 'a.ts');
  pane.handleInput('\x1b3');
  assert.equal(pane.active?.path, 'c.ts');
  click(pane, '×', { occurrence: 1 });
  assert.deepEqual(
    pane.openFiles.map((file) => file.path),
    ['a.ts', 'c.ts'],
  );
  assert.equal(pane.active?.path, 'c.ts');
});

test('the agent changing an open file reloads a clean buffer and warns on a dirty one', async () => {
  const { pane, disk, files, notices } = fixture({ 'a.ts': 'alpha', 'b.ts': 'beta' });
  await pane.open('a.ts');
  await pane.open('b.ts');
  disk.set('a.ts', 'alpha by agent');
  await pane.refreshFromDisk(['a.ts']);
  pane.nextBuffer();
  assert.match(rows(pane), /alpha by agent/);
  assert.equal(pane.dirty, false);
  assert.match(notices.at(-1)!, /updated on disk/);
  // A dirty buffer keeps the user's text and shows the banner; saving needs a second, deliberate Ctrl+S.
  pane.handleInput('mine ');
  disk.set('a.ts', 'agent again');
  await pane.refreshFromDisk();
  assert.match(rows(pane), /changed on disk/);
  assert.match(rows(pane), /mine alpha by agent/);
  assert.equal(pane.message?.kind, 'warning');
  const write = files.write;
  let writes = 0;
  files.write = async (...args) => {
    writes++;
    return write(...args);
  };
  pane.handleInput('\x13');
  await setImmediate();
  assert.equal(writes, 0);
  assert.match(pane.message!.text, /Ctrl\+S again/);
  pane.handleInput('\x13');
  await setImmediate();
  await setImmediate();
  assert.equal(writes, 1);
  assert.equal(disk.get('a.ts'), 'mine alpha by agent');
  assert.doesNotMatch(rows(pane), /changed on disk/);
  assert.equal(pane.dirty, false);
});

test('Ctrl+R reloads the file from disk and drops unsaved edits', async () => {
  const { pane, disk } = fixture({ 'a.ts': 'alpha' });
  await pane.open('a.ts');
  pane.handleInput('draft ');
  disk.set('a.ts', 'from disk');
  await pane.refreshFromDisk();
  pane.handleInput('\x12');
  await setImmediate();
  await setImmediate();
  assert.match(rows(pane), /from disk/);
  assert.doesNotMatch(rows(pane), /draft/);
  assert.equal(pane.dirty, false);
});

test('a file deleted under an edited buffer can be saved again and a clean one is left alone', async () => {
  const { pane, disk } = fixture({ 'a.ts': 'alpha', 'b.ts': 'beta' });
  await pane.open('a.ts');
  pane.handleInput('mine ');
  disk.delete('a.ts');
  await pane.refreshFromDisk();
  assert.match(rows(pane), /deleted on disk/);
  pane.handleInput('\x13');
  pane.handleInput('\x13');
  await setImmediate();
  await setImmediate();
  assert.equal(disk.get('a.ts'), 'mine alpha');
  await pane.open('b.ts');
  disk.delete('b.ts');
  await pane.refreshFromDisk();
  assert.equal(pane.dirty, false);
});

test('Save all writes every dirty file; find ignores case until Alt+C; replace all is one undo step', async () => {
  const { pane, disk } = fixture({ 'a.ts': 'Foo foo FOO', 'b.ts': 'two' });
  await pane.open('a.ts');
  await pane.open('b.ts');
  pane.handleInput('1');
  pane.nextBuffer();
  pane.handleInput('2');
  await pane.saveAll();
  assert.equal(disk.get('a.ts'), '2Foo foo FOO');
  assert.equal(disk.get('b.ts'), '1two');
  assert.equal(pane.dirty, false);
  pane.find();
  pane.handleInput('foo');
  pane.handleInput('\r');
  assert.equal(pane.message?.text, '1 of 3');
  pane.handleInput('\x1bc');
  pane.handleInput('\r');
  assert.match(pane.message!.text, /\b1 of 1|of 1/);
  pane.handleInput('\x1b');
  pane.replace();
  pane.handleInput('\x1bc');
  pane.handleInput('\x01');
  pane.handleInput('foo');
  pane.handleInput('\r');
  pane.handleInput('bar');
  pane.handleInput('\x1b\r');
  assert.match(pane.message!.text, /Replaced 1 match/);
  pane.handleInput('\x1b');
  assert.match(rows(pane), /2Foo bar FOO/);
  pane.handleInput('\x1a');
  assert.match(rows(pane), /2Foo foo FOO/);
});
