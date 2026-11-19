# Decode address lookup table account state

## Ticket

Decode a lookup-table account, not its activation lifecycle. State discriminant u32 LE must be 1. Fixed metadata is 56 bytes: deactivationSlot u64 at 4, lastExtendedSlot u64 at 12, lastExtendedSlotStartIndex u8 at 20, authority Option<Pubkey> tag u8 at 21 and reserved pubkey bytes at 22..53. Metadata bytes 54..55 are reserved and ignored. Addresses begin at 56 as contiguous 32-byte values; count 0..256 and start index ≤ count. For None ignore authority payload. Reject uninitialized/other state, malformed size, invalid option tags, and oversized tables. Return copied keys; slot u64::MAX stays bigint, never Infinity.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export function parseLookupTable(data: Uint8Array): {
  deactivationSlot: bigint;
  lastExtendedSlot: bigint;
  lastExtendedSlotStartIndex: number;
  authority: Uint8Array | null;
  addresses: Uint8Array[];
};
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
