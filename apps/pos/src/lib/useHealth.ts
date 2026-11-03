import { type Liveness, LivenessSchema, type Readiness, ReadinessSchema } from '@pos/contracts';
import { useCallback, useEffect, useState } from 'react';

import { ApiClientError, apiRequest } from './api';

export interface HealthState {
  phase: 'checking' | 'connected' | 'unreachable';
  liveness?: Liveness;
  readiness?: Readiness;
  error?: string;
  checkedAt?: Date;
  refresh: () => void;
}

/**
 * Polls the API's probes so the counter can see at a glance whether the till is
 * talking to the server -- the one thing a cashier needs to know before taking
 * an order. Step 10 turns this into the offline banner.
 */
export function useHealth(intervalMs = 15_000): HealthState {
  const [state, setState] = useState<Omit<HealthState, 'refresh'>>({ phase: 'checking' });
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();

    const check = async (): Promise<void> => {
      try {
        const [liveness, readiness] = await Promise.all([
          apiRequest('/healthz', LivenessSchema, { signal: controller.signal }),
          apiRequest('/readyz', ReadinessSchema, { signal: controller.signal }).catch((error) => {
            // A degraded readiness answers 503 with a valid body; that is
            // information, not a failure to fetch.
            if (error instanceof ApiClientError && error.status === 503) return undefined;
            throw error;
          }),
        ]);

        if (controller.signal.aborted) return;
        setState({ phase: 'connected', liveness, readiness, checkedAt: new Date() });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          phase: 'unreachable',
          error: error instanceof Error ? error.message : String(error),
          checkedAt: new Date(),
        });
      }
    };

    void check();
    const timer = window.setInterval(() => void check(), intervalMs);

    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [intervalMs, nonce]);

  return { ...state, refresh };
}
