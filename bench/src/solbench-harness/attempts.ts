import { RETRY_BACKOFF_MS } from '../infra.ts';

export async function retryFork<T extends { reason: string | null }>(
  run: () => Promise<T>,
  options: { canRetry: () => boolean; onRetry: (result: T) => void; wait?: (ms: number) => Promise<void> },
) {
  for (let attempt = 0; ; attempt++) {
    const result = await run();
    if (
      !['fork-failure', 'usage-limit', 'api-budget'].includes(result.reason ?? '') ||
      attempt >= 2 ||
      !options.canRetry()
    )
      return result;
    options.onRetry(result);
    if (result.reason !== 'fork-failure')
      await (options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
        RETRY_BACKOFF_MS * 2 ** attempt,
      );
  }
}
