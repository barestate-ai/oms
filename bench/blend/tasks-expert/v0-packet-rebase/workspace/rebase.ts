import { array, integer, need, key, bytes } from './strict.ts';
export function rebase(m, x) {
  const n = m.keys.length,
    p = array(x.permutation, 256);
  need(p.length === n && new Set(p).size === n && p[0] === 0);
  const group = (i) => (i < m.required ? (i < m.required ? 0 : 1) : i < n - m.readonlyUnsigned ? 2 : 3),
    inverse = [];
  p.forEach((old, i) => {
    integer(old, n - 1);
    need(group(old) === group(i));
    inverse[old] = i;
  });
  const map = (i) => inverse[i % n],
    updates = new Map();
  for (const u of array(x.newData, 32)) {
    integer(u.instruction, m.instructions.length - 1);
    need(!updates.has(u.instruction) && bytes(u.data).length <= 65535);
    updates.set(u.instruction, u.data);
  }
  return {
    ...m,
    keys: p.map((i) => m.keys[i]),
    blockhash: key(x.blockhash),
    instructions: m.instructions.map((i, n) => ({
      ...i,
      program: map(i.program),
      accounts: i.accounts.map(map),
      data: updates.get(n) || i.data,
    })),
  };
}
