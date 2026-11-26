# PDA and ATA derivation with Ed25519 decompression

## Ticket

Implement Solana PDA derivation without crypto libraries. node:crypto may supply SHA-256 only; implement the compressed Ed25519 Edwards-Y curve-membership check with BigInt. Match Solana/Kit decompression: field p=2^255−19, d=−121665/121666; clear the high sign bit, reduce y modulo p (noncanonical y is not by itself rejection), test the Edwards equation, reject sign=1 when x=0, and do not reject small-order points. Wrong byte length returns false for isOnCurve.

createProgramAddress hashes concatenated seeds, program bytes, then the UTF-8 marker `ProgramDerivedAddress`; reject on-curve hashes. Program is 32 bytes, ≤16 seeds, ≤32 bytes each, empty seeds legal. findProgramAddress appends a one-byte bump, trying 255 down through 0 inclusively; accept ≤15 caller seeds and never swallow input validation errors. Return the highest valid bump.

deriveAta uses the Associated Token Program `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, with owner, tokenProgram, mint as the three seeds in that order. These arguments are 32 bytes. Reject off-curve owners unless explicitly opted in; mint and tokenProgram need not be on curve. tokenProgram is caller-selected so both Token and Token-2022 addresses work.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export function isOnCurve(bytes: Uint8Array): boolean;
export function createProgramAddress(seeds: Uint8Array[], program: Uint8Array): Uint8Array;
export function findProgramAddress(seeds: Uint8Array[], program: Uint8Array): { address: Uint8Array; bump: number };
export function deriveAta(
  owner: Uint8Array,
  mint: Uint8Array,
  tokenProgram: Uint8Array,
  allowOwnerOffCurve?: boolean,
): { address: Uint8Array; bump: number };
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
