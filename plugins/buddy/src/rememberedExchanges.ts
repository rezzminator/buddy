// The buddy's `rememberedExchanges`: the last N exchanges between you and one
// character in one session, oldest first, as a ring. An exchange is one
// /buddy question with its answer, one bubble line on its own (a canned
// event line or a commentAfterEachTurn), or a suggestNextPrompt the prompt box
// showed. No I/O: the adapter keeps a session's rememberedExchanges in
// $.store under storeKey(sessionId), each character's ring under its id, so a
// switched character never claims another's words.

export const REMEMBERED_EXCHANGES_DEFAULT = 6;
export const REMEMBERED_EXCHANGES_MAX = 30;
export const REMEMBERED_EXCHANGES_TEXT_CAP = 160;
/** How many sessions' rememberedExchanges the store keeps; older ones are deleted. */
export const REMEMBERED_EXCHANGES_SESSIONS = 20;
export const REMEMBERED_EXCHANGES_KEY_PREFIX = 'rememberedExchanges:';
/** How long one rememberedExchanges write may take before it is abandoned and later reads and writes go ahead; a read is bounded by its caller's deadline. */
export const REMEMBERED_EXCHANGES_WRITE_DEADLINE_MS = 30_000;

/** One slot of the ring: a question and its answer (none when it got none), a line said on its own, or a suggestNextPrompt. */
export type Exchange = { kind: 'question'; question: string; answer?: string } | { kind: 'line' | 'commentAfterEachTurn' | 'suggestNextPrompt'; text: string };
/** One session's rings, by character id. */
export type RememberedExchanges = Record<string, Exchange[]>;
/** What the store holds under storeKey(sessionId): when it was last written, and the rememberedExchanges. */
export type Stored = { at: number; characters: RememberedExchanges };

export function storeKey(sessionId: string): string {
  return `${REMEMBERED_EXCHANGES_KEY_PREFIX}${sessionId}`;
}

/** One line, at most REMEMBERED_EXCHANGES_TEXT_CAP characters. */
export function capText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > REMEMBERED_EXCHANGES_TEXT_CAP ? `${line.slice(0, REMEMBERED_EXCHANGES_TEXT_CAP - 3)}...` : line;
}

/** The exchange with every text capped; null when it says nothing (an empty question or line). */
function capped(x: Exchange): Exchange | null {
  if (x.kind !== 'question') {
    const text = capText(x.text);
    return text ? { kind: x.kind, text } : null;
  }
  const question = capText(x.question);
  if (!question) return null;
  const answer = capText(x.answer ?? '');
  return answer ? { kind: 'question', question, answer } : { kind: 'question', question };
}

/** The last `n` exchanges of `ring` with `x` after them; n = 0 keeps nothing. */
export function remember(ring: readonly Exchange[], x: Exchange, n: number): Exchange[] {
  if (n <= 0) return [];
  const c = capped(x);
  return (c ? [...ring, c] : [...ring]).slice(-n);
}

/** `rememberedExchanges` with `x` in the ring of `characterId`, kept to its last `n` exchanges. */
export function addRememberedExchange(rememberedExchanges: RememberedExchanges, characterId: string, x: Exchange, n: number): RememberedExchanges {
  return { ...rememberedExchanges, [characterId]: remember(rememberedExchanges[characterId] ?? [], x, n) };
}

/** The last `n` exchanges of one character's ring; none of any other's. */
export function characterRememberedExchanges(rememberedExchanges: RememberedExchanges, characterId: string, n: number): Exchange[] {
  return n <= 0 ? [] : (rememberedExchanges[characterId] ?? []).slice(-n);
}

/** The exchanges as the prompt carries them, oldest first; '' when there are none. */
export function render(exchanges: readonly Exchange[], name: string): string {
  if (exchanges.length === 0) return '';
  const lines = exchanges.flatMap((x) =>
    x.kind === 'question'
      ? [`You: ${x.question}`, ...(x.answer ? [`${name}: ${x.answer}`] : [])]
      : x.kind === 'suggestNextPrompt'
        ? [`${name} suggested your next prompt: ${x.text}`]
        : [`${name}: ${x.text}`],
  );
  return ['Recently (oldest first):', ...lines].join('\n');
}

/** A stored exchange, checked field by field: its capped form, or null when malformed. */
function exchangeOf(v: unknown): Exchange | null {
  if (typeof v !== 'object' || v === null) return null;
  const x = v as Record<string, unknown>;
  if (x.kind === 'question') {
    if (typeof x.question !== 'string' || (x.answer !== undefined && typeof x.answer !== 'string')) return null;
    return capped({ kind: 'question', question: x.question, ...(typeof x.answer === 'string' ? { answer: x.answer } : {}) });
  }
  if ((x.kind === 'line' || x.kind === 'commentAfterEachTurn' || x.kind === 'suggestNextPrompt') && typeof x.text === 'string') return capped({ kind: x.kind, text: x.text });
  return null;
}

/** The rememberedExchanges stored under a session's key: none is an empty rememberedExchanges; a malformed one says what it dropped. */
export function rememberedExchangesOf(value: unknown): { rememberedExchanges: RememberedExchanges; error?: string } {
  if (value === undefined) return { rememberedExchanges: {} };
  if (typeof value !== 'object' || value === null || typeof (value as Stored).characters !== 'object' || (value as Stored).characters === null) {
    return { rememberedExchanges: {}, error: 'the stored rememberedExchanges is not a rememberedExchanges record' };
  }
  const rememberedExchanges: RememberedExchanges = {};
  let dropped = 0;
  for (const [id, ring] of Object.entries((value as Stored).characters)) {
    if (!Array.isArray(ring)) {
      dropped++;
      continue;
    }
    const kept = ring.map(exchangeOf).filter((x): x is Exchange => x !== null);
    dropped += ring.length - kept.length;
    rememberedExchanges[id] = kept;
  }
  return dropped > 0 ? { rememberedExchanges, error: `the stored rememberedExchanges had ${dropped} malformed exchange${dropped === 1 ? '' : 's'}, dropped` } : { rememberedExchanges };
}

/** The keys to delete: all but the `keep` most recently written sessions. */
export function staleKeys(sessions: readonly { key: string; at: number }[], keep: number): string[] {
  return [...sessions].sort((a, b) => b.at - a.at).slice(keep).map((s) => s.key);
}
