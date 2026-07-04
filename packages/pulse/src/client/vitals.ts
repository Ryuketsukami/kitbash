// Hand-rolled Web Vitals — no dependency on the web-vitals package. LCP, CLS
// and INP only settle once the user leaves, so they finalize on the first
// page-hide; FCP and TTFB report as soon as they exist. INP uses the standard
// estimator (worst interaction, stepping to the next-worst per 50 interactions).

export type VitalRating = 'good' | 'needs-improvement' | 'poor';
export type VitalReport = (name: string, value: number, rating: VitalRating) => void;

const THRESHOLDS: Record<string, [number, number]> = {
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

function rating(name: string, value: number): VitalRating {
  const t = THRESHOLDS[name];
  if (!t) return 'good';
  if (value <= t[0]) return 'good';
  if (value <= t[1]) return 'needs-improvement';
  return 'poor';
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface EventTimingEntry extends PerformanceEntry {
  interactionId?: number;
}

export function observeVitals(report: VitalReport): () => void {
  if (typeof PerformanceObserver === 'undefined' || typeof performance === 'undefined') {
    return () => undefined;
  }
  const supported: readonly string[] = PerformanceObserver.supportedEntryTypes ?? [];
  const observers: PerformanceObserver[] = [];
  const reported = new Set<string>();

  const emit = (name: string, value: number) => {
    if (reported.has(name)) return;
    reported.add(name);
    report(name, Math.round(value * 1000) / 1000, rating(name, value));
  };

  const observe = (type: string, cb: (entries: PerformanceEntry[]) => void): void => {
    if (!supported.includes(type)) return;
    try {
      const po = new PerformanceObserver((list) => cb(list.getEntries()));
      po.observe({ type, buffered: true } as PerformanceObserverInit);
      observers.push(po);
    } catch {
      /* observer type rejected at runtime */
    }
  };

  // TTFB — from the navigation entry, may not exist yet on very early init.
  const tryTtfb = () => {
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav && nav.responseStart > 0) emit('TTFB', nav.responseStart);
  };
  tryTtfb();
  const onLoad = () => tryTtfb();
  if (!reported.has('TTFB')) window.addEventListener('load', onLoad);

  observe('paint', (entries) => {
    for (const e of entries) if (e.name === 'first-contentful-paint') emit('FCP', e.startTime);
  });

  let lcp = 0;
  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (last) lcp = last.startTime;
  });

  // CLS session windows: shifts group while <1s apart within a 5s window; the
  // page's CLS is the worst window.
  let cls = 0;
  let windowValue = 0;
  let windowStart = 0;
  let lastShift = 0;
  observe('layout-shift', (entries) => {
    for (const entry of entries as LayoutShiftEntry[]) {
      if (entry.hadRecentInput) continue;
      if (windowValue > 0 && (entry.startTime - lastShift > 1000 || entry.startTime - windowStart > 5000)) {
        windowValue = 0;
      }
      if (windowValue === 0) windowStart = entry.startTime;
      windowValue += entry.value;
      lastShift = entry.startTime;
      if (windowValue > cls) cls = windowValue;
    }
  });

  const interactions = new Map<number, number>();
  observe('event', (entries) => {
    for (const entry of entries as EventTimingEntry[]) {
      if (!entry.interactionId) continue;
      const prev = interactions.get(entry.interactionId) ?? 0;
      if (entry.duration > prev) interactions.set(entry.interactionId, entry.duration);
    }
  });

  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    if (lcp > 0) emit('LCP', lcp);
    emit('CLS', cls);
    if (interactions.size > 0) {
      const durations = [...interactions.values()].sort((a, b) => b - a);
      const idx = Math.min(Math.floor(interactions.size / 50), durations.length - 1);
      emit('INP', durations[idx] ?? 0);
    }
  };
  const onHide = () => {
    if (document.visibilityState === 'hidden') finalize();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', finalize);

  return () => {
    for (const po of observers) po.disconnect();
    window.removeEventListener('load', onLoad);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', finalize);
  };
}
