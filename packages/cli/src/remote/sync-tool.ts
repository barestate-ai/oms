import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export const SYNC_TOOL = 'session_sync';

/** The agent's way to sync a shared session when the person asks it to. It is offered only while the session is shared. */
export interface SyncTool {
  extension: ExtensionFactory;
  /** What a call does; the interface that owns the session sets it. */
  bind(run: (() => Promise<string>) | undefined): void;
  setActive(on: boolean): void;
}

export function createSyncTool(): SyncTool {
  let pi: ExtensionAPI | undefined;
  let run: (() => Promise<string>) | undefined;
  let wanted = false;
  let started = false;
  const apply = (): void => {
    if (!pi || !started) return;
    const active = pi.getActiveTools();
    const has = active.includes(SYNC_TOOL);
    if (wanted && !has) pi.setActiveTools([...active, SYNC_TOOL]);
    else if (!wanted && has) pi.setActiveTools(active.filter((name) => name !== SYNC_TOOL));
  };
  return {
    extension(api) {
      pi = api;
      api.registerTool({
        name: SYNC_TOOL,
        label: 'Session sync',
        description:
          'Sync this shared session with the other participant, when the user asks to sync. Each side receives what the other did since the last sync as one note. The other participant is asked first and may decline. Takes no arguments.',
        parameters: Type.Object({}),
        async execute() {
          const text = run ? await run() : 'This session is not shared, so there is nothing to sync with.';
          return { content: [{ type: 'text', text }], details: undefined };
        },
      } as ToolDefinition);
      api.on('session_start', () => {
        started = true;
        apply();
      });
    },
    bind(next) {
      run = next;
    },
    setActive(on) {
      wanted = on;
      apply();
    },
  };
}
