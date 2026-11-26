import { need, bytes, array } from './strict.ts';
export function seeds(config, instruction, available, base) {
  const b = bytes(config, 32),
    out = [];
  let p = 0;
  const take = () => {
      need(p < b.length);
      return b[p++];
    },
    slice = (b, o, n) => {
      need(n <= 32 && o + n < b.length);
      return Buffer.from(b.subarray(o, o + n));
    };
  while (p < b.length) {
    const tag = take();
    if (tag === 0) {
      need(b.subarray(p).every((n) => n === 0));
      break;
    }
    let s;
    if (tag === 1) {
      const n = take();
      s = slice(b, p, n);
      p += n;
    } else if (tag === 2) {
      const o = take(),
        n = take();
      s = slice(instruction, o, n);
    } else if (tag === 3) {
      const i = take();
      need(i < available.length);
      s = bytes(available[i].key, 32);
    } else {
      need(tag === 4);
      const i = take(),
        o = take(),
        n = take();
      need(i < available.length);
      s = slice(bytes(available[i].data ?? ''), o, n);
    }
    need(out.length <= 15);
    out.push(s);
  }
  return out;
}
