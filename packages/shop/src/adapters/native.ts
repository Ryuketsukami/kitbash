import type { ShopAdapter } from '../adapter.js';
import type { CustomerState, PurchaseResult, ShopConfig, ShopOffering, ShopPackage } from '../types.js';
import { errorMessage, isUserCancelled, mapCustomer, mapOfferings } from './rc-map.js';

type NativeModule = typeof import('@revenuecat/purchases-capacitor');
type NativeSdk = NativeModule['Purchases'];

/** iOS/Android adapter over @revenuecat/purchases-capacitor (StoreKit / Play Billing). */
export class NativeAdapter implements ShopAdapter {
  private sdk: NativeSdk | undefined;

  constructor(private readonly platform: 'ios' | 'android') {}

  async init(cfg: ShopConfig): Promise<void> {
    let mod: { Purchases: NativeSdk };
    try {
      mod = await import('@revenuecat/purchases-capacitor');
    } catch (err) {
      throw new Error(
        `@kitbash/shop: install @revenuecat/purchases-capacitor to use the ${this.platform} shop (${errorMessage(err)})`,
      );
    }
    const apiKey = cfg.apiKeys[this.platform];
    if (!apiKey) {
      throw new Error(`@kitbash/shop: no RevenueCat API key configured for platform "${this.platform}"`);
    }
    await mod.Purchases.configure({ apiKey, ...(cfg.appUserId !== undefined ? { appUserID: cfg.appUserId } : {}) });
    this.sdk = mod.Purchases;
  }

  private get rc(): NativeSdk {
    if (!this.sdk) throw new Error('@kitbash/shop: initShop() has not completed');
    return this.sdk;
  }

  async offerings(): Promise<ShopOffering[]> {
    return mapOfferings(await this.rc.getOfferings());
  }

  async purchase(pkg: ShopPackage): Promise<PurchaseResult> {
    try {
      const res = await this.rc.purchasePackage({ aPackage: pkg.raw });
      return { ok: true, customer: mapCustomer(res) };
    } catch (err) {
      if (isUserCancelled(err)) return { ok: false, cancelled: true };
      return { ok: false, error: errorMessage(err) };
    }
  }

  async restore(): Promise<CustomerState> {
    return mapCustomer(await this.rc.restorePurchases());
  }

  async customer(): Promise<CustomerState> {
    return mapCustomer(await this.rc.getCustomerInfo());
  }

  onCustomerChange(cb: (c: CustomerState) => void): () => void {
    let removed = false;
    const handle = this.rc.addCustomerInfoUpdateListener((info) => {
      if (!removed) cb(mapCustomer(info));
    });
    return () => {
      removed = true;
      void handle.then((h) => h.remove());
    };
  }
}
