export type InfraReason = 'usage-limit' | 'api-budget';

export function infraReason(
  record: { status?: string; reason?: string | null; dispatches?: readonly unknown[] },
  calls: readonly { status_class: string }[],
): InfraReason | null {
  if (record.status === 'capped' && record.reason === 'capped:usd' && record.dispatches?.length === 0)
    return 'api-budget';
  if (/usage.?limit|429/i.test(record.reason ?? '') || calls.at(-1)?.status_class === 'rate_limit')
    return 'usage-limit';
  return null;
}

export const RETRY_BACKOFF_MS = 60000;
