import type { ProviderAdapter } from './shared.js';
import { asRecord, form, getJson, num, postForm, str, tokensFrom } from './shared.js';

// GitHub's REST API rejects requests without a User-Agent.
const API_HEADERS = { 'user-agent': 'kitbash-oauth', accept: 'application/vnd.github+json' };

export const github: ProviderAdapter = {
  id: 'github',
  pkce: true,

  authorizeUrl(p) {
    return (
      'https://github.com/login/oauth/authorize?' +
      form({
        client_id: p.clientId,
        redirect_uri: p.redirectUri,
        scope: 'read:user user:email',
        state: p.state,
        code_challenge: p.codeChallenge,
        code_challenge_method: p.codeChallenge ? 'S256' : undefined,
      })
    );
  },

  async exchange(code, ctx) {
    // GitHub defaults to form-encoded responses; Accept: application/json flips it.
    const raw = await postForm('https://github.com/login/oauth/access_token', {
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
    const auth = { ...API_HEADERS, authorization: `Bearer ${tokens.accessToken}` };
    const u = asRecord(await getJson('https://api.github.com/user', auth));
    const idNum = num(u.id);
    const id = idNum !== undefined ? String(idNum) : str(u.id);
    if (!id) throw new Error('github /user is missing id');

    let email = str(u.email);
    let emailVerified: boolean | undefined;
    try {
      const list = await getJson('https://api.github.com/user/emails', auth);
      const rows = Array.isArray(list) ? list.map(asRecord) : [];
      const best =
        rows.find((e) => e.primary === true && e.verified === true) ??
        rows.find((e) => e.verified === true);
      const bestEmail = best ? str(best.email) : undefined;
      if (bestEmail) {
        email = bestEmail;
        emailVerified = true;
      }
    } catch {
      // /user/emails needs user:email scope; the public email is fine as a fallback.
    }

    return {
      provider: 'github',
      id,
      email,
      emailVerified,
      name: str(u.name) ?? str(u.login),
      avatarUrl: str(u.avatar_url),
      raw: u,
    };
  },
};
