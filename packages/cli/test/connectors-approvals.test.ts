import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApprovalQueue, type Answer } from '../src/connectors/approvals.ts';

function queue() {
  const shown: string[] = [];
  let changes = 0;
  const q = createApprovalQueue({ changed: () => changes++, shown: (entry) => shown.push(entry.text) });
  return { q, shown, changes: () => changes };
}
const settled = (promise: Promise<Answer>) => {
  const box: { value?: Answer } = {};
  void promise.then((value) => (box.value = value));
  return box;
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('questions are asked one at a time, in the order they arrived', async () => {
  const { q, shown } = queue();
  const first = settled(q.request({ text: 'sandbox command', session: true }));
  const second = settled(q.request({ text: 'github comment', session: true }));
  const third = settled(q.request({ text: 'docker run', session: false }));
  assert.deepEqual(shown, ['sandbox command']);
  assert.equal(q.current()?.text, 'sandbox command');
  await flush();
  assert.equal(first.value, undefined);
  q.current()!.answer(true);
  await flush();
  assert.equal(first.value, true);
  assert.deepEqual(shown, ['sandbox command', 'github comment']);
  assert.equal(second.value, undefined);
  q.current()!.answer('session');
  await flush();
  assert.equal(second.value, 'session');
  assert.equal(q.current()?.text, 'docker run');
  q.current()!.answer(false);
  await flush();
  assert.equal(third.value, false);
  assert.equal(q.current(), undefined);
});

test('answering twice, or answering a question that was already settled, changes nothing', async () => {
  const { q, shown } = queue();
  const a = settled(q.request({ text: 'a', session: true }));
  const b = settled(q.request({ text: 'b', session: true }));
  const first = q.current()!;
  first.answer(true);
  first.answer(false);
  await flush();
  assert.equal(a.value, true);
  assert.equal(b.value, undefined);
  assert.deepEqual(shown, ['a', 'b']);
});

test('"this session" counts as once where it is not offered', async () => {
  const { q } = queue();
  const a = settled(q.request({ text: 'docker run', session: false }));
  q.current()!.answer('session');
  await flush();
  assert.equal(a.value, true);
});

test('a waiting request that is aborted leaves without being shown; the one on screen is denied and the next appears', async () => {
  const { q, shown } = queue();
  const waitingController = new AbortController();
  const currentController = new AbortController();
  const a = settled(q.request({ text: 'a', session: true, signal: currentController.signal }));
  const b = settled(q.request({ text: 'b', session: true, signal: waitingController.signal }));
  const c = settled(q.request({ text: 'c', session: true }));
  waitingController.abort();
  await flush();
  assert.equal(b.value, false);
  currentController.abort();
  await flush();
  assert.equal(a.value, false);
  assert.deepEqual(shown, ['a', 'c']);
  assert.equal(q.current()?.text, 'c');
  assert.equal(c.value, undefined);
  assert.equal(await q.request({ text: 'late', session: true, signal: AbortSignal.abort() }), false);
});

test('closing denies the one on screen and everything waiting, and refuses new questions', async () => {
  const { q } = queue();
  const a = settled(q.request({ text: 'a', session: true }));
  const b = settled(q.request({ text: 'b', session: true }));
  q.denyAll();
  await flush();
  assert.equal(a.value, false);
  assert.equal(b.value, false);
  assert.equal(q.current(), undefined);
  assert.equal(await q.request({ text: 'c', session: true }), false);
});

test('the screen is told on every change', () => {
  const { q, changes } = queue();
  const before = changes();
  void q.request({ text: 'a', session: true });
  assert.ok(changes() > before);
  const mid = changes();
  q.current()!.answer(true);
  assert.ok(changes() > mid);
});
