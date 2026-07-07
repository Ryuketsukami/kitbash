# @kitbash/shop

Everything purchasable behind one API: offerings, subscriptions, entitlements,
consumable tokens, restore, a light cart, React bindings, and a server webhook
handler that credits tokens into your own ledger.

Native (iOS/Android) purchases run through the stores via **RevenueCat**. Web
checkout runs through the **Paddle** overlay — RevenueCat ingests Paddle
purchases, so entitlements stay unified across every platform and your server
still listens to exactly one webhook (RevenueCat's).

## Wire

Init + provider (client keys come from your app config, see Env vars):

```tsx
import { ShopProvider } from '@kitbash/shop';

<ShopProvider
  config={{
    apiKeys: { ios: IOS_KEY, android: ANDROID_KEY, web: RC_WEB_KEY }, // web key = entitlement READS only
    appUserId: user.id,
    paddle: {
      clientToken: PADDLE_CLIENT_TOKEN,
      environment: 'production', // or 'sandbox'
      prices: [
        { priceId: 'pri_pro_monthly', kind: 'subscription', period: 'P1M' },
        { priceId: 'pri_tokens_100', kind: 'consumable' },
      ],
      // Recommended: mint the transaction server-side so custom_data can't be
      // spoofed from the browser (see "Server-minted transactions" below).
      createTransaction: (pkg) =>
        fetch('/api/shop/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ priceId: pkg.productId }),
        })
          .then((r) => r.json())
          .then((d) => d.transactionId),
    },
  }}
>
  <App />
</ShopProvider>
```

Paywall data (on web, offerings come from `paddle.prices`, with localized
formatted prices via Paddle's price preview):

```tsx
import { useShop, purchase } from '@kitbash/shop';

const { ready, offerings } = useShop();
const pkgs = offerings.find((o) => o.id === 'default')?.packages ?? [];
// <button onClick={() => purchase(pkg)}>{pkg.title} — {pkg.priceFormatted}</button>
```

`purchase(pkg)` on web opens the Paddle overlay in-page and resolves ok on
`checkout.completed`, cancelled if the buyer closes it first.

Entitlement gate (unchanged on every platform):

```tsx
import { useEntitlement } from '@kitbash/shop';
const isPro = useEntitlement('pro');
```

## RevenueCat ⇄ Paddle wiring (dashboards, once)

1. **Paddle**: create Products + Prices (the `pri_…` ids go into
   `paddle.prices`), a **client-side token** for `paddle.clientToken`, and — if
   you mint transactions server-side — a **secret API key** for your endpoint.
2. **RevenueCat**: add a **Paddle** app to your project (connects your Paddle
   account) and set its **Metadata field key** to exactly `rc_app_user_id`
   (the package's default `appUserIdKey`). Enable **"Track new purchases from
   server-to-server notifications"** and click **Apply in Paddle** so RC
   installs its own Paddle→RC webhook.
3. **RevenueCat webhook → your server**: point it at your
   `createRevenueCatWebhook` route with the `KB_SHOP_RC_WEBHOOK_AUTH` value as
   the Authorization header. This one webhook now covers store AND Paddle
   purchases.

After payment the entitlement takes a few seconds to flow
Paddle → RevenueCat → your webhook; the web adapter grace-polls customer info
briefly after `checkout.completed` so `useEntitlement` flips without a reload.

## Server-minted transactions (recommended)

Without `createTransaction`, the overlay opens directly on the price and the
buyer attribution (`custom_data[rc_app_user_id]`) is set from the browser.
Minting server-side stamps it where the client can't tamper:

```ts
// POST /api/shop/checkout — body: { priceId }
const txn = await fetch(`${PADDLE_API}/transactions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.PADDLE_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    items: [{ price_id: priceId, quantity: 1 }],
    custom_data: { rc_app_user_id: session.userId }, // server-side, unspoofable
  }),
}).then((r) => r.json());
return { transactionId: txn.data.id };
```

(`PADDLE_API` is `https://api.paddle.com`, or `https://sandbox-api.paddle.com`
for the sandbox environment.)

Tokens: model token packs as consumables. The client only triggers the
purchase; RevenueCat (which sees Paddle and store purchases alike) POSTs the
webhook to your server, which credits the amount into your database ledger.
The client never trusts itself with balances.

Webhook route:

```ts
// Next.js: app/api/rc-webhook/route.ts
import { createRevenueCatWebhook } from '@kitbash/shop/server';

const hook = createRevenueCatWebhook({
  tokenProducts: { tokens_100: 100, tokens_550: 550 },
  onTokens: (g) => ledger.credit(g.appUserId, g.amount, g.eventId), // idempotent by eventId
});
export const POST = hook.fetch;
```

```ts
// Express
app.post('/rc-webhook', hook.toNodeHandler());
```

## Env vars

| Var | Where | Purpose |
| --- | --- | --- |
| `KB_SHOP_RC_WEBHOOK_AUTH` | server (secret) | Expected `Authorization` header value for the RevenueCat webhook. |

Client keys are not read from env by this package — pass them into `ShopConfig`
from your app's own env, e.g. `VITE_KB_SHOP_RC_KEY_WEB` / `_IOS` / `_ANDROID`
and `VITE_KB_SHOP_PADDLE_TOKEN` (the names are your app's choice). Your Paddle
**secret** API key belongs only on the server, behind `createTransaction`.

## Notes

- `apiKeys.web` (RevenueCat web key) is optional and read-only: it lets the web
  shop read entitlements client-side. Without it, `customer()` on web reports
  no entitlements and your server — fed by the RC webhook — is the source of
  truth for gating.
- Pass a stable `appUserId` on web. Anonymous ids regenerate, and a Paddle
  purchase attributed to a throwaway id can't be restored later.
- Paddle.js loads from Paddle's CDN on first use; no extra npm install for the
  web path.
- Microsoft Store: the Electron/Windows target is a web build, so the Paddle
  overlay works there — where store policy allows selling outside MS billing;
  otherwise hide purchases on that platform.
- Carts resolve to sequential purchases — `qty > 1` repeats the purchase, which
  only makes sense for consumables.
- Web restore is a no-op refresh: purchases are keyed to the app user id, so
  fetching customer info is the restore.
- Token balances live in YOUR database, credited by the webhook — never
  client-side.
