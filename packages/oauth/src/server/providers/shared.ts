import type { OAuthProfile, OAuthProviderId, OAuthTokens } from '../../types.js';

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}

export interface ExchangeCtx {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  verifier?: string;
}

export interface TokenResult {
  tokens: OAuthTokens;
  raw: Record<string, unknown>;
}

export interface ProfileCtx {
  /** Apple-only: the `user` form field posted on FIRST authorization (holds name). */
  user?: string;
}

export interface ProviderAdapter {
  id: OAuthProviderId;
  pkce: boolean;
  authorizeUrl(p: AuthorizeParams): string;
  exchange(code: string, ctx: ExchangeCtx): Promise<TokenResult>;
  profile(t: TokenResult, ctx?: ProfileCtx): Promise<OAuthProfile>;
}

export function form(fields: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) sp.set(k, v);
  return sp.toString();
}

export async function postForm(
  url: string,
  fields: Record<string, string | undefined>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...headers,
    },
    body: form(fields),
  });
  // Status only in errors — response bodies can contain tokens.
  if (!res.ok) throw new Error(`${new URL(url).host} token endpoint responded ${res.status}`);
  return asRecord((await res.json()) as unknown);
}

export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return (await res.json()) as unknown;
}

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

export function tokensFrom(raw: Record<string, unknown>): OAuthTokens {
  const accessToken = str(raw.access_token);
  if (!accessToken) throw new Error('token response is missing access_token');
  const expiresIn = num(raw.expires_in);
  return {
    accessToken,
    refreshToken: str(raw.refresh_token),
    idToken: str(raw.id_token),
    expiresAt: expiresIn !== undefined ? Date.now() + expiresIn * 1000 : undefined,
    scope: str(raw.scope),
  };
}
