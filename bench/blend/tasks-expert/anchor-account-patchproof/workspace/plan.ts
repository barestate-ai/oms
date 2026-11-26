import { array, integer, need, bytes } from './strict.ts';
export function plan(input, len) {
  const out = [];
  array(input, 32).forEach((p, index) => {
    integer(p.offset, len);
    integer(p.delete, len - p.offset);
    need(bytes(p.data).length <= 1024);
    const old =
      p.delete > 0 ? out.find((v) => v.offset === p.offset && v.delete === p.delete && v.data === p.data) : null;
    if (old) old.aliases = [index];
    else out.push({ ...p, index, aliases: [index] });
  });
  out.sort(
    (a, b) =>
      a.offset - b.offset ||
      (a.delete === 0 && b.delete > 0 ? -1 : a.delete > 0 && b.delete === 0 ? 1 : b.index - a.index),
  );
  const dels = out.filter((p) => p.delete > 0);
  for (let i = 1; i < dels.length; i++) need(dels[i].offset > dels[i - 1].offset + dels[i - 1].delete);
  for (const p of out.filter((p) => p.delete === 0))
    need(dels.every((d) => !(d.offset <= p.offset && p.offset < d.offset + d.delete)));
  return out;
}
