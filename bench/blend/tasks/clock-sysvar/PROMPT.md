# Clock sysvar signed timestamp compatibility

## Ticket

Encode/decode the exact 40-byte Clock sysvar, five 8-byte LE fields: slot u64, epochStartTimestamp i64, epoch u64, leaderScheduleEpoch u64, unixTimestamp i64. All runtime values are bigints. Negative Unix/epoch-start timestamps are legal and use two's complement; slot/epochs are unsigned. Validate input domains and reject suffixes. Do not infer any relation between epochs and slots.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export type Clock = {
  slot: bigint;
  epochStartTimestamp: bigint;
  epoch: bigint;
  leaderScheduleEpoch: bigint;
  unixTimestamp: bigint;
};
export function decodeClock(data: Uint8Array): Clock;
export function encodeClock(clock: Clock): Uint8Array;
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
