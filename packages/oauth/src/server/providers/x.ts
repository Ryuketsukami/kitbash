import type { ProviderAdapter } from './shared.js';
import { asRecord, form, getJson, postForm, str, tokensFrom } from './shared.js';

export const x: ProviderAdapter = {
  id: 'x',
  // X mandates PKCE for its OAuth 2.0 flow.
  pkce: true,

  authorizeUrl(p) {
    return (
      'https://x.com/i/oauth2/authorize?' +
      form({
        response_type: 'code',
        client_id: p.clientId,
        redirect_uri: p.redirectUri,
        scope: 'users.read tweet.read offline.access',
        state: p.state,
        code_challenge: p.codeChallenge,
        code_challenge_method: 'S256',
      })
    );
  },

  async exchange(code, ctx) {
    const basic = Buffer.from(`${ctx.clientId}:${ctx.clientSecret}`).toString('base64');
    const raw = await postForm(
      'https://api.x.com/2/oauth2/token',
      {
        grant_type: 'authorization_code',
        code,
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
        code_verifier: ctx.verifier,
      },
      { authorization: `Basic ${basic}` },
    );
    return { tokens: tokensFrom(raw), raw };
  },

  async profile({ tokens }) {
    const body = asRecord(
      await getJson('https://api.x.com/2/users/me?user.fields=profile_image_url,name', {
        authorization: `Bearer ${tokens.accessToken}`,
      }),
    );
    const u = asRecord(body.data);
    const id = str(u.id);
    if (!id) throw new Error('x /users/me is missing data.id');
    return {
      provider: 'x',
      id,
      // The X API v2 exposes no email at all — intentionally left undefined.
      name: str(u.name) ?? str(u.username),
      avatarUrl: str(u.profile_image_url),
      raw: u,
    };
  },
};
