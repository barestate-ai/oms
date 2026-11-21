import {
  HStack,
  VStack,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import { colorText, type OmsTheme } from './theme.ts';
import { displayText } from './transcript.ts';

export interface ActionItem {
  id: string;
  label: string;
  icon?: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}
interface ActionBarOptions {
  theme: () => OmsTheme;
  render: () => void;
  onEscape?: () => void;
}
interface ActionHit {
  id: string;
  text: string;
  start: number;
  end: number;
}

function actionText(item: ActionItem): string {
  return displayText(`${item.icon ? item.icon + ' ' : ''}${item.label}`, 1000).replace(/[\r\n\t]/g, ' ');
}

/** One row of labelled actions; only fully visible actions can be activated. */
export class ActionBar implements Component, Focusable {
  private readonly items: () => readonly ActionItem[];
  private readonly options: ActionBarOptions;
  private hasFocus = false;
  private selected: string | undefined;
  private active: string | undefined;
  private width = 0;
  private hits: ActionHit[] = [];
  private gesture: { id: string; x: number; y: number; released: boolean } | undefined;

  constructor(items: () => readonly ActionItem[], options: ActionBarOptions) {
    this.items = items;
    this.options = options;
  }

  get focused(): boolean {
    return this.hasFocus;
  }
  set focused(value: boolean) {
    if (this.hasFocus === value) return;
    this.hasFocus = value;
    if (!value) this.gesture = undefined;
    this.options.render();
  }

  invalidate(): void {
    this.hits = [];
    this.gesture = undefined;
  }

  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    if (width !== this.width) this.gesture = undefined;
    this.width = width;
    this.hits = [];
    const items = this.items();
    const active = items.find((item) => item.active)?.id;
    if (active !== this.active) {
      this.active = active;
      if (active !== undefined) this.selected = active;
    }
    if (!items.some((item) => item.id === this.selected && !item.disabled)) {
      this.selected = items.find((item) => !item.disabled)?.id;
    }
    const texts = items.map(actionText);
    const sizes = texts.map((text) => visibleWidth(text) + 4);
    const selectedIndex = items.findIndex((item) => item.id === this.selected);
    let start = 0;
    let used = 0;
    for (let index = 0; index <= selectedIndex; index++) {
      used += sizes[index]! + (index > 0 ? 1 : 0);
    }
    while (used > width && start < selectedIndex) {
      used -= sizes[start]! + 1;
      start++;
    }
    let line = '';
    let column = 0;
    const theme = this.options.theme();
    for (let index = start; index < items.length && column < width; index++) {
      const item = items[index]!;
      if (column > 0) {
        line += ' ';
        column++;
      }
      if (column >= width) break;
      const text = texts[index]!;
      const full = sizes[index]! <= width - column;
      const selected = this.focused && item.id === this.selected && !item.disabled;
      const label = truncateToWidth(`[ ${text} ]`, width - column, '');
      const role = item.disabled ? 'muted' : item.active || selected ? 'accent' : 'foreground';
      line += colorText(theme, role, selected ? `\x1b[4m${label}\x1b[24m` : label);
      if (full && !item.disabled) this.hits.push({ id: item.id, text, start: column, end: column + sizes[index]! });
      column += visibleWidth(label);
      if (!full) break;
    }
    return [line];
  }

  handleInput(data: string): void {
    if (!this.focused || isKeyRelease(data)) return;
    if (matchesKey(data, 'escape')) {
      this.options.onEscape?.();
      return;
    }
    const next = matchesKey(data, 'right') || matchesKey(data, 'down') || matchesKey(data, 'tab');
    const previous = matchesKey(data, 'left') || matchesKey(data, 'up') || matchesKey(data, 'shift+tab');
    if (next || previous) {
      const enabled = this.items().filter((item) => !item.disabled);
      if (!enabled.length) return;
      const index = enabled.findIndex((item) => item.id === this.selected);
      this.selected = enabled[(index + (next ? 1 : -1) + enabled.length) % enabled.length]!.id;
      this.gesture = undefined;
      this.options.render();
    } else if (matchesKey(data, 'enter') || data === ' ') {
      this.activate(this.selected);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.width !== this.width) {
      this.invalidate();
      return undefined;
    }
    const hit = event.y === 0 ? this.hits.find((item) => event.x >= item.start && event.x < item.end) : undefined;
    if (event.type === 'press') {
      this.gesture = undefined;
      if (event.button !== 'left' || !hit) return undefined;
      this.gesture = { id: hit.id, x: event.x, y: event.y, released: false };
      return { handled: true, capture: true, focus: false };
    }
    const gesture = this.gesture;
    if (!gesture) return undefined;
    if (event.type === 'drag' || event.x !== gesture.x || event.y !== gesture.y || hit?.id !== gesture.id) {
      this.gesture = undefined;
      return { handled: true, focus: false };
    }
    if (event.type === 'release') {
      gesture.released = true;
      return { handled: true, focus: false };
    }
    if (event.type === 'click') {
      this.gesture = undefined;
      if (gesture.released && event.button === 'left') this.activate(gesture.id);
      return { handled: true, focus: false };
    }
    return { handled: true, focus: false };
  }

  private activate(id: string | undefined): void {
    const hit = this.hits.find((item) => item.id === id);
    const item = this.items().find((item) => item.id === id);
    if (!hit || !item || item.disabled || actionText(item) !== hit.text) return;
    this.selected = id;
    item.onPress();
  }
}

