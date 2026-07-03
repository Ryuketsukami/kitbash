import type { IncomingMessage, ServerResponse } from 'node:http';

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

// Pure-JS constant-time compare (no node:crypto) so fetch() also runs on edge
// runtimes; scans max length + mixes length diff to avoid early exit timing.
function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
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

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

  function toNodeHandler(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('error', () => {
        res.writeHead(400).end();
      });
      req.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key, value);
          else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
        }
        const method = req.method ?? 'GET';
        const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
        const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks);
        handle(new Request(url, { method, headers, body }))
          .then(async (response) => {
            res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
            res.end(Buffer.from(await response.arrayBuffer()));
          })
          .catch(() => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false }));
          });
      });
    };
  }

  return { fetch: handle, toNodeHandler };
}
