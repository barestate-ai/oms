import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OmsSession } from '@oms/engine';
import { acceptsBlend, blendCommand } from '../src/tui/blend.ts';
import {
  commandHelp,
  chatHelp,
  commandMatches,
  findCommand,
  parseCommand,
  acceptsArgument,
  canRunWhileBusy,
  type CommandContext,
} from '../src/tui/commands.ts';

test('/blend parses defaults and named profiles, appears in help/completion, refuses invalid arguments and busy work', () => {
  const command = findCommand('blend')!;
  assert.ok(command);
  assert.match(commandHelp(), /\/blend.*auto\|pro\|flash\|off/);
  assert.match(chatHelp(), /\/blend/);
  assert.ok(commandMatches('/bl')?.some((c) => c.name === 'blend'));
  assert.equal(canRunWhileBusy(command, ''), false);
  for (const argument of ['', 'auto', 'pro', 'flash', 'off']) {
    assert.ok(acceptsBlend(argument));
    assert.ok(acceptsArgument(command, argument));
    assert.ok(parseCommand(`/blend${argument ? ' ' + argument : ''}`));
  }
  for (const argument of ['on', 'cheap', 'pro extra', 'AUTO']) assert.equal(acceptsBlend(argument), false);
});
test('/blend saves previous model once, switches profiles, restores on off and keeps state isolated per session', async () => {
  const session = { model: { provider: 'anthropic', id: 'claude-sonnet-5-5' } };
  const calls: string[] = [];
  let clear = 0;
  const harness = {
    session,
    async selectModel(provider: string, id: string) {
      calls.push(`${provider}/${id}`);
      session.model = { provider, id };
    },
  } as unknown as OmsSession;
  const ctx = {
    harness,
    clearDraft() {
      clear++;
    },
  } as unknown as CommandContext;
  for (const argument of ['', 'pro', 'flash', 'off']) {
    const prepared = blendCommand(ctx, argument, 'draft');
    assert.ok(prepared.ok);
    await prepared.run(new AbortController().signal);
  }
  assert.deepEqual(calls, ['blend/blend-auto', 'blend/blend-pro', 'blend/blend-flash', 'anthropic/claude-sonnet-5-5']);
  assert.equal(clear, 4);
  const off = blendCommand(ctx, 'off', undefined);
  assert.ok(off.ok);
  assert.match((await off.run(new AbortController().signal))!.text, /No previous model/);
  const other = blendCommand({ ...ctx, harness: { ...harness } as OmsSession }, 'off', undefined);
  assert.ok(other.ok);
  assert.match((await other.run(new AbortController().signal))!.text, /No previous model/);
});
test('failed sign-in selection retains draft and does not install restoration state', async () => {
  let clear = 0;
  const harness = {
    session: { model: { provider: 'xai', id: 'grok-4.3' } },
    async selectModel() {
      throw Error('Blend needs a signed-in invited OMS account. Use /login.');
    },
  } as unknown as OmsSession;
  const ctx = {
    harness,
    clearDraft() {
      clear++;
    },
  } as unknown as CommandContext;
  const prepared = blendCommand(ctx, 'auto', 'draft');
  assert.ok(prepared.ok);
  await assert.rejects(prepared.run(new AbortController().signal), /invited.*\/login/);
  assert.equal(clear, 0);
  const off = blendCommand(ctx, 'off', undefined);
  assert.ok(off.ok);
  assert.match((await off.run(new AbortController().signal))!.text, /No previous model/);
});
