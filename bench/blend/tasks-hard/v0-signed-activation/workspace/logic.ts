import { createPublicKey, verify } from 'node:crypto';
import { need, amount, bytes } from './primitives.ts';
import { parse } from './wire.ts';
import { resolve } from './tables.ts';
export function run(x) {
  const m = parse(x.message);
  need(Array.isArray(x.signatures) && x.signatures.length === m.required && Array.isArray(x.recentSlots));
  const { all, w, r } = resolve(m, x.tables, amount(x.slot), x.recentSlots.map(amount));
  for (let i = 0; i < m.required; i++) {
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes(m.keys[i], 32)]),
      format: 'der',
      type: 'spki',
    });
    need(verify(null, bytes(x.message), key, bytes(x.signatures[i], 64)));
  }
  const writable = m.keys.map((_k, i) =>
    i < m.required ? i <= m.required - m.roSign : i < m.keys.length - m.roUnsigned,
  );
  return {
    keys: all,
    signers: m.keys.slice(0, m.required),
    writable: [...writable, ...w.map(() => true), ...r.map(() => false)],
  };
}
