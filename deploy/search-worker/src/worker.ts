import { createApp, type Env } from './app.ts';
import { dohResolve } from './fetch-guard.ts';

export { ContextDevGate } from './gate.ts';

const handle = createApp({ fetch: (input, init) => fetch(input, init), resolve: dohResolve, now: Date.now });

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => handle(request, env, ctx),
} satisfies ExportedHandler<Env>;
