// Optional fan-out of backend request spans to any OTLP/HTTP collector
// (Tempo, Jaeger, otel-collector…), hand-rolled JSON — no OTel SDK. The
// built-in store keeps working alongside; this is traces-only by design.

import { randomBytes } from 'node:crypto';
import type { RequestRow } from '../store.js';

export interface OtlpExporter {
  push(row: RequestRow): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const MAX_BUFFER = 2000;

export function createOtlpExporter(endpoint: string, serviceName: string): OtlpExporter {
  const url = endpoint.endsWith('/v1/traces')
    ? endpoint
    : `${endpoint.replace(/\/+$/, '')}/v1/traces`;
  let buf: RequestRow[] = [];
  let lastWarn = 0;
  const warn = (msg: string, err?: unknown) => {
    const now = Date.now();
    if (now - lastWarn < 60_000) return;
    lastWarn = now;
    console.warn(`@kitbash/pulse (otlp): ${msg}`, err ?? '');
  };

  async function flush(): Promise<void> {
    if (buf.length === 0) return;
    const rows = buf;
    buf = [];
    const spans = rows.map((r) => ({
      traceId: r.traceId ?? randomBytes(16).toString('hex'),
      spanId: randomBytes(8).toString('hex'),
      name: `${r.method} ${r.route}`,
      kind: 2, // SPAN_KIND_SERVER
      startTimeUnixNano: String(Math.round(r.ts * 1e6)),
      endTimeUnixNano: String(Math.round((r.ts + r.durMs) * 1e6)),
      attributes: [
        { key: 'http.request.method', value: { stringValue: r.method } },
        { key: 'http.route', value: { stringValue: r.route } },
        { key: 'http.response.status_code', value: { intValue: String(r.status) } },
        ...(r.sessionId
          ? [{ key: 'pulse.session_id', value: { stringValue: r.sessionId } }]
          : []),
      ],
      status: r.status >= 500 ? { code: 2 } : {},
    }));
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
          },
          scopeSpans: [{ scope: { name: '@kitbash/pulse' }, spans }],
        },
      ],
    };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) warn(`collector answered ${res.status}`);
    } catch (err) {
      warn('export failed — spans dropped', err);
    }
  }

  return {
    push(row) {
      buf.push(row);
      if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
    },
    flush,
    shutdown: flush,
  };
}
