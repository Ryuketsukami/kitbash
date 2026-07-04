// Thin per-framework shims: measure latency/status/route, lift the client's
// traceparent + x-pulse-session headers, and hand a sample to the collector.
// Frameworks are typed structurally so none of them becomes a dependency.

import type { RequestSample } from './core.js';

export type RecordFn = (sample: RequestSample) => void;

export interface InstrumentOptions {
  /** Return true to leave a request unsampled (health checks, static files…). */
  skip?: (info: { method: string; path: string }) => boolean;
}

type NodeHeaders = Record<string, string | string[] | undefined>;

function getHeader(h: Headers | NodeHeaders, name: string): string | undefined {
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  const v = (h as NodeHeaders)[name];
  return Array.isArray(v) ? v[0] : v;
}

const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

export function traceFromHeaders(h: Headers | NodeHeaders): {
  traceId: string | null;
  sessionId: string | null;
} {
  const tp = getHeader(h, 'traceparent');
  const m = tp ? TRACEPARENT.exec(tp) : null;
  const session = getHeader(h, 'x-pulse-session');
  return {
    traceId: m?.[1] ?? null,
    sessionId: session ? session.slice(0, 64) : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Collapse ids so unrouted paths still group: /users/42/x → /users/:id/x. */
export function normalizeRoute(path: string): string {
  const clean = path.split('?')[0] ?? path;
  return clean
    .split('/')
    .map((seg) => {
      if (/^\d+$/.test(seg)) return ':id';
      if (UUID.test(seg)) return ':id';
      if (/^[0-9a-f]{24,64}$/i.test(seg)) return ':id';
      if (seg.length > 32 && /^[\w-]+$/.test(seg)) return ':id';
      return seg;
    })
    .join('/');
}

// ---- Express ----

interface ExpressReqLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: unknown };
  headers: NodeHeaders;
}

interface ExpressResLike {
  statusCode: number;
  on(event: string, cb: () => void): unknown;
}

export type ExpressMiddleware = (
  req: ExpressReqLike,
  res: ExpressResLike,
  next: (err?: unknown) => void,
) => void;

export function expressMiddleware(
  record: RecordFn,
  basePath: string,
  options: InstrumentOptions = {},
): ExpressMiddleware {
  return (req, res, next) => {
    const method = req.method ?? 'GET';
    const path = (req.originalUrl ?? req.url ?? '/').split('?')[0] ?? '/';
    if (path.startsWith(basePath) || options.skip?.({ method, path })) return next();
    const start = performance.now();
    const trace = traceFromHeaders(req.headers);
    res.on('finish', () => {
      // req.route exists only after the handler ran — read it at finish time.
      const routePath = typeof req.route?.path === 'string' ? req.route.path : null;
      const route = routePath ? `${req.baseUrl ?? ''}${routePath}` : normalizeRoute(path);
      record({
        method,
        route,
        status: res.statusCode,
        durMs: performance.now() - start,
        ...trace,
      });
    });
    next();
  };
}

// ---- Fastify ----

interface FastifyReqLike {
  method: string;
  url: string;
  headers: NodeHeaders;
  routeOptions?: { url?: string };
  routerPath?: string;
}

interface FastifyReplyLike {
  statusCode: number;
  elapsedTime?: number;
  getResponseTime?(): number;
}

interface FastifyLike {
  addHook(
    name: 'onResponse',
    hook: (req: FastifyReqLike, reply: FastifyReplyLike, done: () => void) => void,
  ): unknown;
}

export type FastifyPlugin = (instance: FastifyLike, opts: unknown, done: () => void) => void;

export function fastifyPlugin(
  record: RecordFn,
  basePath: string,
  options: InstrumentOptions = {},
): FastifyPlugin {
  const plugin: FastifyPlugin = (instance, _opts, done) => {
    instance.addHook('onResponse', (req, reply, hookDone) => {
      const path = req.url.split('?')[0] ?? '/';
      if (!path.startsWith(basePath) && !options.skip?.({ method: req.method, path })) {
        const route = req.routeOptions?.url ?? req.routerPath ?? normalizeRoute(path);
        record({
          method: req.method,
          route,
          status: reply.statusCode,
          durMs: reply.elapsedTime ?? reply.getResponseTime?.() ?? 0,
          ...traceFromHeaders(req.headers),
        });
      }
      hookDone();
    });
    done();
  };
  // What fastify-plugin does: hooks apply app-wide, not just in the register scope.
  (plugin as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')] = true;
  return plugin;
}

// ---- fetch-style handlers (Next.js route handlers, Nitro, Bun, workers) ----

export type RouteHandler<C = unknown> = (req: Request, ctx: C) => Response | Promise<Response>;

export function makeWithRoute(record: RecordFn) {
  return function withRoute<C>(route: string, handler: RouteHandler<C>): RouteHandler<C> {
    return async (req, ctx) => {
      const start = performance.now();
      const trace = traceFromHeaders(req.headers);
      try {
        const res = await handler(req, ctx);
        record({
          method: req.method,
          route,
          status: res.status,
          durMs: performance.now() - start,
          ...trace,
        });
        return res;
      } catch (err) {
        record({ method: req.method, route, status: 500, durMs: performance.now() - start, ...trace });
        throw err;
      }
    };
  };
}
