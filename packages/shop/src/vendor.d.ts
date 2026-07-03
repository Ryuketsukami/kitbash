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

declare module '@revenuecat/purchases-js' {
  export interface PurchasesJsInstance {
    getOfferings(): Promise<unknown>;
    purchase(params: { rcPackage: unknown }): Promise<unknown>;
    getCustomerInfo(): Promise<unknown>;
  }
  export const Purchases: {
    configure(apiKey: string, appUserId: string): PurchasesJsInstance;
    generateRevenueCatAnonymousAppUserId?(): string;
  };
}
