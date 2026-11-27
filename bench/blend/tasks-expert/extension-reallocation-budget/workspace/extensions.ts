import { need, bytes, array, integer, reader, uint, cat } from './strict.ts';
export function parse(hex) {
  const r = reader(hex),
    records = [];
  while (r.remaining) {
    if (r.remaining < 4) {
      need(r.take(r.remaining).every((v) => v === 0));
      break;
    }
    const t = Number(r.num(2)),
      n = Number(r.num(2));
    if (t === 0 && n === 0) {
      need(r.take(r.remaining).every((v) => v === 0));
      break;
    }
    need(t > 0 && !records.some((a) => a.tag === t));
    records.push({ tag: t, data: r.take(n) });
  }
  return records;
}
export function encode(records) {
  return cat(
    ...records
      .slice()
      .sort((a, b) => b.tag - a.tag)
      .flatMap((a) => [uint(a.tag, 2), uint(a.data.length, 2), a.data]),
  );
}
export function required(kind, records) {
  const tags = records.map((r) => r.tag);
  need(kind === 'mint' || kind === 'account');
  if (kind === 'mint') {
    need(tags.every((t) => t !== 2 && t !== 15));
    if (tags.includes(14)) need(tags.includes(2));
  } else {
    need(tags.every((t) => t !== 1 && t !== 14));
    if (tags.includes(15)) need(tags.includes(2));
  }
  for (const r of records) {
    if (r.tag === 1) need(r.data.length >= 18);
    if (r.tag === 2) need(r.data.length === 8);
    if (r.tag === 14) need(r.data.length === 33);
    if (r.tag === 15) need(r.data.length === 1 && r.data[0] <= 1);
  }
}
