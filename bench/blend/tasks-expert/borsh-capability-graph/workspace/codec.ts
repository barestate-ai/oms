import { need, reader, uint, bytes, text, hash, cat } from './strict.ts';
export const disc = (n) => hash(Buffer.from('account:' + n)).subarray(0, 8);
export function parse(hex) {
  const r = reader(hex),
    d = r.take(8),
    v = d.equals(disc('Graph1')) ? 1 : d.equals(disc('Graph2')) ? 2 : 0;
  need(v);
  const count = Number(r.num(v === 1 ? 4 : 2));
  need(count < 32);
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const n = Number(r.num(v === 1 ? 4 : 1));
    need(n > 0 && n <= 32);
    const id = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(r.take(n)),
      value = r.num(8),
      len = Number(r.num(v === 1 ? 4 : 2));
    need(len <= 32);
    const edges = [];
    for (let j = 0; j < len; j++) {
      if (v === 1) {
        const size = Number(r.num(4));
        need(size > 0 && size <= 32);
        edges.push(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(r.take(size)));
      } else edges.push(Number(r.num(2)));
    }
    nodes.push({ id, value, edges });
  }
  r.done();
  need(new Set(nodes.map((n) => n.id)).size === nodes.length);
  for (const n of nodes) {
    text(n.id, 32);
    if (v === 2)
      n.edges = n.edges.map((i) => {
        need(i < nodes.length);
        return nodes[i].id;
      });
    need(n.edges.every((id) => nodes.some((n) => n.id === id)));
  }
  return nodes;
}
export function encode(nodes) {
  return cat(
    disc('Graph2'),
    uint(nodes.length, 2),
    nodes.map((n) =>
      cat(
        uint(text(n.id).length, 1),
        text(n.id),
        uint(n.value, 16),
        uint(n.edges.length, 2),
        [...new Set(n.edges)].map((e) =>
          uint(
            nodes.findIndex((n) => n.id === e),
            2,
          ),
        ),
      ),
    ),
  );
}
