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

export interface ShopConfig {
  /**
   * RevenueCat SDK keys. ios/android drive store billing; `web` is optional
   * and read-only — it lets the web shop read entitlements from RevenueCat
   * (which ingests Paddle purchases). Web CHECKOUT runs on Paddle, see below.
   */
  apiKeys: { ios?: string; android?: string; web?: string };
  appUserId?: string;
  /** Web checkout config. Required on web; ignored on ios/android. */
  paddle?: PaddleWebConfig;
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
