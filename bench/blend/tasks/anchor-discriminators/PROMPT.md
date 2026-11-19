# Anchor namespace discriminators

## Ticket

Support conventional 8-byte Anchor discriminators, not custom overrides. Instruction names are hashed verbatim with the `global:` namespace and account names verbatim with `account:`. Names are nonempty strings; preserve case, underscores and Unicode UTF-8 (no normalization). The account matcher checks only the first eight bytes, returning false for data shorter than eight. Use SHA-256. Never mutate inputs.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export function instructionDiscriminator(name: string): Uint8Array;
export function accountDiscriminator(name: string): Uint8Array;
export function hasAccountDiscriminator(data: Uint8Array, name: string): boolean;
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
