# @kitbash/oauth

One sign-in API for Google, Apple, GitHub, LinkedIn and X.
Works on web (redirect flow) and iOS/Android Capacitor apps (system browser + deep link).
Framework-agnostic server handler owns all secrets. Zero runtime dependencies.

## Wire

Client:

```ts
import { createOAuthClient, useOAuth } from '@kitbash/oauth';

const oauth = createOAuthClient({ serverUrl: 'https://app.example.com', appScheme: 'myapp' });

function SignIn() {
  const { signIn, busy, error, result } = useOAuth(oauth);
  return <button disabled={busy} onClick={() => signIn('google')}>Continue with Google</button>;
}
```

Next.js — `app/oauth/[...path]/route.ts`:

```ts
import { createOAuthServer } from '@kitbash/oauth/server';

const oauth = createOAuthServer({
  onSignIn: async ({ profile }) => ({ sessionToken: await mintSession(profile) }),
});
export const GET = (r: Request) => oauth.fetch(r);
export const POST = (r: Request) => oauth.fetch(r);
```

Express: `app.use(oauth.toNodeHandler())`.

Native (Capacitor): install `@capacitor/browser` + `@capacitor/app`, pass `appScheme`,
and list the scheme (e.g. `myapp://`) in `KB_OAUTH_ALLOWED_REDIRECTS` — deep-link
redirects must prefix-match an entry. Configure the custom URL scheme per the
Capacitor deep-links guide. `signIn()` resolves with `{ profile, sessionToken? }`.

## Env vars

| Var | Secret | Purpose |
| --- | --- | --- |
| `KB_OAUTH_BASE_URL` | no | Public base URL used to build callback URLs (falls back to request origin) |
| `KB_OAUTH_STATE_SECRET` | yes | HMAC key for the signed `state` (required) |
| `KB_OAUTH_ALLOWED_REDIRECTS` | no | Comma list of allowed absolute redirect prefixes, incl. `myapp://` |
| `KB_OAUTH_GOOGLE_CLIENT_ID` | no | Google OAuth client ID |
| `KB_OAUTH_GOOGLE_CLIENT_SECRET` | yes | Google client secret |
| `KB_OAUTH_GITHUB_CLIENT_ID` | no | GitHub OAuth app client ID |
| `KB_OAUTH_GITHUB_CLIENT_SECRET` | yes | GitHub client secret |
| `KB_OAUTH_LINKEDIN_CLIENT_ID` | no | LinkedIn app client ID |
| `KB_OAUTH_LINKEDIN_CLIENT_SECRET` | yes | LinkedIn client secret |
| `KB_OAUTH_X_CLIENT_ID` | no | X OAuth 2.0 client ID |
| `KB_OAUTH_X_CLIENT_SECRET` | yes | X client secret (Basic auth on token exchange) |
| `KB_OAUTH_APPLE_CLIENT_ID` | no | Apple Services ID |
| `KB_OAUTH_APPLE_TEAM_ID` | no | Apple developer team ID |
| `KB_OAUTH_APPLE_KEY_ID` | no | Key ID of the Sign in with Apple key |
| `KB_OAUTH_APPLE_PRIVATE_KEY` | yes | `.p8` PEM (literal `\n` escapes allowed) |

## Notes

- Apple: iOS apps that offer other social logins **must** also offer Sign in with Apple
  (App Store Review 4.8). Apple sends the user's name only on first authorization.
- Apple's callback is a cross-site `form_post`, so its state cookie is `SameSite=None`.
- X returns no email address; `profile.email` is always `undefined` for `x`.
- The default one-time-code store is in-memory (single instance). Behind a load
  balancer, pass `otcStore` backed by Redis or similar.
- Relative redirect paths are always allowed; absolute URLs and native schemes must
  prefix-match `KB_OAUTH_ALLOWED_REDIRECTS` (no open redirects).
