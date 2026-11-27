# Version-0 message codec with loaded-key index space

## Ticket

Implement a version-0 MESSAGE codec. Require version prefix 0x80, then the legacy three-byte header, compact-u16 static key count + 32-byte keys, 32-byte blockhash, compact-u16 instruction count and compiled instructions (u8 program index, compact-u16 index count + u8 indices, compact-u16 data size + bytes). After instructions: compact-u16 lookup count; each lookup is a 32-byte table address, compact-u16 writable count + u8 table indices, compact-u16 readonly count + u8 table indices.

Validate header against static keys only: ≥1 required signer, readonly signed < required, readonly unsigned ≤static count−required. Unlike legacy, the full u8 signer-count wire range is permitted. Require 1..256 static keys and ≤256 combined static+loaded entries. Instruction indices address the combined space, so references beyond static keys may be valid. Table indices are u8 but cannot be bounds-checked without tables; preserve duplicates and order. All address/hash strings decode to 32 bytes. Use only canonical compact-u16, reject truncations, unsupported versions, suffixes and noninteger fields; preserve bytes under reserialization. No packet-size cap at this layer.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export type Header = {
  numRequiredSignatures: number;
  numReadonlySignedAccounts: number;
  numReadonlyUnsignedAccounts: number;
};
export type CompiledInstruction = { programIdIndex: number; accountIndices: number[]; data: Uint8Array };
export type LegacyMessage = {
  header: Header;
  accountKeys: string[];
  recentBlockhash: string;
  instructions: CompiledInstruction[];
};
export type V0Message = LegacyMessage & {
  version: 0;
  addressTableLookups: Array<{ accountKey: string; writableIndexes: number[]; readonlyIndexes: number[] }>;
};
export function parseV0(data: Uint8Array): V0Message;
export function serializeV0(message: V0Message): Uint8Array;
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
