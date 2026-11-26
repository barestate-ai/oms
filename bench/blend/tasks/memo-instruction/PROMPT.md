# Refactor memo assembly to deterministic signer metas

## Ticket

Replace the legacy memo builder while retaining these exports. Target Memo v2 program `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`. Encode UTF-8 exactly, no trimming/normalization; reject unpaired surrogates. Wallet policy is ≤512 UTF-8 bytes and ≤32 unique signer keys. Validate each signer as a base58 32-byte address, deduplicate by first occurrence (not sort), and emit readonly signer metas. Decoder is fatal on malformed UTF-8 and preserves BOM as U+FEFF; empty text and NUL are legal. Enforce the same byte cap on decode. No aliasing or caller-array mutation.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export function buildMemo(
  text: string,
  signers: string[],
): {
  programId: string;
  accounts: Array<{ address: string; isSigner: boolean; isWritable: boolean }>;
  data: Uint8Array;
};
export function decodeMemo(data: Uint8Array): string;
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
