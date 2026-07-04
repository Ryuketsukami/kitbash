// The collector: receives client batches at a first-party endpoint, samples
// backend requests via the framework middlewares, buffers both, and writes
// them through a PulseStore. Also serves the read-only query API the
// dashboard consumes (Bearer-token gated).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PulseBatch, PulseEvent, SeriesMetric } from '../types.js';
import type { EventRow, PulseStore, RequestRow, StoreRange } from '../store.js';
import { memoryStore } from '../store.js';
import { createOtlpExporter } from './otlp.js';
import type { OtlpExporter } from './otlp.js';
import {
  expressMiddleware,
  fastifyPlugin,
  makeWithRoute,
  type ExpressMiddleware,
  type FastifyPlugin,
  type InstrumentOptions,
  type RouteHandler,
} from './instrument.js';

/** One backend request sample, as reported by a middleware (or your own code). */
export interface RequestSample {
  method: string;
  route: string;
  status: number;
  durMs: number;
  traceId?: string | null;
  sessionId?: string | null;
  ts?: number;
}

export interface PulseServerOptions {
  /** Where telemetry lands. Default: in-memory (dev only — gone on restart). */
  store?: PulseStore;
  /** Mount point for ingest/query routes. Default '/pulse'. */
  basePath?: string;
  /** Bearer token for the read-only query API. Default: KB_PULSE_READ_TOKEN. */
  readToken?: string;
  /** Zero the host bits of stored client IPs. Default: on unless KB_PULSE_ANON_IP=0. */
  anonymizeIp?: boolean;
  /** OTLP/HTTP traces endpoint for fan-out. Default: KB_PULSE_OTLP_ENDPOINT. */
  otlpEndpoint?: string;
  /** service.name reported over OTLP. Default: KB_PULSE_APP, else 'app'. */
  app?: string;
  flushIntervalMs?: number;
  /** Buffered rows before oldest are dropped. Default 5000 per table. */
  maxBufferRows?: number;
  /** Ingest body cap. Default 512 KiB. */
  maxBodyBytes?: number;
  /** Events accepted per batch. Default 200. */
  maxEventsPerBatch?: number;
  /** Server-side enrich/redact/veto hook. Return null to drop the row. */
  enrich?: (row: EventRow) => EventRow | null;
}

export interface PulseServer {
  /** Handles requests under basePath; returns null for everything else. */
  fetch(req: Request): Promise<Response | null>;
  /** Node/Express-style handler for the same routes. */
  toNodeHandler(): (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void;
  /** Express middleware that samples every request's latency/status/route. */
  express(options?: InstrumentOptions): ExpressMiddleware;
  /** Fastify plugin doing the same (skip-override, so it applies app-wide). */
  fastify(options?: InstrumentOptions): FastifyPlugin;
  /** Wrap a fetch-style (Next.js) route handler; pass the route name for grouping. */
  withRoute<C>(route: string, handler: RouteHandler<C>): RouteHandler<C>;
  /** Server-side business event (platform 'node'). */
  track(
    event: string,
    props?: Record<string, unknown>,
    opts?: { userId?: string; anonId?: string; sessionId?: string },
  ): void;
  /** Feed a request sample from a custom framework. */
  recordRequest(sample: RequestSample): void;
  /** Force-write buffers to the store. */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  readonly store: PulseStore;
}

const DAY_MS = 86_400_000;
const SERIES_METRICS: readonly SeriesMetric[] = ['events', 'sessions', 'requests', 'errors', 'revenue'];

export function createPulseServer(options: PulseServerOptions = {}): PulseServer {
  const store =
    options.store ??
    (console.warn(
      '@kitbash/pulse: no store configured — using in-memory storage (lost on restart). Pass postgresStore() or clickhouseStore().',
    ),
    memoryStore());
  const basePath = (options.basePath ?? '/pulse').replace(/\/+$/, '') || '/pulse';
  const readToken = options.readToken ?? process.env.KB_PULSE_READ_TOKEN;
  const anonymizeIp = options.anonymizeIp ?? process.env.KB_PULSE_ANON_IP !== '0';
  const app = options.app ?? process.env.KB_PULSE_APP ?? null;
  const flushIntervalMs = options.flushIntervalMs ?? 3000;
  const maxBufferRows = options.maxBufferRows ?? 5000;
  const maxBodyBytes = options.maxBodyBytes ?? 512 * 1024;
  const maxEventsPerBatch = options.maxEventsPerBatch ?? 200;

  const otlpEndpoint = options.otlpEndpoint ?? process.env.KB_PULSE_OTLP_ENDPOINT;
  const otlp: OtlpExporter | null = otlpEndpoint
    ? createOtlpExporter(otlpEndpoint, app ?? 'app')
    : null;

  let eventBuf: EventRow[] = [];
  let requestBuf: RequestRow[] = [];
  let lastWarn = 0;
  const warn = (msg: string, err?: unknown) => {
    const now = Date.now();
    if (now - lastWarn < 60_000) return;
    lastWarn = now;
    console.warn(`@kitbash/pulse: ${msg}`, err ?? '');
  };

  const initPromise = store.init().catch((err: unknown) => warn('store init failed', err));

  let flushing = false;
  async function flushBuffers(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      await initPromise;
      if (eventBuf.length > 0) {
        const rows = eventBuf;
        eventBuf = [];
        try {
          await store.insertEvents(rows);
        } catch (err) {
          warn('insertEvents failed — dropping batch', err);
        }
      }
      if (requestBuf.length > 0) {
        const rows = requestBuf;
        requestBuf = [];
        try {
          await store.insertRequests(rows);
        } catch (err) {
          warn('insertRequests failed — dropping batch', err);
        }
      }
      if (otlp) await otlp.flush();
    } finally {
      flushing = false;
    }
  }

