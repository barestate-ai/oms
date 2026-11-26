import { need, integer, bytes } from './primitives.ts';
export function sv(n) {
  integer(n);
  const a = [];
  do {
    let b = n & 127;
    n >>>= 7;
    if (n) b |= 128;
    a.push(b);
  } while (n);
  return Buffer.from(a);
}
export function parse(hex) {
  const b = bytes(hex);
  let p = 0;
  const take = (n) => {
    need(p + n <= b.length);
    const a = b.subarray(p, p + n);
    p += n;
    return a;
  };
  const one = () => take(1)[0];
  const short = () => {
    const start = p;
    let n = 0,
      shift = 0;
    for (let i = 0; i < 3; i++) {
      const v = one();
      n |= (v & 127) << shift;
      if (!(v & 128)) {
        need(n <= 65535 && true);
        return n;
      }
      shift += 7;
    }
    throw Error('invalid');
  };
  need(one() === 128);
  const required = one(),
    roSign = one(),
    roUnsigned = one(),
    count = short();
  need(
    count > 0 &&
      count <= 256 &&
      required > 0 &&
      required <= count &&
      roSign < required &&
      roUnsigned <= count - required,
  );
  const keys = Array.from({ length: count }, () => take(32).toString('hex')),
    blockhash = take(32).toString('hex'),
    instructions = Array.from({ length: short() }, () => {
      const program = one(),
        accounts = Array.from(take(short())),
        data = take(short()).toString('hex');
      need(program < count);
      return { program, accounts, data };
    }),
    lookups = Array.from({ length: short() }, () => {
      const key = take(32).toString('hex'),
        writable = Array.from(take(short())),
        readonly = Array.from(take(short()));
      need(new Set([...writable, ...readonly]).size === writable.length + readonly.length);
      return { key, writable, readonly };
    });
  need(p === b.length && new Set(keys).size === count && new Set(lookups.map((l) => l.key)).size === lookups.length);
  const total = count + lookups.reduce((n, l) => n + l.writable.length + l.readonly.length, 0);
  need(total <= 256 && instructions.every((i) => i.accounts.every((a) => a < total)));
  return {
    required,
    roSign,
    roUnsigned,
    keys,
    blockhash,
    instructions,
    lookups,
  };
}
export function encode(m) {
  return Buffer.concat([
    Buffer.from([128, m.required, m.roSign, m.roUnsigned]),
    sv(m.keys.length),
    ...m.keys.map((k) => bytes(k, 32)),
    bytes(m.blockhash, 32),
    sv(m.instructions.length),
    ...m.instructions.flatMap((i) => [
      Buffer.from([i.program]),
      sv(i.accounts.length),
      Buffer.from(i.accounts),
      sv(bytes(i.data).length),
      bytes(i.data),
    ]),
    sv(m.lookups.length),
    ...m.lookups.flatMap((l) => [
      bytes(l.key, 32),
      sv(l.writable.length),
      Buffer.from(l.writable),
      sv(l.readonly.length),
      Buffer.from(l.readonly),
    ]),
  ]).toString('hex');
}
