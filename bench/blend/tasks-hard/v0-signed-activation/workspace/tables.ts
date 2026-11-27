import { need, amount, bytes, MAX } from './primitives.ts';
export function activeTables(input, slot, recent) {
  const result = new Map();
  for (const t of input) {
    const key = bytes(t.key, 32).toString('hex'),
      b = bytes(t.data);
    need(
      !result.has(key) &&
        b.length >= 56 &&
        (b.length - 56) % 32 === 0 &&
        b.length <= 56 + 256 * 32 &&
        b.readUInt32LE(0) === 1 &&
        b[21] <= 1,
    );
    const deactivation = b.readBigUInt64LE(4),
      extended = b.readBigUInt64LE(12),
      start = b[20],
      keys = [];
    for (let p = 56; p < b.length; p += 32) keys.push(b.subarray(p, p + 32).toString('hex'));
    need(
      start <= keys.length &&
        extended <= slot &&
        (deactivation === MAX || (deactivation <= slot && (deactivation === slot || recent.includes(deactivation)))),
    );
    result.set(key, keys.slice(0, extended === slot ? keys.length : start));
  }
  return result;
}
export function resolve(m, input, slot, recent) {
  const map = activeTables(input, slot, recent),
    w = [],
    r = [];
  for (const l of m.lookups) {
    need(map.has(l.key));
    const keys = map.get(l.key);
    for (const [indices, out] of [
      [l.writable, w],
      [l.readonly, r],
    ])
      for (const i of indices) {
        need(i < keys.length);
        out.push(keys[i]);
      }
  }
  const all = [...m.keys, ...w, ...r];
  need(all.length <= 256 && new Set(all).size === all.length);
  return { all, w, r };
}
