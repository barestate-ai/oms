import type { OmsSession } from '@oms/engine';

/** Restore display-only native boundaries without inserting them into model context. */
export function nativeChatDisplayHistory(harness: Pick<OmsSession, 'session'>): readonly unknown[] {
  const branch = harness.session.sessionManager.getBranch?.();
  if (!branch?.some((entry) => entry.type === 'custom' && entry.customType === 'oms.claude.native-boundary'))
    return harness.session.messages;
  return branch.flatMap<unknown>((entry) => {
    if (entry.type === 'message') return [entry.message];
    if (entry.type !== 'custom' || entry.customType !== 'oms.claude.native-boundary') return [];
    const data = entry.data as { sessionId?: unknown } | undefined;
    return [
      {
        role: 'session',
        content: '── new Claude chat ──' + (typeof data?.sessionId === 'string' ? ` · session ${data.sessionId}` : ''),
      },
    ];
  });
}

/** Report observed transport state; selecting a model or checking login is not a live chat. */
export function claudeChatStatus(harness: OmsSession): string {
  const chat = harness.nativeChat;
  if (!chat) return 'Claude chat controls are unavailable here';
  const status = chat.status();
  return [
    `Native Claude session: ${status.sessionId ?? 'not started'}`,
    `State: ${status.state}`,
    ...(status.detail ? [status.detail] : []),
    harness.session.model?.provider === 'claude-code'
      ? 'Claude Code keeps this history · /clear starts a new chat'
      : 'Claude Code is not selected · /model to switch back to its saved chat',
  ].join('\n');
}
