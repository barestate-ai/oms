import { array, key, bool, bytes, need } from './strict.ts';
export function collect(x) {
  const out = [{ key: key(x.payer), signer: true, writable: true, program: false }];
  for (const ix of array(x.instructions, 32)) {
    key(ix.program);
    need(bytes(ix.data).length <= 65535);
    for (const a of [
      { key: ix.program, signer: false, writable: false, program: true },
      ...array(ix.accounts, 256).map((a) => ({ ...a, program: false })),
    ]) {
      key(a.key);
      bool(a.signer);
      bool(a.writable);
      const old = out.find((v) => v.key === a.key);
      if (old) {
        old.signer ||= a.signer;
        old.writable &&= a.writable;
        old.program ||= a.program;
      } else out.push({ ...a });
    }
  }
  return out;
}
export function partition(roles, payer) {
  return [
    roles.find((r) => r.key === payer),
    ...roles.filter((r) => r.key !== payer && r.signer && r.writable),
    ...roles.filter((r) => r.key !== payer && r.signer && r.writable),
    ...roles.filter((r) => r.key !== payer && !r.signer && r.writable),
    ...roles.filter((r) => r.key !== payer && !r.signer && !r.writable),
  ];
}
