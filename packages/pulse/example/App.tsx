// Copy-paste starting point — not part of the package build.
// Pair with example/server.ts; page views, vitals and errors are captured
// automatically the moment the provider mounts.

import { createPulse, PulseProvider, usePulse } from '@kitbash/pulse';
import { PulseDashboard } from '@kitbash/pulse/dashboard';

const client = createPulse({ app: 'example@0.1.0' });

function BuyButton() {
  const pulse = usePulse();
  return (
    <button onClick={() => pulse.track('purchase', { amount: 19.99, sku: 'pro' })}>
      Buy pro — 19.99
    </button>
  );
}

export default function App() {
  return (
    <PulseProvider client={client}>
      <main>
        <h1>Pulse example</h1>
        <BuyButton />
        {/* Admin-only in a real app — the token exposes your metrics. */}
        <PulseDashboard token="dev-read-token" funnel={['page_view', 'purchase']} />
      </main>
    </PulseProvider>
  );
}
