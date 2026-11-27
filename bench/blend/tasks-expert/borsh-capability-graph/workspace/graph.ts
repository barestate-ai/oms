import { order, need } from './strict.ts';
export function canonical(nodes) {
  let next = 0;
  const index = new Map(),
    low = new Map(),
    stack = [],
    active = new Set(),
    groups = [];
  function visit(id) {
    index.set(id, next);
    low.set(id, next++);
    stack.push(id);
    active.add(id);
    for (const w of nodes.find((n) => n.id === id).edges) {
      if (!index.has(w)) {
        visit(w);
        low.set(id, Math.min(low.get(id), low.get(w)));
      } else if (active.has(w)) low.set(id, Math.min(low.get(id), index.get(w)));
    }
    if (low.get(id) === index.get(id)) {
      const g = [];
      let w;
      do {
        w = stack.pop();
        active.delete(w);
        g.push(w);
      } while (w !== id);
      g.sort((a, b) => order(b, a));
      groups.push(g);
    }
  }
  for (const n of nodes) if (!index.has(n.id)) visit(n.id);
  const done = new Set(),
    out = [];
  while (out.length < nodes.length) {
    const ready = groups.filter(
      (g) =>
        !done.has(g[0]) &&
        g.every((id) =>
          nodes.find((n) => n.id === id).edges.every((e) => g.includes(e) || out.some((n) => n.id === e)),
        ),
    );
    need(ready.length > 0);
    ready.sort((a, b) => order(b[0], a[0]));
    const g = ready[0];
    done.add(g[0]);
    out.push(...g.map((id) => nodes.find((n) => n.id === id)));
  }
  return out;
}
