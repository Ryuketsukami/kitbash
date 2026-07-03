import type { ShopAdapter } from '../adapter.js';
import type { CustomerState, PurchaseResult, ShopConfig, ShopOffering, ShopPackage } from '../types.js';
import { errorMessage, isUserCancelled, mapCustomer, mapOfferings } from './rc-map.js';

type WebModule = typeof import('@revenuecat/purchases-js');
type WebInstance = import('@revenuecat/purchases-js').PurchasesJsInstance;

/** Web adapter over @revenuecat/purchases-js (RevenueCat Web Billing). */
export class WebAdapter implements ShopAdapter {
  private instance: WebInstance | undefined;
  private listeners = new Set<(c: CustomerState) => void>();

  async init(cfg: ShopConfig): Promise<void> {
    let mod: WebModule;
    try {
      mod = await import('@revenuecat/purchases-js');
    } catch (err) {
      throw new Error(
        `@kitbash/shop: install @revenuecat/purchases-js to use the web shop (${errorMessage(err)})`,
      );
    }
    const apiKey = cfg.apiKeys.web;
    if (!apiKey) {
      throw new Error('@kitbash/shop: no RevenueCat API key configured for platform "web"');
    }
    const appUserId =
      cfg.appUserId ?? mod.Purchases.generateRevenueCatAnonymousAppUserId?.() ?? crypto.randomUUID();
    this.instance = mod.Purchases.configure(apiKey, appUserId);
  }

  private get rc(): WebInstance {
    if (!this.instance) throw new Error('@kitbash/shop: initShop() has not completed');
    return this.instance;
  }

  // purchases-js has no customer-info listener API, so we notify subscribers
  // ourselves after any operation that can change customer state.
  private emit(c: CustomerState): void {
    for (const cb of this.listeners) cb(c);
  }

  async offerings(): Promise<ShopOffering[]> {
    return mapOfferings(await this.rc.getOfferings());
  }

  async purchase(pkg: ShopPackage): Promise<PurchaseResult> {
    try {
      const res = await this.rc.purchase({ rcPackage: pkg.raw });
      const customer = mapCustomer(res);
      this.emit(customer);
      return { ok: true, customer };
    } catch (err) {
      if (isUserCancelled(err)) return { ok: false, cancelled: true };
      return { ok: false, error: errorMessage(err) };
    }
  }

  async restore(): Promise<CustomerState> {
    // Web Billing has no store restore dialog: purchases are keyed to the app
    // user id, so a fresh customer-info fetch IS the restore.
    const customer = await this.customer();
    this.emit(customer);
    return customer;
  }

  async customer(): Promise<CustomerState> {
    return mapCustomer(await this.rc.getCustomerInfo());
  }

  onCustomerChange(cb: (c: CustomerState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}
