import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { cart as defaultCart } from './cart.js';
import type { Cart, CartState, CheckoutOutcome } from './cart.js';
import { getCustomer, getOfferings, initShop, onCustomerChange, shopPlatform } from './core.js';
import type { CustomerState, ShopConfig, ShopOffering, ShopPackage, ShopPlatform } from './types.js';

export interface ShopContextValue {
  ready: boolean;
  error?: string;
  platform: ShopPlatform;
  offerings: ShopOffering[];
  customer?: CustomerState;
  refresh: () => Promise<void>;
}

const ShopContext = createContext<ShopContextValue | undefined>(undefined);

export function ShopProvider({ config, children }: { config: ShopConfig; children?: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [offerings, setOfferings] = useState<ShopOffering[]>([]);
  const [customer, setCustomer] = useState<CustomerState | undefined>(undefined);
  const platform = useMemo(() => shopPlatform(), []);

  const refresh = useCallback(async () => {
    try {
      const [o, c] = await Promise.all([getOfferings(), getCustomer()]);
      setOfferings(o);
      setCustomer(c);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Init exactly once: RC SDKs cannot be re-configured at runtime, so a
  // changing `config` prop after mount is deliberately ignored.
  useEffect(() => {
    let alive = true;
    const off = onCustomerChange((c) => {
      if (alive) setCustomer(c);
    });
    initShop(config)
      .then(async () => {
        if (!alive) return;
        setReady(true);
        await refresh();
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<ShopContextValue>(
    () => ({ ready, error, platform, offerings, customer, refresh }),
    [ready, error, platform, offerings, customer, refresh],
  );
  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
}

export function useShop(): ShopContextValue {
  const ctx = useContext(ShopContext);
  if (!ctx) throw new Error('@kitbash/shop: useShop() must be used inside <ShopProvider>');
  return ctx;
}

/** Live entitlement flag; ShopProvider keeps customer state fed by onCustomerChange. */
export function useEntitlement(id: string): boolean {
  const { customer } = useShop();
  return customer?.entitlements[id]?.active === true;
}

export interface UseCartValue {
  state: CartState;
  add: (pkg: ShopPackage, qty?: number) => void;
  remove: (pkgId: string) => void;
  setQty: (pkgId: string, qty: number) => void;
  clear: () => void;
  checkout: () => Promise<CheckoutOutcome>;
}

export function useCart(instance: Cart = defaultCart): UseCartValue {
  const state = useSyncExternalStore(instance.subscribe, instance.get, instance.get);
  return useMemo(
    () => ({
      state,
      add: instance.add,
      remove: instance.remove,
      setQty: instance.setQty,
      clear: instance.clear,
      checkout: instance.checkout,
    }),
    [state, instance],
  );
}
