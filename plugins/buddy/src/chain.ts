// Work run one link after another, each bounded by a deadline of its own run,
// and store writes that never land out of order: no I/O, the adapter passes
// the engine's sleep and store in.

import { within, type Sleep } from './deadline.ts';

/** A chain's tail: settles once every link added so far has ended (landed, failed, abandoned or dropped); never rejects. */
export type Chain = { tail: Promise<void> };

export function newChain(): Chain {
  return { tail: Promise.resolve() };
}

/**
 * How a link ended: `landed`, it ran to its end; `failed`, it threw
 * (`error`); `abandoned`, it started and ran past its deadline, and may still
 * settle later; `dropped`, its caller gave up while it was still queued, so it
 * never ran.
 */
export type LinkOutcome = { kind: 'landed' } | { kind: 'failed'; error: unknown } | { kind: 'abandoned' } | { kind: 'dropped' };

/** One link's work. `live()` is true until its outcome is decided: a link abandoned meanwhile finds it false and writes nothing. */
export type Link = (live: () => boolean) => Promise<void>;

/**
 * `link` run on `chain` once every link added before it has ended. Its
 * deadline, `runMs`, counts only its own run, never the wait before it.
 * `waitMs`, when given, is the caller's patience, counted from now: a link
 * still queued when it passes is dropped and never runs; one running is
 * abandoned then. The next link starts only once this one has ended or been
 * given up, and the one ahead of it has too. Never rejects.
 */
export function chained(sleep: Sleep, chain: Chain, link: Link, runMs: number, waitMs?: number): Promise<LinkOutcome> {
  let decided: LinkOutcome | null = null;
  let running = false;
  const live = () => decided === null;
  const decide = (o: LinkOutcome): LinkOutcome => (decided ??= o);
  const ahead = chain.tail;
  const run = ahead.then(async (): Promise<LinkOutcome> => {
    // Given up while it waited: it never runs.
    if (decided) return decided;
    running = true;
    try {
      const r = await within(sleep, link(live), runMs);
      return decide(r === 'timeout' ? { kind: 'abandoned' } : { kind: 'landed' });
    } catch (error) {
      return decide({ kind: 'failed', error });
    }
  });
  const outcome =
    waitMs === undefined
      ? run
      : within(sleep, run, waitMs).then(
          (r) => (r === 'timeout' ? decide(running ? { kind: 'abandoned' } : { kind: 'dropped' }) : r),
          (error: unknown) => decide({ kind: 'failed', error }),
        );
  // A link given up while queued still waits for the one ahead: two links never run side by side, but for one abandoned.
  chain.tail = Promise.all([ahead, outcome]).then(
    () => undefined,
    () => undefined,
  );
  return outcome;
}

/** Writes `value` under `key` through `set`. */
export type LatestWrites<V> = (key: string, value: V, set: (key: string, value: V) => Promise<void>) => Promise<void>;

/**
 * A writer keeping at most one write per key in flight: a value written while
 * its key's last write has not settled waits, and once it settles only the
 * newest waiting value is sent, so an earlier value never lands over a later
 * one, however late its write settles. Each call resolves once its value, or
 * a newer one of its key, is written, and rejects with the error of the last
 * write it waited on.
 */
export function latestWrites<V>(): LatestWrites<V> {
  const flights = new Map<string, { next: { value: V; set: (key: string, value: V) => Promise<void> } | null; done: Promise<void> }>();
  return (key, value, set) => {
    const flight = flights.get(key);
    if (flight) {
      flight.next = { value, set };
      return flight.done;
    }
    const f: { next: { value: V; set: (key: string, value: V) => Promise<void> } | null; done: Promise<void> } = { next: { value, set }, done: Promise.resolve() };
    flights.set(key, f);
    f.done = (async () => {
      let failure: { error: unknown } | null = null;
      try {
        while (f.next) {
          const w = f.next;
          f.next = null;
          try {
            await w.set(key, w.value);
            failure = null;
          } catch (error) {
            failure = { error };
          }
        }
      } finally {
        flights.delete(key);
      }
      if (failure) throw failure.error;
    })();
    return f.done;
  };
}
