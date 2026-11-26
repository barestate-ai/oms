# Decode token accounts without option-offset drift

## Ticket

Parse exactly the legacy 165-byte SPL Token Account layout. Offsets: mint 0, owner 32, amount u64 64, delegate COption<Pubkey> 72, state byte 108, isNative COption<u64> 109, delegatedAmount u64 121, closeAuthority COption<Pubkey> 129. All integers LE. COption uses a FOUR-byte tag, then its fixed-size payload regardless of Some/None; only tags 0/1 are valid. None payload is ignored. State must be 0 (uninitialized), 1 (initialized), or 2 (frozen). nativeReserve is null for non-native tokens and may be 0n for Some(0). Do not enforce semantic constraints such as delegatedAmount ≤ amount on an untrusted snapshot.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export function parseTokenAccount(data: Uint8Array): {
  mint: Uint8Array;
  owner: Uint8Array;
  amount: bigint;
  delegate: Uint8Array | null;
  state: number;
  nativeReserve: bigint | null;
  delegatedAmount: bigint;
  closeAuthority: Uint8Array | null;
};
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
