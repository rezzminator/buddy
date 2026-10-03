import { describe, expect, test } from 'vitest';
import { CALLS_FILE, NO_PENDING_CALLS, abandonedCalls, callEnded, callStarted, pendingCallsOf, type PendingCall } from '../plugins/buddy/src/pendingCalls.ts';

const TURN: PendingCall = { id: 'a1', kind: 'endOfTurn', at: 1_000, turnId: 't1' };
const ASK: PendingCall = { id: 'a2', kind: 'question', at: 2_000 };

describe('pendingCallsOf', () => {
  test('reads a kept record, its calls as written', () => {
    expect(pendingCallsOf({ version: 1, calls: [TURN, ASK] })).toEqual({ version: 1, calls: [TURN, ASK] });
  });

  test('anything but a version 1 record with a calls list is null', () => {
    for (const v of [null, 'x', [], {}, { version: 2, calls: [] }, { version: 1 }, { version: 1, calls: {} }]) expect(pendingCallsOf(v)).toBeNull();
  });

  test('a malformed call is dropped, the sound ones kept', () => {
    const bad = [{ id: 'b', kind: 'away' }, { id: 3, kind: 'away', at: 1 }, { id: 'c', kind: 'other', at: 1 }, { id: 'd', kind: 'away', at: Number.NaN }, { id: 'e', kind: 'away', at: 1, turnId: 4 }];
    expect(pendingCallsOf({ version: 1, calls: [...bad, ASK] })).toEqual({ version: 1, calls: [ASK] });
  });
});

describe('callStarted and callEnded', () => {
  test('a call that ends leaves nothing pending', () => {
    const started = callStarted(callStarted(NO_PENDING_CALLS, TURN), ASK);
    expect(started.calls).toEqual([TURN, ASK]);
    expect(callEnded(callEnded(started, 'a1'), 'a2')).toEqual(NO_PENDING_CALLS);
  });

  test('a call started twice is kept once; ending an unknown one changes nothing', () => {
    expect(callStarted(callStarted(NO_PENDING_CALLS, TURN), TURN).calls).toEqual([TURN]);
    expect(callEnded({ version: 1, calls: [TURN] }, 'zz')).toEqual({ version: 1, calls: [TURN] });
  });
});

describe('abandonedCalls', () => {
  test('a call kept from before the load and not running now is abandoned once, with its age; the record kept holds none', () => {
    const { abandoned, kept } = abandonedCalls({ version: 1, calls: [TURN] }, new Set(), 9_000);
    expect(abandoned).toEqual([{ kind: 'endOfTurn', turnId: 't1', ms: 8_000 }]);
    expect(kept).toEqual(NO_PENDING_CALLS);
    // The next load reads what was kept: nothing more to log.
    expect(abandonedCalls(kept, new Set(), 20_000).abandoned).toEqual([]);
  });

  test('a call running in this load is never abandoned and stays kept', () => {
    const { abandoned, kept } = abandonedCalls({ version: 1, calls: [TURN, ASK] }, new Set(['a2']), 9_000);
    expect(abandoned).toEqual([{ kind: 'endOfTurn', turnId: 't1', ms: 8_000 }]);
    expect(kept).toEqual({ version: 1, calls: [ASK] });
  });

  test('no record, or a clock that went back: nothing abandoned twice, an age never below 0', () => {
    expect(abandonedCalls(NO_PENDING_CALLS, new Set(), 9_000)).toEqual({ abandoned: [], kept: NO_PENDING_CALLS });
    expect(abandonedCalls({ version: 1, calls: [ASK] }, new Set(), 0).abandoned).toEqual([{ kind: 'question', ms: 0 }]);
  });

  test('the file sits beside the memory', () => {
    expect(CALLS_FILE).toBe('calls.json');
  });
});
