// Web-only auto-instrumentation, installed by createPulse in browsers:
// page views (SPA-aware), uncaught errors, Web Vitals, and traceparent
// injection on outgoing fetch so backend spans correlate with the session.

import type { Pulse, PulseAutocapture } from './core.js';
import { PULSE_EVENTS } from '../types.js';
import { observeVitals } from './vitals.js';
import { randHex, stripQuery } from './util.js';

const ERROR_CAP_PER_PAGE = 50;

export function installAutocapture(
  pulse: Pulse,
  cfg: PulseAutocapture,
  ingestEndpoint: string,
): () => void {
  const cleanups: Array<() => void> = [];

  if (cfg.pageViews !== false) cleanups.push(installPageViews(pulse));
  if (cfg.errors !== false) cleanups.push(installErrorCapture(pulse));
  if (cfg.vitals !== false) {
    cleanups.push(
      observeVitals((name, value, vitalRating) =>
        pulse.track(PULSE_EVENTS.webVital, { name, value, rating: vitalRating }),
      ),
    );
  }
  const tracing = cfg.fetchTracing ?? 'same-origin';
  if (tracing !== false) cleanups.push(installFetchTracing(pulse, tracing, ingestEndpoint));

  return () => {
    for (const c of cleanups) c();
  };
}

function installPageViews(pulse: Pulse): () => void {
  let lastUrl = stripQuery(window.location.href);
  pulse.page();

  const onNavigate = () => {
    const url = stripQuery(window.location.href);
    if (url === lastUrl) return;
    lastUrl = url;
    pulse.page();
  };

  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = (...args: Parameters<History['pushState']>) => {
    origPush(...args);
    onNavigate();
  };
  history.replaceState = (...args: Parameters<History['replaceState']>) => {
    origReplace(...args);
    onNavigate();
  };
  window.addEventListener('popstate', onNavigate);

  return () => {
    history.pushState = origPush;
    history.replaceState = origReplace;
    window.removeEventListener('popstate', onNavigate);
  };
}

function installErrorCapture(pulse: Pulse): () => void {
  let count = 0;
  const capped = () => {
    count += 1;
    return count > ERROR_CAP_PER_PAGE; // an error loop must not flood the store
  };

  const onError = (e: ErrorEvent) => {
    if (typeof e.message !== 'string' || capped()) return;
    const err = e.error as { stack?: string } | undefined;
    pulse.track(PULSE_EVENTS.error, {
      message: e.message.slice(0, 500),
      source: typeof e.filename === 'string' ? e.filename.slice(0, 300) : undefined,
      line: e.lineno,
      col: e.colno,
      stack: typeof err?.stack === 'string' ? err.stack.slice(0, 2000) : undefined,
    });
  };

  const onRejection = (e: PromiseRejectionEvent) => {
    if (capped()) return;
    const reason = e.reason as { message?: string; stack?: string } | undefined;
    pulse.track(PULSE_EVENTS.error, {
      message: `Unhandled rejection: ${String(reason?.message ?? e.reason).slice(0, 500)}`,
      stack: typeof reason?.stack === 'string' ? reason.stack.slice(0, 2000) : undefined,
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

function installFetchTracing(
  pulse: Pulse,
  mode: true | 'same-origin',
  ingestEndpoint: string,
): () => void {
  const orig = window.fetch.bind(window);
  let ingestPath = '/pulse/ingest';
  try {
    ingestPath = new URL(ingestEndpoint, window.location.href).pathname;
  } catch {
    /* keep default */
  }

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const raw =
        typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.href);
      const eligible =
        (mode === true || url.origin === window.location.origin) && url.pathname !== ingestPath;
      if (eligible) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        if (!headers.has('traceparent')) {
          headers.set('traceparent', `00-${randHex(16)}-${randHex(8)}-01`);
        }
        headers.set('x-pulse-session', pulse.sessionId);
        init = { ...init, headers };
      }
    } catch {
      /* malformed URL — pass through untouched */
    }
    return orig(input, init);
  };

  return () => {
    window.fetch = orig;
  };
}
