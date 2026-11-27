# Token-2022 fee schedules and overflow-safe inverse transfer amounts

## Ticket

Implement the 108-byte TransferFeeConfig extension PAYLOAD (no outer Token-2022 TLV): OptionalNonZeroPubkey config authority at 0, withdraw authority at 32 (all-zero means null, no tag), withheldAmount u64 at 64; older fee at 72, newer fee at 90. Each packed fee: epoch u64, maximumFee u64, basisPoints u16. Require basisPoints 0..10000 and older.epoch≤newer.epoch.

Choose newer when current epoch ≥newer.epoch, otherwise older (even if current epoch precedes older.epoch). Fee is ceil(gross*basisPoints/10000), capped at maximumFee. grossForNet returns the SMALLEST u64 gross with gross−fee≥net, with the corresponding fee. Zero net must choose gross=0. Reject unreachable net after fee rather than overflowing, including 100% fees and u64 boundaries. Validate manually constructed config fee fields too; all amounts/epochs unsigned u64 BigInt. Intermediate products may exceed u64; results may not. Do not use floating point.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export type Fee = { epoch: bigint; maximumFee: bigint; basisPoints: number };
export type FeeConfig = {
  configAuthority: Uint8Array | null;
  withdrawAuthority: Uint8Array | null;
  withheldAmount: bigint;
  older: Fee;
  newer: Fee;
};
export function parseFeeConfig(data: Uint8Array): FeeConfig;
export function feeForEpoch(config: FeeConfig, epoch: bigint, gross: bigint): bigint;
export function grossForNet(config: FeeConfig, epoch: bigint, net: bigint): { gross: bigint; fee: bigint };
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
