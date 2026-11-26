import { createWorker } from './wrapper.ts';
export { BlendUser, BlendGlobal } from './wrapper.ts';
export default { fetch: createWorker() } satisfies ExportedHandler<import('./wrapper.ts').Env>;
