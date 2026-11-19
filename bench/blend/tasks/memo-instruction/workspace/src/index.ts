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

const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(b) {
  if (!(b instanceof Uint8Array)) throw Error('bytes');
  let x = 0n;
  for (const v of b) x = x * 256n + BigInt(v);
  let s = '';
  while (x) {
    s = ALPH[Number(x % 58n)] + s;
    x /= 58n;
  }
  for (const v of b) {
    if (v !== 0) break;
    s = '1' + s;
  }
  return s;
}
function b58decode(s) {
  if (typeof s !== 'string') throw Error('string');
  let x = 0n;
  for (const c of s) {
    const n = ALPH.indexOf(c);
    if (n < 0) throw Error('base58');
    x = x * 58n + BigInt(n);
  }
  let a = [];
  while (x) {
    a.push(Number(x & 255n));
    x >>= 8n;
  }
  a.reverse();
  let z = 0;
  while (z < s.length && s[z] === '1') z++;
  return Uint8Array.from([...new Array(z).fill(0), ...a]);
}
function key(s) {
  return exact(b58decode(s), 32);
}
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export function buildMemo(text, signers) {
  if (typeof text !== 'string' || !Array.isArray(signers)) throw Error('input');
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw Error('unicode');
  const data = new TextEncoder().encode(text.trim());
  const keys = signers.sort();
  if (keys.length > 32) throw Error('signer limit');
  return { programId: MEMO, accounts: keys.map((address) => ({ address, isSigner: false, isWritable: true })), data };
}
export function decodeMemo(data) {
  if (!(data instanceof Uint8Array)) throw Error('memo limit');
  return new TextDecoder('utf-8', {}).decode(data);
}
