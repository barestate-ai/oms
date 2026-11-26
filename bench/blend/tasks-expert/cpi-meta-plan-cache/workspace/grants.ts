import { array, key, bytes, need, hash } from './strict.ts';
export function validate(proofs) {
  for (const p of array(proofs, 16)) {
    key(p.key);
    for (const s of array(p.seeds, 16)) need(bytes(s).length <= 32);
  }
}
export function grants(proofs, caller) {
  const out = new Set();
  for (const p of proofs) {
    need(caller !== null);
    need(
      hash(...p.seeds.map((s) => bytes(s)), bytes(caller), Buffer.from('ProgramDerivedAddress')).toString('hex') ===
        p.key,
    );
    out.add(p.key);
  }
  return out;
}
