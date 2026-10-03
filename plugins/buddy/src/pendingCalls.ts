// A buddy model call in flight is kept on disk per chat (calls.json, beside
// the memory) from its start to its end, so a call that a plugin reload or a
// restart killed is told apart from one still pending: the next load logs it
// abandoned, once, and drops it from the file.
// No I/O: the adapter reads and writes the file, one change after another.

/** The file, in the chat's buddy folder. */
export const CALLS_FILE = 'calls.json';

/** The buddy's model calls: the end-of-turn call, the away call and a /buddy question. */
export type PendingCallKind = 'endOfTurn' | 'away' | 'question';
const KINDS: readonly string[] = ['endOfTurn', 'away', 'question'] satisfies PendingCallKind[];

/** One call in flight: its id (unique to the load that made it), its kind, when it began (epoch ms), and the main turn it follows, for an end-of-turn call. */
export type PendingCall = { id: string; kind: PendingCallKind; at: number; turnId?: string };
export type PendingCalls = { version: 1; calls: PendingCall[] };
export const NO_PENDING_CALLS: PendingCalls = { version: 1, calls: [] };

/** One abandoned call, as its outcome is logged: `ms` from its start to the load that found it (never below 0). */
export type AbandonedCall = { kind: PendingCallKind; turnId?: string; ms: number };

function callOf(value: unknown): PendingCall | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.kind !== 'string' || !KINDS.includes(v.kind)) return null;
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return null;
  if (v.turnId !== undefined && typeof v.turnId !== 'string') return null;
  const call: PendingCall = { id: v.id, kind: v.kind as PendingCallKind, at: v.at };
  return typeof v.turnId === 'string' ? { ...call, turnId: v.turnId } : call;
}

/** The kept record, or null when it is not one; a malformed call in it is dropped, the sound ones kept. */
export function pendingCallsOf(value: unknown): PendingCalls | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !Array.isArray(v.calls)) return null;
  return { version: 1, calls: v.calls.map(callOf).filter((c): c is PendingCall => c !== null) };
}

/** `record` with `call` in flight; one already kept under its id is replaced. */
export function callStarted(record: PendingCalls, call: PendingCall): PendingCalls {
  return { version: 1, calls: [...record.calls.filter((c) => c.id !== call.id), call] };
}

/** `record` without the call `id`, which ended, however it ended. */
export function callEnded(record: PendingCalls, id: string): PendingCalls {
  return { version: 1, calls: record.calls.filter((c) => c.id !== id) };
}

/**
 * At a load: every kept call not running in this load (`live`, by id) was
 * killed before it ended, and is abandoned; `kept` holds only the live ones,
 * so the next load finds none of them again.
 */
export function abandonedCalls(record: PendingCalls, live: ReadonlySet<string>, now: number): { abandoned: AbandonedCall[]; kept: PendingCalls } {
  const abandoned: AbandonedCall[] = [];
  const calls: PendingCall[] = [];
  for (const c of record.calls) {
    if (live.has(c.id)) calls.push(c);
    else abandoned.push({ kind: c.kind, ...(c.turnId === undefined ? {} : { turnId: c.turnId }), ms: Math.max(0, now - c.at) });
  }
  return { abandoned, kept: { version: 1, calls } };
}
