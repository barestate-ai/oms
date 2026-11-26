import { need, reader, hash, cat, uint } from './strict.ts';
const disc = (v) => hash(Buffer.from('account:Patch' + v)).subarray(0, 8);
export function parse(raw) {
  const r = reader(raw),
    d = r.take(8),
    v = d.equals(disc(1)) ? 1 : d.equals(disc(2)) ? 2 : 0;
  need(v);
  if (v === 2) need(r.num(2) === 0n);
  const len = r.num(v === 1 ? 4 : 8);
  need(len <= 4096n);
  const payload = r.take(Number(len));
  if (v === 2) need(r.take(32).equals(hash(payload)));
  r.done();
  return payload;
}
export function encode(payload, v) {
  const b = cat(disc(v), v === 2 ? uint(0, 2) : Buffer.alloc(0), uint(payload.length, v === 1 ? 4 : 8), payload);
  return v === 1 ? b : cat(b, hash(b));
}
export const size = (n, v) => (v === 1 ? 16 : 50) + n;
