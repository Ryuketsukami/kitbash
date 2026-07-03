export type ShopPlatform = 'ios' | 'android' | 'web';

export interface ShopConfig {
  apiKeys: { ios?: string; android?: string; web?: string };
  appUserId?: string;
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
