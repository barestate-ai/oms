import { fuzzyMatch, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { OMS_COMMANDS, type CommandSpec } from './commands.ts';
import { inGlyphs, type Glyphs } from './glyphs.ts';
import { colorBg, colorText, type OmsTheme } from './theme.ts';
import { singleLine } from './transcript.ts';

/** The most rows the popup draws. */
export const POPUP_ROWS = 8;

/**
 * The commands the typed name matches, best first: names that start with it, then names that contain it, then fuzzy
 * (in-order letters) name matches, then descriptions. An unfinished name opens it; arguments stay normal input.
 */
export function slashChoices(
  draft: string,
  kind: 'task' | 'chat',
  /** The view on screen: its own command (go to where you already are) is left out. */
  view?: 'harness' | 'workbench',
): readonly CommandSpec[] | undefined {
  const match = /^\/([a-z]*)$/i.exec(draft.trimStart());
  if (!match) return undefined;
  const query = match[1]!.toLowerCase();
  const here = view === 'workbench' ? 'workbench' : view === 'harness' ? 'harness' : undefined;
  const available = OMS_COMMANDS.filter(
    (command) => command.availability !== (kind === 'chat' ? 'task' : 'chat') && command.name !== here,
  );
  if (!query) return available;
  const tier = (command: CommandSpec): number => {
    if (command.name.startsWith(query)) return 0;
    if (command.name.includes(query)) return 1;
    if (fuzzyMatch(query, command.name).matches) return 2;
    return `${command.description} ${command.group}`.toLowerCase().includes(query) ? 3 : -1;
  };
  return available
    .map((command, order) => ({ command, order, rank: tier(command) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((entry) => entry.command);
}

/** `/error <code> [program]` when the draft is exactly a command name (and a space) and the command takes an argument. */
export function argumentUsage(draft: string, kind: 'task' | 'chat'): string | undefined {
  const match = /^\/([a-z]+)\s$/i.exec(draft.trimStart());
  const command = match && OMS_COMMANDS.find((item) => item.name === match[1]!.toLowerCase());
  if (!command?.argument || command.availability === (kind === 'chat' ? 'task' : 'chat')) return undefined;
  return `/${command.name} ${singleLine(command.argument, 80)}`;
}

/** The first choice the popup shows: the window keeps the selected one in view, at its last row when scrolling down. */
export function popupStart(selected: number, total: number, rows: number): number {
  const count = Math.max(1, Math.min(rows, total));
  return Math.max(0, Math.min(selected - count + 1, total - count));
}

/** The popup rows above the composer: pointer, `/name usage`, description; the selected row on the raised surface. */
export function slashPopup(
  theme: OmsTheme,
  glyphs: Glyphs,
  choices: readonly CommandSpec[],
  selected: number,
  width: number,
  maxRows = POPUP_ROWS,
): string[] {
  if (!choices.length)
    return [
      colorText(theme, 'faint', truncateToWidth(`  No command matches that. Type / to see them all.`, width, '')),
    ];
  const count = Math.max(1, Math.min(maxRows, choices.length));
  const start = popupStart(selected, choices.length, maxRows);
  const shown = choices.slice(start, start + count);
  const label = (command: CommandSpec) =>
    `/${command.name}${command.argument ? ' ' + singleLine(command.argument, 60) : ''}`;
  const nameWidth = Math.min(
    Math.max(14, ...shown.map((command) => visibleWidth(label(command)) + 2)),
    Math.max(14, Math.floor(width / 2)),
  );
  return shown.map((command, offset) => {
    const isSelected = start + offset === selected;
    const name = truncateToWidth(label(command), nameWidth - 2, glyphs.ellipsis, true);
    const pointer = isSelected ? colorText(theme, 'accentFill', glyphs.pointer) : ' ';
    const role = isSelected ? 'foreground' : 'muted';
    const row =
      `${pointer} ${colorText(theme, 'foreground', name)}${' '.repeat(Math.max(2, nameWidth - visibleWidth(name)))}` +
      colorText(
        theme,
        role,
        truncateToWidth(
          inGlyphs(glyphs, singleLine(command.description, 200)),
          Math.max(0, width - nameWidth - 2),
          glyphs.ellipsis,
        ),
      );
    return isSelected ? colorBg(theme, 'selection', row, width) : row;
  });
}