interface PaneFrameOptions {
  theme: () => OmsTheme;
  title: () => string;
  focused: () => boolean;
  rows: () => number;
  compact?: () => boolean;
  onFocus?: () => void;
}

/**
 * A stack that only ever fills a slot its parent sized (numeric basis), so it measures as empty. Row layouts measure
 * every child by rendering it; without this a frame would draw its whole transcript or file again on every frame.
 * The visible drawing goes through the layout tree, which never calls this.
 */
class Filled extends VStack {
  override render(): string[] {
    return [];
  }
}

/** Public stacks keep scroll views and cursor-bearing children in the layout tree. */
export class PaneFrame extends Filled {
  constructor(content: Component, options: PaneFrameOptions) {
    super();
    const decorated = (viewport: { width: number }) =>
      viewport.width >= 4 && options.rows() > 12 && !options.compact?.();
    const color = (text: string) => colorText(options.theme(), options.focused() ? 'accent' : 'border', text);
    const focus = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
      if (event.button !== 'left') return undefined;
      if (event.type === 'click') {
        options.onFocus?.();
        return { handled: true };
      }
      return event.type === 'press' ? { handled: true } : undefined;
    };
    const horizontal = (top: boolean): Component => ({
      invalidate() {},
      handleMouse: focus,
      render(width) {
        if (width < 2) return [''];
        const title = top
          ? truncateToWidth(` ${displayText(options.title(), 1000).replace(/[\r\n\t]/g, ' ')} `, width - 2, '')
          : '';
        return [
          color(
            (top ? '╭' : '╰') + title + '─'.repeat(Math.max(0, width - 2 - visibleWidth(title))) + (top ? '╮' : '╯'),
          ),
        ];
      },
    });
    let railText = '';
    let railRows = 0;
    let railLines: string[] = [];
    const rail: Component = {
      invalidate() {},
      handleMouse: focus,
      render() {
        const text = color('│');
        const rows = Math.max(0, Math.floor(options.rows()) - 2);
        if (text !== railText || rows !== railRows) {
          railText = text;
          railRows = rows;
          railLines = Array<string>(rows).fill(text);
        }
        return railLines;
      },
    };
    const body = new HStack([
      { component: rail, basis: 1, grow: 0, shrink: 1, minSize: 0, visible: decorated },
      { component: new Filled([{ component: content, basis: 0, grow: 1 }]), basis: 0, grow: 1, minSize: 1 },
      { component: rail, basis: 1, grow: 0, shrink: 1, minSize: 0, visible: decorated },
    ]);
    this.addChild(horizontal(true), { basis: 1, grow: 0, shrink: 0, visible: decorated });
    this.addChild(body, { basis: 0, grow: 1, minSize: 1 });
    this.addChild(horizontal(false), { basis: 1, grow: 0, shrink: 0, visible: decorated });
  }
}
