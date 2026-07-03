import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OAuthProfile, OAuthProviderId, OAuthTokens } from '../types.js';
import { pkcePair, randomToken, safeEqual, signState, verifyState } from './state.js';
import type { ProviderAdapter } from './providers/shared.js';
import { apple } from './providers/apple.js';
import { github } from './providers/github.js';
import { google } from './providers/google.js';
import { linkedin } from './providers/linkedin.js';
import { x } from './providers/x.js';

const providers: Record<OAuthProviderId, ProviderAdapter> = { google, apple, github, linkedin, x };

function isProviderId(v: string): v is OAuthProviderId {
  return v in providers;
}

export interface OAuthSignIn {
  profile: OAuthProfile;
  tokens: OAuthTokens;
}

export interface OAuthSignInContext {
  provider: OAuthProviderId;
  native: boolean;
  redirect: string;
}

export interface OAuthSignInOutcome {
  redirectTo?: string;
  sessionToken?: string;
  setCookies?: string[];
}

export interface OtcStore {
  put(key: string, value: unknown, ttlMs: number): void;
  take(key: string): unknown | undefined;
}

export interface OAuthServerOptions {
  onSignIn(r: OAuthSignIn, ctx: OAuthSignInContext): Promise<OAuthSignInOutcome | Response>;
  /** Public base URL of this server. Default: KB_OAUTH_BASE_URL, else the request origin. */
  baseUrl?: string;
  /** Default: KB_OAUTH_STATE_SECRET. Required. */
  stateSecret?: string;
  /** Allowed absolute redirect prefixes (incl. native schemes). Default: KB_OAUTH_ALLOWED_REDIRECTS. */
  allowedRedirects?: string[];
  otcTtlMs?: number;
  /** Default store is an in-memory Map — single instance only. */
  otcStore?: OtcStore;
}

