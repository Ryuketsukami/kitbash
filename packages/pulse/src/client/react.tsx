import { createContext, useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPulse } from './core.js';
import type { Pulse, PulseConfig } from './core.js';

const PulseContext = createContext<Pulse | null>(null);

export interface PulseProviderProps {
  /** Preferred: a client created once at module scope with createPulse(). */
  client?: Pulse;
  /** Convenience: the provider creates (and owns) a client from this config. */
  config?: PulseConfig;
  children?: ReactNode;
}

/**
 * Makes a Pulse client available via usePulse(). For StrictMode-clean setup,
 * create the client at module scope and pass `client`; the `config` form
 * creates one on first render (dev double-render can briefly create a spare).
 */
export function PulseProvider({ client, config, children }: PulseProviderProps) {
  const ref = useRef<Pulse | null>(null);
  const owned = useRef(false);
  if (ref.current === null) {
    if (client) {
      ref.current = client;
    } else {
      ref.current = createPulse(config ?? {});
      owned.current = true;
    }
  }
  useEffect(() => {
    const pulse = ref.current;
    return () => {
      if (pulse && owned.current) void pulse.flush();
    };
  }, []);
  return <PulseContext.Provider value={ref.current}>{children}</PulseContext.Provider>;
}

export function usePulse(): Pulse {
  const pulse = useContext(PulseContext);
  if (!pulse) throw new Error('@kitbash/pulse: usePulse must be used inside <PulseProvider>');
  return pulse;
}
