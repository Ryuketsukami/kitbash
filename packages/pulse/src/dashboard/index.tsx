// Mountable React dashboard. Talks only to the collector's read endpoints
// (Bearer read token); charts are hand-rolled SVG so the package stays zero-dep.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  ErrorGroup,
  EventStat,
  FunnelStep,
  LatencyResult,
  Overview,
  RevenueResult,
  RouteStat,
  SeriesPoint,
  VitalStat,
} from '../types.js';

export interface PulseDashboardProps {
  /** Read token — the same value as KB_PULSE_READ_TOKEN on the collector. */
  token: string;
  /** Collector base path or absolute URL. Default '/pulse'. */
  baseUrl?: string;
  /** Auto-refresh interval in ms; 0 disables. Default 30_000. */
  refreshMs?: number;
  /** Ordered funnel steps, e.g. ['page_view', 'signup', 'purchase']. Omit to hide the panel. */
  funnel?: string[];
  className?: string;
}

interface Data {
  overview?: Overview;
  events?: SeriesPoint[];
  requests?: SeriesPoint[];
  errors?: SeriesPoint[];
  latency?: LatencyResult;
  vitals?: VitalStat[];
  topEvents?: EventStat[];
  topRoutes?: RouteStat[];
  funnel?: FunnelStep[];
  revenue?: RevenueResult;
  errorGroups?: ErrorGroup[];
}

const RANGES = [
  { key: '24h', ms: 86_400_000, interval: 1_800_000 },
  { key: '7d', ms: 604_800_000, interval: 14_400_000 },
  { key: '30d', ms: 2_592_000_000, interval: 43_200_000 },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

const COLORS = {
  events: '#6ea8fe',
  requests: '#a78bfa',
  errors: '#f87171',
  revenue: '#34d399',
  p50: '#34d399',
  p95: '#fbbf24',
  p99: '#f87171',
} as const;

// ---- formatting ----

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 10_000) return `${(n / 1e3).toFixed(1)}k`;
  if (Number.isInteger(n)) return String(n);
  return abs >= 100 ? String(Math.round(n)) : n.toFixed(abs >= 1 ? 1 : 2);
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function fmtPct(x: number): string {
  const p = x * 100;
  return `${p >= 10 || p === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

function fmtT(t: number, spanMs: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (spanMs <= 26 * 3_600_000) return time;
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return spanMs <= 8 * 86_400_000 ? `${date} ${time}` : date;
}

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const VITAL_ORDER = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];
const VITAL_LIMITS: Record<string, readonly [number, number]> = {
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

type Tone = 'good' | 'warn' | 'bad';

function vitalTone(name: string, v: number): Tone {
  const lim = VITAL_LIMITS[name];
  if (!lim) return 'good';
  return v <= lim[0] ? 'good' : v <= lim[1] ? 'warn' : 'bad';
}

const fmtVital = (name: string, v: number): string => (name === 'CLS' ? v.toFixed(2) : fmtMs(v));

// ---- data loading ----

async function q<T>(
  base: string,
  token: string,
  path: string,
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${base}/query/${path}?${qs}`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`${path}: ${res.status} ${text}`.trim());
  }
  return (await res.json()) as T;
}

/** Stores return sparse series; charts want a point per bucket. */
function fill(points: SeriesPoint[], from: number, to: number, interval: number): SeriesPoint[] {
  const byT = new Map(points.map((p) => [p.t, p.v]));
  const out: SeriesPoint[] = [];
  for (let t = Math.floor(from / interval) * interval; t <= to; t += interval) {
    out.push({ t, v: byT.get(t) ?? 0 });
  }
  return out;
}

