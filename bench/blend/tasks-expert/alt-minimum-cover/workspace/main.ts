import { key, integer, short } from './strict.ts';
import { load } from './bank.ts';
import { collect, partition } from './roles.ts';
import { encode, size } from './wire.ts';
export function run(x) {
  key(x.blockhash);
  integer(x.limit, 65535);
  if (x.limit < 64) throw Error('invalid');
  const roles = collect(x),
    bank = load(x.tables, x.slot, x.recentSlots),
    usable = bank.filter((t) => t.visible !== null),
    candidates = [];
  for (let mask = 1; mask < 2 ** usable.length; mask++) {
    const selected = usable.filter((_, i) => mask & (1 << i)),
      loaded = new Map(),
      lookups = [];
    for (const t of selected) {
      const w = [],
        r = [];
      for (const a of roles) {
        if (a.key === x.payer || a.signer || a.program || loaded.has(a.key)) continue;
        const i = t.visible.indexOf(a.key);
        if (i >= 0) {
          loaded.set(a.key, true);
          (a.writable ? w : r).push(i);
        }
      }
      w.sort((a, b) => a - b);
      r.sort((a, b) => a - b);
      if (w.length + r.length) lookups.push({ key: t.key, writable: w, readonly: r });
    }
    const stat = partition(
        roles.filter((a) => !loaded.has(a.key)),
        x.payer,
      ),
      w = lookups.flatMap((l) => bank.find((t) => t.key === l.key).visible.filter((_, i) => l.writable.includes(i))),
      r = lookups.flatMap((l) => l.readonly.map((i) => bank.find((t) => t.key === l.key).visible[i])),
      keys = [...stat.map((a) => a.key), ...w, ...r],
      m = {
        required: stat.filter((a) => a.signer).length,
        readonlySigned: stat.filter((a) => a.signer && !a.writable).length,
        readonlyUnsigned: stat.filter((a) => !a.signer && !a.writable).length,
        keys: stat.map((a) => a.key),
        blockhash: x.blockhash,
        instructions: x.instructions.map((i) => ({
          program: keys.indexOf(i.program),
          accounts: i.accounts.map((a) => keys.indexOf(a.key)),
          data: i.data,
        })),
        lookups,
      };
    try {
      const message = encode(m),
        n = short(m.required).length + 64 * m.required + size(m);
      if (n > x.limit) continue;
      candidates.push({
        message: message.toString('hex'),
        size: n,
        signers: m.keys.slice(0, m.required),
        tables: lookups.map((l) => l.key),
        loaded: [...w, ...r],
        order: keys,
      });
    } catch {}
  }
  candidates.sort(
    (a, b) =>
      a.size - b.size ||
      b.tables.join('').localeCompare(a.tables.join(''), 'en') ||
      a.message.localeCompare(b.message, 'en'),
  );
  return candidates[0] ?? null;
}
