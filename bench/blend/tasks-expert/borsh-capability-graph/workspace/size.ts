import { text } from './strict.ts';
export function size(nodes) {
  return 10 + nodes.reduce((n, v) => n + 1 + v.id.length + 16 + 2 + 2 * v.edges.length, 0);
}
