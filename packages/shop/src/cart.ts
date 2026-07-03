import { purchase } from './core.js';
import type { PurchaseResult, ShopPackage } from './types.js';

export interface CartLine {
  pkg: ShopPackage;
  qty: number;
}

export interface CartState {
  lines: CartLine[];
}

export interface CheckoutOutcome {
  results: Array<{ pkgId: string; result: PurchaseResult }>;
  ok: boolean;
}

export interface Cart {
  subscribe(cb: () => void): () => void;
  get(): CartState;
  add(pkg: ShopPackage, qty?: number): void;
  remove(pkgId: string): void;
  setQty(pkgId: string, qty: number): void;
  clear(): void;
  checkout(): Promise<CheckoutOutcome>;
}

/**
 * Framework-free cart store. Stores have no multi-item checkout, so
 * checkout() replays the cart as sequential single purchases.
 */
export function createCart(): Cart {
  let state: CartState = { lines: [] };
  const subs = new Set<() => void>();

  function set(lines: CartLine[]): void {
    state = { lines };
    for (const cb of subs) cb();
  }

  return {
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    get: () => state,
    add(pkg, qty = 1) {
      const existing = state.lines.find((l) => l.pkg.id === pkg.id);
      if (existing) {
        set(state.lines.map((l) => (l.pkg.id === pkg.id ? { ...l, qty: l.qty + qty } : l)));
      } else {
        set([...state.lines, { pkg, qty: Math.max(1, qty) }]);
      }
    },
    remove(pkgId) {
      set(state.lines.filter((l) => l.pkg.id !== pkgId));
    },
    setQty(pkgId, qty) {
      if (qty <= 0) {
        set(state.lines.filter((l) => l.pkg.id !== pkgId));
      } else {
        set(state.lines.map((l) => (l.pkg.id === pkgId ? { ...l, qty } : l)));
      }
    },
    clear() {
      set([]);
    },
    async checkout() {
      const results: Array<{ pkgId: string; result: PurchaseResult }> = [];
      let ok = true;
      outer: for (const line of state.lines) {
        // qty > 1 means buying the same product repeatedly — only sane for
        // consumables; stores reject duplicate subscription/non-consumable buys.
        for (let i = 0; i < line.qty; i++) {
          const result = await purchase(line.pkg);
          results.push({ pkgId: line.pkg.id, result });
          if (!result.ok) {
            ok = false;
            // A cancel is the user's choice, keep going; a hard error likely
            // repeats, so stop burning the rest of the cart on it.
            if (!result.cancelled) break outer;
          }
        }
      }
      if (ok) set([]);
      return { results, ok };
    },
  };
}

/** Shared default cart for apps that only need one. */
export const cart: Cart = createCart();
