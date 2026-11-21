import { formatElapsed, formatTokens, type AgentDefinition, type Helpers, type HelperView } from '@oms/engine';
import { refuse, refuseWith } from './prepared.ts';
import { clipLine } from './transcript.ts';
import type { CommandContext, CommandHandler } from './commands.ts';

const pad = (value: string, width: number): string => value.padEnd(width);

const where = (agent: AgentDefinition): string =>
  agent.source === 'built-in'
    ? 'built-in'
    : agent.source === 'personal'
      ? '~/.oms/agents'
      : '.oms-agents (this folder)';

const statusText = (helper: HelperView, now: number): string => {
  const elapsed = formatElapsed((helper.endedAt ?? now) - helper.startedAt);
  if (helper.status === 'waiting') return `waiting${helper.waitingFor ? ` for ${helper.waitingFor}` : ''}`;
  if (helper.status === 'running') return `running ${elapsed}`;
  if (helper.status === 'interrupted') return 'interrupted';
  return `${helper.status} ${elapsed}`;
};

/** The agents that can be started, then the helpers of this conversation. */
export function agentsText(
  helpers: Helpers,
  available: { ok: true } | { ok: false; reason: string },
  now = Date.now(),
): string {
  const { agents, problems } = helpers.agents();
  const nameWidth = Math.max(...agents.map((agent) => agent.name.length)) + 2;
  const lines = ['Agents'];
  for (const agent of agents)
    lines.push(
      `  ${pad(agent.name, nameWidth)}${pad(agent.tools === 'edit' ? 'edits' : 'read-only', 11)}${pad(clipLine(agent.description, 60), 62)}${where(agent)}`,
    );
  if (!available.ok) lines.push('', available.reason);
  const ran = helpers.list();
  if (ran.length) {
    lines.push('This session');
    for (const helper of ran)
      lines.push(
        `  ${pad(helper.id, 12)}${pad(`"${clipLine(helper.task, 38)}"`, 44)}${pad(statusText(helper, now), 20)}${pad(helper.model, 24)}${formatTokens(helper.tokens)}`,
      );
  }
  if (problems.length) lines.push('', `Skipped: ${problems.map((problem) => clipLine(problem, 160)).join('; ')}`);
  lines.push('', 'New agent · /agents new <name> [--project] [--edit] <what it does>');
  return lines.join('\n');
}

/** /agents [new <name> [--project] [--edit] <what it does>] */
export const agentsCommand: CommandHandler = (ctx, argument, draft) => {
  const { harness } = ctx;
  if (harness.kind !== 'chat') return refuseWith('Helpers are only available in a folder chat');
  const words = argument.trim().split(/\s+/).filter(Boolean);
  if (words[0] !== 'new') {
    if (words.length) return refuse('Usage: /agents · /agents new <name> [--project] [--edit] <what it does>');
    ctx.show('agents', agentsText(harness.helpers, harness.helpers.available()), draft);
    return;
  }
  const rest = words.slice(1);
  const name = rest.shift();
  const flags = new Set(rest.filter((word) => word === '--project' || word === '--edit'));
  const description = rest.filter((word) => !word.startsWith('--')).join(' ');
  if (!name || !description) return refuse('Usage: /agents new <name> [--project] [--edit] <what it does>');
  try {
    const path = harness.helpers.createAgent({
      name,
      description,
      scope: flags.has('--project') ? 'project' : 'personal',
      tools: flags.has('--edit') ? 'edit' : 'read',
    });
    ctx.show('agents', `Created ${path} · edit its instructions, then ask for ${name} by name`, draft);
  } catch (error) {
    return refuse(clipLine(error instanceof Error ? error.message : "Couldn't create the agent", 200));
  }
};

/** /team <goal>: the chat's agent splits the goal, starts helpers together, checks their reports and combines them. */
export const teamCommand: CommandHandler = (ctx: CommandContext, argument, draft) => {
  const { harness } = ctx;
  if (harness.kind !== 'chat') return refuseWith('Helpers are only available in a folder chat');
  if (!argument.trim()) return refuse('Usage: /team <goal>');
  const available = harness.helpers.available();
  if (!available.ok) return refuseWith(available.reason);
  ctx.ask(
    `Work on this as a team: ${argument.trim()}\n\nSplit it into independent pieces and start a helper for each with the agent tool, all in one turn. Do the small or tightly coupled parts yourself. Check every report, then combine the results and tell me what changed.`,
    draft,
  );
};
