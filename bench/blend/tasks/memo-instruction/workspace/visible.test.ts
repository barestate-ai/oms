import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './src/index.ts';
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const A = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  B = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',
  C = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8',
  D = 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq';
const meta = (address, isSigner = false, isWritable = false) => ({ address, isSigner, isWritable });
const ix = (accounts = [], programId = D) => ({ programId, accounts, data: Uint8Array.of(9) });

test('[visible] empty memo', () => {
  assert.equal(api.buildMemo('', []).data.length, 0);
});
test('[visible] program address', () => {
  assert.equal(api.buildMemo('hi', []).programId, 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
});
