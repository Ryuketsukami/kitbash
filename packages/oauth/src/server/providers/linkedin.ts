import type { ProviderAdapter } from './shared.js';
import { asRecord, bool, form, getJson, postForm, str, tokensFrom } from './shared.js';

export const linkedin: ProviderAdapter = {
  id: 'linkedin',
  // LinkedIn's OIDC flow does not support PKCE; classic code + client_secret.
  pkce: false,

  authorizeUrl(p) {
    return (
      'https://www.linkedin.com/oauth/v2/authorization?' +
      form({
        response_type: 'code',
        client_id: p.clientId,
        redirect_uri: p.redirectUri,
        scope: 'openid profile email',
        state: p.state,
      })
    );
  },

  async exchange(code, ctx) {
    const raw = await postForm('https://www.linkedin.com/oauth/v2/accessToken', {
      grant_type: 'authorization_code',
      code,
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
      redirect_uri: ctx.redirectUri,
    });
    return { tokens: tokensFrom(raw), raw };
  },

  async profile({ tokens }) {
    const u = asRecord(
      await getJson('https://api.linkedin.com/v2/userinfo', {
        authorization: `Bearer ${tokens.accessToken}`,
      }),
    );
    const id = str(u.sub);
    if (!id) throw new Error('linkedin userinfo is missing sub');
    return {
      provider: 'linkedin',
      id,
      email: str(u.email),
      emailVerified: bool(u.email_verified),
      name: str(u.name),
      avatarUrl: str(u.picture),
      raw: u,
    };
  },
};
