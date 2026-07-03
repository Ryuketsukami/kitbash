# @kitbash/shop

Everything purchasable behind one API, backed by RevenueCat: offerings, subscriptions,
entitlements, consumable tokens, restore, a light cart, React bindings, and a server
webhook handler that credits tokens into your own ledger.

## Wire

Init + provider (client keys come from your app config, see Env vars):

```tsx
import { ShopProvider } from '@kitbash/shop';

<ShopProvider config={{ apiKeys: { web: WEB_KEY, ios: IOS_KEY, android: ANDROID_KEY }, appUserId: user.id }}>
  <App />
</ShopProvider>
```

Paywall data:

```tsx
import { useShop, purchase } from '@kitbash/shop';

const { ready, offerings } = useShop();
const pkgs = offerings.find((o) => o.id === 'default')?.packages ?? [];
// <button onClick={() => purchase(pkg)}>{pkg.title} — {pkg.priceFormatted}</button>
```

Entitlement gate:

```tsx
import { useEntitlement } from '@kitbash/shop';
const isPro = useEntitlement('pro');
```

Tokens: model token packs as RevenueCat consumables. The client only triggers the store
purchase; RevenueCat then POSTs a webhook to your server, which credits the amount into
your database ledger. The client never trusts itself with balances.

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

Client API keys are not read from env by this package — pass them into `ShopConfig`
from your app's own env, e.g. `VITE_KB_SHOP_RC_KEY_WEB` / `_IOS` / `_ANDROID`
(the names are your app's choice).

## Notes

- Microsoft Store: RevenueCat has no MS Store billing. On the Electron/Windows target,
  use RC Web Billing where store policy allows, or hide purchases on that platform.
- Carts resolve to sequential store purchases — stores have no multi-item checkout.
  `qty > 1` repeats the purchase, which only makes sense for consumables.
- Web restore is a no-op refresh: Web Billing keys purchases to the app user id, so
  fetching customer info is the restore.
- Token balances live in YOUR database, credited by the webhook — never client-side.
