import type { OmsSession } from '@oms/engine';
import type { CommandContext } from './commands.ts';
import type { Prepared } from './prepared.ts';

export const acceptsBlend = (argument: string): boolean => ['', 'auto', 'pro', 'flash', 'off'].includes(argument);
const previous = new WeakMap<OmsSession, { provider: string; id: string }>();

export function blendCommand(ctx: CommandContext, argument: string, draft: string | undefined): Prepared {
  return {
    ok: true,
    async run() {
      const current = ctx.harness.session.model;
      if (argument === 'off') {
        const saved = previous.get(ctx.harness);
        if (!saved)
          return { title: 'Blend', text: 'No previous model saved for this session; use /model to select one.' };
        await ctx.harness.selectModel(saved.provider, saved.id);
        previous.delete(ctx.harness);
        ctx.clearDraft(draft);
        return { title: 'Blend off', text: `Returned to ${saved.provider}/${saved.id}.` };
      }
      const id = `blend-${argument || 'auto'}`;
      await ctx.harness.selectModel('blend', id);
      if (current && current.provider !== 'blend')
        previous.set(ctx.harness, { provider: current.provider, id: current.id });
      ctx.clearDraft(draft);
      return {
        title: 'Blend',
        text: `Selected blend/${id} (provisional policy). /blend off returns to the previous model.`,
      };
    },
  };
}