async function loadAll(
  base: string,
  token: string,
  rangeKey: RangeKey,
  funnelKey: string,
  signal: AbortSignal,
): Promise<{ data: Data; firstError: string | null }> {
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[0];
  const to = Date.now();
  const from = to - range.ms;
  const params = { from: String(from), to: String(to), interval: String(range.interval) };
  const errs: string[] = [];
  const soft = <T,>(p: Promise<T>): Promise<T | undefined> =>
    p.catch((e: unknown) => {
      if (!signal.aborted) errs.push(e instanceof Error ? e.message : String(e));
      return undefined;
    });
  const get = <T,>(path: string, extra?: Record<string, string>): Promise<T> =>
    q<T>(base, token, path, { ...params, ...extra }, signal);
  const steps = funnelKey.split(',').filter((s) => s.length > 0);

  const [overview, ev, rq, er, latency, vitals, topEvents, topRoutes, revenue, errorGroups, funnel] =
    await Promise.all([
      soft(get<Overview>('overview')),
      soft(get<{ points: SeriesPoint[] }>('series', { metric: 'events' })),
      soft(get<{ points: SeriesPoint[] }>('series', { metric: 'requests' })),
      soft(get<{ points: SeriesPoint[] }>('series', { metric: 'errors' })),
      soft(get<LatencyResult>('latency')),
      soft(get<{ vitals: VitalStat[] }>('vitals')),
      soft(get<{ rows: EventStat[] }>('events', { limit: '10' })),
      soft(get<{ rows: RouteStat[] }>('routes', { limit: '10' })),
      soft(get<RevenueResult>('revenue')),
      soft(get<{ rows: ErrorGroup[] }>('errors', { limit: '10' })),
      steps.length >= 2
        ? soft(get<{ steps: FunnelStep[] }>('funnel', { steps: steps.join(',') }))
        : Promise.resolve(undefined),
    ]);

  const f = (p: { points: SeriesPoint[] } | undefined): SeriesPoint[] | undefined =>
    p ? fill(p.points, from, to, range.interval) : undefined;
  return {
    data: {
      overview,
      events: f(ev),
      requests: f(rq),
      errors: f(er),
      latency,
      vitals: vitals?.vitals,
      topEvents: topEvents?.rows,
      topRoutes: topRoutes?.rows,
      revenue: revenue
        ? { ...revenue, points: fill(revenue.points, from, to, range.interval) }
        : undefined,
      errorGroups: errorGroups?.rows,
      funnel: funnel?.steps,
    },
    firstError: errs[0] ?? null,
  };
}

// ---- chart ----

interface ChartLine {
  label: string;
  color: string;
  points: SeriesPoint[];
}