  const interval = setInterval(() => void flushBuffers(), flushIntervalMs);
  (interval as unknown as { unref?: () => void }).unref?.();

  function pushEvents(rows: EventRow[]): void {
    eventBuf.push(...rows);
    if (eventBuf.length > maxBufferRows) {
      eventBuf.splice(0, eventBuf.length - maxBufferRows);
      warn('event buffer overflow — dropping oldest rows');
    }
  }

  function recordRequest(sample: RequestSample): void {
    const row: RequestRow = {
      ts: sample.ts ?? Date.now(),
      method: sample.method.slice(0, 10).toUpperCase(),
      route: sample.route.slice(0, 200) || '/',
      status: sample.status,
      durMs: Number.isFinite(sample.durMs) ? sample.durMs : 0,
      traceId: sample.traceId ?? null,
      sessionId: sample.sessionId ?? null,
      app,
    };
    requestBuf.push(row);
    if (requestBuf.length > maxBufferRows) {
      requestBuf.splice(0, requestBuf.length - maxBufferRows);
      warn('request buffer overflow — dropping oldest rows');
    }
    otlp?.push(row);
  }

  // ---- ingest ----

  function anonIp(raw: string): string {
    if (raw.includes(':')) {
      const groups = raw.split(':');
      return `${groups.slice(0, 3).join(':')}::`; // keep /48
    }
    const parts = raw.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : raw;
  }

  function clientIp(req: Request): string | null {
    const fwd = req.headers.get('x-forwarded-for');
    const first = fwd?.split(',')[0]?.trim();
    if (!first) return null;
    return anonymizeIp ? anonIp(first) : first;
  }

  const str = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;

  function toRows(batch: PulseBatch, req: Request): EventRow[] {
    const now = Date.now();
    const anonId = str(batch.anonId, 64);
    const sessionId = str(batch.sessionId, 64);
    if (!anonId || !sessionId || !Array.isArray(batch.events)) {
      throw new HttpError(400, 'invalid batch envelope');
    }
    const userId = str(batch.userId, 128);
    const platform = str(batch.platform, 32) ?? 'web';
    const batchApp = str(batch.app, 64) ?? app;
    const ua = str(req.headers.get('user-agent'), 300);
    const ip = clientIp(req);
    const rows: EventRow[] = [];
    for (const e of batch.events.slice(0, maxEventsPerBatch) as PulseEvent[]) {
      const event = str(e?.event, 128);
      if (!event) continue;
      let ts = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : now;
      if (ts < now - 2 * DAY_MS || ts > now + 5 * 60_000) ts = now;
      let props: Record<string, unknown> = {};
      if (e.props && typeof e.props === 'object' && !Array.isArray(e.props)) {
        try {
          props = JSON.stringify(e.props).length <= 16_384 ? e.props : { truncated: true };
        } catch {
          props = {};
        }
      }
      let row: EventRow | null = {
        ts,
        event,
        anonId,
        sessionId,
        userId,
        platform,
        app: batchApp,
        url: str(e.url, 500),
        referrer: str(e.referrer, 500),
        props,
        ua,
        ip,
      };
      if (options.enrich) {
        try {
          row = options.enrich(row);
        } catch {
          /* enrich threw — keep the original row */
        }
      }
      if (row) rows.push(row);
    }
    return rows;
  }

  async function handleIngest(req: Request): Promise<Response> {
    const body = await req.text();
    if (body.length > maxBodyBytes) throw new HttpError(413, 'body too large');
    let batch: PulseBatch;
    try {
      batch = JSON.parse(body) as PulseBatch;
    } catch {
      throw new HttpError(400, 'invalid JSON');
    }
    pushEvents(toRows(batch, req));
    return new Response(null, { status: 204 });
  }

  // ---- query API ----

