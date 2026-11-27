# Resolve Token-2022 transfer-hook packed PDA seed recipes

## Ticket

Resolve transfer-hook validation-account ExtraAccountMetaList entries offline. PDA derivation is supplied as a synchronous callback returning the final 32-byte address; do NOT implement curve math in this task. The account is TLV: discriminator [u8;8], payload length u32 LE, payload. Skip unknown entries, reject malformed TLV, require exactly one matching supplied discriminator, permit only an all-zero padding suffix. Matching payload is u32 record count (≤256) followed by EXACTLY count 35-byte records.

Each record: discriminator u8, addressConfig [u8;32], isSigner u8, isWritable u8 (flags strictly 0/1). Discriminator 0 means addressConfig is a literal address. 1 means PDA under hookProgram. 128..255 means PDA under already available account at index discriminator−128; 2..127 are invalid. Accounts initially are baseAccounts, then each resolved extra is appended, permitting references to earlier extras but never forward references. Do not merge duplicates or change requested roles.

PDA addressConfig packs seed recipes: tag 0 terminates (remaining bytes must be zero); tag 1 literal: u8 length then that many bytes; tag 2 instruction-data: u8 offset, u8 length; tag 3 account-key: u8 account index; tag 4 account-data: u8 account index, u8 data offset, u8 length. Every seed ≤32 bytes, ≤15 seeds, empty seeds legal; consuming exactly all 32 config bytes needs no terminator. All slices must be in bounds, never silently truncated. Account-data recipes may reference ONLY base accounts because extra-account data was not supplied. Validate 32-byte addresses and callback results, propagate callback errors, and isolate input buffers even from a mutating callback.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export type AccountData = { address: Uint8Array; data: Uint8Array };
export type ExtraMeta = { address: Uint8Array; isSigner: boolean; isWritable: boolean };
export function resolveExtraMetas(
  list: Uint8Array,
  discriminator: Uint8Array,
  instructionData: Uint8Array,
  baseAccounts: AccountData[],
  hookProgram: Uint8Array,
  derivePda: (seeds: Uint8Array[], program: Uint8Array) => Uint8Array,
): ExtraMeta[];
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
