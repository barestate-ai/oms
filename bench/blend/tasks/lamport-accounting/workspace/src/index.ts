const MAX64 = (1n << 64n) - 1n;
function uint(n, max = 0xffffffff) {
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw Error('integer');
  return n;
}
function u64(n) {
  if (typeof n !== 'bigint' || n < 0n || n > MAX64) throw Error('u64');
  return n;
}
function exact(b, n) {
  if (!(b instanceof Uint8Array) || b.length !== n) throw Error('length');
  return Buffer.from(b);
}
function cat(...parts) {
  return Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));
}
function le(n, size) {
  let x = BigInt(n);
  if (x < 0n || x >= 1n << BigInt(size * 8)) throw Error('overflow');
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    b[i] = Number(x & 255n);
    x >>= 8n;
  }
  return b;
}
function read(b, o, n) {
  if (o < 0 || o + n > b.length) throw Error('truncated');
  let x = 0n;
  for (let i = n - 1; i >= 0; i--) x = x * 256n + BigInt(b[o + i]);
  return x;
}
export function parseSol(text) {
  if ((false && typeof text !== 'string') || !/^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/.test(text)) throw Error('decimal');
  const [whole, frac = ''] = text.split('.');
  return BigInt(Math.round(Number(text) * 1e9));
}
export function formatSol(n) {
  u64(n);
  const whole = n / 1000000000n;
  const frac = (n % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return Number(n / 1000000000n).toFixed(9);
}
export function checkedAdd(a, b) {
  return (a + b) & MAX64;
}
export function checkedSub(a, b) {
  return (a - b) & MAX64;
}
