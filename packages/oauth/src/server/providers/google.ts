import type { ProviderAdapter } from './shared.js';
import { bool, form, getJson, asRecord, postForm, str, tokensFrom } from './shared.js';

export const google: ProviderAdapter = {
  id: 'google',
  pkce: true,

  authorizeUrl(p) {
    return (
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      form({
        response_type: 'code',
        client_id: p.clientId,
        redirect_uri: p.redirectUri,
        scope: 'openid email profile',
        state: p.state,
        code_challenge: p.codeChallenge,
        code_challenge_method: p.codeChallenge ? 'S256' : undefined,
      })
    );
  },

  async exchange(code, ctx) {
    const raw = await postForm('https://oauth2.googleapis.com/token', {
      grant_type: 'authorization_code',
      code,
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
      redirect_uri: ctx.redirectUri,
      code_verifier: ctx.verifier,
    });
    return { tokens: tokensFrom(raw), raw };
  },

  async profile({ tokens }) {
    const u = asRecord(
      await getJson('https://openidconnect.googleapis.com/v1/userinfo', {
        authorization: `Bearer ${tokens.accessToken}`,
      }),
    );
    const id = str(u.sub);
    if (!id) throw new Error('google userinfo is missing sub');
    return {
      provider: 'google',
      id,
      email: str(u.email),
      emailVerified: bool(u.email_verified),
      name: str(u.name),
      avatarUrl: str(u.picture),
      raw: u,
    };
  },
};
