import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import { colorText, type OmsTheme, type ThemeRole } from './theme.ts';

/**
 * A one-column vertical rule between panes. Its height is the host terminal's, and the layout clips it, the way the old
 * pane frame's rails did: a column of constant text, not a measured component.
 */
export function verticalRule(theme: () => OmsTheme, role: () => ThemeRole, rows: () => number): Component {
  let key = '';
  let lines: string[] = [];
  return {
    invalidate() {},
    render() {
      const height = Math.max(1, Math.floor(rows()));
      const text = colorText(theme(), role(), '│');
      if (`${text}|${height}` !== key) {
        key = `${text}|${height}`;
        lines = Array<string>(height).fill(text);
      }
      return lines;
    },
  };
}

/** A full-width horizontal rule; `label` sits at the left and `right` at the right end, in the muted role. */
export function horizontalRule(
  theme: () => OmsTheme,
  role: () => ThemeRole,
  label: () => string = () => '',
  right: () => string = () => '',
): Component {
  return {
    invalidate() {},
    render(width) {
      const t = theme();
      const left = label() ? ` ${label()} ` : '';
      const end = right() ? ` ${right()} ` : '';
      const lead = left ? '─' : '';
      const fill = Math.max(0, width - visibleWidth(lead) - visibleWidth(left) - visibleWidth(end));
      return [
        truncateToWidth(
          colorText(t, role(), lead) +
            colorText(t, 'muted', left) +
            colorText(t, role(), '─'.repeat(fill)) +
            colorText(t, 'muted', end),
          width,
          '',
        ),
      ];
    },
  };
}
