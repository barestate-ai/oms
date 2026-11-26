import { MAX, need, array, key, integer, amount } from './strict.ts';
export function load(tables, slot, recent) {
  integer(slot, Number.MAX_SAFE_INTEGER);
  array(recent, 512);
  for (let i = 0; i < recent.length; i++) {
    integer(recent[i], Number.MAX_SAFE_INTEGER);
    need(recent[i] < slot && (!i || recent[i] < recent[i - 1]));
  }
  const out = [];
  for (const t of array(tables, 8)) {
    key(t.key);
    need(!out.some((v) => v.key === t.key));
    const keys = array(t.addresses, 256).map(key),
      extended = integer(t.lastExtendedSlot, Number.MAX_SAFE_INTEGER),
      start = integer(t.lastStartIndex, 256),
      deact = amount(t.deactivationSlot);
    need(start <= keys.length);
    const active =
      extended <= slot &&
      (deact === MAX || deact === BigInt(slot) || (deact < BigInt(slot) && recent.some((v) => BigInt(v) === deact)));
    out.push({ ...t, visible: active ? keys.slice(0, extended === slot ? keys.length : start) : null });
  }
  return out;
}
export function resolve(m, tables) {
  const w = [],
    r = [];
  for (const l of m.lookups) {
    const t = tables.find((t) => t.key === l.key);
    need(t && t.visible !== null);
    for (const i of l.writable) {
      need(i < t.visible.length);
      w.push(t.visible[i]);
    }
    for (const i of l.readonly) {
      need(i < t.visible.length);
      r.push(t.visible[i]);
    }
  }
  const keys = [...m.keys, ...w, ...r];
  need(new Set(keys).size === keys.length && keys.length <= 256);
  return { keys, w, r };
}
