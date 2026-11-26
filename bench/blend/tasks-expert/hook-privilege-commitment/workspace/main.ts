import { key, bytes, array, bool, integer, need, hash, uint } from './strict.ts';
import { seeds } from './recipes.ts';
import { load, merge, effective } from './roles.ts';
export function run(x) {
  const program = key(x.program),
    instruction = bytes(x.instruction);
  need(instruction.length <= 255);
  const a = load(x.base),
    base = a.slice();
  for (const e of array(x.extras, 32)) {
    bool(e.signer);
    bool(e.writable);
    const i = e.programIndex;
    if (i !== null) {
      integer(i, 255);
      need(i < a.length);
    }
    const p = i === null ? program : a[i].key,
      k = hash(...seeds(e.config, instruction, a, base), bytes(p), Buffer.from('ProgramDerivedAddress')).toString(
        'hex',
      );
    a.push(effective(a, k, e.signer, e.writable));
  }
  const accounts = merge(a),
    positions = a.map((v) => accounts.findIndex((o) => o.key === v.key)),
    payload = a.flatMap((v, i) => {
      const u = v;
      return [bytes(v.key), uint(u.signer ? 1 : 0, 1), uint(u.writable ? 1 : 0, 1)];
    });
  return {
    accounts,
    positions,
    commitment: hash(Buffer.from('HOOK5'), uint(accounts.length, 2), ...payload, instruction).toString('hex'),
  };
}
