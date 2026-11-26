# Extract runtime custom errors without trusting program text

## Ticket

Decode runtime failure lines of the exact form `Program <base58-id> failed: custom program error: 0x<hex>` or the same with an unsigned decimal code. Require an address decoding to exactly 32 bytes, and a code fitting u32; hex must have at least one digit. Report all matching lines in original order with zero-based line indices, and the last matching error or null. Ignore program-generated `Program log:` text, suffixes, leading/trailing whitespace, invalid addresses and out-of-range codes. A log line is not a JSON object.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export function customErrors(logs: string[]): Array<{ programId: string; code: number; line: number }>;
export function lastCustomError(logs: string[]): { programId: string; code: number; line: number } | null;
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
