import { need, integer, bytes, short, hash } from './strict.ts';
import { decode, encode, size } from './wire.ts';
import { rebase } from './rebase.ts';
import { signatures, packet } from './packet.ts';
export function run(x) {
  integer(x.limit, 65535);
  need(x.limit >= 64);
  const m = decode(x.message),
    next = rebase(m, x),
    message = encode(next),
    changed = !message.equals(bytes(x.message)),
    s = signatures(m, x.signatures, next, changed),
    p = packet(message, s.signatures),
    n = short(next.required).length + 64 * next.required + size(next);
  need(n === p.length && n <= x.limit);
  return {
    message: message.toString('hex'),
    packet: p.toString('hex'),
    size: n,
    ...s,
    digest: hash(p).toString('hex'),
  };
}
