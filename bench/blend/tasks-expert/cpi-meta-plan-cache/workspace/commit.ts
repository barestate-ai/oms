import { hash, uint, text, bytes } from './strict.ts';
export function commit(n, metas, parent, ordinal) {
  const id = text(n.id, 32);
  return hash(
    Buffer.from('CPI5'),
    bytes(parent, 32),
    uint(n.id.length, 1),
    id,
    bytes(n.program),
    uint(metas.length, 2),
    ...metas.flatMap((a) => [bytes(a.key), uint(a.signer ? 1 : 0, 1), uint(a.writable ? 1 : 0, 1)]),
    uint(ordinal + 1, 2),
  ).toString('hex');
}
