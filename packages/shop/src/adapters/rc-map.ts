import type {
  CustomerState,
  EntitlementState,
  ShopOffering,
  ShopPackage,
  ShopPackageKind,
} from '../types.js';

// Both RC SDKs (capacitor + js) return structurally similar payloads with
// slightly different key names; everything arrives as `unknown` and is probed
// here so the adapters share one honest narrowing layer.

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | undefined {
  return typeof v === 'object' && v !== null ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toKind(productType: unknown, period: string | undefined): ShopPackageKind {
  const t = str(productType)?.toLowerCase();
  switch (t) {
    case 'consumable':
      return 'consumable';
    case 'non_consumable':
    case 'nonconsumable':
      return 'non_consumable';
    case 'subscription':
    case 'auto_renewable_subscription':
    case 'prepaid_subscription':
      return 'subscription';
    default:
      // A recurrence period is only reported for subscriptions.
      return period ? 'subscription' : 'unknown';
  }
}

function toPackage(rawPkg: unknown, offeringId: string): ShopPackage | undefined {
  const pkg = asRec(rawPkg);
  if (!pkg) return undefined;
  const id = str(pkg.identifier);
  // capacitor: `product`; purchases-js: `rcBillingProduct` (older) / `webBillingProduct`.
  const product = asRec(pkg.product) ?? asRec(pkg.rcBillingProduct) ?? asRec(pkg.webBillingProduct);
  if (id === undefined || !product) return undefined;

  const productId = str(product.identifier) ?? '';
  const price = asRec(product.currentPrice);
  const priceUnits = num(product.price);
  const period = str(product.subscriptionPeriod) ?? str(product.normalPeriodDuration);
  return {
    id,
    offeringId,
    productId,
    title: str(product.title) ?? str(product.displayName) ?? productId,
    description: str(product.description) ?? '',
    priceFormatted: str(product.priceString) ?? str(price?.formattedPrice) ?? '',
    priceMicros:
      num(price?.amountMicros) ??
      (priceUnits !== undefined ? Math.round(priceUnits * 1_000_000) : undefined),
    currency: str(product.currencyCode) ?? str(price?.currency),
    period,
    kind: toKind(product.productType ?? product.productCategory, period),
    raw: rawPkg,
  };
}

export function mapOfferings(raw: unknown): ShopOffering[] {
  const all = asRec(asRec(raw)?.all);
  if (!all) return [];
  const out: ShopOffering[] = [];
  for (const rawOffering of Object.values(all)) {
    const offering = asRec(rawOffering);
    const id = str(offering?.identifier);
    if (!offering || id === undefined) continue;
    const rawPkgs = Array.isArray(offering.availablePackages) ? offering.availablePackages : [];
    const packages: ShopPackage[] = [];
    for (const p of rawPkgs) {
      const mapped = toPackage(p, id);
      if (mapped) packages.push(mapped);
    }
    out.push({ id, packages, raw: rawOffering });
  }
  return out;
}

function toEpochMs(v: unknown): number | undefined {
  if (v instanceof Date) return v.getTime();
  const s = str(v);
  if (s === undefined) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

export function mapCustomer(raw: unknown): CustomerState {
  // Capacitor wraps CustomerInfo as { customerInfo }; purchases-js returns it bare.
  const outer = asRec(raw);
  const info = asRec(outer?.customerInfo) ?? outer;
  const entitlements: Record<string, EntitlementState> = {};
  const entContainer = asRec(info?.entitlements);
  const entMap = asRec(entContainer?.all) ?? asRec(entContainer?.active);
  if (entMap) {
    for (const [key, rawEnt] of Object.entries(entMap)) {
      const ent = asRec(rawEnt);
      if (!ent) continue;
      entitlements[key] = {
        active: ent.isActive === true,
        expiresAt: toEpochMs(ent.expirationDate),
        productId: str(ent.productIdentifier),
      };
    }
  }
  return {
    appUserId: str(info?.originalAppUserId) ?? '',
    entitlements,
    raw: info ?? raw,
  };
}

/** True when a thrown SDK error represents the user backing out of the purchase flow. */
export function isUserCancelled(err: unknown): boolean {
  const e = asRec(err);
  if (!e) return false;
  if (e.userCancelled === true) return true;
  const code = str(e.code) ?? str(e.errorCode) ?? num(e.errorCode)?.toString();
  // Capacitor surfaces PURCHASE_CANCELLED / "1"; purchases-js UserCancelledError.
  if (code !== undefined && /PURCHASE_?CANCELLED|USER_?CANCELLED/i.test(code)) return true;
  const msg = str(e.message);
  return msg !== undefined && /cancel/i.test(msg) && /purchase|user/i.test(msg);
}

export function errorMessage(err: unknown): string {
  const e = asRec(err);
  const msg = str(e?.message) ?? str(err);
  return msg ?? 'Purchase failed';
}
