# Borsh vesting records with UTF-8 and fixed options

## Ticket

Implement the Borsh record in field order: owner [u8;32], label String (u32 LE UTF-8 byte length then bytes), delegate Option<[u8;32]> (one-byte tag 0/1), entries Vec<{unlockSlot:u64, amount:u64}> (u32 LE count, then each pair LE). Limit label to 64 encoded bytes and entries to 16. Reject invalid UTF-8 on decode and unpaired UTF-16 surrogates on encode; preserve BOM as an ordinary U+FEFF label character. All u64 values are bigint. Empty labels/vectors and Some(all-zero pubkey) are legal. Options are packed, not SPL COption. Reject trailing data and malicious vector/string lengths before allocating.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export type Vesting = {
  owner: Uint8Array;
  label: string;
  delegate: Uint8Array | null;
  entries: Array<{ unlockSlot: bigint; amount: bigint }>;
};
export function encodeVesting(value: Vesting): Uint8Array;
export function decodeVesting(data: Uint8Array): Vesting;
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
