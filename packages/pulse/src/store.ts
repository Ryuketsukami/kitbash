// The storage seam. Every adapter (memory here, Postgres/ClickHouse under
// ./adapters/*) implements the same semantic queries, so moving from small to
// large scale is a one-line store swap. Series results are sparse (empty
// buckets omitted, sorted by t) — renderers fill gaps.

import type {
  ErrorGroup,
  EventStat,
  FunnelStep,
  LatencyResult,
  Overview,
  RevenueResult,
  RouteStat,
  SeriesMetric,
  SeriesPoint,
  VitalStat,
} from './types.js';
import { PULSE_EVENTS, REVENUE_EVENTS } from './types.js';

/** One stored client event. `ts` is epoch ms everywhere. */
export interface EventRow {
  ts: number;
  event: string;
  anonId: string;
  sessionId: string;
  userId: string | null;
  platform: string;
  app: string | null;
  url: string | null;
  referrer: string | null;
  props: Record<string, unknown>;
  ua: string | null;
  ip: string | null;
}

/** One stored backend request sample. */
export interface RequestRow {
  ts: number;
  method: string;
  route: string;
  status: number;
  durMs: number;
  traceId: string | null;
  sessionId: string | null;
  app: string | null;
}

export interface StoreRange {
  from: number;
  to: number;
  intervalMs: number;
}

export interface PulseStore {
  /** Create tables / verify connectivity. Idempotent. */
  init(): Promise<void>;
  insertEvents(rows: EventRow[]): Promise<void>;
  insertRequests(rows: RequestRow[]): Promise<void>;
  overview(r: StoreRange): Promise<Overview>;
  series(metric: SeriesMetric, r: StoreRange): Promise<SeriesPoint[]>;
  latency(r: StoreRange): Promise<LatencyResult>;
  vitals(r: StoreRange): Promise<VitalStat[]>;
  topEvents(r: StoreRange, limit: number): Promise<EventStat[]>;
  topRoutes(r: StoreRange, limit: number): Promise<RouteStat[]>;
  funnel(steps: string[], r: StoreRange): Promise<FunnelStep[]>;
  revenue(r: StoreRange): Promise<RevenueResult>;
  errors(r: StoreRange, limit: number): Promise<ErrorGroup[]>;
  close?(): Promise<void>;
}

export const actorOf = (e: { userId: string | null; anonId: string }): string =>
  e.userId ?? e.anonId;

export const isRevenueEvent = (name: string): boolean =>
  (REVENUE_EVENTS as readonly string[]).includes(name);

