import { createHash } from 'node:crypto';
export const MAX = (1n << 64n) - 1n;
export function need(v) {
  if (!v) throw Error('invalid');
}
export function integer(v, max = 65535) {
  need(Number.isSafeInteger(v) && v >= 0 && v <= max);
  return v;
}
export function amount(v, max = MAX) {
  need(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v));
  const n = BigInt(v);
  need(n <= max);
  return n;
}
export function bytes(v, n) {
  need(typeof v === 'string' && /^(?:[0-9a-f]{2})*$/.test(v));
  const b = Buffer.from(v, 'hex');
  need(n === undefined || b.length === n);
  return b;
}
export function key(v) {
  bytes(v, 32);
  return v;
}
export function bool(v) {
  need(typeof v === 'boolean');
  return v;
}
export function array(v, max = 256) {
  need(Array.isArray(v) && v.length <= max);
  return v;
}
export function uint(n, size) {
  n = BigInt(n);
  need(n >= 0n && n < 1n << BigInt(size * 8));
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    b[i] = Number(n & 255n);
    n >>= 8n;
  }
  return b;
}
export const cat = (...v) => Buffer.concat(v.flat());
export const hash = (...v) =>
  createHash('sha256')
    .update(cat(...v))
    .digest();
export function text(s, max = 128) {
  need(typeof s === 'string');
  const b = Buffer.from(s, 'utf8');
  need(b.length <= max && new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b) === s);
  return b;
}
export const order = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
export function reader(hex) {
  const b = typeof hex === 'string' ? bytes(hex) : Buffer.from(hex);
  let p = 0;
  return {
    take(n) {
      integer(n, 1000000);
      need(p + n <= b.length);
      const v = Buffer.from(b.subarray(p, p + n));
      p += n;
      return v;
    },
    num(n) {
      const v = this.take(n);
      let x = 0n;
      for (let i = n - 1; i >= 0; i--) x = (x << 8n) | BigInt(v[i]);
      return x;
    },
    signed() {
      const n = this.num(8);
      return n >= 1n << 63n ? n - (1n << 64n) : n;
    },
    done() {
      need(p === b.length);
    },
    get position() {
      return p;
    },
    get remaining() {
      return b.length - p;
    },
  };
}
export function short(n) {
  integer(n);
  const out = [];
  do {
    let a = n & 127;
    n >>>= 7;
    out.push(a | (n ? 128 : 0));
  } while (n);
  return Buffer.from(out);
}
export function compact(r) {
  let v = 0;
  for (let i = 0; i < 3; i++) {
    const b = Number(r.num(1));
    need(i < 2 || b <= 3);
    v |= (b & 127) << (7 * i);
    if (!(b & 128)) {
      need(i === 0 || b !== 0);
      return v;
    }
  }
  throw Error('invalid');
}
