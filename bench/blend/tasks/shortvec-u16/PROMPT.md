# Canonical Solana short-vec lengths

## Ticket

Implement Solana's canonical compact-u16 length prefix: seven payload bits per byte, bit 7 signals continuation, least-significant group first. Accept only 0..65535. Decode from offset (default 0), return the first unread absolute offset, and allow subsequent bytes. Reject truncated, overlong/non-minimal and overflowing encodings, and invalid offsets.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export function encodeShortU16(value: number): Uint8Array;
export function decodeShortU16(data: Uint8Array, offset?: number): { value: number; offset: number };
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
