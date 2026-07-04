// ClickHouse store for scale — speaks the native HTTP interface directly
// (INSERT … FORMAT JSONEachRow / SELECT … FORMAT JSON), so it needs no driver
// at all. MergeTree tables partitioned by day, ordered for the query shapes
// the dashboard uses. Values are interpolated with strict escaping/coercion
// because the HTTP interface has no bind parameters.

import type { PulseStore, StoreRange } from '../store.js';
import { REVENUE_EVENTS } from '../types.js';

export interface ClickhouseStoreOptions {
  /** e.g. http://default:pass@localhost:8123/pulse — default: KB_PULSE_CLICKHOUSE_URL. */
  url?: string;
}

type Row = Record<string, unknown>;

const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === 'nan' ? null : Number.isFinite(Number(v)) ? Number(v) : null;

/** ClickHouse string literal escaping (backslash + single quote). */
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const int = (n: number): number => Math.trunc(n);

const ACTOR = `if(user_id != '', user_id, anon_id)`;
const IS_PAY = `event IN (${REVENUE_EVENTS.map((e) => `'${e}'`).join(', ')}) AND JSONType(props, 'amount') IN ('Int64', 'UInt64', 'Double')`;
const AMOUNT = `JSONExtractFloat(props, 'amount')`;
const MS = `toUnixTimestamp64Milli(ts)`;
const Q50 = 'quantileExactInclusive(0.5)';
const Q75 = 'quantileExactInclusive(0.75)';
const Q95 = 'quantileExactInclusive(0.95)';
const Q99 = 'quantileExactInclusive(0.99)';

const DDL_EVENTS = `
CREATE TABLE IF NOT EXISTS pulse_events (
  ts DateTime64(3, 'UTC'),
  event LowCardinality(String),
  anon_id String,
  session_id String,
  user_id String DEFAULT '',
  platform LowCardinality(String) DEFAULT 'web',
  app LowCardinality(String) DEFAULT '',
  url String DEFAULT '',
  referrer String DEFAULT '',
  props String DEFAULT '{}',
  ua String DEFAULT '',
  ip String DEFAULT ''
) ENGINE = MergeTree PARTITION BY toDate(ts) ORDER BY (event, ts)`;

const DDL_REQUESTS = `
CREATE TABLE IF NOT EXISTS pulse_requests (
  ts DateTime64(3, 'UTC'),
  method LowCardinality(String),
  route LowCardinality(String),
  status UInt16,
  dur_ms Float64,
  trace_id String DEFAULT '',
  session_id String DEFAULT '',
  app LowCardinality(String) DEFAULT ''
) ENGINE = MergeTree PARTITION BY toDate(ts) ORDER BY (route, ts)`;

