# Repair CPI invocation stack reconstruction

## Ticket

Return invocations in start order from runtime lines `Program <id> invoke [<depth>]`, `Program <id> success`, or `Program <id> failed: <message>`. Validate ids decode to 32 bytes; lines with invalid ids are unrelated text. Ignore all other lines, including program-generated lookalikes prefixed by `Program log:`. start/end are zero-based log indices; parent is the index in the returned array. Runtime depth must be exactly stack length+1. Completion must match the top stack program, including recursive CPI to the same program; mismatches or completions without a frame throw. Truncated logs are allowed: unclosed frames stay incomplete with end=null. Each root begins at depth 1. Preserve the full failure message in error only on failed frames.

## Public API

Implement these exports in `src/index.ts` (types describe the required runtime values):

```ts
export function parseInvocations(
  logs: string[],
): Array<{
  programId: string;
  depth: number;
  start: number;
  end: number | null;
  status: 'success' | 'failed' | 'incomplete';
  parent: number | null;
  error?: string;
}>;
```

## Constraints

Use TypeScript and Node.js 22.19+ builtins only. No npm dependencies, RPC, network access, or external processes. Do not change tests. Inputs described as bytes are Uint8Array (Buffer is acceptable as input); return fresh Uint8Array values, never aliases, unless stated otherwise. Do not mutate caller data. Throw an Error for invalid input; message/class is not graded unless specified. All integers must be exact, finite, and in the documented range. Reject trailing bytes for full-record decoders unless this ticket explicitly permits a suffix. No undefined behavior on truncated data.

Run the public checks with `node --test`. The grading test is supplied separately and will be placed at workspace root; it imports `./src/index.ts`. Public cases are examples, not the full contract.
