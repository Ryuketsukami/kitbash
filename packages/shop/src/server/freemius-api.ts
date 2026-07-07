import { freemiusTimeMs } from './freemius.js';

// Product-scoped Freemius REST reads used by reconciliation. Tokens come from
// the product's Settings → API Token tab and only see that one product.

export interface FreemiusApiOptions {
  productId: string | number;
  /** Product-scoped bearer token; defaults to env KB_SHOP_FREEMIUS_API_TOKEN. */
  apiToken?: string;
  /** Defaults to https://api.freemius.com/v1. */
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface FreemiusLicense {
  id: string;
  planId?: string;
  /** Freemius user id — join to listUsers() for the email. */
  userId?: string;
  /** undefined = lifetime license. */
  expirationMs?: number;
  isCancelled?: boolean;
  raw: unknown;
}

export interface FreemiusUser {
  id: string;
  email?: string;
  raw: unknown;
}

export interface FreemiusApi {
  listLicenses(): Promise<FreemiusLicense[]>;
  listUsers(): Promise<FreemiusUser[]>;
}

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | undefined {
  return typeof v === 'object' && v !== null ? (v as Rec) : undefined;
}

function idStr(v: unknown): string | undefined {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return undefined;
}

const PAGE = 200;

export function createFreemiusApi(options: FreemiusApiOptions): FreemiusApi {
  const token = options.apiToken ?? process.env.KB_SHOP_FREEMIUS_API_TOKEN;
  if (!token) {
    throw new Error(
      '@kitbash/shop/server: set options.apiToken or env KB_SHOP_FREEMIUS_API_TOKEN before creating the Freemius API client',
    );
  }
  const base = (options.baseUrl ?? 'https://api.freemius.com/v1').replace(/\/$/, '');
  const product = encodeURIComponent(String(options.productId));
  const fetchFn = options.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function page(resource: 'licenses' | 'users', offset: number): Promise<unknown[]> {
    const res = await fetchFn(`${base}/products/${product}/${resource}.json?count=${PAGE}&offset=${offset}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `@kitbash/shop/server: Freemius ${resource} list failed (${res.status}) ${text.slice(0, 300)}`,
      );
    }
    const body: unknown = await res.json().catch(() => undefined);
    const list = asRec(body)?.[resource];
    return Array.isArray(list) ? list : [];
  }

  async function all(resource: 'licenses' | 'users'): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const batch = await page(resource, offset);
      out.push(...batch);
      if (batch.length < PAGE) return out;
    }
  }

  return {
    async listLicenses() {
      const out: FreemiusLicense[] = [];
      for (const raw of await all('licenses')) {
        const rec = asRec(raw);
        const id = idStr(rec?.id);
        if (rec === undefined || id === undefined) continue;
        out.push({
          id,
          planId: idStr(rec.plan_id),
          userId: idStr(rec.user_id),
          expirationMs: freemiusTimeMs(rec.expiration),
          isCancelled: bool(rec.is_cancelled),
          raw,
        });
      }
      return out;
    },
    async listUsers() {
      const out: FreemiusUser[] = [];
      for (const raw of await all('users')) {
        const rec = asRec(raw);
        const id = idStr(rec?.id);
        if (rec === undefined || id === undefined) continue;
        const email = typeof rec.email === 'string' ? rec.email.trim().toLowerCase() : undefined;
        out.push({ id, email: email === '' ? undefined : email, raw });
      }
      return out;
    },
  };
}
