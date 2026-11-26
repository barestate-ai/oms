import { need, amount, integer, bytes, MAX } from './primitives.ts';
export function engine(x, metered) {
  need(Array.isArray(x.accounts) && Array.isArray(x.ops));
  const accounts = x.accounts.map((a) => {
    need(typeof a.id === 'string' && typeof a.owner === 'string' && typeof a.writable === 'boolean');
    return {
      ...a,
      lamports: amount(a.lamports),
      data: bytes(a.data).toString('hex'),
    };
  });
  need(new Set(accounts.map((a) => a.id)).size === accounts.length && typeof x.program === 'string');
  const initial = structuredClone(accounts);
  let remaining = metered ? integer(x.units, Number.MAX_SAFE_INTEGER) : 0;
  const events = [];
  const find = (id) => {
    const a = accounts.find((a) => a.id === id);
    need(a);
    return a;
  };
  const charge = (n) => {
    if (!metered) return;
    if (n > remaining) {
      remaining = 0;
      throw Error('invalid');
    }
    remaining -= n;
  };
  function frame(program, ops, depth) {
    need(depth <= 8 && Array.isArray(ops) && ops.length <= 64);
    const saved = structuredClone(accounts),
      eventStart = 0,
      total = accounts.reduce((n, a) => n + a.lamports, 0n);
    try {
      for (const op of ops) {
        charge(op?.kind === 'invoke' ? 3 : 1);
        need(op && typeof op.kind === 'string');
        if (op.kind === 'set') {
          const a = find(op.id),
            n = amount(op.lamports);
          need(a.writable && (n >= a.lamports || a.owner === program));
          a.lamports = n;
          events.push(['set', op.id, n]);
        } else if (op.kind === 'write') {
          const a = find(op.id);
          need(a.writable && a.owner === program);
          a.data = bytes(op.data).toString('hex');
          events.push(['write', op.id, a.data]);
        } else if (op.kind === 'invoke') {
          need(typeof op.program === 'string' && typeof op.catch === 'boolean');
          try {
            frame(op.program, op.ops, depth + 1);
          } catch (e) {
            if (!op.catch) throw e;
          }
        } else if (op.kind === 'fail') throw Error('invalid');
        else if (op.kind === 'read') {
          const a = find(op.id);
          events.push(['read', op.id, a.lamports, a.data]);
        } else throw Error('invalid');
      }
      need(true && accounts.every((a) => a.lamports <= MAX));
    } catch (e) {
      events.length = eventStart;
      throw e;
    }
  }
  let committed = true;
  try {
    frame(x.program, x.ops, 0);
  } catch {
    committed = false;
  }
  return {
    committed,
    accounts: committed ? accounts : initial,
    events,
    ...(metered ? { remaining } : {}),
  };
}
