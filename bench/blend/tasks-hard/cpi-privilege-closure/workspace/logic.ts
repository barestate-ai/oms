import { createHash } from 'node:crypto';
import { need, bytes } from './primitives.ts';
function merge(list) {
  need(Array.isArray(list) && list.length <= 256);
  const m = new Map();
  for (const a of list) {
    bytes(a.key, 32);
    need(typeof a.signer === 'boolean' && typeof a.writable === 'boolean');
    const old = m.get(a.key);
    if (old) {
      old.signer = old.signer || a.signer;
      old.writable = old.writable && a.writable;
    } else m.set(a.key, { ...a });
  }
  return m;
}
export function run(x) {
  const initial = merge(x.accounts);
  need(initial.size === x.accounts.length);
  const out = [];
  function visit(f, parent, caller, depth) {
    need(depth <= 8 && out.length < 64);
    bytes(f.program, 32);
    need(parent.has(f.program) && Array.isArray(f.derived) && Array.isArray(f.children));
    const grants = new Set();
    for (const g of f.derived) {
      need(caller !== null && Array.isArray(g.seeds) && g.seeds.length <= 15);
      bytes(g.key, 32);
      const seeds = g.seeds.map((s) => {
        const b = bytes(s);
        need(b.length <= 32);
        return b;
      });
      const derived = createHash('sha256')
        .update(Buffer.concat([...seeds, bytes(f.program, 32), Buffer.from('ProgramDerivedAddress')]))
        .digest('hex');
      need(derived === g.key);
      grants.add(g.key);
    }
    const meta = merge(f.metas);
    for (const a of meta.values()) {
      const p = parent.get(a.key);
      need(p && (!a.writable || p.writable || grants.has(a.key)) && (!a.signer || p.signer || grants.has(a.key)));
    }
    out.push({ program: f.program, metas: [...meta.values()] });
    for (const child of f.children) visit(child, meta, f.program, depth + 1);
  }
  visit(x.frame, initial, null, 0);
  return out;
}
