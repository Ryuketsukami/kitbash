// Postgres store — the easy default. Needs the `pg` package (optional peer),
// imported lazily so nothing else in @kitbash/pulse touches it. Events keep
// their properties in JSONB; percentiles use percentile_cont, so results match
// the in-memory reference exactly.

import type { EventRow, PulseStore, RequestRow, StoreRange } from '../store.js';
import { REVENUE_EVENTS } from '../types.js';
import type { Pool } from 'pg';

export interface PostgresStoreOptions {
  /** Connection string. Default: KB_PULSE_DATABASE_URL. */
  url?: string;
  poolSize?: number;
  /** Convert tables to TimescaleDB hypertables on init (extension required). */
  timescale?: boolean;
}

const DDL = `
CREATE TABLE IF NOT EXISTS pulse_events (
  ts timestamptz NOT NULL,
  event text NOT NULL,
  anon_id text NOT NULL,
  session_id text NOT NULL,
  user_id text,
  platform text NOT NULL DEFAULT 'web',
  app text,
  url text,
  referrer text,
  props jsonb NOT NULL DEFAULT '{}'::jsonb,
  ua text,
  ip text
);
CREATE INDEX IF NOT EXISTS pulse_events_ts_idx ON pulse_events (ts);
CREATE INDEX IF NOT EXISTS pulse_events_event_ts_idx ON pulse_events (event, ts);
CREATE INDEX IF NOT EXISTS pulse_events_actor_ts_idx ON pulse_events ((coalesce(user_id, anon_id)), ts);
CREATE TABLE IF NOT EXISTS pulse_requests (
  ts timestamptz NOT NULL,
  method text NOT NULL,
  route text NOT NULL,
  status integer NOT NULL,
  dur_ms double precision NOT NULL,
  trace_id text,
  session_id text,
  app text
);
CREATE INDEX IF NOT EXISTS pulse_requests_ts_idx ON pulse_requests (ts);
CREATE INDEX IF NOT EXISTS pulse_requests_route_ts_idx ON pulse_requests (route, ts);
`;

const TIMESCALE_DDL = `
SELECT create_hypertable('pulse_events', 'ts', if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('pulse_requests', 'ts', if_not_exists => TRUE, migrate_data => TRUE);
`;

type Row = Record<string, unknown>;

const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

// Shared SQL fragments. All user input travels as bind params — these are static.
const RANGE = `ts >= to_timestamp($1 / 1000.0) AND ts <= to_timestamp($2 / 1000.0)`;
const ACTOR = `coalesce(user_id, anon_id)`;
const IS_PAY = `event = ANY($REV) AND jsonb_typeof(props -> 'amount') = 'number'`;
const AMOUNT = `(props ->> 'amount')::float8`;

