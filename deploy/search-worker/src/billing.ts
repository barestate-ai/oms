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
  | { ok: false; code: 'SEARCH_PAYMENT_REQUIRED' | 'UNFUNDED_USAGE' | 'INVALID_REQUEST'; message: string };

/** The `oms` gateway's SearchBilling entrypoint, reached through the BILLING service binding. */
export interface SearchBillingRpc {
  charge(input: { userId: string; requestId: string; kind: 'search' | 'fetch' }): Promise<SearchChargeResult>;
  refund(input: { userId: string; requestId: string }): Promise<{ ok: true }>;
}

/** The env surface billing needs: the SearchBilling binding (absent means fail closed) and the usage sink. */
export interface BillingEnv {
  BILLING?: SearchBillingRpc;
  USAGE_EVENTS?: AnalyticsEngineDataset;
}

export const BILLING_PAGE = 'https://barestate.xyz/oms/billing';

const billingError = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
    return billingUnavailable();
  }
  if (result?.ok === true) return undefined;
  if (result?.ok === false) {
    if (result.code === 'SEARCH_PAYMENT_REQUIRED')
      return billingError(
        402,
        'SEARCH_PAYMENT_REQUIRED',
        `Your free searches for this month are used up. Add credits or upgrade to Pro at ${BILLING_PAGE}`,
      );
    if (result.code === 'UNFUNDED_USAGE')
      return billingError(
        402,
        'UNFUNDED_USAGE',
        `You have unpaid usage on your OMS account. Settle it at ${BILLING_PAGE}`,
      );
  }
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
      await env.BILLING?.refund({ userId: user, requestId });
      return;
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
