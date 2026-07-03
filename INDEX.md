# kitbash — module index

| Module | Package | What it adds |
| --- | --- | --- |
| [Onboarding](#onboarding) | `@kitbash/onboarding` | Spotlight tours: dim, highlight, guide |
| [OAuth](#oauth) | `@kitbash/oauth` | Sign in with Google / Apple / GitHub / LinkedIn / X |
| [Shop](#shop) | `@kitbash/shop` | RevenueCat products, subscriptions, tokens, cart |
| [Ship](#ship) | `@kitbash/ship` | One React app → iOS, Android, Microsoft Store, web |

---

## Onboarding

`packages/onboarding` — [README](packages/onboarding/README.md)

Multi-step guided tours: dims the whole screen, cuts a bright hole around the current
target, floats a card (title / body / Next) beside it, scrolls offscreen targets into
view, then glides to the next step. Declarative `<Spotlight steps={…} />` for
show-once onboarding, `useSpotlight()` to launch a tour from any event handler.
Once-per-user via localStorage. Pure UI — no env vars.

## OAuth

`packages/oauth` — [README](packages/oauth/README.md)

One `signIn('google' | 'apple' | 'github' | 'linkedin' | 'x')` for every app. Web uses a
server-driven redirect flow; iOS/Android (Capacitor) use the system browser plus a deep
link back into the app. Ships a framework-agnostic server handler (Next / Nitro /
Express) that owns the secrets, state + PKCE, token exchange, and profile
normalization. Providers are configured via `KB_OAUTH_*` env vars.

## Shop

`packages/shop` — [README](packages/shop/README.md)

Everything purchasable behind one API, backed by RevenueCat: offerings, subscriptions,
entitlements, consumable tokens, restore, and a light cart. Native builds use the
RevenueCat Capacitor SDK; the web uses RevenueCat Web Billing. Includes a webhook
handler for server-side token crediting. Keys and webhook auth via `KB_SHOP_*`.

## Ship

`packages/ship` — [README](packages/ship/README.md)

The pipeline that turns one React (Vite) codebase into all four targets: a PWA for the
web, Capacitor shells for iOS and Android, and an Electron → MSIX build for the
Microsoft Store. `kitbash-ship init` writes the platform scaffolding;
`ios | android | windows | web` build each target; `doctor` checks your toolchain.
