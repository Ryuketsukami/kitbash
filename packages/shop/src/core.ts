import type { ShopAdapter } from './adapter.js';
import { NativeAdapter } from './adapters/native.js';
import { WebAdapter } from './adapters/web.js';
import type { CustomerState, PurchaseResult, ShopConfig, ShopOffering, ShopPackage, ShopPlatform } from './types.js';

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

/** Detects ios/android via the Capacitor bridge global; anything else is web. */
export function shopPlatform(): ShopPlatform {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (cap?.isNativePlatform?.()) {
    const p = cap.getPlatform?.();
    if (p === 'ios' || p === 'android') return p;
  }
  return 'web';
}

let adapter: ShopAdapter | undefined;
let initPromise: Promise<ShopAdapter> | undefined;

function makeAdapter(platform: ShopPlatform): ShopAdapter {
  return platform === 'web' ? new WebAdapter() : new NativeAdapter(platform);
}

/**
 * Configures the RevenueCat SDK for the current platform. Module-level
 * singleton: repeated calls return the same in-flight/completed init so app
 * code and <ShopProvider> can both call it safely.
 */
export function initShop(config: ShopConfig): Promise<void> {
  if (!initPromise) {
    const candidate = makeAdapter(shopPlatform());
    initPromise = candidate.init(config).then(
      () => {
        adapter = candidate;
        return candidate;
      },
      (err: unknown) => {
        initPromise = undefined; // allow retry after a failed init
        throw err;
      },
    );
  }
  return initPromise.then(() => undefined);
}

async function ready(): Promise<ShopAdapter> {
  if (adapter) return adapter;
  if (!initPromise) throw new Error('@kitbash/shop: call initShop(config) before using the shop');
  return initPromise;
}

export async function getOfferings(): Promise<ShopOffering[]> {
  return (await ready()).offerings();
}

export async function purchase(pkg: ShopPackage): Promise<PurchaseResult> {
  return (await ready()).purchase(pkg);
}

export async function restorePurchases(): Promise<CustomerState> {
  return (await ready()).restore();
}

export async function getCustomer(): Promise<CustomerState> {
  return (await ready()).customer();
}

export async function hasEntitlement(id: string): Promise<boolean> {
  const c = await getCustomer();
  return c.entitlements[id]?.active === true;
}

/**
 * Subscribes to customer-state updates. Safe to call before init completes:
 * the subscription attaches once the adapter is ready.
 */
export function onCustomerChange(cb: (c: CustomerState) => void): () => void {
  let unsub: (() => void) | undefined;
  let disposed = false;
  void ready().then(
    (a) => {
      if (!disposed) unsub = a.onCustomerChange(cb);
    },
    () => undefined, // init failure already surfaces via initShop()
  );
  return () => {
    disposed = true;
    unsub?.();
  };
}
