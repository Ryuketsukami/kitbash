import type { ShopAdapter } from '../adapter.js';
import type {
  CustomerState,
  PaddleWebConfig,
  PurchaseResult,
  ShopConfig,
  ShopOffering,
  ShopPackage,
} from '../types.js';
import { ensurePaddle, paddleOfferings } from './paddle.js';
import type { PaddleApi, PaddleCheckoutEvent } from './paddle.js';
import { errorMessage, mapCustomer } from './rc-map.js';

type WebModule = typeof import('@revenuecat/purchases-js');
type WebInstance = import('@revenuecat/purchases-js').PurchasesJsInstance;

const DEFAULT_APP_USER_ID_KEY = 'rc_app_user_id';

// Paddle → RevenueCat ingestion is server-to-server and takes a few seconds,
// so after checkout.completed the entitlement is not instantly readable.
const GRACE_POLL_DELAYS_MS = [4000, 10000, 20000];

/**
 * Web adapter: checkout runs through the Paddle.js overlay; entitlements are
 * read from RevenueCat (optional `apiKeys.web`), which ingests Paddle
 * purchases via its Paddle integration — the buyer is attributed through
 * transaction custom_data[appUserIdKey]. Without an RC web key, customer()
 * reports no entitlements and your own server (fed by the RC webhook) is the
 * source of truth.
 */
export class WebAdapter implements ShopAdapter {
  private paddle: PaddleApi | undefined;
  private rc: WebInstance | undefined;
  private cfg: PaddleWebConfig | undefined;
  private appUserId = '';
  private listeners = new Set<(c: CustomerState) => void>();
  private pending: ((r: PurchaseResult) => void) | undefined;

  async init(cfg: ShopConfig): Promise<void> {
    const pcfg = cfg.paddle;
    if (!pcfg?.clientToken) {
      throw new Error(
        '@kitbash/shop: web checkout runs on Paddle — set config.paddle ({ clientToken, prices })',
      );
    }
    this.cfg = pcfg;

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

    this.paddle = await ensurePaddle(pcfg.clientToken, pcfg.environment ?? 'production', (ev) =>
      this.onPaddleEvent(ev),
    );
  }

  private get pad(): PaddleApi {
    if (!this.paddle) throw new Error('@kitbash/shop: initShop() has not completed');
    return this.paddle;
  }

  private get catalog(): PaddleWebConfig {
    if (!this.cfg) throw new Error('@kitbash/shop: initShop() has not completed');
    return this.cfg;
  }

  private emit(c: CustomerState): void {
    for (const cb of this.listeners) cb(c);
  }

  async offerings(): Promise<ShopOffering[]> {
    return paddleOfferings(this.pad, this.catalog.prices);
  }

  async purchase(pkg: ShopPackage): Promise<PurchaseResult> {
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

  // The overlay reports through the page-global eventCallback: completed
  // resolves ok (the overlay shows its own success screen and closes later),
  // closed-before-completed is the user backing out.
  private onPaddleEvent(ev: PaddleCheckoutEvent): void {
    const resolve = this.pending;
    if (!resolve) return;
    switch (ev.name) {
      case 'checkout.completed':
        this.pending = undefined;
        void this.settleCompleted(resolve);
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

  private async settleCompleted(resolve: (r: PurchaseResult) => void): Promise<void> {
    let customer: CustomerState | undefined;
    if (this.rc) {
      try {
        customer = await this.customer();
      } catch {
        // payment already succeeded — never fail the result on a read
      }
    }
    resolve({ ok: true, customer });
    if (customer) this.emit(customer);
    // Grace re-polls so onCustomerChange subscribers see the entitlement land
    // once RevenueCat has ingested the Paddle transaction.
    if (this.rc) {
      for (const delay of GRACE_POLL_DELAYS_MS) {
        setTimeout(() => {
          void this.customer()
            .then((c) => this.emit(c))
            .catch(() => undefined);
        }, delay);
      }
    }
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
