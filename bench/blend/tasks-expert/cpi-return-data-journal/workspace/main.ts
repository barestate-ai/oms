import { MAX, need, array, text, bool, amount, bytes } from './strict.ts';
import { load, caps, total, account } from './accounts.ts';
import { returnStore } from './returns.ts';
import { meter } from './meter.ts';
export function run(x) {
  need(text(x.program, 32).length > 0);
  array(x.ops, 64);
  const a = load(x.accounts),
    m = meter(x.units),
    ret = returnStore(),
    events = [],
    root = new Map(a.map((v) => [v.id, { id: v.id, signer: v.signer, writable: v.writable }]));
  let count = 0;
  function frame(program, ops, c, depth) {
    ret.clear();
    need(++count <= 64 && depth <= 4 && text(program, 32).length > 0);
    array(ops, 64);
    const saved = structuredClone(a),
      start = events.length,
      sum = total(a);
    try {
      for (const o of ops) {
        const k = o?.kind;
        m.charge(k);
        if (k === 'return') ret.set(program, o.data);
        else if (k === 'readReturn') events.push(ret.read(o.max));
        else if (k === 'invoke') {
          bool(o.catch);
          let success = true;
          try {
            ret.clear();
            const child = caps(o.metas, c);
            frame(o.program, o.ops, child, depth + 1);
          } catch (e) {
            success = false;
            if (!o.catch) throw e;
          }
          events.push(['invoke', o.program, success]);
        } else {
          const v = account(a, c, o.id);
          if (k === 'read') events.push(['read', v.id, v.lamports, v.data]);
          else if (k === 'set') {
            const n = amount(o.lamports);
            need(c.get(v.id).writable && (n >= v.lamports || v.owner === program));
            v.lamports = n;
          } else if (k === 'write') {
            need(c.get(v.id).writable && v.owner === program);
            const b = bytes(o.data);
            need(b.length <= 1024);
            v.data = b.toString('hex');
          } else throw Error('invalid');
        }
      }
      need(total(a) === sum && a.every((v) => v.lamports <= MAX));
    } catch (e) {
      a.splice(0, a.length, ...a);
      events.length = 0;
      throw e;
    }
  }
  let committed = true;
  try {
    frame(x.program, x.ops, root, 0);
  } catch {
    committed = false;
  }
  return { committed, accounts: a, remaining: m.remaining, events, returnData: ret.value };
}
