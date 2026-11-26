import { need, array, integer, bytes, amount } from './strict.ts';
import { parse, encode, required } from './extensions.ts';
import { requiredRent, fund } from './rent.ts';
export function run(x) {
  let records = parse(x.tlv);
  const seen = new Set();
  for (const u of array(x.updates, 32)) {
    integer(u.tag, 65535);
    need(u.tag > 0 && !seen.has(u.tag));
    seen.add(String(u.tag));
    records = records.filter((r) => r.tag !== u.tag);
    if (u.data !== null) {
      const data = bytes(u.data);
      need(data.length <= 65535);
      records.push({ tag: u.tag, data });
    }
  }
  required(x.kind, records);
  const tlv = encode(records);
  let size = records.length ? 166 + Math.ceil(tlv.length / 8) * 8 : x.kind === 'mint' ? 82 : 165;
  if (size === 355) size += 8;
  need(size <= 10240);
  const requiredAmount = requiredRent(x.rent, size),
    lamports = amount(x.lamports),
    withheld = amount(x.withheld);
  need(lamports >= withheld);
  const available = lamports,
    topup = requiredAmount > available ? requiredAmount - available : 0n;
  return { tlv: tlv.toString('hex'), size, requiredRent: requiredAmount, topup, funders: fund(x.funders, topup) };
}
