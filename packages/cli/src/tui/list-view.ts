import {
  ScrollView,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import { colorBg, type OmsTheme } from './theme.ts';

/** One row: `text` is already colored; `right` sits at the right edge. */
export interface ListItem {
  key: string;
  text: string;
  right?: string;
  /** The row can be skipped over and never activated (a heading or a hint). */
  inert?: boolean;
}
interface ListViewOptions {
  theme: () => OmsTheme;
  render: () => void;
  items: () => readonly ListItem[];
  /** Enter, or a click, on a row. */
  activate: (item: ListItem, index: number) => void;
  /** Whether the list has focus: the selected bar is bright with it and quiet without. */
  focused: () => boolean;
  /** Lines shown when there are no items (already colored). */
  empty?: () => readonly string[];
  /** A click on a row also asks for focus. */
  requestFocus?: () => void;
  /** The selection moved. */
  selectionChanged?: (item: ListItem | undefined) => void;
}

/** A scrolling list with one filled selection bar; keyboard and mouse share the same activation. */
export class ListView {
  readonly view: ScrollView;
  private selected = 0;
  private selectedKey: string | undefined;
  private lastItems: readonly ListItem[] = [];
  private reveal = true;
  private readonly options: ListViewOptions;

  constructor(options: ListViewOptions) {
    this.options = options;
    const owner = this;
    const content: Component = {
      invalidate() {},
      render: (width) => this.draw(width),
      handleMouse: (event) => this.mouse(event),
    };
    this.view = new (class extends ScrollView {
      override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
        super.updateLayout(contentHeight, viewportHeight, requestRender);
        if (!owner.reveal || viewportHeight < 1) return;
        owner.reveal = false;
        if (owner.selected < this.scrollTop) this.scrollTo(owner.selected);
        else if (owner.selected >= this.scrollTop + viewportHeight) this.scrollTo(owner.selected - viewportHeight + 1);
      }
    })(content, { follow: 'none', scrollbar: 'auto', overscroll: 'contain' });
  }

  get item(): ListItem | undefined {
    return this.lastItems[this.selected];
  }
  get index(): number {
    return this.selected;
  }
  get count(): number {
    return this.lastItems.length;
  }

  /** Select a row by key (when it is still there). */
  select(key: string): void {
    const at = this.lastItems.findIndex((item) => item.key === key);
    if (at >= 0) this.setSelection(at);
  }

  /** Back to the first row and the top of the list. */
  reset(): void {
    this.selected = 0;
    this.selectedKey = undefined;
    this.reveal = true;
    this.view.scrollToStart();
  }

  private setSelection(index: number): void {
    const items = this.lastItems;
    this.selected = Math.max(0, Math.min(items.length - 1, index));
    this.selectedKey = items[this.selected]?.key;
    this.reveal = true;
    this.options.selectionChanged?.(items[this.selected]);
    this.options.render();
  }

  private draw(width: number): string[] {
    const theme = this.options.theme();
    const items = this.options.items();
    this.lastItems = items;
    // The selection follows its row when the list changes under it.
    const at = this.selectedKey === undefined ? -1 : items.findIndex((item) => item.key === this.selectedKey);
    if (at >= 0) this.selected = at;
    else this.selected = Math.max(0, Math.min(this.selected, items.length - 1));
    if (!items.length) return [...(this.options.empty?.() ?? [])].map((line) => truncateToWidth(line, width, ''));
    return items.map((item, index) => {
      const right = item.right ? ` ${item.right} ` : '';
      const room = Math.max(1, width - visibleWidth(right));
      const left = truncateToWidth(item.text, room, '…', true);
      const line = truncateToWidth(left + right, width, '', true);
      return index === this.selected && !item.inert
        ? colorBg(theme, this.options.focused() ? 'selection' : 'surface', line, width)
        : line;
    });
  }

  /** Up, down, page, home and end move the bar; Enter activates. True when the key was one of these. */
  handleInput(data: string): boolean {
    if (isKeyRelease(data)) return false;
    const page = Math.max(1, this.view.viewportHeight - 1);
    const step = (direction: 1 | -1, distance: number) => {
      let next = this.selected + direction * distance;
      // Skip over rows that are only headings.
      while (next > 0 && next < this.lastItems.length - 1 && this.lastItems[next]?.inert) next += direction;
      this.setSelection(next);
    };
    if (matchesKey(data, 'up')) step(-1, 1);
    else if (matchesKey(data, 'down')) step(1, 1);
    else if (matchesKey(data, 'pageUp')) step(-1, page);
    else if (matchesKey(data, 'pageDown')) step(1, page);
    else if (matchesKey(data, 'home')) this.setSelection(0);
    else if (matchesKey(data, 'end')) this.setSelection(this.lastItems.length - 1);
    else if (matchesKey(data, 'enter')) {
      const item = this.item;
      if (item && !item.inert) this.options.activate(item, this.selected);
    } else return false;
    return true;
  }

  private mouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== 'left') return undefined;
    if (event.type === 'press') return { handled: true, focus: true };
    if (event.type !== 'click') return undefined;
    this.options.requestFocus?.();
    const item = this.lastItems[event.y];
    if (item && !item.inert) {
      this.setSelection(event.y);
      this.options.activate(item, event.y);
    }
    return { handled: true, focus: true };
  }
}