export interface OAuthServer {
  /** Returns null for paths outside /oauth/ so apps can compose their own routing. */
  fetch(req: Request): Promise<Response | null>;
  toNodeHandler(): (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void;
}

interface OtcEntry {
  profile: OAuthProfile;
  tokens: OAuthTokens;
  provider: OAuthProviderId;
  redirect: string;
}

export function createOAuthServer(options: OAuthServerOptions): OAuthServer {
  const secretInput = options.stateSecret ?? process.env.KB_OAUTH_STATE_SECRET;
  if (!secretInput) {
    throw new Error(
      '@kitbash/oauth: state secret is missing — set KB_OAUTH_STATE_SECRET or pass options.stateSecret',
    );
  }
  // Re-bind so the narrowed string type survives into the route closures.
  const stateSecret: string = secretInput;
  const configuredBase = options.baseUrl ?? process.env.KB_OAUTH_BASE_URL;
  const allowed =
    options.allowedRedirects ??
    (process.env.KB_OAUTH_ALLOWED_REDIRECTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  const otcTtlMs = options.otcTtlMs ?? 60_000;
  const store = options.otcStore ?? memoryOtcStore();

  function validateRedirect(redirect: string, native: boolean): string {
    // Same-site relative paths are always fine ("//" and "/\" are scheme-relative tricks).
    if (!native && redirect.startsWith('/') && !/^\/[/\\]/.test(redirect)) return redirect;
    if (allowed.some((a) => redirect.startsWith(a))) return redirect;
    throw new HttpError(400, `redirect ${native ? 'deep link' : 'URL'} is not in the allowed list`);
  }

  function creds(id: OAuthProviderId): { clientId: string; clientSecret: string } {
    const P = id.toUpperCase();
    const clientId = process.env[`KB_OAUTH_${P}_CLIENT_ID`];
    if (!clientId) throw new Error(`@kitbash/oauth: missing env KB_OAUTH_${P}_CLIENT_ID`);
    if (id === 'apple') return { clientId, clientSecret: '' }; // Apple signs an ES256 JWT instead.
    const clientSecret = process.env[`KB_OAUTH_${P}_CLIENT_SECRET`];
    if (!clientSecret) throw new Error(`@kitbash/oauth: missing env KB_OAUTH_${P}_CLIENT_SECRET`);
    return { clientId, clientSecret };
  }

  function stateCookie(provider: OAuthProviderId, id: string, value: string, maxAge: number): string {
    // Apple's callback is a cross-site POST from appleid.apple.com, so the
    // cookie must be SameSite=None or the browser won't send it.
    const sameSite = provider === 'apple' ? 'None' : 'Lax';
    return `kb_oauth_${id}=${value}; Max-Age=${maxAge}; Path=/oauth; HttpOnly; Secure; SameSite=${sameSite}`;
  }

  function startRoute(adapter: ProviderAdapter, url: URL, base: string): Response {
    const native = url.searchParams.get('native') === '1';
    const redirect = validateRedirect(url.searchParams.get('redirect') ?? '/', native);
    const { clientId } = creds(adapter.id);
    const cookieId = randomToken(6);
    const cookieValue = randomToken(16);
    const pk = adapter.pkce ? pkcePair() : undefined;
    const state = signState(
      { provider: adapter.id, redirect, native, cookieId, cookieValue, verifier: pk?.verifier },
      stateSecret,
    );
    const location = adapter.authorizeUrl({
      clientId,
      redirectUri: `${base}/oauth/${adapter.id}/callback`,
      state,
      codeChallenge: pk?.challenge,
    });
    const headers = new Headers({ location });
    headers.append('set-cookie', stateCookie(adapter.id, cookieId, cookieValue, 600));
    return new Response(null, { status: 302, headers });
  }

  async function callbackRoute(
    adapter: ProviderAdapter,
    req: Request,
    url: URL,
    base: string,
  ): Promise<Response> {
    const params = req.method === 'POST' ? new URLSearchParams(await req.text()) : url.searchParams;
    const providerError = params.get('error');
    if (providerError) {
      return new Response(`OAuth ${adapter.id} error: ${providerError}`, { status: 400 });
    }
    const code = params.get('code');
    const stateParam = params.get('state');
    if (!code || !stateParam) return new Response('Missing code or state', { status: 400 });

    const state = verifyState(stateParam, stateSecret);
    if (!state || state.provider !== adapter.id) {
      return new Response('Invalid or expired state', { status: 400 });
    }
    const cookieValue = readCookie(req.headers.get('cookie'), `kb_oauth_${state.cookieId}`);
    if (!cookieValue || !safeEqual(cookieValue, state.cookieValue)) {
      return new Response('State cookie missing or mismatched', { status: 400 });
    }

    const { clientId, clientSecret } = creds(adapter.id);
    const tokenResult = await adapter.exchange(code, {
      clientId,
      clientSecret,
      redirectUri: `${base}/oauth/${adapter.id}/callback`,
      verifier: state.verifier,
    });
    const profile = await adapter.profile(tokenResult, { user: params.get('user') ?? undefined });
    const clear = stateCookie(adapter.id, state.cookieId, '', 0);

    if (state.native) {
      // Re-validate: the deep link was checked at /start, but the allowlist may
      // have changed and the state blob is attacker-visible (not forgeable).
      const redirect = validateRedirect(state.redirect, true);
      const otc = randomToken(16);
      const entry: OtcEntry = { profile, tokens: tokenResult.tokens, provider: adapter.id, redirect };
      store.put(otc, entry, otcTtlMs);
      const sep = redirect.includes('?') ? '&' : '?';
      const headers = new Headers({ location: `${redirect}${sep}otc=${otc}` });
      headers.append('set-cookie', clear);
      return new Response(null, { status: 302, headers });
    }

    const outcome = await options.onSignIn(
      { profile, tokens: tokenResult.tokens },
      { provider: adapter.id, native: false, redirect: state.redirect },
    );
    if (outcome instanceof Response) return outcome;
    const headers = new Headers({
      location: validateRedirect(outcome.redirectTo ?? state.redirect, false),
    });
    headers.append('set-cookie', clear);
    for (const c of outcome.setCookies ?? []) headers.append('set-cookie', c);
    return new Response(null, { status: 302, headers });
  }

  async function exchangeRoute(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = (await req.json()) as unknown;
    } catch {
      body = undefined;
    }
    const otc =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).otc
        : undefined;
    if (typeof otc !== 'string' || otc.length === 0) return json({ error: 'missing otc' }, 400);
    const entry = parseOtcEntry(store.take(otc));
    if (!entry) return json({ error: 'invalid or expired code' }, 400);
    const outcome = await options.onSignIn(
      { profile: entry.profile, tokens: entry.tokens },
      { provider: entry.provider, native: true, redirect: entry.redirect },
    );
    if (outcome instanceof Response) return outcome;
    const headers = new Headers({ 'content-type': 'application/json' });
    for (const c of outcome.setCookies ?? []) headers.append('set-cookie', c);
    return new Response(
      JSON.stringify({ profile: entry.profile, sessionToken: outcome.sessionToken }),
      { status: 200, headers },
    );
  }

