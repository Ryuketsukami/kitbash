import { createPrivateKey, sign } from 'node:crypto';
import type { ProviderAdapter } from './shared.js';
import { asRecord, bool, form, postForm, str, tokensFrom } from './shared.js';

export const apple: ProviderAdapter = {
  id: 'apple',
  pkce: false,

  authorizeUrl(p) {
    return (
      'https://appleid.apple.com/auth/authorize?' +
      form({
        response_type: 'code',
        // form_post is required whenever name/email scopes are requested.
        response_mode: 'form_post',
        client_id: p.clientId,
        redirect_uri: p.redirectUri,
        scope: 'name email',
        state: p.state,
      })
    );
  },

  async exchange(code, ctx) {
    const raw = await postForm('https://appleid.apple.com/auth/token', {
      grant_type: 'authorization_code',
      code,
      client_id: ctx.clientId,
      client_secret: appleClientSecret(ctx.clientId),
      redirect_uri: ctx.redirectUri,
    });
    return { tokens: tokensFrom(raw), raw };
  },

  async profile({ tokens }, ctx) {
    if (!tokens.idToken) throw new Error('apple token response is missing id_token');
    // WHY no JWKS verification: this id_token comes straight from Apple's token
    // endpoint over TLS during the code exchange, so its origin is already
    // authenticated; decoding the payload is sufficient here.
    const claims = decodeJwtPayload(tokens.idToken);
    const id = str(claims.sub);
    if (!id) throw new Error('apple id_token is missing sub');

    // Apple sends the user's name exactly once, on first auth, via the `user`
    // form field on the callback POST.
    let name: string | undefined;
    if (ctx?.user) {
      try {
        const u = asRecord(JSON.parse(ctx.user) as unknown);
        const n = asRecord(u.name);
        const joined = [str(n.firstName), str(n.lastName)].filter(Boolean).join(' ');
        name = joined.length > 0 ? joined : undefined;
      } catch {
        // Malformed user field: ignore, the profile is still valid without a name.
      }
    }

    return {
      provider: 'apple',
      id,
      email: str(claims.email),
      emailVerified: bool(claims.email_verified),
      name,
      raw: claims,
    };
  },
};

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1];
  if (!payload) throw new Error('malformed apple id_token');
  return asRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`@kitbash/oauth: missing env ${name} (required for Apple sign-in)`);
  return v;
}

function appleClientSecret(clientId: string): string {
  const teamId = requireEnv('KB_OAUTH_APPLE_TEAM_ID');
  const keyId = requireEnv('KB_OAUTH_APPLE_KEY_ID');
  // Allow \n-escaped PEM so the .p8 key fits in a single-line env var.
  const pem = requireEnv('KB_OAUTH_APPLE_PRIVATE_KEY').replace(/\\n/g, '\n');
  const key = createPrivateKey(pem);
  const iat = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const claims = b64urlJson({
    iss: teamId,
    iat,
    // Apple caps client-secret lifetime at 6 months; 150 days stays safely under.
    exp: iat + 60 * 60 * 24 * 150,
    aud: 'https://appleid.apple.com',
    sub: clientId,
  });
  const data = `${header}.${claims}`;
  // WHY ieee-p1363: JOSE ES256 signatures must be raw r||s; node's default DER
  // encoding is rejected by Apple.
  const sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}

function b64urlJson(v: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}
