import { array, key, bool, need } from './strict.ts';
export function merge(m) {
  const out = [];
  for (const a of array(m, 32)) {
    key(a.key);
    bool(a.signer);
    bool(a.writable);
    const old = out.find((v) => v.key === a.key);
    if (old) {
      old.signer ||= a.signer;
      old.writable &&= a.writable;
    } else out.push({ key: a.key, signer: a.signer, writable: a.writable });
  }
  return out;
}
export function allowed(m, parent, grants) {
  for (const a of m) {
    const p = parent.find((p) => p.key === a.key);
    need(p && (!a.writable || p.writable || grants.has(a.key)) && (!a.signer || p.signer || grants.has(a.key)));
  }
  return m;
}
