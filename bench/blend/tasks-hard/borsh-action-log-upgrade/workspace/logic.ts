import { need } from './primitives.ts';
import { Reader, disc, num, text } from './codec.ts';
export function run(x) {
  const r = new Reader(x.data),
    d = r.take(8),
    v1 = d.equals(disc('account:ActionLogV1'));
  need(v1 || d.equals(disc('account:ActionLogV2')));
  let nodes = 0,
    total = 0n;
  function list(reader, count, depth) {
    need(count <= 64 && (count === 0 || depth <= 4));
    const out = [];
    for (let i = 0; i < count; i++) {
      ++nodes;
      const tag = reader.u8();
      if (tag === (v1 ? 0 : 2)) {
        const amount = v1 ? null : reader.u128(),
          to = reader.take(32),
          n = v1 ? reader.u64() : amount;
        total += n;
        need(total < 1n << 128n);
        out.push(Buffer.concat([num(2, 1), num(n, 16), to]));
      } else if (tag === (v1 ? 1 : 0)) {
        const until = reader.i64(),
          hard = v1 ? 1 : reader.u8();
        need(hard <= 1);
        out.push(Buffer.concat([num(0, 1), num(until, 8, true), num(hard, 1)]));
      } else if (tag === (v1 ? 2 : 1)) {
        let value = '';
        if (v1) value = reader.str();
        else {
          const has = reader.u8();
          need(has <= 1);
          if (has) value = reader.str();
        }
        out.push(value ? Buffer.concat([num(1, 1), num(1, 1), text(value)]) : Buffer.from([1, 0]));
      } else {
        need(tag === 3);
        let child;
        if (v1) child = list(reader, reader.u32(), depth + 1);
        else {
          const len = reader.u32(),
            count = reader.u16(),
            sub = new Reader(reader.take(len));
          child = list(sub, count, depth + 1);
          sub.done();
        }
        const payload = Buffer.concat(child);
        out.push(Buffer.concat([num(3, 1), num(child.length, 4), num(child.length, 2), payload]));
      }
    }
    return out;
  }
  const count = r.u32(),
    encoded = list(r, count, 0);
  r.done();
  return {
    data: Buffer.concat([disc('account:ActionLogV2'), num(count, 4), ...encoded]).toString('hex'),
    transferTotal: total,
    nodes,
  };
}
