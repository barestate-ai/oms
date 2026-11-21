import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import { colorBg, colorText, type OmsTheme } from './theme.ts';
import { displayText } from './transcript.ts';

export interface TabItem {
  id: string;
  label: string;
  active: boolean;
  /** An unsaved change: a dot after the name. */
  dirty?: boolean;
  /** A small mark before the name, such as a diff sign. */
  glyph?: string;
  /** Only tabs with a close action show an ×. */
  onClose?: () => void;
  onSelect: () => void;
}
interface TabStripOptions {
  theme: () => OmsTheme;
  render: () => void;
}
interface Hit {
  id: string;
  start: number;
  end: number;
  /** Columns [closeAt, end) close the tab. */
  closeAt: number;
}

const clean = (text: string): string => displayText(text, 400).replace(/[\r\n\t]/g, ' ');

/**
 * One row of editor tabs: the active tab on the surface color, a dot for unsaved changes and an × to close. Tabs that
 * do not fit scroll so the active one stays visible, with ‹ and › marking what is hidden.
 */
export class TabStrip implements Component {
  private readonly items: () => readonly TabItem[];
  private readonly options: TabStripOptions;
  private hits: Hit[] = [];
  private width = 0;
  private gesture: { id: string; close: boolean } | undefined;

  constructor(items: () => readonly TabItem[], options: TabStripOptions) {
    this.items = items;
    this.options = options;
  }

  invalidate(): void {
    this.hits = [];
    this.gesture = undefined;
  }

  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    this.width = width;
    this.hits = [];
    const theme = this.options.theme();
    const items = this.items();
    const cells = items.map((item) => {
      const name = ` ${item.glyph ? item.glyph + ' ' : ''}${clean(item.label)}`;
      const mark = item.dirty ? ' ●' : '';
      const close = item.onClose ? ' ×' : '';
      return { item, name, mark, close, size: visibleWidth(name + mark + close) + 1 };
    });
    // Scroll so the active tab fits: drop tabs from the left until it does.
    const activeIndex = Math.max(
      0,
      cells.findIndex((cell) => cell.item.active),
    );
    let start = 0;
    let used = 0;
    for (let index = 0; index <= activeIndex && index < cells.length; index++) used += cells[index]!.size;
    while (used > width - (start > 0 ? 2 : 0) && start < activeIndex) used -= cells[start++]!.size;
    let line = '';
    let column = 0;
    if (start > 0) {
      line += colorText(theme, 'muted', `‹${start} `.slice(0, 3));
      column += 3;
    }
    let hidden = 0;
    for (let index = start; index < cells.length; index++) {
      const cell = cells[index]!;
      const room = width - column;
      // Keep room for the › marker unless this is the last tab; a tab that does not fully fit is cut, not dropped.
      const reserve = index < cells.length - 1 ? 3 : 0;
      const available = room - reserve;
      if (available < 6 && index !== activeIndex) {
        hidden = cells.length - index;
        break;
      }
      const text = truncateToWidth(
        cell.name,
        Math.max(1, Math.min(visibleWidth(cell.name), available - visibleWidth(cell.mark + cell.close) - 1)),
        '…',
      );
      const body = [
        colorText(theme, cell.item.active ? 'foreground' : 'muted', cell.item.active ? `\x1b[1m${text}\x1b[22m` : text),
        cell.mark ? colorText(theme, 'warning', cell.mark) : '',
        cell.close ? colorText(theme, 'muted', cell.close) : '',
        ' ',
      ].join('');
      const shown = visibleWidth(text + cell.mark + cell.close) + 1;
      line += cell.item.active ? colorBg(theme, 'surface', body) : body;
      this.hits.push({
        id: cell.item.id,
        start: column,
        end: column + shown,
        closeAt: cell.close ? column + shown - 3 : column + shown,
      });
      column += shown;
    }
    if (hidden > 0 && column + 3 <= width) {
      line += colorText(theme, 'muted', ` ${hidden}›`);
      column += visibleWidth(` ${hidden}›`);
    }
    return [truncateToWidth(line, width, '')];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.width !== this.width) {
      this.invalidate();
      return undefined;
    }
    const hit =
      event.y === 0 ? this.hits.find((candidate) => event.x >= candidate.start && event.x < candidate.end) : undefined;
    if (event.type === 'press') {
      this.gesture = undefined;
      if (event.button !== 'left' || !hit) return undefined;
      this.gesture = { id: hit.id, close: event.x >= hit.closeAt };
      return { handled: true, capture: true, focus: false };
    }
    const gesture = this.gesture;
    if (!gesture) return undefined;
    if (event.type === 'click' || event.type === 'release') {
      if (event.type === 'click') {
        this.gesture = undefined;
        const item = this.items().find((candidate) => candidate.id === gesture.id);
        if (item && hit?.id === gesture.id && event.button === 'left') {
          if (gesture.close && item.onClose) item.onClose();
          else item.onSelect();
        }
      }
      return { handled: true, focus: false };
    }
    if (event.type === 'drag') this.gesture = undefined;
    return { handled: true, focus: false };
  }
}
