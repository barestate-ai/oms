import { need, amount, integer, MAX } from './primitives.ts';
function config(x, epoch) {
  integer(epoch, Number.MAX_SAFE_INTEGER);
  integer(x.at, Number.MAX_SAFE_INTEGER);
  for (const c of [x.old, x.next]) {
    integer(c.bps, 10000);
    amount(c.max);
  }
  return epoch >= x.at ? x.next : x.old;
}
function fee(n, c) {
  const raw = (n * BigInt(c.bps) + 9999n) / 10000n;
  return raw < amount(c.max) ? raw : amount(c.max);
}
export function run(x) {
  const c = config(x.schedule, x.epoch);
  let mint = amount(x.mintWithheld);
  need(Array.isArray(x.accounts) && Array.isArray(x.ops));
  const accounts = x.accounts.map((a) => {
    need(typeof a.id === 'string' && a.id.length > 0 && typeof a.frozen === 'boolean');
    return { ...a, balance: amount(a.balance), withheld: amount(a.withheld) };
  });
  need(new Set(accounts.map((a) => a.id)).size === accounts.length);
  const original = structuredClone(accounts),
    initial = mint,
    fees = [];
  for (const op of x.ops) {
    need(['transfer', 'harvest', 'withdraw'].includes(op.kind));
    if (op.kind === 'transfer') {
      amount(op.amount);
      amount(op.expectedFee);
      need(typeof op.from === 'string' && typeof op.to === 'string');
    }
    if (op.kind === 'harvest') need(Array.isArray(op.ids) && op.ids.every((k) => typeof k === 'string'));
    if (op.kind === 'withdraw') need(typeof op.to === 'string' && typeof op.authority === 'boolean');
  }
  try {
    const get = (id) => {
      const a = accounts.find((a) => a.id === id);
      need(a);
      return a;
    };
    for (const op of x.ops) {
      if (op.kind === 'transfer') {
        const a = get(op.from),
          b = get(op.to),
          n = amount(op.amount),
          f = fee(n, c);
        need(a !== b && !a.frozen && !b.frozen && a.balance >= n && f === amount(op.expectedFee));
        a.balance -= n;
        b.balance += n;
        b.withheld += f;
        fees.push(f);
      } else if (op.kind === 'harvest') {
        need(new Set(op.ids).size === op.ids.length);
        for (const id of op.ids) {
          const a = get(id);
          mint += a.withheld;
        }
      } else {
        const a = get(op.to);
        need(op.authority === true && !a.frozen);
        a.balance += mint;
        mint = 0n;
      }
      need(mint <= MAX && accounts.every((a) => a.balance <= MAX && a.withheld <= MAX));
    }
    return { committed: true, accounts, mintWithheld: mint, fees };
  } catch {
    return { committed: false, accounts, mintWithheld: mint, fees: [] };
  }
}
