import { array, text, need, amount, bool, bytes } from './strict.ts';
export function load(input) {
  const out = [];
  for (const a of array(input, 32)) {
    need(text(a.id, 32).length > 0 && text(a.owner, 32).length > 0);
    const v = {
      id: a.id,
      owner: a.owner,
      lamports: amount(a.lamports),
      data: bytes(a.data).toString('hex'),
      signer: bool(a.signer),
      writable: bool(a.writable),
    };
    need(v.data.length <= 2048);
    const old = out.find((v) => v.id === a.id);
    if (old) {
      need(old.owner === v.owner && old.lamports === v.lamports && old.data === v.data);
      old.signer ||= v.signer;
      old.writable &&= v.writable;
    } else out.push(v);
  }
  return out;
}
export function caps(metas, parent) {
  const out = new Map();
  for (const a of array(metas, 32)) {
    need(typeof a.id === 'string');
    bool(a.signer);
    bool(a.writable);
    const old = out.get(a.id);
    if (old) {
      old.signer ||= a.signer;
      old.writable ||= a.writable;
    } else out.set(a.id, { id: a.id, signer: a.signer, writable: a.writable });
  }
  for (const a of out.values()) {
    const p = parent.get(a.id);
    need(p && (!a.signer || p.writable) && (!a.writable || p.writable));
  }
  return out;
}
export const total = (a) => a.reduce((n, a) => n + a.lamports, 0n);
export function account(a, c, id) {
  need(typeof id === 'string' && c.has(id));
  const v = a.find((v) => v.id === id);
  need(v);
  return v;
}
