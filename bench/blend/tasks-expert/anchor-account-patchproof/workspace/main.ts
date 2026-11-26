import { integer, need, bytes, hash, uint } from './strict.ts';
import { parse, encode, size } from './schema.ts';
import { plan } from './plan.ts';
import { apply } from './apply.ts';
export function run(x) {
  integer(x.targetVersion, 2);
  need(x.targetVersion >= 1);
  const old = parse(bytes(x.data)),
    p = plan(x.patches, old.length),
    result = apply(old, p, x.patches.length),
    data = encode(result.payload, x.targetVersion),
    length = size(result.payload.length, x.targetVersion);
  need(data.length === length);
  return {
    data: data.toString('hex'),
    payload: result.payload.toString('hex'),
    spans: result.spans,
    size: length,
    commitment: hash(Buffer.from('PATCH5'), uint(x.targetVersion, 1), data).toString('hex'),
  };
}
