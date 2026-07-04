# @kitbash/pulse

Self-hosted, full-stack telemetry: one package that watches your app's **health**
(page views, Web Vitals, JS errors, backend latency/error rates) and your
**business** (signups, funnels, revenue, who converts and how fast, how often
payers pay). Events flow to a **first-party** endpoint on your own domain — no
third-party calls, ever, so ad blockers don't eat your data and nothing leaves
your infrastructure.

The npm package is the whole product — client SDK + server collector + React
dashboard. The only extra moving part is a database, which runs as a container
(`deploy/docker-compose.yml`) or is whatever Postgres you already have.

## Quickstart (~5 minutes)

```sh
# 1. a database (skip if you have Postgres already)
docker compose -f node_modules/@kitbash/pulse/deploy/docker-compose.yml up -d

# 2. env
export KB_PULSE_DATABASE_URL=postgres://pulse:pulse-dev-password@localhost:5433/pulse
export KB_PULSE_READ_TOKEN=$(openssl rand -hex 24)
```

```ts
// 3. server — two middlewares on any Express app
import { createPulseServer } from '@kitbash/pulse/server';
import { postgresStore } from '@kitbash/pulse/adapters/postgres';

const pulse = createPulseServer({ store: postgresStore() });
app.use(pulse.express());        // samples every request: latency, status, route
app.use(pulse.toNodeHandler());  // mounts POST /pulse/ingest + GET /pulse/query/*
```

```tsx
// 4. client — wrap the app once; page views, vitals and errors are automatic
import { createPulse, PulseProvider } from '@kitbash/pulse';

const client = createPulse({ app: 'myapp@1.0.0' });
<PulseProvider client={client}><App /></PulseProvider>
```

```tsx
// 5. dashboard — mount on an admin-only page
import { PulseDashboard } from '@kitbash/pulse/dashboard';

<PulseDashboard token={READ_TOKEN} funnel={['page_view', 'signup', 'purchase']} />
```

Load a page, click around — the dashboard fills in.

## Wire

**Client (React web).** `createPulse()` once at module scope, provider at the
root, `usePulse()` anywhere:

```tsx
import { createPulse, PulseProvider, usePulse } from '@kitbash/pulse';

const client = createPulse({
  app: 'myapp@1.0.0',
  // endpoint: '/pulse/ingest',   // default — keep it same-origin
  // sampleRate: 1,               // 0..1, deterministic per visitor
  // respectDoNotTrack: true,     // opt-in DNT/GPC honoring
});

export function Root() {
  return (
    <PulseProvider client={client}>
      <App />
    </PulseProvider>
  );
}

function BuyButton() {
  const pulse = usePulse();
  return <button onClick={() => pulse.track('purchase', { amount: 19.99, sku: 'pro' })}>Buy</button>;
}

// after login:
client.identify(user.id);
```

Autocapture (all optional, all on by default in the browser): SPA page views,
Web Vitals (LCP/CLS/INP/FCP/TTFB), unhandled errors/rejections, and a
`traceparent` header on same-origin `fetch` calls so backend spans link to the
session that caused them.

**Client (React Native / anything without a DOM).** Same core, no provider
needed — import from `@kitbash/pulse/client` (the SDK minus the React bindings;
the package root re-exports the provider, so importing it needs `react`
installed), pass `platform`, an absolute `endpoint`, and call `screen()`
yourself:

```ts
import { createPulse } from '@kitbash/pulse/client';

const client = createPulse({ platform: 'ios', endpoint: 'https://api.myapp.com/pulse/ingest' });
client.screen('Home');
```

**Server (Express / any Node http server).** As in the quickstart. Order
matters only in that `pulse.express()` should come before your routes. The
node handler calls `next()` for non-`/pulse` paths, so it composes anywhere.

**Server (Next.js App Router).**

```ts
// lib/pulse.ts
import { createPulseServer } from '@kitbash/pulse/server';
import { postgresStore } from '@kitbash/pulse/adapters/postgres';
export const pulse = createPulseServer({ store: postgresStore() });

// app/pulse/[[...rest]]/route.ts — mounts the collector
import { pulse } from '@/lib/pulse';
const handler = async (req: Request) =>
  (await pulse.fetch(req)) ?? new Response('not found', { status: 404 });
export { handler as GET, handler as POST };

// any API route you want timed:
export const GET = pulse.withRoute('/api/items', async (req) => Response.json(await listItems()));
```

**Server (Fastify).** Request sampling is a plugin; the collector itself is a
Node handler, so mount it via `@fastify/middie` (or run it on a sibling route
in front of Fastify):

```ts
await app.register(pulse.fastify());        // latency/status/route sampling
await app.register(import('@fastify/middie'));
app.use(pulse.toNodeHandler());             // /pulse/ingest + /pulse/query/*
```

**Server-side business events.** Money events should come from the code that
actually knows (webhook handlers, checkout callbacks), not the browser:

```ts
pulse.track('subscription_renewed', { amount: 9.99, plan: 'pro' }, { userId: sub.userId });
```

**Dashboard.** `PulseDashboard` is a self-styled component that talks to
`{basePath}/query/*` with the read token. Put it behind your own auth — the
token is the only gate, and shipping it to the public bundle makes your
metrics public:

```tsx
<PulseDashboard
  token={readToken}
  baseUrl="/pulse"                              // or an absolute URL (needs CORS)
  refreshMs={30_000}
  funnel={['page_view', 'signup', 'purchase']}  // optional funnel panel
/>
```

Prefer Grafana? `deploy/grafana/` ships a provisioned datasource + dashboard
JSON against the Postgres schema — uncomment the `grafana` service in the
compose file and open http://localhost:3300.

## Env vars

All server-side. The client takes a config object instead — nothing secret
belongs in a browser bundle.

| Var | Secret | Purpose |
| --- | --- | --- |
| `KB_PULSE_DATABASE_URL` | yes | Postgres connection string for `postgresStore()`. |
| `KB_PULSE_CLICKHOUSE_URL` | yes | ClickHouse HTTP URL for `clickhouseStore()`, e.g. `http://user:pass@localhost:8123/pulse`. |
| `KB_PULSE_READ_TOKEN` | yes | Bearer token guarding `GET {basePath}/query/*`. Unset ⇒ the read API is disabled (ingest still works). |
| `KB_PULSE_OTLP_ENDPOINT` | no | Optional OTLP/HTTP collector (Tempo, Jaeger, otel-collector) to mirror backend request spans to. |
| `KB_PULSE_ANON_IP` | no | IP anonymization for stored events — on by default (v4 → `/24`, v6 → `/48`); set `0` to keep full IPs. |
| `KB_PULSE_APP` | no | App tag stamped on server rows and used as OTLP `service.name`, e.g. `myapp@1.4.0`. |

With nothing set you get an in-memory store (dev only — lost on restart) and a
disabled read API.

## Business events

Health data is automatic; business data is three conventions:

| Event | Props | Meaning |
| --- | --- | --- |
| `lead` / `signup` | any | Funnel milestones — name them whatever matches your product. |
| `purchase` | `{ amount }` | One-off payment. |
| `subscription_started` / `subscription_renewed` | `{ amount }` | Recurring payments. |

Any event named `purchase`, `subscription_started` or `subscription_renewed`
with a numeric `amount` prop counts as revenue (pick one currency unit and
stick to it — values are stored as plain numbers). From those, `/query/revenue`
derives: total, paying users, **new** payers in range, ARPU, **median days
from a user's first event to their first payment**, and **median days between
consecutive payments** (payment cadence ≈ how long people stay). Pair with
`/query/funnel?steps=page_view,signup,purchase` for conversion rates between
any stages you like. Call `identify(userId)` at login so pre-signup anonymous
activity and post-signup revenue count as one person.

## Query API

`GET {basePath}/query/<name>?from=&to=&interval=` (epoch ms; defaults to the
last 24 h; span capped at 90 days), authenticated via `Authorization: Bearer
<KB_PULSE_READ_TOKEN>`:

`overview` · `series?metric=events|sessions|requests|errors|revenue` ·
`latency` (p50/p95/p99 over time) · `vitals` · `events?limit=` ·
`routes?limit=` · `funnel?steps=a,b,c` · `revenue` · `errors?limit=`.

## Storage

One interface (`PulseStore`), three implementations — swapping is a one-line
change and nothing else moves:

```ts
import { memoryStore } from '@kitbash/pulse/server';
import { postgresStore } from '@kitbash/pulse/adapters/postgres';
import { clickhouseStore } from '@kitbash/pulse/adapters/clickhouse';
```

- `memoryStore()` — zero-config dev default, capped ring buffer.
- `postgresStore({ url?, poolSize?, timescale? })` — the default for real use;
  JSONB props, sensible indexes, works on any plain Postgres. `timescale: true`
  turns both tables into hypertables when the TimescaleDB extension exists.
- `clickhouseStore({ url? })` — for serious volume; MergeTree tables over the
  plain HTTP interface, no driver needed.

Tables are created on first start (idempotent `CREATE IF NOT EXISTS` — no
migration step). Implement `PulseStore` yourself to target anything else.

## Privacy defaults

- First-party only: the SDK talks to *your* origin, nothing else, ever.
- Query strings and fragments are stripped from stored URLs.
- A built-in deny list drops password/token/card-style props at any depth;
  add `denyProps`/`allowProps`/`beforeSend` (client) and `enrich` (server).
- Client IPs are anonymized before storage by default.
- `respectDoNotTrack: true` turns the SDK into a no-op for DNT/GPC visitors.
- `sampleRate` keeps a deterministic slice of visitors instead of everyone.

## Notes

- Zero runtime dependencies. `react` and `pg` are optional peers — `pg` is
  only needed for `postgresStore()`; ClickHouse and OTLP use plain `fetch`.
- Batches leave the browser via `sendBeacon`/`fetch keepalive` on tab close,
  so exit events survive navigation.
- Web Vitals are measured with hand-rolled `PerformanceObserver` code (no
  `web-vitals` dependency); INP uses the standard estimator, so numbers can
  differ from Chrome's by a hair.
- Unmatched Express routes are normalized (`/users/42` → `/users/:id`) to keep
  route cardinality sane; framework route templates are used when available.
- The OTLP exporter sends spans only (no metrics/logs) and reuses the client's
  `traceparent` trace id, so a slow API call in Tempo links back to the exact
  frontend session.
- `example/` has a runnable Express + React pair showing the whole loop.