export function revenueAmount(e: EventRow): number | null {
  if (!isRevenueEvent(e.event)) return null;
  const v = e.props['amount'];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** percentile_cont semantics (linear interpolation) over an unsorted sample. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = s[lo] ?? 0;
  const b = s[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

const median = (values: number[]): number | null =>
  values.length === 0 ? null : percentile(values, 0.5);

const bucketOf = (ts: number, intervalMs: number): number =>
  Math.floor(ts / intervalMs) * intervalMs;

function toSeries(byBucket: Map<number, number>): SeriesPoint[] {
  return [...byBucket.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
}

export interface MemoryStoreOptions {
  /** FIFO cap per table. Default 100_000. */
  maxRows?: number;
}

/**
 * In-memory store: zero setup for dev and tests, and the reference the SQL
 * adapters are held to. Single process, bounded, gone on restart.
 */
export function memoryStore(options: MemoryStoreOptions = {}): PulseStore {
  const maxRows = options.maxRows ?? 100_000;
  const events: EventRow[] = [];
  const requests: RequestRow[] = [];

  const trim = (arr: unknown[]) => {
    if (arr.length > maxRows) arr.splice(0, arr.length - maxRows);
  };
  const evIn = (r: StoreRange) => events.filter((e) => e.ts >= r.from && e.ts <= r.to);
  const reqIn = (r: StoreRange) => requests.filter((e) => e.ts >= r.from && e.ts <= r.to);

  return {
    init: () => Promise.resolve(),

    insertEvents(rows) {
      events.push(...rows);
      trim(events);
      return Promise.resolve();
    },

    insertRequests(rows) {
      requests.push(...rows);
      trim(requests);
      return Promise.resolve();
    },

    overview(r) {
      const ev = evIn(r);
      const rq = reqIn(r);
      const sessions = new Set(ev.map((e) => e.sessionId));
      const users = new Set(ev.map(actorOf));
      const server5xx = rq.filter((q) => q.status >= 500).length;
      const payerSet = new Set<string>();
      let revenue = 0;
      for (const e of ev) {
        const amount = revenueAmount(e);
        if (amount !== null) {
          revenue += amount;
          payerSet.add(actorOf(e));
        }
      }
      return Promise.resolve({
        events: ev.length,
        sessions: sessions.size,
        users: users.size,
        requests: rq.length,
        errorRate: rq.length === 0 ? 0 : server5xx / rq.length,
        clientErrors: ev.filter((e) => e.event === PULSE_EVENTS.error).length,
        revenue,
        payers: payerSet.size,
      });
    },

    series(metric, r) {
      const add = (m: Map<number, number>, ts: number, v: number) => {
        const t = bucketOf(ts, r.intervalMs);
        m.set(t, (m.get(t) ?? 0) + v);
      };
      const m = new Map<number, number>();
      if (metric === 'events') {
        for (const e of evIn(r)) add(m, e.ts, 1);
      } else if (metric === 'sessions') {
        const seen = new Map<number, Set<string>>();
        for (const e of evIn(r)) {
          const t = bucketOf(e.ts, r.intervalMs);
          let s = seen.get(t);
          if (!s) seen.set(t, (s = new Set()));
          s.add(e.sessionId);
        }
        for (const [t, s] of seen) m.set(t, s.size);
      } else if (metric === 'requests') {
        for (const q of reqIn(r)) add(m, q.ts, 1);
      } else if (metric === 'errors') {
        for (const e of evIn(r)) if (e.event === PULSE_EVENTS.error) add(m, e.ts, 1);
        for (const q of reqIn(r)) if (q.status >= 500) add(m, q.ts, 1);
      } else {
        for (const e of evIn(r)) {
          const amount = revenueAmount(e);
          if (amount !== null) add(m, e.ts, amount);
        }
      }
      return Promise.resolve(toSeries(m));
    },

    latency(r) {
      const rq = reqIn(r);
      const byBucket = new Map<number, number[]>();
      for (const q of rq) {
        const t = bucketOf(q.ts, r.intervalMs);
        let arr = byBucket.get(t);
        if (!arr) byBucket.set(t, (arr = []));
        arr.push(q.durMs);
      }
      const all = rq.map((q) => q.durMs);
      const points = [...byBucket.entries()]
        .map(([t, d]) => ({
          t,
          p50: percentile(d, 0.5),
          p95: percentile(d, 0.95),
          p99: percentile(d, 0.99),
        }))
        .sort((a, b) => a.t - b.t);
      return Promise.resolve({
        points,
        p50: percentile(all, 0.5),
        p95: percentile(all, 0.95),
        p99: percentile(all, 0.99),
      });
    },

    vitals(r) {
      const byName = new Map<string, number[]>();
      for (const e of evIn(r)) {
        if (e.event !== PULSE_EVENTS.webVital) continue;
        const name = typeof e.props['name'] === 'string' ? (e.props['name'] as string) : '';
        const value = e.props['value'];
        if (!name || typeof value !== 'number' || !Number.isFinite(value)) continue;
        let arr = byName.get(name);
        if (!arr) byName.set(name, (arr = []));
        arr.push(value);
      }
      const out = [...byName.entries()].map(([name, v]) => ({
        name,
        p50: percentile(v, 0.5),
        p75: percentile(v, 0.75),
        p95: percentile(v, 0.95),
        count: v.length,
      }));
      out.sort((a, b) => a.name.localeCompare(b.name));
      return Promise.resolve(out);
    },

    topEvents(r, limit) {
      const byEvent = new Map<string, { count: number; users: Set<string> }>();
      for (const e of evIn(r)) {
        let s = byEvent.get(e.event);
        if (!s) byEvent.set(e.event, (s = { count: 0, users: new Set() }));
        s.count += 1;
        s.users.add(actorOf(e));
      }
      const out = [...byEvent.entries()]
        .map(([event, s]) => ({ event, count: s.count, users: s.users.size }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
      return Promise.resolve(out);
    },

    topRoutes(r, limit) {
      const byRoute = new Map<string, { durs: number[]; errors: number }>();
      for (const q of reqIn(r)) {
        let s = byRoute.get(q.route);
        if (!s) byRoute.set(q.route, (s = { durs: [], errors: 0 }));
        s.durs.push(q.durMs);
        if (q.status >= 500) s.errors += 1;
      }
      const out = [...byRoute.entries()]
        .map(([route, s]) => ({
          route,
          count: s.durs.length,
          p95: percentile(s.durs, 0.95),
          errors: s.errors,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
      return Promise.resolve(out);
    },

    funnel(steps, r) {
      if (steps.length === 0) return Promise.resolve([]);
      const ev = evIn(r).sort((a, b) => a.ts - b.ts);
      // reached[actor] = ts at which the actor completed the previous step.
      let reached = new Map<string, number>();
      const first = steps[0] as string;
      for (const e of ev) {
        if (e.event !== first) continue;
        const a = actorOf(e);
        if (!reached.has(a)) reached.set(a, e.ts);
      }
      const counts = [reached.size];
      for (const step of steps.slice(1)) {
        const next = new Map<string, number>();
        for (const e of ev) {
          if (e.event !== step) continue;
          const a = actorOf(e);
          const prev = reached.get(a);
          if (prev !== undefined && e.ts >= prev && !next.has(a)) next.set(a, e.ts);
        }
        reached = next;
        counts.push(next.size);
      }
      const base = counts[0] ?? 0;
      return Promise.resolve(
        steps.map((event, i) => ({
          event,
          actors: counts[i] ?? 0,
          rate: base === 0 ? 0 : (counts[i] ?? 0) / base,
        })),
      );
    },

    revenue(r) {
      // Per-actor payment history over all time — needed for "first payment",
      // conversion delay and repeat cadence; range only scopes the series/total.
      const firstSeen = new Map<string, number>();
      const payments = new Map<string, number[]>();
      for (const e of events) {
        const a = actorOf(e);
        const seen = firstSeen.get(a);
        if (seen === undefined || e.ts < seen) firstSeen.set(a, e.ts);
        const amount = revenueAmount(e);
        if (amount !== null) {
          let arr = payments.get(a);
          if (!arr) payments.set(a, (arr = []));
          arr.push(e.ts);
        }
      }
      const byBucket = new Map<number, number>();
      let total = 0;
      const payersInRange = new Set<string>();
      for (const e of evIn(r)) {
        const amount = revenueAmount(e);
        if (amount === null) continue;
        total += amount;
        payersInRange.add(actorOf(e));
        const t = bucketOf(e.ts, r.intervalMs);
        byBucket.set(t, (byBucket.get(t) ?? 0) + amount);
      }
      let newPayers = 0;
      const convertDays: number[] = [];
      const gapDays: number[] = [];
      for (const [a, ts] of payments) {
        const sorted = [...ts].sort((x, y) => x - y);
        const firstPay = sorted[0] as number;
        if (firstPay >= r.from && firstPay <= r.to) {
          newPayers += 1;
          const seen = firstSeen.get(a) ?? firstPay;
          convertDays.push((firstPay - seen) / 86_400_000);
        }
        for (let i = 1; i < sorted.length; i += 1) {
          gapDays.push(((sorted[i] as number) - (sorted[i - 1] as number)) / 86_400_000);
        }
      }
      return Promise.resolve({
        points: toSeries(byBucket),
        total,
        payers: payersInRange.size,
        newPayers,
        arpu: payersInRange.size === 0 ? 0 : total / payersInRange.size,
        medianDaysToConvert: median(convertDays),
        medianDaysBetweenPayments: median(gapDays),
      });
    },

    errors(r, limit) {
      const groups = new Map<string, { count: number; lastSeen: number }>();
      for (const e of evIn(r)) {
        if (e.event !== PULSE_EVENTS.error) continue;
        const message = String(e.props['message'] ?? 'Unknown error').slice(0, 200);
        const g = groups.get(message);
        if (g) {
          g.count += 1;
          if (e.ts > g.lastSeen) g.lastSeen = e.ts;
        } else {
          groups.set(message, { count: 1, lastSeen: e.ts });
        }
      }
      const out = [...groups.entries()]
        .map(([message, g]) => ({ message, ...g }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
      return Promise.resolve(out);
    },
  };
}