function pathOf(points: SeriesPoint[], X: (t: number) => number, Y: (v: number) => number): string {
  const first = points[0];
  if (!first) return '';
  if (points.length === 1) {
    return `M ${(X(first.t) - 3).toFixed(2)} ${Y(first.v).toFixed(2)} L ${(X(first.t) + 3).toFixed(2)} ${Y(first.v).toFixed(2)}`;
  }
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${X(p.t).toFixed(2)} ${Y(p.v).toFixed(2)}`)
    .join(' ');
}

function LineChart({ lines, unit }: { lines: ChartLine[]; unit: 'count' | 'ms' }) {
  const all = lines.flatMap((l) => l.points);
  if (all.length === 0) return <div className="kbp-empty">no data yet</div>;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMax = 0;
  for (const p of all) {
    if (p.t < xMin) xMin = p.t;
    if (p.t > xMax) xMax = p.t;
    if (p.v > yMax) yMax = p.v;
  }
  if (yMax <= 0) yMax = 1;
  const W = 600;
  const H = 150;
  const spanX = Math.max(1, xMax - xMin);
  const X = (t: number): number => ((t - xMin) / spanX) * W;
  const Y = (v: number): number => H - 6 - (v / yMax) * (H - 14);
  const fmt = unit === 'ms' ? fmtMs : fmtNum;
  const area = lines.length === 1 ? lines[0] : undefined;
  const areaFirst = area?.points[0];
  const areaLast = area?.points[area.points.length - 1];
  return (
    <div className="kbp-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 150, display: 'block' }}>
        {[0.25, 0.5, 0.75].map((frac) => (
          <line
            key={frac}
            x1={0}
            x2={W}
            y1={Y(yMax * frac)}
            y2={Y(yMax * frac)}
            className="kbp-gridline"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {area && areaFirst && areaLast && area.points.length > 1 && (
          <path
            d={`${pathOf(area.points, X, Y)} L ${X(areaLast.t).toFixed(2)} ${H} L ${X(areaFirst.t).toFixed(2)} ${H} Z`}
            fill={area.color}
            opacity={0.12}
            stroke="none"
          />
        )}
        {lines.map((l) => (
          <path
            key={l.label}
            d={pathOf(l.points, X, Y)}
            fill="none"
            stroke={l.color}
            strokeWidth={1.8}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="kbp-chart-max">{fmt(yMax)}</div>
      <div className="kbp-chart-x">
        <span>{fmtT(xMin, spanX)}</span>
        <span>{fmtT(xMax, spanX)}</span>
      </div>
      <div className="kbp-legend">
        {lines.map((l) => (
          <span key={l.label}>
            <i style={{ background: l.color }} /> {l.label}{' '}
            <b>{fmt(l.points[l.points.length - 1]?.v ?? 0)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- small pieces ----

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="kbp-panel">
      <div className="kbp-panel-t">{title}</div>
      {children}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="kbp-tile">
      <div className={`kbp-tile-v${tone ? ` kbp-${tone}` : ''}`}>{value}</div>
      <div className="kbp-tile-l">{label}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <b>{value}</b>
      {label}
    </span>
  );
}

// ---- dashboard ----

export function PulseDashboard(props: PulseDashboardProps) {
  const base = (props.baseUrl ?? '/pulse').replace(/\/+$/, '');
  const refreshMs = props.refreshMs ?? 30_000;
  const funnelKey = props.funnel?.map((s) => s.trim()).join(',') ?? '';
  const [rangeKey, setRangeKey] = useState<RangeKey>('24h');
  const [data, setData] = useState<Data>({});
  const [err, setErr] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = async () => {
      const { data: next, firstError } = await loadAll(base, props.token, rangeKey, funnelKey, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setData(next);
      setErr(firstError);
      setUpdatedAt(Date.now());
    };
    void load();
    const timer = refreshMs > 0 ? setInterval(() => void load(), refreshMs) : undefined;
    return () => {
      ctrl.abort();
      if (timer !== undefined) clearInterval(timer);
    };
  }, [base, props.token, rangeKey, funnelKey, refreshMs, tick]);

  const o = data.overview;
  const rev = data.revenue;
  const lat = data.latency;
  const errorTone: Tone | undefined =
    o === undefined ? undefined : o.errorRate > 0.05 ? 'bad' : o.errorRate > 0.01 ? 'warn' : 'good';
  const vitals = data.vitals
    ? [...data.vitals].sort((a, b) => {
        const ia = VITAL_ORDER.indexOf(a.name);
        const ib = VITAL_ORDER.indexOf(b.name);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      })
    : undefined;

  return (
    <div className={`kbp${props.className ? ` ${props.className}` : ''}`}>
      <style>{CSS}</style>
      <div className="kbp-head">
        <div className="kbp-title">Pulse</div>
        <div className="kbp-ranges">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              className={`kbp-range${r.key === rangeKey ? ' kbp-on' : ''}`}
              onClick={() => setRangeKey(r.key)}
            >
              {r.key}
            </button>
          ))}
          <button type="button" className="kbp-range" onClick={() => setTick((t) => t + 1)}>
            refresh
          </button>
        </div>
        {updatedAt !== null && <div className="kbp-updated">updated {ago(updatedAt)}</div>}
      </div>

      {err !== null && <div className="kbp-banner">{err}</div>}

      <div className="kbp-tiles">
        <Tile label="events" value={o ? fmtNum(o.events) : '—'} />
        <Tile label="sessions" value={o ? fmtNum(o.sessions) : '—'} />
        <Tile label="users" value={o ? fmtNum(o.users) : '—'} />
        <Tile label="api requests" value={o ? fmtNum(o.requests) : '—'} />
        <Tile label="5xx rate" value={o ? fmtPct(o.errorRate) : '—'} tone={errorTone} />
        <Tile label="client errors" value={o ? fmtNum(o.clientErrors) : '—'} tone={o && o.clientErrors > 0 ? 'warn' : undefined} />
        <Tile label="revenue" value={o ? fmtNum(o.revenue) : '—'} tone="good" />
        <Tile label="payers" value={o ? fmtNum(o.payers) : '—'} />
      </div>

      <div className="kbp-grid">
        <Panel title="Traffic">
          <LineChart
            unit="count"
            lines={[
              ...(data.events ? [{ label: 'events', color: COLORS.events, points: data.events }] : []),
              ...(data.requests ? [{ label: 'api requests', color: COLORS.requests, points: data.requests }] : []),
            ]}
          />
        </Panel>
        <Panel title="API latency">
          {lat && lat.points.length > 0 ? (
            <>
              <LineChart
                unit="ms"
                lines={[
                  { label: 'p50', color: COLORS.p50, points: lat.points.map((p) => ({ t: p.t, v: p.p50 })) },
                  { label: 'p95', color: COLORS.p95, points: lat.points.map((p) => ({ t: p.t, v: p.p95 })) },
                  { label: 'p99', color: COLORS.p99, points: lat.points.map((p) => ({ t: p.t, v: p.p99 })) },
                ]}
              />
              <div className="kbp-stats">
                <Stat label="p50 overall" value={fmtMs(lat.p50)} />
                <Stat label="p95 overall" value={fmtMs(lat.p95)} />
                <Stat label="p99 overall" value={fmtMs(lat.p99)} />
              </div>
            </>
          ) : (
            <div className="kbp-empty">no requests yet</div>
          )}
        </Panel>
        <Panel title="Errors (client + 5xx)">
          <LineChart
            unit="count"
            lines={data.errors ? [{ label: 'errors', color: COLORS.errors, points: data.errors }] : []}
          />
        </Panel>
        <Panel title="Revenue">
          {rev ? (
            <>
              <LineChart
                unit="count"
                lines={[{ label: 'revenue', color: COLORS.revenue, points: rev.points }]}
              />
              <div className="kbp-stats">
                <Stat label="total" value={fmtNum(rev.total)} />
                <Stat label="arpu" value={fmtNum(rev.arpu)} />
                <Stat label="new payers" value={fmtNum(rev.newPayers)} />
                <Stat
                  label="median days to convert"
                  value={rev.medianDaysToConvert === null ? '—' : rev.medianDaysToConvert.toFixed(1)}
                />
                <Stat
                  label="median days between payments"
                  value={rev.medianDaysBetweenPayments === null ? '—' : rev.medianDaysBetweenPayments.toFixed(1)}
                />
              </div>
            </>
          ) : (
            <div className="kbp-empty">no data yet</div>
          )}
        </Panel>
      </div>

      <div className="kbp-grid">
        <Panel title="Web vitals (p75)">
          {vitals && vitals.length > 0 ? (
            <div className="kbp-tiles kbp-tight">
              {vitals.map((v) => (
                <div className="kbp-tile" key={v.name}>
                  <div className={`kbp-tile-v kbp-${vitalTone(v.name, v.p75)}`}>{fmtVital(v.name, v.p75)}</div>
                  <div className="kbp-tile-l">
                    {v.name} · p50 {fmtVital(v.name, v.p50)} · p95 {fmtVital(v.name, v.p95)} · n={fmtNum(v.count)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="kbp-empty">no vitals yet</div>
          )}
        </Panel>
        {funnelKey.split(',').filter((s) => s.length > 0).length >= 2 && (
          <Panel title="Funnel">
            {data.funnel && data.funnel.length > 0 ? (
              <div>
                {data.funnel.map((s, i) => (
                  <div className="kbp-funnel-row" key={s.event}>
                    <div className="kbp-funnel-label">
                      {i + 1}. {s.event}
                    </div>
                    <div className="kbp-funnel-track">
                      <div className="kbp-funnel-bar" style={{ width: `${Math.max(2, s.rate * 100)}%` }} />
                    </div>
                    <div className="kbp-funnel-nums">
                      {fmtNum(s.actors)} · {fmtPct(s.rate)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="kbp-empty">no data yet</div>
            )}
          </Panel>
        )}
      </div>

      <div className="kbp-grid">
        <Panel title="Top events">
          {data.topEvents && data.topEvents.length > 0 ? (
            <table className="kbp-table">
              <thead>
                <tr>
                  <th>event</th>
                  <th className="kbp-r">count</th>
                  <th className="kbp-r">users</th>
                </tr>
              </thead>
              <tbody>
                {data.topEvents.map((e) => (
                  <tr key={e.event}>
                    <td>{e.event}</td>
                    <td className="kbp-r">{fmtNum(e.count)}</td>
                    <td className="kbp-r">{fmtNum(e.users)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="kbp-empty">no events yet</div>
          )}
        </Panel>
        <Panel title="Top API routes">
          {data.topRoutes && data.topRoutes.length > 0 ? (
            <table className="kbp-table">
              <thead>
                <tr>
                  <th>route</th>
                  <th className="kbp-r">count</th>
                  <th className="kbp-r">p95</th>
                  <th className="kbp-r">5xx</th>
                </tr>
              </thead>
              <tbody>
                {data.topRoutes.map((r) => (
                  <tr key={r.route}>
                    <td>{r.route}</td>
                    <td className="kbp-r">{fmtNum(r.count)}</td>
                    <td className="kbp-r">{fmtMs(r.p95)}</td>
                    <td className={`kbp-r${r.errors > 0 ? ' kbp-bad' : ''}`}>{fmtNum(r.errors)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="kbp-empty">no requests yet</div>
          )}
        </Panel>
        <Panel title="Recent errors">
          {data.errorGroups && data.errorGroups.length > 0 ? (
            <table className="kbp-table">
              <thead>
                <tr>
                  <th>message</th>
                  <th className="kbp-r">count</th>
                  <th className="kbp-r">last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.errorGroups.map((g) => (
                  <tr key={g.message}>
                    <td title={g.message}>{g.message}</td>
                    <td className="kbp-r">{fmtNum(g.count)}</td>
                    <td className="kbp-r">{ago(g.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="kbp-empty">no errors — nice</div>
          )}
        </Panel>
      </div>
    </div>
  );
}

const CSS = `
.kbp{--kbp-bg:#0c1120;--kbp-panel:#141b30;--kbp-border:#232c4a;--kbp-fg:#e7eaf4;--kbp-muted:#939bb4;--kbp-accent:#6ea8fe;--kbp-good-c:#34d399;--kbp-warn-c:#fbbf24;--kbp-bad-c:#f87171;background:var(--kbp-bg);color:var(--kbp-fg);font:14px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;padding:16px;border-radius:14px}
.kbp *{box-sizing:border-box}
.kbp button{font:inherit}
.kbp-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.kbp-title{font-size:17px;font-weight:700;margin-right:auto;letter-spacing:.02em}
.kbp-ranges{display:flex;gap:6px}
.kbp-range{background:var(--kbp-panel);border:1px solid var(--kbp-border);color:var(--kbp-muted);border-radius:8px;padding:4px 10px;cursor:pointer}
.kbp-range.kbp-on{color:var(--kbp-fg);border-color:var(--kbp-accent)}
.kbp-updated{color:var(--kbp-muted);font-size:12px}
.kbp-banner{background:rgba(248,113,113,.12);border:1px solid var(--kbp-bad-c);color:var(--kbp-bad-c);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:13px;word-break:break-word}
.kbp-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:12px}
.kbp-tiles.kbp-tight{margin-bottom:0}
.kbp-tile{background:var(--kbp-panel);border:1px solid var(--kbp-border);border-radius:10px;padding:10px 12px}
.kbp-tight .kbp-tile{background:var(--kbp-bg)}
.kbp-tile-v{font-size:20px;font-weight:700}
.kbp-tile-l{color:var(--kbp-muted);font-size:12px;margin-top:2px}
.kbp-good{color:var(--kbp-good-c)}
.kbp-warn{color:var(--kbp-warn-c)}
.kbp-bad{color:var(--kbp-bad-c)}
.kbp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px;margin-bottom:12px}
.kbp-panel{background:var(--kbp-panel);border:1px solid var(--kbp-border);border-radius:12px;padding:12px;min-width:0}
.kbp-panel-t{font-size:12px;font-weight:600;color:var(--kbp-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
.kbp-chart{position:relative}
.kbp-gridline{stroke:var(--kbp-border);stroke-width:1;stroke-dasharray:3 4}
.kbp-chart-max{position:absolute;top:0;left:2px;font-size:11px;color:var(--kbp-muted)}
.kbp-chart-x{display:flex;justify-content:space-between;font-size:11px;color:var(--kbp-muted);margin-top:2px}
.kbp-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--kbp-muted);margin-top:6px}
.kbp-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px}
.kbp-legend b{color:var(--kbp-fg)}
.kbp-stats{display:flex;gap:18px;flex-wrap:wrap;margin-top:10px;font-size:12px;color:var(--kbp-muted)}
.kbp-stats b{color:var(--kbp-fg);font-size:14px;display:block}
.kbp-table{width:100%;border-collapse:collapse;font-size:13px}
.kbp-table th{text-align:left;color:var(--kbp-muted);font-weight:500;font-size:12px;padding:4px 8px 4px 0;border-bottom:1px solid var(--kbp-border)}
.kbp-table td{padding:5px 8px 5px 0;border-bottom:1px solid var(--kbp-border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
.kbp-table th.kbp-r,.kbp-table td.kbp-r{text-align:right;padding-right:0}
.kbp-empty{color:var(--kbp-muted);font-size:13px;padding:18px 0;text-align:center}
.kbp-funnel-row{display:grid;grid-template-columns:minmax(90px,170px) 1fr 110px;gap:10px;align-items:center;margin-bottom:8px;font-size:13px}
.kbp-funnel-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kbp-funnel-track{background:var(--kbp-bg);border-radius:6px;height:18px;overflow:hidden}
.kbp-funnel-bar{background:var(--kbp-accent);height:100%;border-radius:6px}
.kbp-funnel-nums{color:var(--kbp-muted);text-align:right;white-space:nowrap}
`;
