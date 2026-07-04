// Copy-paste starting point — not part of the package build.
// Run:  docker compose -f ../deploy/docker-compose.yml up -d
//       export KB_PULSE_DATABASE_URL=postgres://pulse:pulse-dev-password@localhost:5433/pulse
//       export KB_PULSE_READ_TOKEN=dev-read-token
//       npm i express pg && npx tsx server.ts

import express from 'express';
import { createPulseServer } from '@kitbash/pulse/server';
import { postgresStore } from '@kitbash/pulse/adapters/postgres';

const pulse = createPulseServer({
  // Omit `store` to fall back to the in-memory store for a quick look.
  store: process.env.KB_PULSE_DATABASE_URL ? postgresStore() : undefined,
});

const app = express();
app.use(pulse.express()); // samples latency/status/route of every request below
app.use(pulse.toNodeHandler()); // POST /pulse/ingest + GET /pulse/query/* + /pulse/health

app.get('/api/items', (_req, res) => {
  res.json([{ id: 1, name: 'thing' }]);
});

// Money events come from the code that actually knows — e.g. a payment webhook:
app.post('/webhooks/payment', express.json(), (req, res) => {
  const userId = String((req.body as { userId?: string })?.userId ?? 'demo-user');
  pulse.track('purchase', { amount: 19.99, sku: 'pro' }, { userId });
  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log('http://localhost:3000 — ingest at /pulse/ingest, queries at /pulse/query/*');
});
