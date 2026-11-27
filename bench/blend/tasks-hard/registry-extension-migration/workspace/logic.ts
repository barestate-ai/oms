import { need } from './primitives.ts';
import { Reader, disc, num, text } from './codec.ts';
export function run(x) {
  const r = new Reader(x.data);
  need(r.take(8).equals(disc('account:Registry')));
  const v = r.u8();
  need(v === 1 || v === 2);
  const owner = r.take(32),
    count = r.u16();
  need(count <= 64);
  const records = new Map();
  for (let i = 0; i < count; i++) {
    const tag = v === 1 ? r.u8() : r.u16(),
      n = v === 1 ? r.u16() : r.u32();
    need(tag > 0 && !records.has(tag) && n <= 65535);
    records.set(tag, r.take(n));
  }
  r.done();
  need(records.has(1) && records.has(2));
  const a = new Reader(records.get(1)),
    limit = v === 1 ? a.u64() : a.u128();
  a.done();
  const b = new Reader(records.get(2)),
    name = b.str();
  b.done();
  const permissions = new Map();
  if (records.has(3)) {
    const c = new Reader(records.get(3)),
      n = v === 1 ? c.u32() : c.u16();
    need(n <= 64);
    if (v === 1) {
      for (let i = 0; i < n; i++) {
        const key = c.take(32).toString('hex'),
          p = c.u8();
        need(p <= 7);
        permissions.set(key, p);
      }
    } else {
      const keys = [];
      for (let i = 0; i < n; i++) {
        const key = c.take(32).toString('hex');
        need(!i || keys[i - 1] < key);
        keys.push(key);
        permissions.set(key, 0);
      }
      const width = Math.ceil(n / 8);
      for (let bit = 0; bit < 3; bit++) {
        const map = c.take(width);
        if (n % 8) need(map[width - 1] >>> (n % 8) === 0);
        for (let i = 0; i < n; i++)
          if (map[i >> 3] & (1 << (7 - (i % 8)))) permissions.set(keys[i], permissions.get(keys[i]) | (1 << bit));
      }
    }
    c.done();
  }
  const roles = [...permissions]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, permissions]) => ({ key, permissions })),
    width = Math.ceil(roles.length / 8),
    maps = Array.from({ length: 3 }, () => Buffer.alloc(width));
  roles.forEach((role, i) => {
    for (let bit = 0; bit < 3; bit++) if (role.permissions & (1 << bit)) maps[bit][i >> 3] |= 1 << (i % 8);
  });
  records.set(1, num(limit, 16));
  records.set(2, text(name));
  records.set(3, Buffer.concat([num(roles.length, 2), ...roles.map((v) => Buffer.from(v.key, 'hex')), ...maps]));
  need(records.size <= 64);
  const sorted = [...records].sort((a, b) => a[0] - b[0]);
  return {
    data: Buffer.concat([
      disc('account:Registry'),
      num(2, 1),
      owner,
      num(sorted.length, 2),
      ...sorted.flatMap(([t, p]) => [num(t, 2), num(p.length, 4), p]),
    ]).toString('hex'),
    limit,
    name,
    roles,
    unknownTags: sorted.filter(([t]) => t > 3).map(([t]) => t),
  };
}
