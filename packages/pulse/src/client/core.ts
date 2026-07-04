// Framework-agnostic capture core: works in browsers and React Native (every
// web API is feature-detected). Events queue locally and ship in batches to a
// first-party, same-origin endpoint — fetch keepalive normally, sendBeacon on
// page hide — so capture survives ad blockers and never touches a third party.

import type { PulseBatch, PulseEvent } from '../types.js';
import { PULSE_EVENTS } from '../types.js';
import { installAutocapture } from './autocapture.js';
import { randHex, stripQuery } from './util.js';

export interface PulseStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
}

export interface PulseAutocapture {
  /** Track page_view on load + SPA navigations. Web only. Default true. */
  pageViews?: boolean;
  /** Track uncaught errors and unhandled rejections. Web only. Default true. */
  errors?: boolean;
  /** Track Web Vitals (LCP/CLS/INP/FCP/TTFB). Web only. Default true. */
  vitals?: boolean;
  /**
   * Add `traceparent` + `x-pulse-session` headers to outgoing fetch calls so
   * backend requests correlate with the frontend session. Default 'same-origin'.
   */
  fetchTracing?: boolean | 'same-origin';
}

export interface PulseConfig {
  /** Ingest URL. Default '/pulse/ingest' — keep it same-origin. */
  endpoint?: string;
  /** App tag stored with every event, e.g. "myapp@1.4.0". */
  app?: string;
  /** Default: 'web' in a browser, 'node' elsewhere. Set 'ios'/'android' in RN. */
  platform?: string;
  /** Share of anonymous users captured, 0..1 (deterministic per user). Default 1. */
  sampleRate?: number;
  flushIntervalMs?: number;
  /** Events per request. Default 50. */
  maxBatch?: number;
  /** Queued events before oldest are dropped. Default 1000. */
  maxQueue?: number;
  /** Inactivity gap that starts a new session. Default 30 min. */
  sessionTimeoutMs?: number;
  /** Prop keys dropped at every depth (case-insensitive), merged with the built-in deny list. */
  denyProps?: string[];
  /** When set, only these top-level prop keys survive. */
  allowProps?: string[];
  /** Honor Do Not Track / Global Privacy Control. Default false. */
  respectDoNotTrack?: boolean;
  /** Enrich, redact or veto any event before it queues. Return null to drop. */
  beforeSend?: (event: PulseEvent) => PulseEvent | null;
  autocapture?: PulseAutocapture;
  /** Persistence for anon/session ids. Default localStorage (web) or in-memory. */
  storage?: PulseStorage;
  debug?: boolean;
}

export interface Pulse {
  track(event: string, props?: Record<string, unknown>): void;
  /** Attach a stable user id to this and future batches (also emits `identify`). */
  identify(userId: string, props?: Record<string, unknown>): void;
  page(title?: string): void;
  screen(name: string, props?: Record<string, unknown>): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  readonly anonId: string;
  readonly sessionId: string;
  /** False when sampled out or DNT applies — every call becomes a no-op. */
  readonly enabled: boolean;
}

const DENY_DEFAULT = [
  'password',
  'pass',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'auth',
  'apikey',
  'api_key',
  'cookie',
  'ssn',
  'creditcard',
  'card_number',
];

const isBrowser = (): boolean =>
  typeof window !== 'undefined' && typeof document !== 'undefined';

/** FNV-1a → [0,1). Deterministic sampling: a user is consistently in or out. */
function sampleHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

function dntActive(): boolean {
  if (!isBrowser()) return false;
  const nav = navigator as unknown as Record<string, unknown>;
  return (
    nav['doNotTrack'] === '1' ||
    (window as unknown as Record<string, unknown>)['doNotTrack'] === '1' ||
    nav['globalPrivacyControl'] === true
  );
}

function defaultStorage(): PulseStorage {
  if (isBrowser()) {
    try {
      // Touch it once — private-mode Safari throws on write, not on access.
      window.localStorage.setItem('kb_pulse_t', '1');
      window.localStorage.removeItem('kb_pulse_t');
      return {
        get: (k) => window.localStorage.getItem(k),
        set: (k, v) => window.localStorage.setItem(k, v),
      };
    } catch {
      /* fall through to memory */
    }
  }
  const mem = new Map<string, string>();
  return { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) };
}

function scrubValue(v: unknown, deny: Set<string>, depth: number): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.length > 2000 ? v.slice(0, 2000) : v;
  if (depth <= 0) return undefined;
  if (Array.isArray(v)) {
    return v.slice(0, 50).map((x) => scrubValue(x, deny, depth - 1) ?? null);
  }
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (deny.has(k.toLowerCase())) continue;
      const s = scrubValue(val, deny, depth - 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined; // functions, symbols, bigints
}

