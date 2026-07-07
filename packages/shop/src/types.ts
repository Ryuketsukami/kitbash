export type ShopPlatform = 'ios' | 'android' | 'web';

export interface PaddlePriceEntry {
  /** Paddle price id (`pri_…`). Becomes the package's productId. */
  priceId: string;
  /** Offering to group under; default "default". */
  offeringId?: string;
  /** Package id your UI keys on; defaults to the priceId. */
  id?: string;
  /** Overrides for the Paddle product copy (PricePreview fills these otherwise). */
  title?: string;
  description?: string;
  kind?: ShopPackageKind;
  /** Recurrence to surface on the package, e.g. "P1M". */
  period?: string;
}

export interface PaddleWebConfig {
  /** Browser-safe client-side token that boots Paddle.js. */
  clientToken: string;
  /** Default "production". */
  environment?: 'production' | 'sandbox';
  /** The web paywall catalog — Paddle has no client offerings API, so it is config. */
  prices: PaddlePriceEntry[];
  /**
   * Recommended: mint the transaction on YOUR server (stamp custom_data =
   * { [appUserIdKey]: appUserId } there, unspoofable) and return its id; the
   * overlay then opens on that transaction. Absent ⇒ the overlay opens
   * directly on the price and custom_data is set from the browser.
   */
  createTransaction?: (pkg: ShopPackage) => Promise<string>;
  /** custom_data key RevenueCat reads to attribute the buyer; default "rc_app_user_id". */
  appUserIdKey?: string;
}

export type FreemiusBillingCycle = 'monthly' | 'annual' | 'lifetime';

export interface FreemiusPlanEntry {
  /** Freemius plan id. Becomes the package's productId. */
  planId: string | number;
  /** Specific pricing id within the plan (optional — Freemius picks the default otherwise). */
  pricingId?: string | number;
  /** Offering to group under; default "default". */
  offeringId?: string;
  /** Package id your UI keys on; defaults to the planId. */
  id?: string;
  title?: string;
  description?: string;
  kind?: ShopPackageKind;
  /** Cycle the checkout opens on; subscriptions default to Freemius' own default cycle. */
  billingCycle?: FreemiusBillingCycle;
  /** Display price — Freemius has no client price-preview API, so config supplies it. */
  priceFormatted?: string;
  currency?: string;
  /** Recurrence to surface on the package, e.g. "P1M"; derived from billingCycle when omitted. */
  period?: string;
}

export interface FreemiusWebConfig {
  /** Freemius product id (aka plugin id). */
  productId: string | number;
  /** Product PUBLIC key (pk_…) — browser-safe. */
  publicKey?: string;
  /** The web paywall catalog — Freemius has no client offerings API, so it is config. */
  plans: FreemiusPlanEntry[];
  /** Extra fields merged into every checkout open() call (e.g. { sandbox }). */
  checkoutDefaults?: Record<string, unknown>;
}

export interface ShopConfig {
  /**
   * RevenueCat SDK keys. ios/android drive store billing; `web` is optional
   * and read-only — it lets the web shop read entitlements from RevenueCat
   * (which ingests Paddle purchases directly, or Freemius ones via your
   * webhook → promotional-entitlement bridge). Web CHECKOUT runs on the
   * paddle/freemius config below.
   */
  apiKeys: { ios?: string; android?: string; web?: string };
  appUserId?: string;
  /**
   * Buyer email — prefilled read-only in Freemius web checkout so your
   * webhook can attribute the purchase to this user.
   */
  userEmail?: string;
  /** Web checkout config. Set exactly one of paddle/freemius on web; ignored on ios/android. */
  paddle?: PaddleWebConfig;
  freemius?: FreemiusWebConfig;
}

export type ShopPackageKind = 'subscription' | 'consumable' | 'non_consumable' | 'unknown';

export interface ShopPackage {
  id: string;
  offeringId: string;
  productId: string;
  title: string;
  description: string;
  priceFormatted: string;
  priceMicros?: number;
  currency?: string;
  period?: string;
  kind: ShopPackageKind;
  raw: unknown;
}

export interface ShopOffering {
  id: string;
  packages: ShopPackage[];
  raw: unknown;
}

export interface EntitlementState {
  active: boolean;
  expiresAt?: number;
  productId?: string;
}

export interface CustomerState {
  appUserId: string;
  entitlements: Record<string, EntitlementState>;
  raw: unknown;
}

export interface PurchaseResult {
  ok: boolean;
  cancelled?: boolean;
  customer?: CustomerState;
  error?: string;
}
