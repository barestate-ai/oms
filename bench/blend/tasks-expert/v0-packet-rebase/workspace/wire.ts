import { need, key, bytes, array, integer, reader, compact, short, uint, cat } from './strict.ts';
export function validate(m) {
  const keys = array(m.keys, 256);
  need(keys.length > 0);
  keys.forEach(key);
  key(m.blockhash);
  const req = integer(m.required, 255),
    rs = integer(m.readonlySigned, 255),
    ru = integer(m.readonlyUnsigned, 255);
  need(req > 0 && req <= keys.length && rs < req && ru <= keys.length - req && new Set(keys).size === keys.length);
  let loaded = 0;
  for (const l of array(m.lookups, 65535)) {
    key(l.key);
    array(l.writable, 256).forEach((v) => integer(v, 255));
    array(l.readonly, 256).forEach((v) => integer(v, 255));
    need(new Set([...l.writable, ...l.readonly]).size === l.writable.length + l.readonly.length);
    loaded += l.writable.length + l.readonly.length;
  }
  need(keys.length + loaded <= 256);
  for (const ix of array(m.instructions, 65535)) {
    integer(ix.program, 255);
    need(ix.program < keys.length);
    for (const i of array(ix.accounts, 65535)) {
      integer(i, 255);
      need(i < keys.length + loaded);
    }
    need(bytes(ix.data).length <= 65535);
  }
  return m;
}
export function encode(m) {
  validate(m);
  return cat(
    Buffer.from([128, m.required, m.readonlySigned, m.readonlyUnsigned]),
    short(m.keys.length),
    m.keys.map((k) => bytes(k)),
    bytes(m.blockhash),
    short(m.instructions.length),
    m.instructions.map((i) =>
      cat(
        uint(i.program, 1),
        short(i.accounts.length),
        Buffer.from(i.accounts),
        short(bytes(i.data).length),
        bytes(i.data),
      ),
    ),
    short(m.lookups.length),
    m.lookups.map((l) =>
      cat(
        bytes(l.key),
        short(l.writable.length),
        Buffer.from(l.writable),
        short(l.readonly.length),
        Buffer.from(l.readonly),
      ),
    ),
  );
}
export function decode(hex) {
  const r = reader(hex);
  need(Number(r.num(1)) === 128);
  const m = {
    required: Number(r.num(1)),
    readonlySigned: Number(r.num(1)),
    readonlyUnsigned: Number(r.num(1)),
    keys: [],
    blockhash: '',
    instructions: [],
    lookups: [],
  };
  for (let n = compact(r); n > 0; n--) m.keys.push(r.take(32).toString('hex'));
  m.blockhash = r.take(32).toString('hex');
  for (let n = compact(r); n > 0; n--) {
    const program = Number(r.num(1)),
      accounts = [...r.take(compact(r))],
      data = r.take(compact(r)).toString('hex');
    m.instructions.push({ program, accounts, data });
  }
  for (let n = compact(r); n > 0; n--) {
    const key = r.take(32).toString('hex'),
      writable = [...r.take(compact(r))],
      readonly = [...r.take(compact(r))];
    m.lookups.push({ key, writable, readonly });
  }
  r.done();
  return validate(m);
}
export function size(m) {
  validate(m);
  const w = (n) => short(n).length;
  return (
    4 +
    w(m.keys.length) +
    32 * m.keys.length +
    32 +
    w(m.instructions.length) +
    m.instructions.reduce(
      (n, i) => n + 1 + w(i.accounts.length) + i.accounts.length + w(bytes(i.data).length) + bytes(i.data).length,
      0,
    ) +
    w(m.lookups.length) +
    m.lookups.reduce((n, l) => n + 32 + w(l.writable.length) + l.writable.length + w(l.readonly.length) + 0, 0)
  );
}
