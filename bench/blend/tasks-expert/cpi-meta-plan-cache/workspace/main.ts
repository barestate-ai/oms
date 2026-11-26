import { array, key, text, need } from './strict.ts';
import { merge, allowed } from './roles.ts';
import { validate, grants } from './grants.ts';
import { commit } from './commit.ts';
export function run(x) {
  const accounts = merge(x.accounts),
    nodes = new Map();
  for (const n of array(x.nodes, 32)) {
    need(text(n.id, 32).length > 0 && !nodes.has(n.id));
    key(n.program);
    merge(n.metas);
    validate(n.derived);
    array(n.children, 32).forEach((v) => need(typeof v === 'string'));
    nodes.set(n.id, n);
  }
  for (const n of nodes.values()) need(n.children.every((id) => nodes.has(id)));
  need(typeof x.root === 'string' && nodes.has(x.root));
  const out = [],
    path = new Set(),
    cache = new Map();
  function visit(id, parent, caller, parentHash, depth) {
    need(depth <= 5 && out.length < 64 && !path.has(id));
    const n = nodes.get(id);
    need(parent.some((a) => a.key === n.program));
    const cacheKey = id,
      metas = cache.get(cacheKey) ?? allowed(merge(n.metas), parent, grants(n.derived, caller));
    cache.set(cacheKey, metas);
    const h = commit(n, metas, parentHash, out.length);
    out.push({ id, program: n.program, metas, hash: h });
    path.add(id);
    for (const child of n.children) visit(child, metas, n.program, h, depth + 1);
    path.add(id);
  }
  visit(x.root, accounts, null, '00'.repeat(32), 0);
  return out;
}
