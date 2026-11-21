import {
  loadContext,
  loadLinearIssue,
  parseContextArgument,
  type ContextKind,
  type Forge,
} from '../connectors/context.ts';
import type { Connectors } from '../connectors/runtime.ts';
import type { CommandHandler } from './commands.ts';
import { refuseWith } from './prepared.ts';

/** `/connectors` opens the screen; `/connectors dismiss` ends the sign-in tip for good. */
export const acceptsConnectors = (argument: string): boolean => argument === '' || argument === 'dismiss';

export const connectorsCommand: CommandHandler = (ctx, argument, draft) => {
  if (!ctx.connectors) return refuseWith('Connectors work in a folder chat.');
  if (argument === 'dismiss') {
    ctx.clearDraft(draft);
    ctx.connectors.dismissTip();
    ctx.setNotice('That tip will not show again. /connectors still opens the list.');
    return;
  }
  ctx.openConnectors(draft);
};

const on = (connectors: Connectors, id: Parameters<Connectors['access']>[0]) => connectors.access(id) !== 'off';

/** The commands that need a connected service, for /help: only the ones that would work. */
export function connectorCommandNames(connectors: Connectors | undefined): string[] {
  if (!connectors) return [];
  if (on(connectors, 'github') || on(connectors, 'gitlab')) return ['pr', 'issue', 'ci'];
  return on(connectors, 'linear') ? ['issue'] : [];
}

/** GitHub or GitLab for this folder: the one that is on, or the one its origin remote names when both are. */
function forgeOf(connectors: Connectors): Forge | undefined {
  const github = on(connectors, 'github');
  const gitlab = on(connectors, 'gitlab');
  if (github && gitlab) return connectors.remote() === 'gitlab' ? 'gitlab' : 'github';
  return github ? 'github' : gitlab ? 'gitlab' : undefined;
}

/**
 * /pr, /issue and /ci: OMS fetches the text from your signed-in tool on the host, frames it as outside data, and sends it to
 * the agent with a request. The agent itself needs no access to your credentials for this.
 */
export const contextCommand =
  (kind: ContextKind): CommandHandler =>
  (ctx, argument) => {
    const connectors = ctx.connectors;
    if (!connectors) return refuseWith('This works in a folder chat.');
    const parsed = parseContextArgument(argument);
    // A Linear key only means something for /issue; anywhere else the whole text is the request.
    const linear = kind === 'issue' ? parsed.linear : undefined;
    const request = parsed.linear && !linear ? { instruction: argument.trim() } : parsed;
    const base = {
      run: connectors.run,
      folder: connectors.folder,
      env: connectors.env,
      credentials: connectors.credentials,
    };
    if (linear) {
      if (!on(connectors, 'linear')) return refuseWith("Linear isn't connected · /connectors");
      return {
        ok: true,
        async run(signal) {
          const loaded = await loadLinearIssue(linear, request.instruction, { ...base, signal });
          return { title: 'linear', text: loaded.note, ask: loaded.message };
        },
      };
    }
    const forge = forgeOf(connectors);
    if (!forge) return refuseWith("GitHub or GitLab isn't connected · /connectors");
    return {
      ok: true,
      async run(signal) {
        const loaded = await loadContext(kind, request, forge, { ...base, signal });
        return { title: forge, text: loaded.note, ask: loaded.message };
      },
    };
  };
