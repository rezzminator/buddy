// One deadline raced against a call: no I/O, the adapter passes the engine's
// sleep in.

/** A sleep of `ms` that rejects at once when `signal` aborts: `$.clock.sleep`'s shape. */
export type Sleep = (ms: number, options: { signal: AbortSignal }) => Promise<void>;

/**
 * `p`, or 'timeout' once `sleep(ms)` ends first; the sleep is aborted once
 * either settles. Only that abort's rejection is no outcome: any other
 * rejection of the sleep ends the wait as a failure, rejected with it.
 */
export async function within<T>(sleep: Sleep, p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  const stop = new AbortController();
  const deadline = sleep(ms, { signal: stop.signal }).then(
    () => 'timeout' as const,
    (error: unknown) => {
      // Aborted once the race is decided: that rejection is the timer stopping.
      if (stop.signal.aborted) return new Promise<never>(() => undefined);
      throw error;
    },
  );
  try {
    return await Promise.race([p, deadline]);
  } finally {
    stop.abort();
  }
}
