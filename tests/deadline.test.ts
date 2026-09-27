import { describe, expect, test } from 'vitest';
import { within, type Sleep } from '../plugins/buddy/src/deadline.ts';

/** A sleep that settles only when told: `end()` resolves it, `fail(e)` rejects it, and an abort rejects it at once. */
function sleeper() {
  let end = () => undefined as void;
  let fail = (_e: unknown) => undefined as void;
  const sleep: Sleep = (_ms, { signal }) =>
    new Promise<void>((resolve, reject) => {
      end = resolve;
      fail = reject;
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  return { sleep, end: () => end(), fail: (e: unknown) => fail(e) };
}

describe('within', () => {
  test('the call settling first wins, and the deadline\'s own abort is no outcome', async () => {
    const s = sleeper();
    await expect(within(s.sleep, Promise.resolve('done'), 1000)).resolves.toBe('done');
  });
  test('the deadline passing first is a timeout', async () => {
    const s = sleeper();
    const r = within(s.sleep, new Promise<string>(() => undefined), 1000);
    s.end();
    await expect(r).resolves.toBe('timeout');
  });
  test('any other rejection of the deadline\'s sleep ends the wait as a failure, never a wait forever', async () => {
    const s = sleeper();
    const r = within(s.sleep, new Promise<string>(() => undefined), 1000);
    s.fail(new Error('the hook budget ran out'));
    await expect(r).rejects.toThrow('the hook budget ran out');
  });
});
