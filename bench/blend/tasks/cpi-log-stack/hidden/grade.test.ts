import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const P = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  Q = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const invoke = (p, d) => `Program ${p} invoke [${d}]`;
const ok = (p) => `Program ${p} success`;
const fail = (p) => `Program ${p} failed: custom program error: 0x1`;

test('[hidden] empty log', () => {
  assert.deepEqual(api.parseInvocations([]), []);
});
test('[hidden] one success', () => {
  const a = api.parseInvocations([invoke(P, 1), ok(P)]);
  assert.equal(a[0].status, 'success');
  assert.equal(a[0].end, 1);
});
test('[hidden] nested parents', () => {
  const a = api.parseInvocations([invoke(P, 1), invoke(Q, 2), ok(Q), ok(P)]);
  assert.equal(a[1].parent, 0);
  assert.equal(a[0].end, 3);
});
test('[hidden] recursive same program', () => {
  const a = api.parseInvocations([invoke(P, 1), invoke(P, 2), ok(P), ok(P)]);
  assert.equal(a[0].end, 3);
  assert.equal(a[1].end, 2);
});
test('[hidden] failure bubbles independently', () => {
  const a = api.parseInvocations([invoke(P, 1), invoke(Q, 2), fail(Q), fail(P)]);
  assert.equal(a[1].error, 'custom program error: 0x1');
  assert.equal(a[0].status, 'failed');
});
test('[hidden] truncated stack', () => {
  const a = api.parseInvocations([invoke(P, 1), invoke(Q, 2)]);
  assert.equal(a[0].status, 'incomplete');
  assert.equal(a[1].end, null);
});
test('[hidden] multiple roots', () => {
  const a = api.parseInvocations([invoke(P, 1), ok(P), invoke(Q, 1), ok(Q)]);
  assert.equal(a[1].parent, null);
});
test('[hidden] ignore spoofed runtime text', () => {
  const a = api.parseInvocations([invoke(P, 1), 'Program log: ' + invoke(Q, 2), ok(P)]);
  assert.equal(a.length, 1);
});
test('[hidden] depth jump rejected', () => {
  assert.throws(() => api.parseInvocations([invoke(P, 1), invoke(Q, 3)]));
});
test('[hidden] wrong completion rejected', () => {
  assert.throws(() => api.parseInvocations([invoke(P, 1), ok(Q)]));
});
test('[hidden] unmatched completion rejected', () => {
  assert.throws(() => api.parseInvocations([ok(P)]));
});
test('[hidden] line indexes count unrelated lines', () => {
  const a = api.parseInvocations(['noise', invoke(P, 1), 'Program log: hi', ok(P)]);
  assert.equal(a[0].start, 1);
  assert.equal(a[0].end, 3);
});
