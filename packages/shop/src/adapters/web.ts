import type { ShopAdapter } from '../adapter.js';
import type {
  CustomerState,
  FreemiusWebConfig,
  PaddleWebConfig,
  PurchaseResult,
  ShopConfig,
  ShopOffering,
  ShopPackage,
} from '../types.js';
import { ensurePaddle, paddleOfferings } from './paddle.js';
import type { PaddleApi, PaddleCheckoutEvent } from './paddle.js';
import { freemiusOfferings, openFreemiusCheckout } from './freemius.js';
import { errorMessage, mapCustomer } from './rc-map.js';

type WebModule = typeof import('@revenuecat/purchases-js');
type WebInstance = import('@revenuecat/purchases-js').PurchasesJsInstance;

const DEFAULT_APP_USER_ID_KEY = 'rc_app_user_id';

// Non-store → RevenueCat ingestion is server-to-server (Paddle via RC's
// integration, Freemius via your webhook → promotional-entitlement bridge)
// and takes a few seconds, so right after checkout completes the entitlement
// is not instantly readable.
const GRACE_POLL_DELAYS_MS = [4000, 10000, 20000];

/**
 * Web adapter: checkout runs through the Paddle.js overlay OR the Freemius
 * overlay (exactly one is configured); entitlements are read from RevenueCat
 * (optional `apiKeys.web`). Paddle purchases reach RevenueCat through its
 * Paddle integration, attributed via transaction custom_data[appUserIdKey];
 * Freemius purchases reach it through your server's webhook bridge, attributed
 * by buyer email. Without an RC web key, customer() reports no entitlements
 * and your own server (fed by the webhooks) is the source of truth.
 */
export class WebAdapter implements ShopAdapter {
  private paddle: PaddleApi | undefined;
  private rc: WebInstance | undefined;
  private paddleCfg: PaddleWebConfig | undefined;
  private freemiusCfg: FreemiusWebConfig | undefined;
  private appUserId = '';
  private userEmail: string | undefined;
  private listeners = new Set<(c: CustomerState) => void>();
  private pending: ((r: PurchaseResult) => void) | undefined;
  private freemiusOpen = false;

  async init(cfg: ShopConfig): Promise<void> {
    const pcfg = cfg.paddle;
    const fcfg = cfg.freemius;
    if (pcfg?.clientToken && fcfg?.productId) {
      throw new Error('@kitbash/shop: configure either paddle or freemius for web checkout, not both');
    }
    if (fcfg?.productId) {
      this.freemiusCfg = fcfg;
    } else if (pcfg?.clientToken) {
      this.paddleCfg = pcfg;
    } else {
      throw new Error(
        '@kitbash/shop: web checkout needs config.paddle ({ clientToken, prices }) or config.freemius ({ productId, plans })',
      );
    }
    this.userEmail = cfg.userEmail;

    if (cfg.apiKeys.web) {
      let mod: WebModule;
      try {
        mod = await import('@revenuecat/purchases-js');
      } catch (err) {
        throw new Error(
          `@kitbash/shop: install @revenuecat/purchases-js for web entitlement reads, or drop apiKeys.web (${errorMessage(err)})`,
        );
      }
      this.appUserId =
        cfg.appUserId ?? mod.Purchases.generateRevenueCatAnonymousAppUserId?.() ?? crypto.randomUUID();
      this.rc = mod.Purchases.configure(cfg.apiKeys.web, this.appUserId);
    } else {
      // No RC on web: purchases still attribute to this id via custom_data,
      // but an anonymous id changes per load — pass appUserId for real users.
      this.appUserId = cfg.appUserId ?? crypto.randomUUID();
    }

    if (this.paddleCfg) {
      this.paddle = await ensurePaddle(this.paddleCfg.clientToken, this.paddleCfg.environment ?? 'production', (ev) =>
        this.onPaddleEvent(ev),
      );
    }
    // The Freemius checkout JS loads lazily on the first purchase.
  }

  private get pad(): PaddleApi {
    if (!this.paddle) throw new Error('@kitbash/shop: initShop() has not completed');
    return this.paddle;
  }

  private get catalog(): PaddleWebConfig {
    if (!this.paddleCfg) throw new Error('@kitbash/shop: initShop() has not completed');
    return this.paddleCfg;
  }

