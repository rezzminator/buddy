import { describe, expect, test } from 'vitest';
import { chained, latestWrites, newChain, type LinkOutcome } from '../plugins/buddy/src/chain.ts';
import type { Sleep } from '../plugins/buddy/src/deadline.ts';

/** A clock that moves only when told: `advance(ms)` ends every sleep due by then, in order; an abort rejects a sleep at once. */
function clock() {
  let now = 0;
  const timers: { at: number; end: () => void }[] = [];
  const sleep: Sleep = (ms, { signal }) =>
    new Promise<void>((resolve, reject) => {
      const t = { at: now + ms, end: resolve };
      timers.push(t);
      signal.addEventListener('abort', () => {
        timers.splice(timers.indexOf(t), 1);
        reject(new Error('aborted'));
      });
    });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  async function advance(ms: number): Promise<void> {
    const until = now + ms;
    await settle();
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > until) break;
      timers.shift();
      now = t.at;
      t.end();
      await settle();
    }
    now = until;
  }
  return { sleep, advance, settle };
}

/** A promise settled only when told. */
function gate<T = void>() {
  let open!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const p = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { p, open, fail };
}

describe('chained', () => {
  test('links run one after another, in the order added', async () => {
    const c = clock();
    const chain = newChain();
    const ran: string[] = [];
    const first = gate();
    const a = chained(c.sleep, chain, async () => {
      ran.push('a start');
      await first.p;
      ran.push('a end');
    }, 1000);
    const b = chained(c.sleep, chain, async () => {
      ran.push('b');
    }, 1000);
    await c.settle();
    expect(ran).toEqual(['a start']);
    first.open();
    await expect(a).resolves.toEqual({ kind: 'landed' });
    await expect(b).resolves.toEqual({ kind: 'landed' });
    expect(ran).toEqual(['a start', 'a end', 'b']);
  });

  test('a link\'s deadline counts only its own run: one queued behind a hung link is never abandoned while it waits', async () => {
    const c = clock();
    const chain = newChain();
    const outcomes: LinkOutcome[] = [];
    void chained(c.sleep, chain, () => new Promise<void>(() => undefined), 90_000).then((o) => outcomes.push(o));
    const wrote = gate();
    void chained(c.sleep, chain, async () => {
      wrote.open();
    }, 30_000).then((o) => outcomes.push(o));
    await c.advance(30_000);
    expect(outcomes).toEqual([]);
    await c.advance(60_000);
    await wrote.p;
    await c.settle();
    expect(outcomes).toEqual([{ kind: 'abandoned' }, { kind: 'landed' }]);
  });

  test('an abandoned link finds live() false, so what it would write after landing late is skipped', async () => {
    const c = clock();
    const chain = newChain();
    const late = gate();
    let wrote = false;
    const a = chained(c.sleep, chain, async (live) => {
      await late.p;
      if (live()) wrote = true;
    }, 1000);
    await c.advance(1000);
    await expect(a).resolves.toEqual({ kind: 'abandoned' });
    late.open();
    await c.settle();
    expect(wrote).toBe(false);
  });

  test('a caller\'s patience (waitMs) passing while its link is still queued drops it: it never runs later', async () => {
    const c = clock();
    const chain = newChain();
    void chained(c.sleep, chain, () => new Promise<void>(() => undefined), 30_000);
    let ran = false;
    const b = chained(c.sleep, chain, async () => {
      ran = true;
    }, 10_000, 10_000);
    await c.advance(10_000);
    await expect(b).resolves.toEqual({ kind: 'dropped' });
    await c.advance(30_000);
    expect(ran).toBe(false);
  });

  test('a dropped link never lets the next one run beside the link still running ahead of it', async () => {
    const c = clock();
    const chain = newChain();
    const first = gate();
    let firstDone = false;
    void chained(c.sleep, chain, async () => {
      await first.p;
      firstDone = true;
    }, 30_000);
    void chained(c.sleep, chain, async () => undefined, 5_000, 5_000);
    let sawFirstDone: boolean | undefined;
    const third = chained(c.sleep, chain, async () => {
      sawFirstDone = firstDone;
    }, 30_000);
    await c.advance(10_000);
    expect(sawFirstDone).toBeUndefined();
    first.open();
    await expect(third).resolves.toEqual({ kind: 'landed' });
    expect(sawFirstDone).toBe(true);
  });

  test('a link that throws before its deadline fails with the error, and the chain goes on', async () => {
    const c = clock();
    const chain = newChain();
    const a = chained(c.sleep, chain, async () => {
      throw new Error('EACCES');
    }, 1000);
    const b = chained(c.sleep, chain, async () => undefined, 1000);
    const o = await a;
    expect(o.kind).toBe('failed');
    expect(o.kind === 'failed' && (o.error as Error).message).toBe('EACCES');
    await expect(b).resolves.toEqual({ kind: 'landed' });
  });
});

describe('latestWrites', () => {
  test('a value written while the last write of its key is in flight waits, and only the newest waiting one is sent: an earlier value never lands over a later one', async () => {
    const write = latestWrites<string>();
    const store = new Map<string, string>();
    const sent: string[] = [];
    const hung = gate();
    const set = async (key: string, value: string) => {
      sent.push(value);
      if (value === 'A') await hung.p;
      store.set(key, value);
    };
    const a = write('k', 'A', set);
    const b = write('k', 'AB', set);
    const c = write('k', 'ABC', set);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(['A']);
    hung.open();
    await Promise.all([a, b, c]);
    expect(sent).toEqual(['A', 'ABC']);
    expect(store.get('k')).toBe('ABC');
  });

  test('keys write independently; a failed write rejects its waiters, and the next write of the key is sent', async () => {
    const write = latestWrites<string>();
    const sent: string[] = [];
    const set = async (key: string, value: string) => {
      sent.push(`${key}=${value}`);
      if (value === 'bad') throw new Error('EACCES');
    };
    await expect(write('k', 'bad', set)).rejects.toThrow('EACCES');
    await write('j', 'x', set);
    await write('k', 'good', set);
    expect(sent).toEqual(['k=bad', 'j=x', 'k=good']);
  });
});
