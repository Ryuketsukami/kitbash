// Ambient declarations for the optional RevenueCat peers (not installed here).
// Only the members this package calls are declared; SDK payloads are typed
// `unknown` and narrowed at the call sites, so these stay minimal and honest.

declare module '@revenuecat/purchases-capacitor' {
  export const Purchases: {
    configure(options: { apiKey: string; appUserID?: string }): Promise<void>;
    getOfferings(): Promise<unknown>;
    purchasePackage(options: { aPackage: unknown }): Promise<unknown>;
    restorePurchases(): Promise<unknown>;
    getCustomerInfo(): Promise<unknown>;
    addCustomerInfoUpdateListener(
      listener: (customerInfo: unknown) => void,
    ): Promise<{ remove(): Promise<void> }>;
  };
}

// Read-only on web since the Paddle migration: checkout goes through the
// Paddle.js overlay, purchases-js only fetches customer info / entitlements.
declare module '@revenuecat/purchases-js' {
  export interface PurchasesJsInstance {
    getCustomerInfo(): Promise<unknown>;
  }
  export const Purchases: {
    configure(apiKey: string, appUserId: string): PurchasesJsInstance;
    generateRevenueCatAnonymousAppUserId?(): string;
  };
}
