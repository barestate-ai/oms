import { need, bytes } from './primitives.ts';
import { encode } from './wire.ts';
export function run(x) {
  bytes(x.payer, 32);
  bytes(x.blockhash, 32);
  need(Array.isArray(x.instructions) && Array.isArray(x.tables));
  const roles = new Map(),
    programs = new Set(x.instructions.map((i) => i.program));
  const add = (key, signer, writable) => {
    bytes(key, 32);
    need(typeof signer === 'boolean' && typeof writable === 'boolean');
    const old = roles.get(key);
    if (old) {
      old.signer = old.signer || signer;
      old.writable = old.writable && writable;
    } else roles.set(key, { key, signer, writable });
  };
  add(x.payer, true, true);
  for (const i of x.instructions) {
    bytes(i.program, 32);
    bytes(i.data);
    need(Array.isArray(i.accounts));
    for (const a of i.accounts) add(a.key, a.signer, a.writable);
    add(i.program, false, false);
  }
  need(new Set(x.tables.map((t) => t.key)).size === x.tables.length);
  for (const t of x.tables) {
    bytes(t.key, 32);
    need(Array.isArray(t.addresses) && t.addresses.length <= 256);
    t.addresses.forEach((k) => bytes(k, 32));
  }
  const selected = new Map();
  for (const role of roles.values())
    if (!role.signer) {
      for (let t = 0; t < x.tables.length; t++) {
        const n = x.tables[t].addresses.indexOf(role.key);
        if (n >= 0) {
          selected.set(role.key, {
            table: t,
            index: n,
            writable: role.writable,
          });
          break;
        }
      }
    }
  const stat = [...roles.values()].filter((r) => !selected.has(r.key));
  const rank = (r) => (r.key === x.payer ? -1 : r.signer ? (r.writable ? 0 : 1) : r.writable ? 2 : 3);
  stat.sort((a, b) => rank(a) - rank(b));
  const lookups = [],
    w = [],
    r = [];
  for (let t = 0; t < x.tables.length; t++) {
    const values = [...selected.values()].filter((v) => v.table === t);
    if (!values.length) continue;
    const writable = values
        .filter((v) => v.writable)
        .map((v) => v.index)
        .sort((a, b) => a - b),
      readonly = values
        .filter((v) => !v.writable)
        .map((v) => v.index)
        .sort((a, b) => a - b);
    lookups.push({ key: x.tables[t].key, writable, readonly });
    w.push(...writable.map((i) => x.tables[t].addresses[i]));
    r.push(...readonly.map((i) => x.tables[t].addresses[i]));
  }
  const keys = stat.map((v) => v.key),
    all = [...keys, ...r, ...w],
    required = stat.filter((v) => v.signer).length;
  need(all.length <= 256 && required <= 255);
  const m = {
    required,
    roSign: stat.filter((v) => v.signer && !v.writable).length,
    roUnsigned: stat.filter((v) => !v.signer && !v.writable).length,
    keys,
    blockhash: x.blockhash,
    instructions: x.instructions.map((i) => ({
      program: all.indexOf(i.program),
      accounts: i.accounts.map((a) => all.indexOf(a.key)),
      data: i.data,
    })),
    lookups,
  };
  return {
    message: encode(m),
    signerKeys: keys.slice(0, required),
    loadedWritable: w,
    loadedReadonly: r,
  };
}
