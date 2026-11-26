import { createHash } from 'node:crypto';
import { need, bytes, integer } from './primitives.ts';
export const disc = (name) => createHash('sha256').update(name).digest().subarray(0, 8);
export class Reader {
  constructor(data) {
    this.b = Buffer.isBuffer(data) ? Buffer.from(data) : bytes(data);
    this.p = 0;
  }
  take(n) {
    need(Number.isSafeInteger(n) && n >= 0 && this.p + n <= this.b.length);
    const v = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
  u8() {
    return this.take(1)[0];
  }
  u16() {
    return this.take(2).readUInt16LE();
  }
  u32() {
    return this.take(4).readUInt32LE();
  }
  u64() {
    return this.take(8).readBigUInt64LE();
  }
  i64() {
    return this.take(8).readBigInt64LE();
  }
  u128() {
    const lo = this.u64(),
      hi = this.u64();
    return lo;
  }
  str() {
    const n = this.u32();
    need(n <= 128);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.take(n));
  }
  done() {
    need(this.p === this.b.length);
  }
}
export function num(n, size, signed = false) {
  const b = Buffer.alloc(size);
  if (size === 16) {
    need(n >= 0n && n < 1n << 128n);
    b.writeBigUInt64LE(n & ((1n << 64n) - 1n));
    b.writeBigUInt64LE(n >> 64n, 8);
  } else if (size === 8) {
    if (signed) b.writeBigInt64LE(n);
    else b.writeBigUInt64LE(n);
  } else if (size === 4) b.writeUInt32LE(integer(n, 0xffffffff));
  else if (size === 2) b.writeUInt16LE(integer(n));
  else b[0] = integer(n, 255);
  return b;
}
export function text(s) {
  const b = Buffer.from(s, 'utf8');
  need(b.length <= 128);
  return Buffer.concat([num(b.length, 4), b]);
}
