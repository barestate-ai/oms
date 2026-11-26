import { integer } from './strict.ts';
export function meter(units) {
  let remaining = integer(units, 1000000);
  return {
    charge(k) {
      const n = k === 'invoke' ? 5 : k === 'set' || k === 'write' ? 3 : k === 'return' ? 2 : 1;
      if (remaining < n) {
        throw Error('invalid');
      }
      remaining -= n;
    },
    get remaining() {
      return remaining;
    },
  };
}
