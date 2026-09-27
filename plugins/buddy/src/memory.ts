// The buddy's short memory: the last N exchanges between you and one
// character in one session, oldest first, as a ring. An exchange is one
// /buddy question with its answer, one bubble line on its own (a canned
// event line or a quip), or a next prompt the buddy suggested and the prompt
// box showed. No I/O: the adapter keeps a session's book in
// $.store under storeKey(sessionId), each character's ring under its id, so a
// switched character never claims another's words.

export const MEMORY_DEFAULT = 6;
export const MEMORY_MAX = 30;
export const MEMORY_TEXT_CAP = 160;
/** How many sessions' books the store keeps; older ones are deleted. */
export const MEMORY_SESSIONS = 20;
export const MEMORY_KEY_PREFIX = 'memory:';

/** One slot of the ring: a question and its answer (none when it got none), a line said on its own, or a next prompt the buddy suggested. */
export type Exchange = { kind: 'question'; question: string; answer?: string } | { kind: 'line' | 'quip' | 'suggestion'; text: string };
/** One session's rings, by character id. */
export type Book = Record<string, Exchange[]>;
/** What the store holds under storeKey(sessionId): when it was last written, and the book. */
export type Stored = { at: number; characters: Book };

export function storeKey(sessionId: string): string {
  return `${MEMORY_KEY_PREFIX}${sessionId}`;
}

/** One line, at most MEMORY_TEXT_CAP characters. */
export function capText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MEMORY_TEXT_CAP ? `${line.slice(0, MEMORY_TEXT_CAP - 3)}...` : line;
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

/** `book` with `x` in the ring of `characterId`, kept to its last `n` exchanges. */
export function record(book: Book, characterId: string, x: Exchange, n: number): Book {
  return { ...book, [characterId]: remember(book[characterId] ?? [], x, n) };
}

/** The last `n` exchanges of one character's ring; none of any other's. */
export function recall(book: Book, characterId: string, n: number): Exchange[] {
  return n <= 0 ? [] : (book[characterId] ?? []).slice(-n);
}

/** The exchanges as the prompt carries them, oldest first; '' when there are none. */
export function render(exchanges: readonly Exchange[], name: string): string {
  if (exchanges.length === 0) return '';
  const lines = exchanges.flatMap((x) =>
    x.kind === 'question'
      ? [`You: ${x.question}`, ...(x.answer ? [`${name}: ${x.answer}`] : [])]
      : x.kind === 'suggestion'
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
  if ((x.kind === 'line' || x.kind === 'quip' || x.kind === 'suggestion') && typeof x.text === 'string') return capped({ kind: x.kind, text: x.text });
  return null;
}

/** The book stored under a session's key: none is an empty book; a malformed one says what it dropped. */
export function bookOf(value: unknown): { book: Book; error?: string } {
  if (value === undefined) return { book: {} };
  if (typeof value !== 'object' || value === null || typeof (value as Stored).characters !== 'object' || (value as Stored).characters === null) {
    return { book: {}, error: 'the stored memory is not a memory record' };
  }
  const book: Book = {};
  let dropped = 0;
  for (const [id, ring] of Object.entries((value as Stored).characters)) {
    if (!Array.isArray(ring)) {
      dropped++;
      continue;
    }
    const kept = ring.map(exchangeOf).filter((x): x is Exchange => x !== null);
    dropped += ring.length - kept.length;
    book[id] = kept;
  }
  return dropped > 0 ? { book, error: `the stored memory had ${dropped} malformed exchange${dropped === 1 ? '' : 's'}, dropped` } : { book };
}

/** The keys to delete: all but the `keep` most recently written sessions. */
export function staleKeys(sessions: readonly { key: string; at: number }[], keep: number): string[] {
  return [...sessions].sort((a, b) => b.at - a.at).slice(keep).map((s) => s.key);
}
