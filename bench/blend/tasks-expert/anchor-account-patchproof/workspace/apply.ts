import { bytes, cat, need } from './strict.ts';
export function apply(payload, patches, count) {
  const parts = [],
    spans = Array(count);
  let cursor = 0,
    length = 0;
  for (const p of patches) {
    if (p.offset > cursor) {
      const b = payload.subarray(cursor, p.offset);
      parts.push(b);
      length += b.length;
      cursor = p.offset;
    }
    const b = bytes(p.data),
      start = length;
    parts.push(b);
    length += b.length;
    for (const index of p.aliases) spans[index] = { index, start, end: length };
    if (p.delete > 0) cursor += p.delete + bytes(p.data).length;
  }
  parts.push(payload.subarray(cursor));
  const result = cat(parts);
  need(result.length <= 4096);
  return { payload: result, spans };
}
