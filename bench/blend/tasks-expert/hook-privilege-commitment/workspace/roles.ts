import { array, key, bool, bytes, need } from './strict.ts';
export function load(base) {
  return array(base, 32).map((a) => {
    key(a.key);
    need(bytes(a.data).length <= 255);
    return { ...a, signer: bool(a.signer), writable: bool(a.writable) };
  });
}
export function merge(a) {
  const out = [];
  for (const v of a) {
    const old = out.find((o) => o.key === v.key);
    if (old) {
      old.signer ||= v.signer;
      old.writable &&= v.writable;
    } else out.push({ key: v.key, signer: v.signer, writable: v.writable });
  }
  return out;
}
export function effective(a, k, s, w) {
  const matches = a.filter((v) => v.key === k);
  return {
    key: k,
    signer: s || !matches.length || matches.some((a) => a.signer),
    writable: w || !matches.length || matches.some((a) => a.writable),
  };
}
