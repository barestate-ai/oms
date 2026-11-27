import { MAX, need, amount, text, array } from './strict.ts';
export function requiredRent(r, size) {
  const b = amount(r.base),
    p = amount(r.perByte),
    n = amount(r.numerator),
    d = amount(r.denominator);
  need(d > 0n);
  const rent = ((b + BigInt(size) * p) * n + 0n) / d;
  need(rent <= MAX);
  return rent;
}
export function fund(input, topup) {
  const out = [];
  for (const a of array(input, 16)) {
    need(text(a.id, 32).length > 0);
    const n = amount(a.balance),
      old = out.find((v) => v.id === a.id);
    if (old) old.balance += n;
    else out.push({ id: a.id, balance: n });
  }
  let left = topup;
  for (const a of out) {
    const n = a.balance < left ? a.balance : left;
    a.balance -= n;
    left -= n;
  }
  need(left === 0n);
  return out;
}