  private emit(c: CustomerState): void {
    for (const cb of this.listeners) cb(c);
  }

  async offerings(): Promise<ShopOffering[]> {
    if (this.freemiusCfg) return freemiusOfferings(this.freemiusCfg.plans);
    return paddleOfferings(this.pad, this.catalog.prices);
  }

  async purchase(pkg: ShopPackage): Promise<PurchaseResult> {
    if (this.freemiusCfg) return this.purchaseFreemius(pkg, this.freemiusCfg);
    if (this.pending) return { ok: false, error: '@kitbash/shop: a checkout is already open' };
    const open: Record<string, unknown> = {};
    try {
      if (this.catalog.createTransaction) {
        open.transactionId = await this.catalog.createTransaction(pkg);
      } else {
        open.items = [{ priceId: pkg.productId, quantity: 1 }];
        open.customData = { [this.catalog.appUserIdKey ?? DEFAULT_APP_USER_ID_KEY]: this.appUserId };
      }
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    return new Promise<PurchaseResult>((resolve) => {
      this.pending = resolve;
      try {
        this.pad.Checkout.open(open);
      } catch (err) {
        this.pending = undefined;
        resolve({ ok: false, error: errorMessage(err) });
      }
    });
  }

  private async purchaseFreemius(pkg: ShopPackage, cfg: FreemiusWebConfig): Promise<PurchaseResult> {
    if (this.freemiusOpen) return { ok: false, error: '@kitbash/shop: a checkout is already open' };
    this.freemiusOpen = true;
    try {
      const entry = cfg.plans.find((p) => String(p.planId) === pkg.productId);
      const res = await openFreemiusCheckout({
        productId: cfg.productId,
        publicKey: cfg.publicKey,
        planId: pkg.productId,
        pricingId: entry?.pricingId,
        billingCycle: entry?.billingCycle,
        email: this.userEmail,
        extra: cfg.checkoutDefaults,
      });
      if (!res.ok) {
        return res.cancelled ? { ok: false, cancelled: true } : { ok: false, error: res.error };
      }
      return await this.settleOk();
    } finally {
      this.freemiusOpen = false;
    }
  }

  // The Paddle overlay reports through the page-global eventCallback:
  // completed resolves ok (the overlay shows its own success screen and
  // closes later), closed-before-completed is the user backing out.
  private onPaddleEvent(ev: PaddleCheckoutEvent): void {
    const resolve = this.pending;
    if (!resolve) return;
    switch (ev.name) {
      case 'checkout.completed':
        this.pending = undefined;
        void this.settleOk().then(resolve);
        break;
      case 'checkout.error':
        this.pending = undefined;
        resolve({ ok: false, error: errorMessage(ev.error) });
        break;
      case 'checkout.closed':
        this.pending = undefined;
        resolve({ ok: false, cancelled: true });
        break;
    }
  }

  /** Post-completion settle shared by both rails: read RC once, then grace re-polls. */
  private async settleOk(): Promise<PurchaseResult> {
    let customer: CustomerState | undefined;
    if (this.rc) {
      try {
        customer = await this.customer();
      } catch {
        // payment already succeeded — never fail the result on a read
      }
    }
    if (customer) this.emit(customer);
    // Grace re-polls so onCustomerChange subscribers see the entitlement land
    // once RevenueCat has ingested the purchase.
    if (this.rc) {
      for (const delay of GRACE_POLL_DELAYS_MS) {
        setTimeout(() => {
          void this.customer()
            .then((c) => this.emit(c))
            .catch(() => undefined);
        }, delay);
      }
    }
    return { ok: true, customer };
  }

  async restore(): Promise<CustomerState> {
    // No store restore dialog on web: purchases are keyed to the app user id,
    // so a fresh customer-info fetch IS the restore.
    const customer = await this.customer();
    this.emit(customer);
    return customer;
  }

  async customer(): Promise<CustomerState> {
    if (!this.rc) return { appUserId: this.appUserId, entitlements: {}, raw: undefined };
    return mapCustomer(await this.rc.getCustomerInfo());
  }

  onCustomerChange(cb: (c: CustomerState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}