export function createPulse(config: PulseConfig = {}): Pulse {
  const endpoint = config.endpoint ?? '/pulse/ingest';
  const platform = config.platform ?? (isBrowser() ? 'web' : 'node');
  const flushIntervalMs = config.flushIntervalMs ?? 5000;
  const maxBatch = config.maxBatch ?? 50;
  const maxQueue = config.maxQueue ?? 1000;
  const sessionTimeoutMs = config.sessionTimeoutMs ?? 30 * 60_000;
  const deny = new Set([...DENY_DEFAULT, ...(config.denyProps ?? [])].map((k) => k.toLowerCase()));
  const allow = config.allowProps;
  const storage = config.storage ?? defaultStorage();
  const debug = config.debug === true;

  let anonId = randHex(16);
  let sessionId = randHex(12);
  let sessionLast = Date.now();
  let userId: string | undefined;
  let enabled = !(config.respectDoNotTrack === true && dntActive());
  let queue: PulseEvent[] = [];
  let retry: { events: PulseEvent[]; attempts: number } | null = null;
  let flushing = false;
  let closed = false;

  const log = (...args: unknown[]) => {
    if (debug) console.info('[pulse]', ...args);
  };

  // Identity loads async (RN storage is async); events queue meanwhile and the
  // first flush waits, so nothing ships under a throwaway id.
  const ready = (async () => {
    const storedAnon = await storage.get('kb_pulse_id');
    if (storedAnon) anonId = storedAnon;
    else await storage.set('kb_pulse_id', anonId);
    const rawSession = await storage.get('kb_pulse_s');
    if (rawSession) {
      try {
        const s = JSON.parse(rawSession) as { id?: string; last?: number };
        if (typeof s.id === 'string' && typeof s.last === 'number' && Date.now() - s.last < sessionTimeoutMs) {
          sessionId = s.id;
          sessionLast = s.last;
        }
      } catch {
        /* corrupted — keep the fresh session */
      }
    }
    const storedUser = await storage.get('kb_pulse_u');
    if (storedUser) userId = storedUser;
    if (enabled && (config.sampleRate ?? 1) < 1 && sampleHash(anonId) >= (config.sampleRate ?? 1)) {
      enabled = false;
      log('sampled out');
    }
    await persistSession();
  })().catch(() => undefined);

  let lastSessionWrite = 0;
  async function persistSession(): Promise<void> {
    lastSessionWrite = Date.now();
    await storage.set('kb_pulse_s', JSON.stringify({ id: sessionId, last: sessionLast }));
  }

  function touchSession(): void {
    const now = Date.now();
    if (now - sessionLast > sessionTimeoutMs) {
      sessionId = randHex(12);
      log('new session', sessionId);
    }
    sessionLast = now;
    if (now - lastSessionWrite > 5000) void persistSession();
  }

  function enqueue(event: PulseEvent): void {
    let e: PulseEvent | null = event;
    if (config.beforeSend) {
      try {
        e = config.beforeSend(e);
      } catch {
        e = event;
      }
    }
    if (!e) return;
    queue.push(e);
    if (queue.length > maxQueue) queue.splice(0, queue.length - maxQueue);
    if (queue.length >= maxBatch) void flush();
  }

  function buildProps(props?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!props) return undefined;
    let source = props;
    if (allow) {
      source = {};
      for (const k of allow) if (k in props) source[k] = props[k];
    }
    return scrubValue(source, deny, 4) as Record<string, unknown>;
  }

  function track(event: string, props?: Record<string, unknown>): void {
    if (!enabled || closed || typeof event !== 'string' || event.length === 0) return;
    touchSession();
    const e: PulseEvent = { event: event.slice(0, 128), ts: Date.now() };
    const p = buildProps(props);
    if (p && Object.keys(p).length > 0) e.props = p;
    if (isBrowser()) {
      e.url = stripQuery(window.location.href);
      if (document.referrer) e.referrer = stripQuery(document.referrer);
    }
    enqueue(e);
  }

  async function send(events: PulseEvent[], unloading: boolean): Promise<boolean> {
    const batch: PulseBatch = {
      anonId,
      sessionId,
      ...(userId ? { userId } : {}),
      platform,
      ...(config.app ? { app: config.app } : {}),
      sentAt: Date.now(),
      events,
    };
    const body = JSON.stringify(batch);
    if (unloading && isBrowser() && typeof navigator.sendBeacon === 'function') {
      // Beacon survives the page teardown; 64KB cap is why batches stay small.
      if (navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }))) return true;
    }
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
        credentials: 'omit',
      });
      if (res.status >= 500) return false;
      return true; // 2xx delivered; 4xx means malformed — don't retry those
    } catch {
      return false;
    }
  }

  async function flush(unloading = false): Promise<void> {
    if (!enabled || flushing) return;
    flushing = true;
    try {
      await ready;
      while (queue.length > 0 || retry) {
        let events: PulseEvent[];
        let attempts = 0;
        if (retry) {
          ({ events, attempts } = retry);
          retry = null;
        } else {
          events = queue.slice(0, maxBatch);
          queue = queue.slice(events.length);
        }
        const ok = await send(events, unloading);
        if (!ok) {
          if (attempts < 3) retry = { events, attempts: attempts + 1 };
          else log('dropped batch after retries');
          break; // back off until the next interval
        }
      }
    } finally {
      flushing = false;
    }
  }

  const interval = setInterval(() => void flush(), flushIntervalMs);
  // Node keeps the process alive for active intervals; browsers ignore unref.
  (interval as unknown as { unref?: () => void }).unref?.();

  let removeUnloadListeners: (() => void) | undefined;
  if (isBrowser()) {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush(true);
    };
    const onPageHide = () => void flush(true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    removeUnloadListeners = () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
    };
  }

  const pulse: Pulse = {
    track,
    identify(id, props) {
      if (!enabled || closed) return;
      userId = id;
      void ready.then(() => storage.set('kb_pulse_u', id));
      track(PULSE_EVENTS.identify, props);
    },
    page(title) {
      track(PULSE_EVENTS.pageView, {
        title: title ?? (isBrowser() ? document.title : undefined),
      });
    },
    screen(name, props) {
      track(PULSE_EVENTS.screenView, { ...props, name });
    },
    flush: () => flush(),
    async shutdown() {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      removeUnloadListeners?.();
      removeAutocapture?.();
      await flush();
    },
    get anonId() {
      return anonId;
    },
    get sessionId() {
      return sessionId;
    },
    get enabled() {
      return enabled;
    },
  };

  let removeAutocapture: (() => void) | undefined;
  if (enabled && isBrowser()) {
    removeAutocapture = installAutocapture(pulse, config.autocapture ?? {}, endpoint);
  }

  return pulse;
}
