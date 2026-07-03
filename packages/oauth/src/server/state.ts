import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OAuthProviderId } from '../types.js';

export const STATE_TTL_MS = 10 * 60 * 1000;

export interface StatePayload {
  provider: OAuthProviderId;
  redirect: string;
  native: boolean;
  /** Suffix of the kb_oauth_<id> CSRF cookie set at /start. */
  cookieId: string;
  /** Random value the cookie must echo back at /callback. */
  cookieValue: string;
  /** PKCE code_verifier for providers that use it. */
  verifier?: string;
  exp: number;
}

export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

function hmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signState(
  payload: Omit<StatePayload, 'exp'>,
  secret: string,
  ttlMs = STATE_TTL_MS,
): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString(
    'base64url',
  );
  return `${body}.${hmac(body, secret)}`;
}

export function verifyState(state: string, secret: string): StatePayload | null {
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  if (!safeEqual(sig, hmac(body, secret))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.provider !== 'string' ||
    typeof p.redirect !== 'string' ||
    typeof p.native !== 'boolean' ||
    typeof p.cookieId !== 'string' ||
    typeof p.cookieValue !== 'string' ||
    typeof p.exp !== 'number' ||
    p.exp < Date.now()
  ) {
    return null;
  }
  return {
    provider: p.provider as OAuthProviderId,
    redirect: p.redirect,
    native: p.native,
    cookieId: p.cookieId,
    cookieValue: p.cookieValue,
    verifier: typeof p.verifier === 'string' ? p.verifier : undefined,
    exp: p.exp,
  };
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Length leaks are fine here; content must not leak via timing.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
