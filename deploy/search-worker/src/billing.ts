import { sha256Hex } from './auth.ts';

/** The `oms` gateway SearchBilling charge result (contract shared with the gateway worker). */
export type SearchChargeResult =
  | {
      ok: true;
      source: 'allowance' | 'balance';
      month: string;
      plan: 'free' | 'pro' | 'team';
      usedUnits: number;
      allowanceUnits: number;
      chargedWalletUnits: number;
    }
  | { ok: false; code: 'SEARCH_PAYMENT_REQUIRED' | 'UNFUNDED_USAGE' | 'INVALID_REQUEST'; message: string }
  | { ok: false; code: 'SEARCH_LIMIT_REACHED'; message: string; resetsAt: number };

/** The `oms` gateway's SearchBilling entrypoint, reached through the BILLING service binding. */
export interface SearchBillingRpc {
  charge(input: { userId: string; requestId: string; kind: 'search' | 'fetch' }): Promise<SearchChargeResult>;
  refund(input: { userId: string; requestId: string }): Promise<{ ok: boolean }>;
}

/** The env surface billing needs: the SearchBilling binding (absent means fail closed) and the usage sink. */
export interface BillingEnv {
  BILLING?: SearchBillingRpc;
  USAGE_EVENTS?: AnalyticsEngineDataset;
}

export const BILLING_PAGE = 'https://barestate.xyz/oms/billing';

const billingError = (status: number, code: string, message: string, extra?: Record<string, unknown>) =>
  new Response(JSON.stringify({ error: { code, message, ...extra } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** The largest ms epoch `new Date` accepts; past it `utcMonthDay` would read "NaN". Same bound as the engine's paywall parsing. */
const MAX_RESETS_AT = 8_640_000_000_000_000;
const UTC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `Dec 1` in UTC from an ms epoch. */
const utcMonthDay = (ms: number) => {
  const date = new Date(ms);
  return `${UTC_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
};
const billingUnavailable = () => billingError(503, 'SEARCH_BILLING_UNAVAILABLE', 'search billing is unavailable');

/**
 * Charges one hosted call for a signed-in user before it is served. Returns the refusal or unavailability
 * response, or undefined when the charge went through; anything but a well-formed answer fails closed.
 */
export async function chargeSearch(
  env: BillingEnv,
  user: string,
  kind: 'search' | 'fetch',
  requestId: string,
): Promise<Response | undefined> {
  if (!env.BILLING) return billingUnavailable();
  let result: SearchChargeResult;
  try {
    result = await env.BILLING.charge({ userId: user, requestId, kind });
  } catch {
    // The RPC threw or timed out, so the gateway may have recorded the charge anyway: give it back once,
    // best-effort, before refusing. The gateway must treat a refund of a requestId it never charged as a no-op.
    await refundSearch(env, user, requestId, kind);
    return billingUnavailable();
  }
  if (result?.ok === true) return undefined;
  if (result?.ok === false) {
    if (result.code === 'SEARCH_PAYMENT_REQUIRED')
      return billingError(
        402,
        'SEARCH_PAYMENT_REQUIRED',
        `Your free searches for this month are used up. Add credits or upgrade to Pro at ${BILLING_PAGE}`,
        { billing: BILLING_PAGE },
      );
    if (
      result.code === 'SEARCH_LIMIT_REACHED' &&
      Number.isFinite(result.resetsAt) &&
      result.resetsAt > 0 &&
      result.resetsAt <= MAX_RESETS_AT
    )
      return billingError(
        402,
        'SEARCH_LIMIT_REACHED',
        `This month's free hosted searches are used up. They reset on ${utcMonthDay(result.resetsAt)}. Add your own search key to keep searching.`,
        { resetsAt: result.resetsAt, billing: BILLING_PAGE },
      );
    if (result.code === 'UNFUNDED_USAGE')
      return billingError(
        402,
        'UNFUNDED_USAGE',
        `You have unpaid usage on your OMS account. Settle it at ${BILLING_PAGE}`,
        { billing: BILLING_PAGE },
      );
    // Any other well-formed refusal means the gateway declined the charge, so there is nothing to refund.
    return billingUnavailable();
  }
  // The answer did not match the charge contract, so the outcome is uncertain: refund once like the throw above.
  await refundSearch(env, user, requestId, kind);
  return billingUnavailable();
}

/**
 * Gives a charge back when the call failed with nothing served, retried once. A refund that still fails must
 * not mask the real error, so it is recorded — a USAGE_EVENTS datapoint and a structured log naming the user
 * digest, requestId and route — instead of thrown. The session token is never logged.
 */
export async function refundSearch(
  env: BillingEnv,
  user: string,
  requestId: string,
  route: 'search' | 'fetch',
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Only a well-formed ok counts: a refusal or an unreadable answer is a failed refund.
      if ((await env.BILLING?.refund({ userId: user, requestId }))?.ok === true) return;
    } catch {}
  }
  try {
    env.USAGE_EVENTS?.writeDataPoint({
      indexes: [user],
      blobs: ['refund_failed', route, requestId],
      doubles: [1],
    });
  } catch {}
  console.error(JSON.stringify({ event: 'refund_failed', route, requestId, user: await sha256Hex(user) }));
}
