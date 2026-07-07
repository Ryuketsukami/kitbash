import type { PaddlePriceEntry, ShopOffering, ShopPackage } from '../types.js';

// Paddle.js is loaded from Paddle's CDN (their npm package is the same loader),
// so there is no module to import — the API arrives as a window global. Only
// the members this package calls are typed; payloads stay `unknown` and are
// narrowed below, same policy as the RevenueCat shims.

export interface PaddleCheckoutEvent {
  name?: string;
  error?: unknown;
  data?: unknown;
}

export interface PaddleApi {
  Environment: { set: (env: string) => void };
  Initialize: (opts: { token: string; eventCallback?: (ev: PaddleCheckoutEvent) => void }) => void;
  Checkout: {
    open: (opts: Record<string, unknown>) => void;
    close?: () => void;
  };
  PricePreview: (req: { items: Array<{ priceId: string; quantity: number }> }) => Promise<unknown>;
}

declare global {
  interface Window {
    Paddle?: PaddleApi;
  }
}

const PADDLE_SRC = 'https://cdn.paddle.com/paddle/v2/paddle.js';

let scriptPromise: Promise<void> | undefined;
let initialized = false;

function loadScript(): Promise<void> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('@kitbash/shop: the Paddle web shop only runs in a browser'));
  }
  if (window.Paddle) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PADDLE_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = undefined; // allow retry after a network failure
        reject(new Error('@kitbash/shop: failed to load Paddle.js'));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

/**
 * Loads + initializes Paddle.js once for the page. Paddle.Initialize is
 * page-global, so the first caller's eventCallback wins — the shop is a
 * module-level singleton (see core.ts), so in practice that is this package.
 */
export async function ensurePaddle(
  clientToken: string,
  environment: 'production' | 'sandbox',
  eventCallback: (ev: PaddleCheckoutEvent) => void,
): Promise<PaddleApi> {
  await loadScript();
  const paddle = window.Paddle;
  if (!paddle) throw new Error('@kitbash/shop: Paddle.js loaded but window.Paddle is missing');
  if (!initialized) {
    paddle.Environment.set(environment);
    paddle.Initialize({ token: clientToken, eventCallback });
    initialized = true;
  }
  return paddle;
}

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | undefined {
  return typeof v === 'object' && v !== null ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

interface PricePreviewLine {
  formattedTotal?: string;
  currency?: string;
  productName?: string;
  productDescription?: string;
  raw: unknown;
}

/** PricePreview response → priceId-keyed display data (localized by Paddle). */
function mapPricePreview(raw: unknown): Map<string, PricePreviewLine> {
  const out = new Map<string, PricePreviewLine>();
  const data = asRec(asRec(raw)?.data);
  const currency = str(data?.currencyCode);
  const details = asRec(data?.details);
  const lines = Array.isArray(details?.lineItems) ? details.lineItems : [];
  for (const rawLine of lines) {
    const line = asRec(rawLine);
    const priceId = str(asRec(line?.price)?.id);
    if (priceId === undefined) continue;
    const product = asRec(line?.product);
    out.set(priceId, {
      formattedTotal: str(asRec(line?.formattedTotals)?.total),
      currency,
      productName: str(product?.name),
      productDescription: str(product?.description),
      raw: rawLine,
    });
  }
  return out;
}

/**
 * Builds the web offerings from the configured Paddle price catalog. Paddle
 * has no client offerings API, so the catalog is config; PricePreview fills
 * in localized formatted prices and product copy. A failed preview (offline,
 * bad token) degrades to the catalog's own fields rather than an empty paywall.
 */
export async function paddleOfferings(
  paddle: PaddleApi,
  entries: PaddlePriceEntry[],
): Promise<ShopOffering[]> {
  if (entries.length === 0) return [];
  let preview = new Map<string, PricePreviewLine>();
  try {
    preview = mapPricePreview(
      await paddle.PricePreview({ items: entries.map((e) => ({ priceId: e.priceId, quantity: 1 })) }),
    );
  } catch {
    // degrade: packages render without formatted prices
  }

  const byOffering = new Map<string, ShopPackage[]>();
  for (const entry of entries) {
    const offeringId = entry.offeringId ?? 'default';
    const line = preview.get(entry.priceId);
    const pkg: ShopPackage = {
      id: entry.id ?? entry.priceId,
      offeringId,
      productId: entry.priceId,
      title: entry.title ?? line?.productName ?? entry.priceId,
      description: entry.description ?? line?.productDescription ?? '',
      priceFormatted: line?.formattedTotal ?? '',
      currency: line?.currency,
      period: entry.period,
      kind: entry.kind ?? 'unknown',
      raw: { entry, preview: line?.raw },
    };
    const list = byOffering.get(offeringId);
    if (list) list.push(pkg);
    else byOffering.set(offeringId, [pkg]);
  }
  return [...byOffering.entries()].map(([id, packages]) => ({ id, packages, raw: undefined }));
}
