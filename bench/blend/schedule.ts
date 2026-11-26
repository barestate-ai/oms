export interface Cell {
  task_id: string;
  config: string;
  rep: number;
}

export function providerGate(limits: Record<string, number>) {
  const active = new Map<string, number>(),
    queues = new Map<string, Array<() => void>>();
  return async (provider: string) => {
    const limit = limits[provider];
    if (!Number.isSafeInteger(limit) || limit! < 1) throw new Error('Invalid provider concurrency');
    await new Promise<void>((resolve) => {
      if ((active.get(provider) ?? 0) < limit!) {
        active.set(provider, (active.get(provider) ?? 0) + 1);
        resolve();
      } else {
        const queue = queues.get(provider) ?? [];
        queue.push(resolve);
        queues.set(provider, queue);
      }
    });
    let released = false;
    return () => {
      if (released) throw new Error('Provider permit already released');
      released = true;
      const next = queues.get(provider)?.shift();
      if (next) next();
      else active.set(provider, active.get(provider)! - 1);
    };
  };
}

export function settleCalls(
  calls: Array<{ dispatched: boolean; status_class: string; usd: number }>,
  bounds: number[],
) {
  const dispatched = calls.filter((call) => call.dispatched);
  let liability = 0;
  for (let i = 0; i < dispatched.length; i++)
    if (dispatched[i]!.status_class !== 'ok') liability += Math.max(0, (bounds[i] ?? 0) - dispatched[i]!.usd);
  return {
    liability,
    released: bounds.reduce((sum, bound) => sum + bound, 0),
    valid: dispatched.length === bounds.length,
  };
}

export function roundRobin(tasks: string[], configs: string[], reps: number): Cell[] {
  if (!Number.isSafeInteger(reps) || reps < 1 || new Set(configs).size !== configs.length || !configs.length)
    throw new Error('Invalid matrix');
  return tasks.flatMap((task_id) =>
    Array.from({ length: reps }, (_, rep) => configs.map((config) => ({ task_id, config, rep: rep + 1 }))).flat(),
  );
}

export async function schedule<T>(
  cells: Cell[],
  options: {
    concurrency: number;
    maxUsd: number;
    perRunUsd: number;
    provider?: (cell: Cell) => string;
    providerConcurrency?: Record<string, number>;
    retryBackoffMs?: number;
    maxRetries?: number;
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
    run(cell: Cell, index: number, attempt: number): Promise<{ chargeUsd: number; value: T; retry?: boolean }>;
  },
): Promise<T[]> {
  const { concurrency, maxUsd, perRunUsd, run } = options;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isFinite(maxUsd) ||
    maxUsd < 0 ||
    !Number.isFinite(perRunUsd) ||
    perRunUsd <= 0
  )
    throw new Error('Invalid budget');
  const maximum = Math.floor(maxUsd * 1e9),
    reservation = Math.ceil(perRunUsd * 1e9);
  if (Object.values(options.providerConcurrency ?? {}).some((n) => !Number.isSafeInteger(n) || n < 1))
    throw new Error('Invalid provider concurrency');
  const now = options.now ?? Date.now,
    wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    backoff = options.retryBackoffMs ?? 60000,
    maxRetries = options.maxRetries ?? 2;
  if (!Number.isFinite(backoff) || backoff < 0) throw new Error('Invalid retry backoff');
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) throw new Error('Invalid retry limit');
  const pending = cells.map((cell, index) => ({ cell, index, attempt: 0, ready: 0 })),
    providers = new Map<string, number>(),
    cooldowns = new Map<string, number>();
  let used = 0,
    held = 0,
    failure: unknown;
  const active = new Set<Promise<void>>(),
    values: T[] = [];
  while (pending.length || active.size) {
    while (!failure && pending.length && active.size < concurrency && used + held + reservation <= maximum) {
      const position = pending.findIndex((job) => {
        const provider = options.provider?.(job.cell) ?? 'default';
        return (
          Math.max(job.ready, cooldowns.get(provider) ?? 0) <= now() &&
          (providers.get(provider) ?? 0) < (options.providerConcurrency?.[provider] ?? concurrency)
        );
      });
      if (position < 0) break;
      const job = pending.splice(position, 1)[0]!,
        provider = options.provider?.(job.cell) ?? 'default';
      providers.set(provider, (providers.get(provider) ?? 0) + 1);
      held += reservation;
      const promise = Promise.resolve()
        .then(() => run(job.cell, job.index, job.attempt))
        .then((result) => {
          if (!Number.isFinite(result.chargeUsd) || result.chargeUsd < 0) throw new Error('Unknown batch spend');
          used += Math.ceil(result.chargeUsd * 1e9);
          values.push(result.value);
          if (result.retry) cooldowns.set(provider, now() + backoff * 2 ** job.attempt);
          if (result.retry && job.attempt < maxRetries)
            pending.push({ ...job, attempt: job.attempt + 1, ready: now() + backoff * 2 ** job.attempt });
        })
        .catch((error) => {
          used += reservation;
          failure = error;
        })
        .finally(() => {
          held -= reservation;
          active.delete(promise);
          providers.set(provider, providers.get(provider)! - 1);
        });
      active.add(promise);
    }
    if (failure || used + held + reservation > maximum) {
      if (!active.size) break;
    }
    if (active.size) await Promise.race(active);
    else if (pending.length && used + reservation <= maximum)
      await wait(
        Math.max(
          0,
          Math.min(
            ...pending.map((job) => Math.max(job.ready, cooldowns.get(options.provider?.(job.cell) ?? 'default') ?? 0)),
          ) - now(),
        ),
      );
    else break;
  }
  if (failure) throw failure;
  return values;
}
