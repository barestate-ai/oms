import { need, amount, integer, MAX } from './primitives.ts';
function config(x, epoch) {
  integer(epoch, Number.MAX_SAFE_INTEGER);
  integer(x.at, Number.MAX_SAFE_INTEGER);
  for (const c of [x.old, x.next]) {
    integer(c.bps, 10000);
    amount(c.max);
  }
  return epoch > x.at ? x.next : x.old;
}
function fee(n, c) {
  const raw = (n * BigInt(c.bps) + 0n) / 10000n;
  return raw < amount(c.max) ? raw : amount(c.max);
}
export function run(x) {
  const n = amount(x.net),
    a = config(x.first, x.epoch),
    b = config(x.second, x.epoch);
  function quote(g) {
    const f = fee(g, a),
      s = fee(g, b);
    return { gross: g, firstFee: f, secondFee: s, net: g - f - s };
  }
  need(quote(MAX).net >= n);
  let lo = 0n,
    hi = MAX;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (quote(mid).net >= n) hi = mid;
    else lo = mid + 1n;
  }
  return quote(lo);
}
