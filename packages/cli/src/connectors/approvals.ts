import type { ApprovalRequest } from '../tui/panel.ts';

/** The most text an approval card shows, and so the most a call may carry: what is approved is what is sent. */
export const APPROVAL_TEXT_LIMIT = 16_000;

/** One question for the person, and which answers are offered. */
export interface ApprovalEntry {
  text: string;
  /** What the card above the composer draws; the text stands in for a screen that has no card. */
  card?: ApprovalRequest;
  /** Whether "this session" is offered next to "once". */
  session: boolean;
  signal?: AbortSignal;
}
export type Answer = boolean | 'session';
/** The question on screen: answering it resolves its caller and brings up the next one. */
export interface ShownApproval {
  text: string;
  card?: ApprovalRequest;
  session: boolean;
  answer(answer: Answer): void;
}
export interface ApprovalQueue {
  /** Wait for the person. Resolves false when aborted, denied or closed. */
  request(entry: ApprovalEntry): Promise<Answer>;
  /** What the screen shows now, if anything. */
  current(): ShownApproval | undefined;
  /** Deny the one on screen and everything waiting (the interface is closing). */
  denyAll(): void;
}

/**
 * Sandbox approvals and connector approvals share one row on screen, so they are asked one at a time, in the order they
 * arrived, and never overlap. A request that is aborted while it waits leaves the line without ever being shown.
 */
export function createApprovalQueue(hooks: {
  changed(): void;
  shown?(entry: ShownApproval): void;
  /** One was answered (by the person, an abort or a close), before the next comes up. */
  answered?(): void;
}): ApprovalQueue {
  const waiting: Array<{ entry: ApprovalEntry; settle(answer: Answer): void }> = [];
  let current: (ShownApproval & { release(): void }) | undefined;
  let closed = false;

  function next(): void {
    if (current || closed) return;
    const item = waiting.shift();
    if (!item) return hooks.changed();
    const { entry, settle } = item;
    let done = false;
    const onAbort = () => shown.answer(false);
    const shown: ShownApproval & { release(): void } = {
      text: entry.text,
      ...(entry.card ? { card: entry.card } : {}),
      session: entry.session,
      release: () => entry.signal?.removeEventListener('abort', onAbort),
      answer(answer) {
        if (done) return;
        done = true;
        shown.release();
        current = undefined;
        // "This session" is only a choice when it is offered; otherwise it is the same as once.
        settle(answer === 'session' && !entry.session ? true : answer);
        hooks.answered?.();
        next();
      },
    };
    current = shown;
    entry.signal?.addEventListener('abort', onAbort, { once: true });
    hooks.shown?.(shown);
    hooks.changed();
  }

  return {
    request(entry) {
      if (closed || entry.signal?.aborted) return Promise.resolve(false);
      return new Promise<Answer>((resolve) => {
        const item = { entry, settle: resolve };
        waiting.push(item);
        entry.signal?.addEventListener(
          'abort',
          () => {
            const at = waiting.indexOf(item);
            if (at < 0) return;
            waiting.splice(at, 1);
            resolve(false);
          },
          { once: true },
        );
        next();
      });
    },
    current: () => current,
    denyAll() {
      closed = true;
      current?.answer(false);
      for (const item of waiting.splice(0)) item.settle(false);
      hooks.changed();
    },
  };
}
