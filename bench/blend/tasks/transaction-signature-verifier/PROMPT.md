# Verify raw legacy and v0 transaction signer ordering

## Ticket

The offline verifier must verify Ed25519 signatures over the EXACT original message bytes, using the first header.numRequiredSignatures static account keys in order. Support legacy and version-0 messages. Use Node crypto Ed25519 (algorithm null; raw 32-byte keys wrapped as SPKI as necessary); never hash, reserialize or reorder the signed message. Return every failed signer index in ascending order. Invalid/all-zero signatures return valid=false, not an input-format error; a correct signature for the wrong slot still fails.

Reject malformed wire separately by throwing: >1232 bytes, noncanonical/overflow/truncated short-vec, zero signature count, signature/header count mismatch, duplicate static keys, bad message header/indices, unsupported versions and trailing bytes. The message module is part of this task and must fully validate both message versions: header counts refer to static keys; at least one writable signer, ≤256 combined static+loaded keys; canonical length prefixes; instruction indices in combined bounds. Legacy signers ≤127; v0 permits u8. V0 lookups are not resolved for signature checking. Return copied signer keys.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export function verifyTransaction(wire: Uint8Array): {
  valid: boolean;
  invalidSignerIndices: number[];
  signerKeys: Uint8Array[];
};
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