export function clickhouseStore(options: ClickhouseStoreOptions = {}): PulseStore {
  const raw = options.url ?? process.env.KB_PULSE_CLICKHOUSE_URL;
  let base = '';
  let auth: string | undefined;
  let database = 'default';

  function configure(): void {
    if (base) return;
    if (!raw) {
      throw new Error(
        '@kitbash/pulse: clickhouseStore needs a URL — set KB_PULSE_CLICKHOUSE_URL or pass options.url',
      );
    }
    const u = new URL(raw);
    if (u.username || u.password) {
      auth = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
    }
    database = u.pathname.replace(/^\/+/, '') || 'default';
    base = u.origin;
  }

  async function exec(query: string, body?: string): Promise<string> {
    configure();
    const url = `${base}/?database=${encodeURIComponent(database)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        ...(auth ? { authorization: auth } : {}),
      },
      body: body === undefined ? query : `${query}\n${body}`,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`@kitbash/pulse: clickhouse ${res.status} — ${text.slice(0, 300)}`);
    }
    return text;
  }

  async function select(query: string): Promise<Row[]> {
    const text = await exec(`${query} FORMAT JSON`);
    const parsed = JSON.parse(text) as { data?: Row[] };
    return parsed.data ?? [];
  }

  const range = (r: StoreRange) => `${MS} >= ${int(r.from)} AND ${MS} <= ${int(r.to)}`;
  const bucket = (r: StoreRange) => `intDiv(${MS}, ${int(r.intervalMs)}) * ${int(r.intervalMs)}`;

  async function seriesQuery(table: string, where: string, r: StoreRange, agg = 'count()') {
    const rows = await select(
      `SELECT ${bucket(r)} AS t, ${agg} AS v FROM ${table} WHERE ${range(r)}${where} GROUP BY t ORDER BY t`,
    );
    return rows.map((row) => ({ t: num(row['t']), v: num(row['v']) }));
  }

  return {
    async init() {
      await exec(DDL_EVENTS);
      await exec(DDL_REQUESTS);
    },

    async insertEvents(rows) {
      if (rows.length === 0) return;
      const lines = rows
        .map((e) =>
          JSON.stringify({
            ts: (e.ts / 1000).toFixed(3),
            event: e.event,
            anon_id: e.anonId,
            session_id: e.sessionId,
            user_id: e.userId ?? '',
            platform: e.platform,
            app: e.app ?? '',
            url: e.url ?? '',
            referrer: e.referrer ?? '',
            props: JSON.stringify(e.props ?? {}),
            ua: e.ua ?? '',
            ip: e.ip ?? '',
          }),
        )
        .join('\n');
      await exec('INSERT INTO pulse_events FORMAT JSONEachRow', lines);
    },

    async insertRequests(rows) {
      if (rows.length === 0) return;
      const lines = rows
        .map((e) =>
          JSON.stringify({
            ts: (e.ts / 1000).toFixed(3),
            method: e.method,
            route: e.route,
            status: e.status,
            dur_ms: e.durMs,
            trace_id: e.traceId ?? '',
            session_id: e.sessionId ?? '',
            app: e.app ?? '',
          }),
        )
        .join('\n');
      await exec('INSERT INTO pulse_requests FORMAT JSONEachRow', lines);
    },

    async overview(r) {
      const [ev] = await select(
        `SELECT count() AS events,
                uniqExact(session_id) AS sessions,
                uniqExact(${ACTOR}) AS users,
                countIf(event = 'error') AS client_errors,
                sumIf(${AMOUNT}, ${IS_PAY}) AS revenue,
                uniqExactIf(${ACTOR}, ${IS_PAY}) AS payers
         FROM pulse_events WHERE ${range(r)}`,
      );
      const [rq] = await select(
        `SELECT count() AS requests, countIf(status >= 500) AS errors FROM pulse_requests WHERE ${range(r)}`,
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
      if (metric === 'sessions') return seriesQuery('pulse_events', '', r, 'uniqExact(session_id)');
      if (metric === 'requests') return seriesQuery('pulse_requests', '', r);
      if (metric === 'revenue') {
        return seriesQuery('pulse_events', ` AND ${IS_PAY}`, r, `sum(${AMOUNT})`);
      }
      const [a, b] = await Promise.all([
        seriesQuery('pulse_events', ` AND event = 'error'`, r),
        seriesQuery('pulse_requests', ' AND status >= 500', r),
      ]);
      const merged = new Map<number, number>();
      for (const p of [...a, ...b]) merged.set(p.t, (merged.get(p.t) ?? 0) + p.v);
      return [...merged.entries()].map(([t, v]) => ({ t, v })).sort((x, y) => x.t - y.t);
    },

    async latency(r) {
      const points = await select(
        `SELECT ${bucket(r)} AS t, ${Q50}(dur_ms) AS p50, ${Q95}(dur_ms) AS p95, ${Q99}(dur_ms) AS p99
         FROM pulse_requests WHERE ${range(r)} GROUP BY t ORDER BY t`,
      );
      const [all] = await select(
        `SELECT ${Q50}(dur_ms) AS p50, ${Q95}(dur_ms) AS p95, ${Q99}(dur_ms) AS p99
         FROM pulse_requests WHERE ${range(r)}`,
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
      const value = `JSONExtractFloat(props, 'value')`;
      const rows = await select(
        `SELECT JSONExtractString(props, 'name') AS name,
                ${Q50}(${value}) AS p50, ${Q75}(${value}) AS p75, ${Q95}(${value}) AS p95, count() AS count
         FROM pulse_events
         WHERE ${range(r)} AND event = 'web_vital'
           AND JSONHas(props, 'name') AND JSONType(props, 'value') IN ('Int64', 'UInt64', 'Double')
         GROUP BY name ORDER BY name`,
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
      const rows = await select(
        `SELECT event, count() AS count, uniqExact(${ACTOR}) AS users
         FROM pulse_events WHERE ${range(r)} GROUP BY event ORDER BY count DESC LIMIT ${int(limit)}`,
      );
      return rows.map((row) => ({
        event: String(row['event'] ?? ''),
        count: num(row['count']),
        users: num(row['users']),
      }));
    },

    async topRoutes(r, limit) {
      const rows = await select(
        `SELECT route, count() AS count, ${Q95}(dur_ms) AS p95, countIf(status >= 500) AS errors
         FROM pulse_requests WHERE ${range(r)} GROUP BY route ORDER BY count DESC LIMIT ${int(limit)}`,
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
      const windowSec = Math.max(1, Math.ceil((r.to - r.from) / 1000));
      const conds = steps.map((s) => `event = '${esc(s)}'`).join(', ');
      const names = steps.map((s) => `'${esc(s)}'`).join(', ');
      const counts = steps.map((_, i) => `countIf(lvl >= ${i + 1}) AS c${i}`).join(', ');
      const [row] = await select(
        `SELECT ${counts} FROM (
           SELECT ${ACTOR} AS actor, windowFunnel(${windowSec})(ts, ${conds}) AS lvl
           FROM pulse_events WHERE ${range(r)} AND event IN (${names})
           GROUP BY actor
         )`,
      );
      const base = num(row?.['c0']);
      return steps.map((event, i) => {
        const actors = num(row?.[`c${i}`]);
        return { event, actors, rate: base === 0 ? 0 : actors / base };
      });
    },

    async revenue(r) {
      const points = await seriesQuery('pulse_events', ` AND ${IS_PAY}`, r, `sum(${AMOUNT})`);
      const [tot] = await select(
        `SELECT sum(${AMOUNT}) AS total, uniqExact(${ACTOR}) AS payers
         FROM pulse_events WHERE ${range(r)} AND ${IS_PAY}`,
      );
      const [conv] = await select(
        `SELECT count() AS new_payers,
                ${Q50}((first_pay - first_seen) / 86400000) AS median_days
         FROM (
           SELECT ${ACTOR} AS actor, min(${MS}) AS first_seen, minIf(${MS}, ${IS_PAY}) AS first_pay
           FROM pulse_events GROUP BY actor HAVING countIf(${IS_PAY}) > 0
         )
         WHERE first_pay >= ${int(r.from)} AND first_pay <= ${int(r.to)}`,
      );
      const [gap] = await select(
        `SELECT ${Q50}(gap_ms / 86400000) AS median_gap FROM (
           SELECT arrayJoin(arraySlice(arrayDifference(arraySort(groupArrayIf(${MS}, ${IS_PAY}))), 2)) AS gap_ms
           FROM pulse_events GROUP BY ${ACTOR} HAVING countIf(${IS_PAY}) >= 2
         )`,
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
      const rows = await select(
        `SELECT substring(if(JSONHas(props, 'message'), JSONExtractString(props, 'message'), 'Unknown error'), 1, 200) AS message,
                count() AS count, max(${MS}) AS last_seen
         FROM pulse_events WHERE ${range(r)} AND event = 'error'
         GROUP BY message ORDER BY count DESC LIMIT ${int(limit)}`,
      );
      return rows.map((row) => ({
        message: String(row['message'] ?? ''),
        count: num(row['count']),
        lastSeen: num(row['last_seen']),
      }));
    },
  };
}
