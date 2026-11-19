import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const P = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  Q = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const invoke = (p, d) => `Program ${p} invoke [${d}]`;
const ok = (p) => `Program ${p} success`;
const fail = (p) => `Program ${p} failed: custom program error: 0x1`;

test('[visible] empty log', () => {
  assert.deepEqual(api.parseInvocations([]), []);
});
test('[visible] one success', () => {
  const a = api.parseInvocations([invoke(P, 1), ok(P)]);
  assert.equal(a[0].status, 'success');
  assert.equal(a[0].end, 1);
});
