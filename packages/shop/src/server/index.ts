import type { IncomingMessage, ServerResponse } from 'node:http';
import { constantTimeEqual, json, nodeHandler } from './internal.js';

export {
  createFreemiusWebhook,
  parseFreemiusEvent,
  verifyFreemiusSignature,
  freemiusTimeMs,
} from './freemius.js';
export type { FreemiusEvent, FreemiusWebhook, FreemiusWebhookOptions } from './freemius.js';
export { createRcAdmin } from './rc-admin.js';
export type { RcAdmin, RcAdminOptions, RcGrantInput, RcRevokeInput } from './rc-admin.js';
export { createFreemiusApi } from './freemius-api.js';
export type { FreemiusApi, FreemiusApiOptions, FreemiusLicense, FreemiusUser } from './freemius-api.js';
export { planReconciliation } from './reconcile.js';
export type { CurrentGrant, DesiredGrant, ReconcilePlan } from './reconcile.js';

/** Minimal slice of a RevenueCat webhook event — only the fields this handler reads. */
export interface RcEvent {
  id: string;
  type: string;
  app_user_id: string;
  product_id?: string;
  [k: string]: unknown;
}

export interface TokenGrant {
  appUserId: string;
  productId: string;
  amount: number;
  eventId: string;
  type: string;
}

export interface RevenueCatWebhookOptions {
  /** Expected Authorization header value; defaults to env KB_SHOP_RC_WEBHOOK_AUTH. */
  authHeader?: string;
  /** productId → token amount to credit on purchase events. */
  tokenProducts?: Record<string, number>;
  onEvent?: (evt: RcEvent) => Promise<void> | void;
  onTokens?: (grant: TokenGrant) => Promise<void> | void;
}

export interface RevenueCatWebhook {
  fetch(req: Request): Promise<Response>;
  toNodeHandler(): (req: IncomingMessage, res: ServerResponse) => void;
}

const TOKEN_EVENT_TYPES = new Set(['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE', 'RENEWAL']);

function parseEvent(body: unknown): RcEvent | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const evt = (body as Record<string, unknown>).event;
  if (typeof evt !== 'object' || evt === null) return undefined;
  const e = evt as Record<string, unknown>;
  if (typeof e.id !== 'string' || typeof e.type !== 'string' || typeof e.app_user_id !== 'string') {
    return undefined;
  }
  return e as unknown as RcEvent;
}

export function createRevenueCatWebhook(options: RevenueCatWebhookOptions = {}): RevenueCatWebhook {
  const expectedAuth = options.authHeader ?? process.env.KB_SHOP_RC_WEBHOOK_AUTH;
  if (!expectedAuth) {
    // Fail at creation, not per-request: a webhook without auth silently
    // accepts forged token grants.
    throw new Error(
      '@kitbash/shop/server: set options.authHeader or env KB_SHOP_RC_WEBHOOK_AUTH before creating the webhook',
    );
  }
  const tokenProducts = options.tokenProducts ?? {};

  async function handle(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
    const auth = req.headers.get('authorization') ?? '';
    if (!constantTimeEqual(auth, expectedAuth as string)) {
      return json(401, { ok: false, error: 'unauthorized' });
    }

    let evt: RcEvent | undefined;
    try {
      evt = parseEvent(JSON.parse(await req.text()));
    } catch {
      evt = undefined;
    }
    if (!evt) return json(400, { ok: false, error: 'malformed webhook body' });

    try {
      await options.onEvent?.(evt);
      const amount = evt.product_id !== undefined ? tokenProducts[evt.product_id] : undefined;
      if (TOKEN_EVENT_TYPES.has(evt.type) && evt.product_id !== undefined && amount !== undefined) {
        await options.onTokens?.({
          appUserId: evt.app_user_id,
          productId: evt.product_id,
          amount,
          eventId: evt.id,
          type: evt.type,
        });
      }
    } catch (err) {
      // Non-2xx makes RevenueCat retry, so a failed ledger write is not lost.
      return json(500, { ok: false, error: err instanceof Error ? err.message : 'handler failed' });
    }
    return json(200, { ok: true });
  }

  return { fetch: handle, toNodeHandler: () => nodeHandler(handle) };
}
