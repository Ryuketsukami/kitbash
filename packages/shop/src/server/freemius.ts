import type { IncomingMessage, ServerResponse } from 'node:http';
import { constantTimeEqual, json, nodeHandler } from './internal.js';

// Freemius webhooks POST the raw event JSON with an `x-signature` header:
// HMAC-SHA256 (hex) of the raw body keyed with the product's SECRET key.
// Payload shape: { id, type: 'resource.event', created, plugin_id, objects:
// { user, install, license, payment, subscription } } — ids arrive as numbers
// or strings depending on the resource, so everything is narrowed here.

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | undefined {
  return typeof v === 'object' && v !== null ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function idStr(v: unknown): string | undefined {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return undefined;
}

/** Epoch ms from a Freemius datetime — 'YYYY-MM-DD HH:MM:SS' (UTC, no zone) or ISO 8601. */
export function freemiusTimeMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  const s = str(v);
  if (s === undefined || s === '') return undefined;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/** Flattened view of a Freemius webhook event — only the fields a billing bridge needs. */
export interface FreemiusEvent {
  id: string;
  /** `resource.event` name, e.g. 'license.created', 'payment.created', 'subscription.cancelled'. */
  type: string;
  productId?: string;
  /** Freemius user id. */
  userId?: string;
  /** Buyer email (trimmed + lowercased) — the usual join key to your own users. */
  email?: string;
  planId?: string;
  pricingId?: string;
  licenseId?: string;
  subscriptionId?: string;
  paymentId?: string;
  /** License expiration; undefined for lifetime licenses. */
  expirationMs?: number;
  isCancelled?: boolean;
  /** Payment gross amount in major units on payment.* events. */
  gross?: number;
  raw: unknown;
}

export function parseFreemiusEvent(body: unknown): FreemiusEvent | undefined {
  const root = asRec(body);
  if (!root) return undefined;
  const id = idStr(root.id);
  const type = str(root.type);
  if (id === undefined || type === undefined || type === '') return undefined;
  const objects = asRec(root.objects);
  const user = asRec(objects?.user);
  const license = asRec(objects?.license);
  const subscription = asRec(objects?.subscription);
  const payment = asRec(objects?.payment);
  const email = str(user?.email)?.trim().toLowerCase();
  return {
    id,
    type,
    productId: idStr(root.plugin_id ?? root.product_id),
    userId: idStr(user?.id ?? root.user_id),
    email: email === '' ? undefined : email,
    planId: idStr(license?.plan_id ?? subscription?.plan_id ?? payment?.plan_id),
    pricingId: idStr(license?.pricing_id ?? subscription?.pricing_id ?? payment?.pricing_id),
    licenseId: idStr(license?.id ?? payment?.license_id ?? subscription?.license_id),
    subscriptionId: idStr(subscription?.id ?? payment?.subscription_id ?? license?.subscription_id),
    paymentId: idStr(payment?.id),
    expirationMs: freemiusTimeMs(license?.expiration),
    isCancelled: bool(license?.is_cancelled),
    gross: num(payment?.gross),
    raw: body,
  };
}

/** HMAC-SHA256 hex of the raw body with the product secret key, compared constant-time. */
export async function verifyFreemiusSignature(
  rawBody: string,
  signature: string | null | undefined,
  secretKey: string,
): Promise<boolean> {
  if (!signature || !secretKey) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  let hex = '';
  for (const b of mac) hex += b.toString(16).padStart(2, '0');
  return constantTimeEqual(hex, signature.trim().toLowerCase());
}

export interface FreemiusWebhookOptions {
  /** Product SECRET key that signs webhooks; defaults to env KB_SHOP_FREEMIUS_SECRET. */
  secretKey?: string;
  /** When set, verified events for other products are acknowledged but not dispatched. */
  productId?: string | number;
  onEvent?: (evt: FreemiusEvent) => Promise<void> | void;
}

export interface FreemiusWebhook {
  fetch(req: Request): Promise<Response>;
  toNodeHandler(): (req: IncomingMessage, res: ServerResponse) => void;
}

export function createFreemiusWebhook(options: FreemiusWebhookOptions = {}): FreemiusWebhook {
  const secretKey = options.secretKey ?? process.env.KB_SHOP_FREEMIUS_SECRET;
  if (!secretKey) {
    // Fail at creation, not per-request: a webhook without a signing key
    // silently accepts forged purchase events.
    throw new Error(
      '@kitbash/shop/server: set options.secretKey or env KB_SHOP_FREEMIUS_SECRET before creating the webhook',
    );
  }
  const signingKey: string = secretKey;
  const productId = options.productId !== undefined ? String(options.productId) : undefined;

  async function handle(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
    const rawBody = await req.text();
    const verified = await verifyFreemiusSignature(rawBody, req.headers.get('x-signature'), signingKey);
    if (!verified) return json(401, { ok: false, error: 'bad signature' });

    let evt: FreemiusEvent | undefined;
    try {
      evt = parseFreemiusEvent(JSON.parse(rawBody));
    } catch {
      evt = undefined;
    }
    if (!evt) return json(400, { ok: false, error: 'malformed webhook body' });
    if (productId !== undefined && evt.productId !== undefined && evt.productId !== productId) {
      return json(200, { ok: true, ignored: 'other product' });
    }
    try {
      await options.onEvent?.(evt);
    } catch (err) {
      // Non-2xx makes Freemius retry, so a failed grant/ledger write is not lost.
      return json(500, { ok: false, error: err instanceof Error ? err.message : 'handler failed' });
    }
    return json(200, { ok: true });
  }

  return { fetch: handle, toNodeHandler: () => nodeHandler(handle) };
}
