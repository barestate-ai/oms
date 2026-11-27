import { array, key, bytes, need, cat, short } from './strict.ts';
export function signatures(m, entries, next, changed) {
  const a = array(entries, 255);
  need(a.length === m.required);
  const map = new Map();
  for (const e of a) {
    key(e.key);
    need(m.keys.slice(0, m.required).includes(e.key) && !map.has(e.key));
    if (e.signature !== null) bytes(e.signature, 64);
    map.set(e.key, e.signature);
  }
  const stale = [],
    out = next.keys.slice(0, next.required).map((key, i) => {
      let signature = map.get(key);
      if (changed && signature !== null && key !== m.keys[0]) {
        stale.push(i);
        signature = null;
      }
      return { key, signature };
    });
  return { signatures: out, stale };
}
export function packet(message, signatures) {
  return cat(
    short(signatures.length),
    signatures.map((s) => (s.signature === null ? Buffer.alloc(32) : bytes(s.signature, 64))),
    message,
  );
}