  async function handleFetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/oauth/')) return null;
    const segs = url.pathname.slice('/oauth/'.length).split('/').filter((s) => s.length > 0);
    const base = (configuredBase ?? url.origin).replace(/\/+$/, '');
    try {
      if (segs.length === 1 && segs[0] === 'exchange' && req.method === 'POST') {
        return await exchangeRoute(req);
      }
      const [providerId, action] = segs;
      if (segs.length === 2 && providerId !== undefined && isProviderId(providerId)) {
        const adapter = providers[providerId];
        if (action === 'start' && req.method === 'GET') return startRoute(adapter, url, base);
        if (action === 'callback' && (req.method === 'GET' || req.method === 'POST')) {
          return await callbackRoute(adapter, req, url, base);
        }
      }
      return new Response('Not found', { status: 404 });
    } catch (err) {
      if (err instanceof HttpError) return new Response(err.message, { status: err.status });
      // Message only — never echo tokens, codes or response bodies.
      const message = err instanceof Error ? err.message : 'unknown error';
      return new Response(`OAuth error: ${message}`, { status: 502 });
    }
  }

  return {
    fetch: handleFetch,
    toNodeHandler() {
      return (req, res, next) => {
        void nodeHandle(handleFetch, req, res, next).catch((err: unknown) => {
          if (next) return next(err);
          if (!res.headersSent) res.statusCode = 500;
          res.end('OAuth error');
        });
      };
    },
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function parseOtcEntry(v: unknown): OtcEntry | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.provider !== 'string' || !isProviderId(r.provider)) return null;
  if (typeof r.profile !== 'object' || r.profile === null) return null;
  if (typeof r.tokens !== 'object' || r.tokens === null) return null;
  return {
    profile: r.profile as OAuthProfile,
    tokens: r.tokens as OAuthTokens,
    provider: r.provider,
    redirect: typeof r.redirect === 'string' ? r.redirect : '/',
  };
}

function memoryOtcStore(): OtcStore {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    put(key, value, ttlMs) {
      if (entries.size >= 1024) {
        const now = Date.now();
        for (const [k, e] of entries) if (e.expiresAt <= now) entries.delete(k);
      }
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    take(key) {
      const e = entries.get(key);
      if (!e) return undefined;
      entries.delete(key); // single-use
      return e.expiresAt > Date.now() ? e.value : undefined;
    },
  };
}

async function nodeHandle(
  handleFetch: (req: Request) => Promise<Response | null>,
  req: IncomingMessage,
  res: ServerResponse,
  next?: (err?: unknown) => void,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const fwd = req.headers['x-forwarded-proto'];
  const proto =
    (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() ||
    ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const host = req.headers.host ?? 'localhost';

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD' && body.length > 0;
  const request = new Request(`${proto}://${host}${req.url ?? '/'}`, {
    method,
    headers,
    body: hasBody ? body : undefined,
  });

  const response = await handleFetch(request);
  if (response === null) {
    if (next) return next();
    res.statusCode = 404;
    res.end();
    return;
  }

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') res.setHeader(key, value);
  });
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) res.setHeader('set-cookie', setCookies);
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > 0) res.end(buf);
  else res.end();
}
