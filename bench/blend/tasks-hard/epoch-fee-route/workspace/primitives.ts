export const MAX = (1n << 64n) - 1n;
export function need(ok) {
  if (!ok) throw Error('invalid');
}
export function amount(v) {
  need(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v));
  const n = BigInt(v);
  need(n <= MAX);
  return n;
}
export function integer(v, max = 65535) {
  need(Number.isSafeInteger(v) && v >= 0 && v <= max);
  return v;
}
export function bytes(v, n) {
  need(typeof v === 'string' && /^(?:[0-9a-f]{2})*$/.test(v));
  const b = Buffer.from(v, 'hex');
  need(n === undefined || b.length === n);
  return b;
}
export function unique(v) {
  need(new Set(v).size === v.length);
  return v;
}
