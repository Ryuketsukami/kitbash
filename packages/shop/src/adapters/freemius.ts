import type { FreemiusBillingCycle, FreemiusPlanEntry, ShopOffering, ShopPackage } from '../types.js';

// The Freemius checkout JS loads from their CDN and exposes a global
// FS.Checkout class (their @freemius/checkout npm package is the same code).
// Only the members this package calls are typed; callback payloads stay
// `unknown` and are handed back raw, same policy as the Paddle/RC shims.

interface FsCheckoutInstance {
  open(opts: Record<string, unknown>): void;
  close?(): void;
}

interface FsGlobal {
  Checkout: new (opts: Record<string, unknown>) => FsCheckoutInstance;
}

declare global {
  interface Window {
    FS?: FsGlobal;
  }
}

const FREEMIUS_SRC = 'https://checkout.freemius.com/js/v1/';

let scriptPromise: Promise<void> | undefined;
const instances = new Map<string, FsCheckoutInstance>();

function loadScript(): Promise<void> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('@kitbash/shop: the Freemius web shop only runs in a browser'));
  }
  if (window.FS?.Checkout) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = FREEMIUS_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = undefined; // allow retry after a network failure
        reject(new Error('@kitbash/shop: failed to load the Freemius checkout JS'));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

/** One FS.Checkout instance per product, shared across opens. */
async function ensureCheckout(productId: string | number, publicKey?: string): Promise<FsCheckoutInstance> {
  await loadScript();
  const fs = window.FS;
  if (!fs?.Checkout) {
    throw new Error('@kitbash/shop: Freemius checkout JS loaded but window.FS.Checkout is missing');
  }
  const key = String(productId);
  let inst = instances.get(key);
  if (!inst) {
    inst = new fs.Checkout({
      product_id: key,
      ...(publicKey !== undefined && publicKey !== '' ? { public_key: publicKey } : {}),
    });
    instances.set(key, inst);
  }
  return inst;
}

export interface FreemiusCheckoutInput {
  productId: string | number;
  publicKey?: string;
  planId: string | number;
  pricingId?: string | number;
  billingCycle?: FreemiusBillingCycle;
  licenses?: number;
  /** Prefills + locks the buyer email so your webhook can attribute the purchase. */
  email?: string;
  coupon?: string;
  /** Extra open() fields (e.g. { sandbox }); merged after the derived ones. */
  extra?: Record<string, unknown>;
}

export interface FreemiusCheckoutResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  /** Raw `purchaseCompleted` payload (purchase + user) when ok. */
  data?: unknown;
}

/**
 * Opens the Freemius overlay for one plan. Resolves ok on `purchaseCompleted`
 * (the overlay still shows its own success screen and closes later), or
 * cancelled when the buyer closes the overlay without purchasing. The actual
 * grant happens server-side off the Freemius webhook — treat ok as "start
 * polling", not "entitlement is live".
 */
export async function openFreemiusCheckout(input: FreemiusCheckoutInput): Promise<FreemiusCheckoutResult> {
  let checkout: FsCheckoutInstance;
  try {
    checkout = await ensureCheckout(input.productId, input.publicKey);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return new Promise<FreemiusCheckoutResult>((resolve) => {
    let settled = false;
    const settle = (r: FreemiusCheckoutResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const opts: Record<string, unknown> = {
      plan_id: String(input.planId),
      ...(input.pricingId !== undefined ? { pricing_id: String(input.pricingId) } : {}),
      ...(input.billingCycle !== undefined ? { billing_cycle: input.billingCycle } : {}),
      ...(input.licenses !== undefined ? { licenses: input.licenses } : {}),
      ...(input.email !== undefined && input.email !== ''
        ? { user_email: input.email, readonly_user: true }
        : {}),
      ...(input.coupon !== undefined ? { coupon: input.coupon } : {}),
      ...input.extra,
      purchaseCompleted: (data: unknown) => settle({ ok: true, data }),
      success: (data: unknown) => settle({ ok: true, data }),
      cancel: () => settle({ ok: false, cancelled: true }),
    };
    try {
      checkout.open(opts);
    } catch (err) {
      settle({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * Builds the web offerings from the configured Freemius plan catalog. There
 * is no client price API, so display prices come straight from the config.
 */
export function freemiusOfferings(entries: FreemiusPlanEntry[]): ShopOffering[] {
  const byOffering = new Map<string, ShopPackage[]>();
  for (const entry of entries) {
    const offeringId = entry.offeringId ?? 'default';
    const planId = String(entry.planId);
    const pkg: ShopPackage = {
      id: entry.id ?? planId,
      offeringId,
      productId: planId,
      title: entry.title ?? planId,
      description: entry.description ?? '',
      priceFormatted: entry.priceFormatted ?? '',
      currency: entry.currency,
      period:
        entry.period ??
        (entry.billingCycle === 'monthly' ? 'P1M' : entry.billingCycle === 'annual' ? 'P1Y' : undefined),
      kind: entry.kind ?? 'unknown',
      raw: { entry },
    };
    const list = byOffering.get(offeringId);
    if (list) list.push(pkg);
    else byOffering.set(offeringId, [pkg]);
  }
  return [...byOffering.entries()].map(([id, packages]) => ({ id, packages, raw: undefined }));
}