  function requireRead(req: Request, url: URL): void {
    if (!readToken) {
      throw new HttpError(401, 'read API disabled — set KB_PULSE_READ_TOKEN (or options.readToken)');
    }
    const header = req.headers.get('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const presented = bearer ?? url.searchParams.get('token') ?? '';
    if (!safeEqual(presented, readToken)) throw new HttpError(401, 'invalid read token');
  }

  function parseRange(url: URL): StoreRange {
    const now = Date.now();
    const num = (name: string): number | undefined => {
      const raw = url.searchParams.get(name);
      if (raw === null) return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new HttpError(400, `invalid ${name}`);
      return n;
    };
    let to = num('to') ?? now;
    let from = num('from') ?? to - DAY_MS;
    if (from >= to) throw new HttpError(400, 'from must be before to');
    if (to - from > 90 * DAY_MS) from = to - 90 * DAY_MS;
    const span = to - from;
    let intervalMs = num('interval') ?? Math.ceil(span / 60);
    intervalMs = Math.min(Math.max(intervalMs, 10_000), DAY_MS);
    return { from, to, intervalMs };
  }

  const limitOf = (url: URL): number => {
    const n = Number(url.searchParams.get('limit') ?? 20);
    return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 100) : 20;
  };

  async function handleQuery(req: Request, url: URL, name: string): Promise<Response> {
    requireRead(req, url);
    const r = parseRange(url);
    await flushBuffers(); // dashboards see what just happened, even mid-interval
    let result: unknown;
    switch (name) {
      case 'overview':
        result = await store.overview(r);
        break;
      case 'series': {
        const metric = url.searchParams.get('metric') as SeriesMetric | null;
        if (!metric || !SERIES_METRICS.includes(metric)) {
          throw new HttpError(400, `metric must be one of ${SERIES_METRICS.join(', ')}`);
        }
        result = { points: await store.series(metric, r) };
        break;
      }
      case 'latency':
        result = await store.latency(r);
        break;
      case 'vitals':
        result = { vitals: await store.vitals(r) };
        break;
      case 'events':
        result = { rows: await store.topEvents(r, limitOf(url)) };
        break;
      case 'routes':
        result = { rows: await store.topRoutes(r, limitOf(url)) };
        break;
      case 'funnel': {
        const steps = (url.searchParams.get('steps') ?? '')
          .split(',')
          .map((s) => s.trim().slice(0, 128))
          .filter((s) => s.length > 0)
          .slice(0, 8);
        if (steps.length < 2) throw new HttpError(400, 'steps needs at least 2 comma-separated events');
        result = { steps: await store.funnel(steps, r) };
        break;
      }
      case 'revenue':
        result = await store.revenue(r);
        break;
      case 'errors':
        result = { rows: await store.errors(r, limitOf(url)) };
        break;
      default:
        throw new HttpError(404, 'unknown query');
    }
    return json(result, 200);
  }

  async function handleFetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return null;
    const sub = url.pathname.slice(basePath.length);
    try {
      if (sub === '/ingest' && req.method === 'POST') return await handleIngest(req);
      if (sub === '/health' && req.method === 'GET') return json({ ok: true }, 200);
      if (sub.startsWith('/query/') && req.method === 'GET') {
        return await handleQuery(req, url, sub.slice('/query/'.length));
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      warn('request failed', err);
      return json({ error: 'internal error' }, 500);
    }
  }

  return {
    fetch: handleFetch,
    toNodeHandler() {
      return (req, res, next) => {
        void nodeHandle(handleFetch, req, res, next).catch((err: unknown) => {
          if (next) return next(err);
          if (!res.headersSent) res.statusCode = 500;
          res.end('pulse error');
        });
      };
    },
    express: (o) => expressMiddleware(recordRequest, basePath, o),
    fastify: (o) => fastifyPlugin(recordRequest, basePath, o),
    withRoute: makeWithRoute(recordRequest),
    track(event, props, opts) {
      if (typeof event !== 'string' || event.length === 0) return;
      pushEvents([
        {
          ts: Date.now(),
          event: event.slice(0, 128),
          anonId: opts?.anonId ?? opts?.userId ?? 'server',
          sessionId: opts?.sessionId ?? 'server',
          userId: opts?.userId ?? null,
          platform: 'node',
          app,
          url: null,
          referrer: null,
          props: props ?? {},
          ua: null,
          ip: null,
        },
      ]);
    },
    recordRequest,
    flush: flushBuffers,
    async shutdown() {
      clearInterval(interval);
      await flushBuffers();
      await otlp?.shutdown();
      await store.close?.();
    },
    store,
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function nodeHandle(
  handleFetch: (req: Request) => Promise<Response | null>,
  req: IncomingMessage,
  res: ServerResponse,
  next?: (err?: unknown) => void,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const fwd = req.headers['x-forwarded-proto'];
  const proto =
    (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() ||
    ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const host = req.headers.host ?? 'localhost';

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  // Direct connections have no XFF — surface the socket address for IP capture.
  if (!headers.has('x-forwarded-for') && req.socket.remoteAddress) {
    headers.set('x-forwarded-for', req.socket.remoteAddress);
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD' && body.length > 0;
  const request = new Request(`${proto}://${host}${req.url ?? '/'}`, {
    method,
    headers,
    body: hasBody ? body : undefined,
  });

  const response = await handleFetch(request);
  if (response === null) {
    if (next) return next();
    res.statusCode = 404;
    res.end();
    return;
  }

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf.length > 0 ? buf : undefined);
}
