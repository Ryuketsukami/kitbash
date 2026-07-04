// Shared contracts. The client speaks PulseBatch to the collector; the dashboard
// speaks the query result shapes to the read endpoints; stores implement the same
// semantic queries — so swapping an adapter never touches callers.

/** One captured event as sent by a client SDK. */
export interface PulseEvent {
  event: string;
  /** Client-clock epoch ms; the collector clamps wild values. */
  ts: number;
  props?: Record<string, unknown>;
  url?: string;
  referrer?: string;
}

/** The envelope POSTed to the first-party ingest endpoint. */
export interface PulseBatch {
  anonId: string;
  sessionId: string;
  userId?: string;
  /** 'web' | 'ios' | 'android' | 'node' | anything you set. */
  platform: string;
  /** App name/version tag, e.g. "myapp@1.4.0". */
  app?: string;
  sentAt: number;
  events: PulseEvent[];
}

/** Event names emitted by autocapture / used by built-in queries. */
export const PULSE_EVENTS = {
  pageView: 'page_view',
  screenView: 'screen_view',
  error: 'error',
  webVital: 'web_vital',
  identify: 'identify',
} as const;

/** Events whose numeric `amount` prop counts as revenue. */
export const REVENUE_EVENTS = ['purchase', 'subscription_started', 'subscription_renewed'] as const;

// ---- Query results (server → dashboard, and what every store returns) ----

export interface SeriesPoint {
  /** Bucket start, epoch ms. */
  t: number;
  v: number;
}

export type SeriesMetric = 'events' | 'sessions' | 'requests' | 'errors' | 'revenue';

export interface Overview {
  events: number;
  sessions: number;
  /** Distinct actors (userId when identified, else anonId). */
  users: number;
  requests: number;
  /** 5xx share of backend requests, 0..1. */
  errorRate: number;
  /** Client-side `error` events. */
  clientErrors: number;
  revenue: number;
  /** Distinct actors with at least one revenue event in range. */
  payers: number;
}

export interface LatencyPoint {
  t: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface LatencyResult {
  points: LatencyPoint[];
  p50: number;
  p95: number;
  p99: number;
}

export interface VitalStat {
  name: string;
  p50: number;
  p75: number;
  p95: number;
  count: number;
}

export interface EventStat {
  event: string;
  count: number;
  users: number;
}

export interface RouteStat {
  route: string;
  count: number;
  p95: number;
  /** 5xx count. */
  errors: number;
}

export interface FunnelStep {
  event: string;
  actors: number;
  /** Share of the first step's actors, 0..1. */
  rate: number;
}

export interface RevenueResult {
  points: SeriesPoint[];
  total: number;
  payers: number;
  /** Actors whose first-ever payment falls inside the range. */
  newPayers: number;
  /** total / payers (0 when no payers). */
  arpu: number;
  /** Median days from an actor's first event to their first payment. */
  medianDaysToConvert: number | null;
  /** Median gap in days between consecutive payments per payer (2+ payments). */
  medianDaysBetweenPayments: number | null;
}

export interface ErrorGroup {
  message: string;
  count: number;
  lastSeen: number;
}
