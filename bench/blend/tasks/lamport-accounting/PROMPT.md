# Remove floating-point lamport accounting

## Ticket

Amounts must round-trip through decimal UI strings without Number precision loss. parseSol accepts only a canonical unsigned whole part (`0` or a nonzero digit followed by digits), optionally a decimal point plus 1–9 digits. Reject signs, spaces, exponent notation, leading whole-part zeros and more than 9 fractional digits, even trailing zeroes. Convert exactly at 1 SOL = 1,000,000,000 lamports. All amounts and arithmetic operands/results are u64 bigints. formatSol emits no unnecessary fractional trailing zeroes or decimal point.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export function parseSol(text: string): bigint;
export function formatSol(lamports: bigint): string;
export function checkedAdd(a: bigint, b: bigint): bigint;
export function checkedSub(a: bigint, b: bigint): bigint;
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
