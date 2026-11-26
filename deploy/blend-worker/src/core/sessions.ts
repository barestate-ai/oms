import type { SessionState, SessionStore } from './types.ts';

export class MemorySessions implements SessionStore {
  private entries = new Map<string, { state: SessionState; tail: Promise<unknown> }>();

  async run<T>(key: string, operation: (state: SessionState) => Promise<T>): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { state: { escalated: {}, labels: {}, executorTurns: {}, orchestrations: {} }, tail: Promise.resolve() };
      this.entries.set(key, entry);
    }
    const current = entry;
    const result = current.tail.then(() => operation(current.state));
    current.tail = result.catch(() => {});
    return result;
  }
}
