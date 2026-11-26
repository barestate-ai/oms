import { need, hash } from './strict.ts';
import { parse, encode } from './codec.ts';
import { canonical } from './graph.ts';
import { size } from './size.ts';
export function run(x) {
  const n = canonical(parse(x.data)),
    total = n.reduce((s, n) => s + n.value, 0n);
  need(total < 1n << 128n);
  const data = encode(n),
    length = size(n);
  need(data.length === length);
  return {
    data: data.toString('hex'),
    size: length,
    hash: hash(data.subarray(8)).toString('hex'),
    total,
    order: n.map((n) => n.id),
  };
}
