export interface RcAdminOptions {
  /** RevenueCat SECRET API key (sk_…); defaults to env KB_SHOP_RC_SECRET. */
  secretKey?: string;
  /** Defaults to https://api.revenuecat.com/v1. */
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface RcGrantInput {
  appUserId: string;
  entitlementId: string;
  /** Epoch ms when the granted entitlement lapses. */
  endTimeMs: number;
}

export interface RcRevokeInput {
  appUserId: string;
  entitlementId: string;
}

export interface RcAdmin {
  grantEntitlement(input: RcGrantInput): Promise<void>;
  revokeEntitlement(input: RcRevokeInput): Promise<void>;
}

/**
 * Minimal RevenueCat REST v1 client for promotional entitlements — the bridge
 * that lets a non-store rail (e.g. Freemius web checkout) publish entitlements
 * into RevenueCat as the single source of truth. Grants are naturally
 * idempotent: RC treats a re-grant whose end_time_ms falls within 2 hours of
 * the active grant's expiration as a duplicate, so time-boxed re-grants (say,
 * license expiration + slack) can be re-sent freely by webhook retries and
 * reconciliation runs.
 */
export function createRcAdmin(options: RcAdminOptions = {}): RcAdmin {
  const secretKey = options.secretKey ?? process.env.KB_SHOP_RC_SECRET;
  if (!secretKey) {
    throw new Error(
      '@kitbash/shop/server: set options.secretKey or env KB_SHOP_RC_SECRET before creating the RevenueCat admin client',
    );
  }
  const base = (options.baseUrl ?? 'https://api.revenuecat.com/v1').replace(/\/$/, '');
  const fetchFn = options.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  function entPath(appUserId: string, entitlementId: string): string {
    return `/subscribers/${encodeURIComponent(appUserId)}/entitlements/${encodeURIComponent(entitlementId)}`;
  }

  async function post(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetchFn(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '');
    throw new Error(`@kitbash/shop/server: RevenueCat ${what} failed (${res.status}) ${text.slice(0, 300)}`);
  }

  return {
    async grantEntitlement({ appUserId, entitlementId, endTimeMs }) {
      const res = await post(`${entPath(appUserId, entitlementId)}/promotional`, {
        end_time_ms: Math.round(endTimeMs),
      });
      if (!res.ok) await fail(res, `grant of "${entitlementId}"`);
    },
    async revokeEntitlement({ appUserId, entitlementId }) {
      const res = await post(`${entPath(appUserId, entitlementId)}/revoke_promotionals`, {});
      // 404 = nothing granted / unknown subscriber — the desired state already holds.
      if (!res.ok && res.status !== 404) await fail(res, `revoke of "${entitlementId}"`);
    },
  };
}
