# Encode System Program transfer, assign and allocate

## Ticket

Build the instruction-data payloads used by the System Program (not account metas). Bincode enum discriminants are u32 LE: Transfer=2 followed by u64 lamports, Assign=1 followed by a 32-byte owner, Allocate=8 followed by u64 space. Zero amounts/space are legal. Reject out-of-range u64s or wrong owner width.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export function transferData(lamports: bigint): Uint8Array;
export function assignData(owner: Uint8Array): Uint8Array;
export function allocateData(space: bigint): Uint8Array;
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