export function postgresStore(options: PostgresStoreOptions = {}): PulseStore {
  const url = options.url ?? process.env.KB_PULSE_DATABASE_URL;
  let pool: Pool | null = null;

  async function db(): Promise<Pool> {
    if (pool) return pool;
    if (!url) {
      throw new Error(
        '@kitbash/pulse: postgresStore needs a connection string — set KB_PULSE_DATABASE_URL or pass options.url',
      );
    }
    let mod: typeof import('pg');
    try {
      mod = await import('pg');
    } catch {
      throw new Error("@kitbash/pulse: postgresStore requires the optional peer 'pg' — npm i pg");
    }
    pool = new mod.Pool({ connectionString: url, max: options.poolSize ?? 5 });
    return pool;
  }

  async function q(text: string, params: unknown[] = []): Promise<Row[]> {
    // $REV marks the revenue-event list; splice it in as the last bind param.
    let sql = text;
    if (sql.includes('$REV')) {
      params = [...params, [...REVENUE_EVENTS]];
      sql = sql.replaceAll('$REV', `$${params.length}`);
    }
    const res = await (await db()).query(sql, params);
    return res.rows as Row[];
  }

  const bucket = (r: StoreRange) =>
    `floor(extract(epoch FROM ts) * 1000 / ${Math.trunc(r.intervalMs)}) * ${Math.trunc(r.intervalMs)}`;

  async function seriesQuery(table: string, where: string, r: StoreRange, agg = 'count(*)::float8') {
    const rows = await q(
      `SELECT ${bucket(r)} AS t, ${agg} AS v FROM ${table} WHERE ${RANGE}${where} GROUP BY 1 ORDER BY 1`,
      [r.from, r.to],
    );
    return rows.map((row) => ({ t: num(row['t']), v: num(row['v']) }));
  }

  return {
    async init() {
      await q(DDL);
      if (options.timescale) await q(TIMESCALE_DDL);
    },

    async insertEvents(rows) {
      if (rows.length === 0) return;
      const payload = JSON.stringify(
        rows.map((e) => ({
          ts: e.ts,
          event: e.event,
          anon_id: e.anonId,
          session_id: e.sessionId,
          user_id: e.userId,
          platform: e.platform,
          app: e.app,
          url: e.url,
          referrer: e.referrer,
          props: e.props,
          ua: e.ua,
          ip: e.ip,
        })),
      );
      await q(
        `INSERT INTO pulse_events (ts, event, anon_id, session_id, user_id, platform, app, url, referrer, props, ua, ip)
         SELECT to_timestamp(x.ts / 1000.0), x.event, x.anon_id, x.session_id, x.user_id,
                coalesce(x.platform, 'web'), x.app, x.url, x.referrer, coalesce(x.props, '{}'::jsonb), x.ua, x.ip
         FROM jsonb_to_recordset($1::jsonb) AS x(
           ts float8, event text, anon_id text, session_id text, user_id text, platform text,
           app text, url text, referrer text, props jsonb, ua text, ip text)`,
        [payload],
      );
    },

    async insertRequests(rows) {
      if (rows.length === 0) return;
      const payload = JSON.stringify(
        rows.map((e) => ({
          ts: e.ts,
          method: e.method,
          route: e.route,
          status: e.status,
          dur_ms: e.durMs,
          trace_id: e.traceId,
          session_id: e.sessionId,
          app: e.app,
        })),
      );
      await q(
        `INSERT INTO pulse_requests (ts, method, route, status, dur_ms, trace_id, session_id, app)
         SELECT to_timestamp(x.ts / 1000.0), x.method, x.route, x.status, x.dur_ms, x.trace_id, x.session_id, x.app
         FROM jsonb_to_recordset($1::jsonb) AS x(
           ts float8, method text, route text, status integer, dur_ms float8,
           trace_id text, session_id text, app text)`,
        [payload],
      );
    },

    async overview(r) {
      const [ev] = await q(
        `SELECT count(*)::float8 AS events,
                count(DISTINCT session_id)::float8 AS sessions,
                count(DISTINCT ${ACTOR})::float8 AS users,
                count(*) FILTER (WHERE event = 'error')::float8 AS client_errors,
                coalesce(sum(${AMOUNT}) FILTER (WHERE ${IS_PAY}), 0)::float8 AS revenue,
                count(DISTINCT ${ACTOR}) FILTER (WHERE ${IS_PAY})::float8 AS payers
         FROM pulse_events WHERE ${RANGE}`,
        [r.from, r.to],
      );
      const [rq] = await q(
        `SELECT count(*)::float8 AS requests,
                count(*) FILTER (WHERE status >= 500)::float8 AS errors
         FROM pulse_requests WHERE ${RANGE}`,
        [r.from, r.to],
      );
      const requests = num(rq?.['requests']);
      return {
        events: num(ev?.['events']),
        sessions: num(ev?.['sessions']),
        users: num(ev?.['users']),
        requests,
        errorRate: requests === 0 ? 0 : num(rq?.['errors']) / requests,
        clientErrors: num(ev?.['client_errors']),
        revenue: num(ev?.['revenue']),
        payers: num(ev?.['payers']),
      };
    },

    async series(metric, r) {
      if (metric === 'events') return seriesQuery('pulse_events', '', r);
      if (metric === 'sessions') {
        return seriesQuery('pulse_events', '', r, 'count(DISTINCT session_id)::float8');
      }
      if (metric === 'requests') return seriesQuery('pulse_requests', '', r);
      if (metric === 'revenue') {
        return seriesQuery('pulse_events', ` AND ${IS_PAY}`, r, `coalesce(sum(${AMOUNT}), 0)::float8`);
      }
      // errors = client error events + backend 5xx, merged per bucket
      const [a, b] = await Promise.all([
        seriesQuery('pulse_events', ` AND event = 'error'`, r),
        seriesQuery('pulse_requests', ' AND status >= 500', r),
      ]);
      const merged = new Map<number, number>();
      for (const p of [...a, ...b]) merged.set(p.t, (merged.get(p.t) ?? 0) + p.v);
      return [...merged.entries()].map(([t, v]) => ({ t, v })).sort((x, y) => x.t - y.t);
    },

    async latency(r) {
      const points = await q(
        `SELECT ${bucket(r)} AS t,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY dur_ms) AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY dur_ms) AS p95,
                percentile_cont(0.99) WITHIN GROUP (ORDER BY dur_ms) AS p99
         FROM pulse_requests WHERE ${RANGE} GROUP BY 1 ORDER BY 1`,
        [r.from, r.to],
      );
      const [all] = await q(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY dur_ms) AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY dur_ms) AS p95,
                percentile_cont(0.99) WITHIN GROUP (ORDER BY dur_ms) AS p99
         FROM pulse_requests WHERE ${RANGE}`,
        [r.from, r.to],
      );
      return {
        points: points.map((row) => ({
          t: num(row['t']),
          p50: num(row['p50']),
          p95: num(row['p95']),
          p99: num(row['p99']),
        })),
        p50: num(all?.['p50']),
        p95: num(all?.['p95']),
        p99: num(all?.['p99']),
      };
    },

    async vitals(r) {
      const rows = await q(
        `SELECT props ->> 'name' AS name,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY (props ->> 'value')::float8) AS p50,
                percentile_cont(0.75) WITHIN GROUP (ORDER BY (props ->> 'value')::float8) AS p75,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY (props ->> 'value')::float8) AS p95,
                count(*)::float8 AS count
         FROM pulse_events
         WHERE ${RANGE} AND event = 'web_vital'
           AND props ->> 'name' IS NOT NULL AND jsonb_typeof(props -> 'value') = 'number'
         GROUP BY 1 ORDER BY 1`,
        [r.from, r.to],
      );
      return rows.map((row) => ({
        name: String(row['name'] ?? ''),
        p50: num(row['p50']),
        p75: num(row['p75']),
        p95: num(row['p95']),
        count: num(row['count']),
      }));
    },

    async topEvents(r, limit) {
      const rows = await q(
        `SELECT event, count(*)::float8 AS count, count(DISTINCT ${ACTOR})::float8 AS users
         FROM pulse_events WHERE ${RANGE} GROUP BY 1 ORDER BY count DESC LIMIT $3`,
        [r.from, r.to, limit],
      );
      return rows.map((row) => ({
        event: String(row['event'] ?? ''),
        count: num(row['count']),
        users: num(row['users']),
      }));
    },

    async topRoutes(r, limit) {
      const rows = await q(
        `SELECT route, count(*)::float8 AS count,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY dur_ms) AS p95,
                count(*) FILTER (WHERE status >= 500)::float8 AS errors
         FROM pulse_requests WHERE ${RANGE} GROUP BY 1 ORDER BY count DESC LIMIT $3`,
        [r.from, r.to, limit],
      );
      return rows.map((row) => ({
        route: String(row['route'] ?? ''),
        count: num(row['count']),
        p95: num(row['p95']),
        errors: num(row['errors']),
      }));
    },

    async funnel(steps, r) {
      if (steps.length === 0) return [];
      // One CTE per step: actors who did step N after completing step N-1.
      const params: unknown[] = [r.from, r.to];
      const ctes: string[] = [];
      steps.forEach((step, i) => {
        params.push(step);
        const p = `$${params.length}`;
        if (i === 0) {
          ctes.push(
            `s0 AS (SELECT ${ACTOR} AS actor, min(ts) AS t FROM pulse_events WHERE ${RANGE} AND event = ${p} GROUP BY 1)`,
          );
        } else {
          ctes.push(
            `s${i} AS (SELECT s${i - 1}.actor, min(e.ts) AS t
             FROM pulse_events e JOIN s${i - 1} ON ${ACTOR.replaceAll('user_id', 'e.user_id').replaceAll('anon_id', 'e.anon_id')} = s${i - 1}.actor AND e.ts >= s${i - 1}.t
             WHERE e.ts >= to_timestamp($1 / 1000.0) AND e.ts <= to_timestamp($2 / 1000.0) AND e.event = ${p}
             GROUP BY 1)`,
          );
        }
      });
      const selects = steps.map((_, i) => `(SELECT count(*)::float8 FROM s${i}) AS c${i}`);
      const [row] = await q(`WITH ${ctes.join(', ')} SELECT ${selects.join(', ')}`, params);
      const base = num(row?.['c0']);
      return steps.map((event, i) => {
        const actors = num(row?.[`c${i}`]);
        return { event, actors, rate: base === 0 ? 0 : actors / base };
      });
    },

    async revenue(r) {
      const points = await seriesQuery(
        'pulse_events',
        ` AND ${IS_PAY}`,
        r,
        `coalesce(sum(${AMOUNT}), 0)::float8`,
      );
      const [tot] = await q(
        `SELECT coalesce(sum(${AMOUNT}), 0)::float8 AS total, count(DISTINCT ${ACTOR})::float8 AS payers
         FROM pulse_events WHERE ${RANGE} AND ${IS_PAY}`,
        [r.from, r.to],
      );
      const [conv] = await q(
        `WITH pay AS (
           SELECT ${ACTOR} AS actor, min(ts) AS first_pay
           FROM pulse_events WHERE ${IS_PAY} GROUP BY 1
         ), seen AS (
           SELECT ${ACTOR} AS actor, min(ts) AS first_seen
           FROM pulse_events WHERE ${ACTOR} IN (SELECT actor FROM pay) GROUP BY 1
         )
         SELECT count(*)::float8 AS new_payers,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM p.first_pay - s.first_seen) / 86400.0) AS median_days
         FROM pay p JOIN seen s USING (actor)
         WHERE p.first_pay >= to_timestamp($1 / 1000.0) AND p.first_pay <= to_timestamp($2 / 1000.0)`,
        [r.from, r.to],
      );
      const [gap] = await q(
        `WITH pays AS (
           SELECT ts, lag(ts) OVER (PARTITION BY ${ACTOR} ORDER BY ts) AS prev
           FROM pulse_events WHERE ${IS_PAY}
         )
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ts - prev) / 86400.0) AS median_gap
         FROM pays WHERE prev IS NOT NULL`,
      );
      const total = num(tot?.['total']);
      const payers = num(tot?.['payers']);
      return {
        points,
        total,
        payers,
        newPayers: num(conv?.['new_payers']),
        arpu: payers === 0 ? 0 : total / payers,
        medianDaysToConvert: numOrNull(conv?.['median_days']),
        medianDaysBetweenPayments: numOrNull(gap?.['median_gap']),
      };
    },

    async errors(r, limit) {
      const rows = await q(
        `SELECT left(coalesce(props ->> 'message', 'Unknown error'), 200) AS message,
                count(*)::float8 AS count,
                (extract(epoch FROM max(ts)) * 1000)::float8 AS last_seen
         FROM pulse_events WHERE ${RANGE} AND event = 'error'
         GROUP BY 1 ORDER BY count DESC LIMIT $3`,
        [r.from, r.to, limit],
      );
      return rows.map((row) => ({
        message: String(row['message'] ?? ''),
        count: num(row['count']),
        lastSeen: num(row['last_seen']),
      }));
    },

    async close() {
      await pool?.end();
      pool = null;
    },
  };
}
