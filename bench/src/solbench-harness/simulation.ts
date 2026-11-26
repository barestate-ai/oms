import { getBase58Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';

const base58Encoder = getBase58Encoder();
const transactionDecoder = getTransactionDecoder();
const messageDecoder = getCompiledTransactionMessageDecoder();

export function simulationError(params: unknown): string | undefined {
  if (!Array.isArray(params) || typeof params[0] !== 'string' || params.length > 2)
    return 'simulateTransaction expects an encoded transaction and optional configuration';
  const [data, config] = params;
  if (config !== undefined && config !== null && (typeof config !== 'object' || Array.isArray(config)))
    return 'invalid simulateTransaction configuration';
  const encoding = config?.encoding ?? 'base58';
  if (encoding !== 'base58' && encoding !== 'base64')
    return 'unsupported simulation encoding; expected base58 or base64';
  if (data.length > (encoding === 'base58' ? 1683 : 1644))
    return 'simulation transaction exceeds the 1232-byte packet limit';
  if (encoding === 'base58' && !/^[1-9A-HJ-NP-Za-km-z]+$/.test(data))
    return 'invalid base58 transaction encoding; default is base58 (set encoding to base64 for base64 data)';
  if (encoding === 'base64' && (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0))
    return 'invalid base64 transaction encoding';
  try {
    const bytes = encoding === 'base58' ? Buffer.from(base58Encoder.encode(data)) : Buffer.from(data, 'base64');
    if (encoding === 'base64' && bytes.toString('base64') !== data) return 'invalid base64 transaction encoding';
    if (bytes.length > 1232) return 'simulation transaction exceeds the 1232-byte packet limit';
    const transaction = transactionDecoder.decode(bytes);
    const version = transaction.messageBytes[0];
    if (version === undefined || (version >= 128 && version !== 128))
      return 'unsupported simulation transaction version';
    messageDecoder.decode(transaction.messageBytes);
  } catch {
    return 'malformed simulation transaction';
  }
}
