// The buddy's memory, `chatTurnsToRead`: the main chat's last N answered turns,
// each filtered to what carries meaning (the prompt without its markup, what
// Claude did as one line per step, the start and end of its answer), and under each what the buddy and you exchanged after it, oldest first, one
// timeline per session. The buddy remembers of itself exactly as far back as
// it remembers of the chat, so it never holds words about a turn it can no
// longer see. An exchange is one /buddy question with its answer, one canned
// line the bubble showed on its own, or one end-of-turn call's shown output:
// its commentAfterEachTurn, its suggestNextPrompt, or both, kept together.
// What you and the buddy said to each other is kept whole, never cut. A
// compaction of the main chat is remembered as a turn of its own: its summary
// is what Claude holds of everything before it.
// No I/O: the adapter keeps a session's timeline in memory.json in the chat's
// own folder, beside its transcript (src/chatFolder.ts), each character's
// exchanges under its id, so a switched character never claims another's
// words. Before 1.0.0 it was kept in $.store under storeKey(sessionId): the
// adapter moves it into the file the first time the chat is opened again.

import { DID_MAX, DID_TEXT_CAP } from './did.ts';
import type { Turn } from './prompts.ts';

/** How many of the main chat's latest answered turns the buddy remembers by default: the chatTurnsToRead option's default. */
export const CHAT_TURNS_TO_READ_DEFAULT = 4;
/** The most turns the buddy may remember: the chatTurnsToRead option's ceiling. */
export const CHAT_TURNS_TO_READ_MAX = 10;
/**
 * How much of a remembered turn's prompt is kept from its start, where the ask
 * is, and from its end. Measured over 12,492 real turns, these cut 3.6% of
 * turns and 7.7% of their text; docs/design/chatTurnsToRead.md has the tiers.
 */
export const TURN_PROMPT_HEAD = 4800;
export const TURN_PROMPT_TAIL = 2400;
/** How much of a remembered turn's answer is kept from its start, where Claude says what came of it, and from its end, where it says what is next. */
export const TURN_ANSWER_HEAD = 8000;
export const TURN_ANSWER_TAIL = 3200;
/** The most canned lines one character keeps under one turn: past it the oldest go. Questions, answers, comments and suggestions are never dropped. */
export const LINES_PER_TURN_MAX = 3;
/** The `from` of a remembered compaction: its turn's answer is the summary. */
export const COMPACTION = 'compaction';
/** The store key prefix a session's chatTurnsToRead was kept under before 1.0.0. */
export const CHAT_TURNS_TO_READ_KEY_PREFIX = 'chatTurnsToRead:';
/** How long one chatTurnsToRead write may take before it is abandoned and later reads and writes go ahead; a read is bounded by its caller's deadline. */
export const CHAT_TURNS_TO_READ_WRITE_DEADLINE_MS = 60_000;
/** How many times a write that failed or was abandoned is made, in all, while the next main turn has not started. */
export const CHAT_TURNS_TO_READ_WRITE_TRIES = 3;
/** How long after a failed or abandoned write the next try waits: the reads queued meanwhile go first. */
export const CHAT_TURNS_TO_READ_RETRY_MS = 5_000;

/** One exchange: a question and its answer (none when it got none), a canned line said on its own, or an end-of-turn call's shown commentAfterEachTurn and suggestNextPrompt, at least one. */
export type Exchange =
  | { kind: 'question'; question: string; answer?: string }
  | { kind: 'line'; text: string }
  | { kind: 'endOfTurn'; commentAfterEachTurn?: string; suggestNextPrompt?: string };
/**
 * One main-chat turn, by its turnId, and each character's exchanges after it
 * ended, before the next one did. Only the first block may have no turn: what
 * was exchanged before the first turn remembered. `at`: when the turn was
 * filed. `full`: its prompt's and answer's length before they were cut to
 * their start and end, for the audit of what is lost.
 */
export type Block = { turnId?: string; turn?: Turn; at?: number; full?: number; characters: Record<string, Exchange[]> };
/** What memory.json holds (and the store held under storeKey(sessionId) before 1.0.0): when it was last written, and the timeline. */
export type Stored = { at: number; blocks: Block[] };

export function storeKey(sessionId: string): string {
  return `${CHAT_TURNS_TO_READ_KEY_PREFIX}${sessionId}`;
}

/** A text as said, whole: only the blank space around it goes. */
export function keepText(text: string): string {
  return text.trim();
}

/** `text` whole when it fits `head` and `tail`, else its first `head` and last `tail` characters around ` … `; cutting it again keeps it. */
export function ends(text: string, head: number, tail: number): string {
  return text.length > head + tail + 3 ? `${text.slice(0, head)} … ${text.slice(text.length - tail)}` : text;
}

/**
 * A prompt without the markup the chat wraps around it: a task notification
 * is its summary, a system reminder goes whole, every other tag goes and its
 * text stays; folded to one line.
 */
export function cleanPrompt(text: string): string {
  const note = /<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>/.exec(text);
  const t = note ? note[1]! : text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/** An answer without the markdown that only draws: bold, heading marks, table rules and blank lines go; words, code and line breaks stay. */
export function cleanAnswer(text: string): string {
  return text
    .replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^#+ /gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** The exchange with every text kept whole; null when it says nothing (an empty question or line, an end of turn with neither text). */
function capped(x: Exchange): Exchange | null {
  if (x.kind === 'line') {
    const text = keepText(x.text);
    return text ? { kind: 'line', text } : null;
  }
  if (x.kind === 'endOfTurn') {
    const commentAfterEachTurn = keepText(x.commentAfterEachTurn ?? '');
    const suggestNextPrompt = keepText(x.suggestNextPrompt ?? '');
    if (!commentAfterEachTurn && !suggestNextPrompt) return null;
    return { kind: 'endOfTurn', ...(commentAfterEachTurn ? { commentAfterEachTurn } : {}), ...(suggestNextPrompt ? { suggestNextPrompt } : {}) };
  }
  const question = keepText(x.question);
  if (!question) return null;
  const answer = keepText(x.answer ?? '');
  return answer ? { kind: 'question', question, answer } : { kind: 'question', question };
}

/** The turn cleaned and kept to the start and end of its prompt and answer, with what it did, if anything; capping it again keeps it. */
function cappedTurn(t: Turn): Turn {
  const turn: Turn = { prompt: ends(cleanPrompt(t.prompt), TURN_PROMPT_HEAD, TURN_PROMPT_TAIL), answer: ends(cleanAnswer(t.answer), TURN_ANSWER_HEAD, TURN_ANSWER_TAIL) };
  const did = (t.did ?? []).slice(0, DID_MAX).map((d) => (d.length > DID_TEXT_CAP ? `${d.slice(0, DID_TEXT_CAP - 1)}…` : d)).filter((d) => d);
  return { ...turn, ...(did.length > 0 ? { did } : {}), ...(t.from === undefined ? {} : { from: t.from }) };
}

/** The timeline with the answered turn `turnId` added last, at `at`, kept to its last `n` blocks: a turnless first block goes once `n` turns follow it. */
export function addTurn(blocks: readonly Block[], turnId: string, turn: Turn, n: number, at?: number): Block[] {
  const full = cleanPrompt(turn.prompt).length + cleanAnswer(turn.answer).length;
  return [...blocks, { turnId, turn: cappedTurn(turn), ...(at === undefined ? {} : { at }), full, characters: {} }].slice(-Math.max(1, n));
}

/** The timeline with the main chat's compaction `id` added last as a turn of its own, its summary the answer, kept to `n` blocks like any turn. */
export function addCompaction(blocks: readonly Block[], id: string, summary: string, n: number, at?: number): Block[] {
  return addTurn(blocks, id, { prompt: '', answer: summary, from: COMPACTION }, n, at);
}

/** What `n` blocks of the timeline hand the model of the main chat's turns: how many, their prompt and answer characters kept, and how many they had before the cut. */
export function memoryStats(blocks: readonly Block[], n: number): { turns: number; kept: number; full: number } {
  const turns = blocks.slice(-Math.max(1, n)).filter((b) => b.turn);
  const kept = turns.reduce((k, b) => k + b.turn!.prompt.length + b.turn!.answer.length, 0);
  return { turns: turns.length, kept, full: turns.reduce((f, b) => f + Math.max(b.full ?? 0, b.turn!.prompt.length + b.turn!.answer.length), 0) };
}

/**
 * The timeline with `x` filed for `characterId` under the turn `after` (the
 * newest remembered when the exchange began), or under the newest block when
 * `after` is undefined; with no block yet, under a first, turnless one. An
 * exchange whose turn is no longer remembered is older than the memory: dropped.
 */
export function addExchange(blocks: readonly Block[], characterId: string, x: Exchange, after?: string): Block[] {
  const c = capped(x);
  if (!c) return [...blocks];
  if (blocks.length === 0) return after === undefined ? [{ characters: { [characterId]: [c] } }] : [];
  const i = after === undefined ? blocks.length - 1 : blocks.findIndex((b) => b.turnId === after);
  if (i < 0) return [...blocks];
  const b = blocks[i]!;
  const exchanges = dropOldLines([...(b.characters[characterId] ?? []), c]);
  return blocks.map((y, k) => (k === i ? { ...b, characters: { ...b.characters, [characterId]: exchanges } } : y));
}

/** `xs` with only its newest LINES_PER_TURN_MAX canned lines: every other exchange stays. */
function dropOldLines(xs: Exchange[]): Exchange[] {
  let lines = xs.filter((x) => x.kind === 'line').length;
  return xs.filter((x) => x.kind !== 'line' || lines-- <= LINES_PER_TURN_MAX);
}

/** Prompt origins that say nothing of whose a prompt was: no submission seen (`unknown`), or one the engine could not place. */
const UNKNOWN_ORIGINS: readonly string[] = ['unknown', 'unclassified'];

/** A remembered turn's prompt and answer; a prompt not the user's is never shown as what the user asked, one of unknown origin never said not to be. */
function turnLines(t: Turn, k: number): string[] {
  if (t.from === COMPACTION) return [`Turn ${k}. The main chat was compacted: Claude now holds only this summary of everything before it:`, t.answer || '(no summary)'];
  const asked = t.from === undefined ? 'The user asked Claude:' : UNKNOWN_ORIGINS.includes(t.from) ? 'Claude was sent, from an unknown origin:' : `Claude was sent, not by the user (${t.from}):`;
  return [`Turn ${k}. ${asked}`, t.prompt || '(not seen)', ...(t.did ? [`Claude did: ${t.did.join('; ')}`] : []), 'Claude answered:', t.answer || '(no text)'];
}

/** The lines of one exchange, addressed to the character as "you": its first line a list item, the rest indented under it. */
function exchangeLines(x: Exchange): string[] {
  switch (x.kind) {
    case 'question':
      return [`The user asked you: ${x.question}`, x.answer ? `You answered: ${x.answer}` : 'You gave no answer.'];
    case 'line':
      return [`You said: ${x.text}`];
    case 'endOfTurn': {
      const suggestion = (lead: string) => `${lead} the user's next prompt: ${x.suggestNextPrompt}`;
      if (!x.commentAfterEachTurn) return [suggestion('After this turn, you suggested')];
      const comment = `After this turn, you commented: ${x.commentAfterEachTurn}`;
      return x.suggestNextPrompt ? [comment, suggestion('With it, you suggested')] : [comment];
    }
  }
}

/**
 * What `characterId` remembers, as the prompt carries it: the last `n` blocks,
 * oldest first, each turn with that character's exchanges after it, one list
 * item each; '' when there is nothing.
 */
export function render(blocks: readonly Block[], characterId: string, n: number): string {
  const kept = blocks.slice(-Math.max(1, n));
  const hasTurns = kept.some((b) => b.turn);
  let k = 0;
  const parts = kept.flatMap((b) => {
    // A text of several lines stays under its item: every line after the first indented.
    const exchanges = (b.characters[characterId] ?? []).map((x) => exchangeLines(x).map((l, i) => `${i === 0 ? '- ' : '  '}${l.replace(/\n/g, '\n    ')}`).join('\n'));
    const head = b.turn ? turnLines(b.turn, ++k) : exchanges.length > 0 ? [hasTurns ? 'Before those turns:' : 'Before any turn of the main chat:'] : [];
    return head.length > 0 ? [[...head, ...exchanges].join('\n')] : [];
  });
  return parts.length > 0 ? ['What you remember, oldest first:', ...parts].join('\n\n') : '';
}

/** A stored exchange, checked field by field: its capped form, or null when malformed. */
function exchangeOf(v: unknown): Exchange | null {
  if (typeof v !== 'object' || v === null) return null;
  const x = v as Record<string, unknown>;
  if (x.kind === 'question') {
    if (typeof x.question !== 'string' || (x.answer !== undefined && typeof x.answer !== 'string')) return null;
    return capped({ kind: 'question', question: x.question, ...(typeof x.answer === 'string' ? { answer: x.answer } : {}) });
  }
  if (x.kind === 'line' && typeof x.text === 'string') return capped({ kind: 'line', text: x.text });
  if (x.kind === 'endOfTurn') {
    const { commentAfterEachTurn: c, suggestNextPrompt: s } = x;
    if ((c !== undefined && typeof c !== 'string') || (s !== undefined && typeof s !== 'string')) return null;
    return capped({ kind: 'endOfTurn', ...(typeof c === 'string' ? { commentAfterEachTurn: c } : {}), ...(typeof s === 'string' ? { suggestNextPrompt: s } : {}) });
  }
  return null;
}

/** A stored turn, checked field by field, or null when malformed. */
function turnOf(v: unknown): Turn | null {
  if (typeof v !== 'object' || v === null) return null;
  const t = v as Record<string, unknown>;
  if (typeof t.prompt !== 'string' || typeof t.answer !== 'string' || (t.from !== undefined && typeof t.from !== 'string')) return null;
  if (t.did !== undefined && !(Array.isArray(t.did) && t.did.every((d) => typeof d === 'string'))) return null;
  return cappedTurn({ prompt: t.prompt, answer: t.answer, ...(Array.isArray(t.did) ? { did: t.did as string[] } : {}), ...(typeof t.from === 'string' ? { from: t.from } : {}) });
}

/** The timeline stored under a session's key: none is an empty timeline; a malformed one keeps what reads and says how much it dropped. */
export function chatTurnsToReadOf(value: unknown): { blocks: Block[]; error?: string } {
  if (value === undefined) return { blocks: [] };
  if (typeof value !== 'object' || value === null || !Array.isArray((value as Stored).blocks)) {
    return { blocks: [], error: 'the stored chatTurnsToRead is not a chatTurnsToRead record' };
  }
  const blocks: Block[] = [];
  let dropped = 0;
  for (const raw of (value as Stored).blocks as unknown[]) {
    const b = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
    const turn = b && b.turn !== undefined ? turnOf(b.turn) : undefined;
    const characters = b && typeof b.characters === 'object' && b.characters !== null ? (b.characters as Record<string, unknown>) : null;
    // A turn needs its id, a block its characters; only the first block may lack a turn.
    if (!b || !characters || turn === null || (turn !== undefined && typeof b.turnId !== 'string') || (turn === undefined && blocks.length > 0)) {
      dropped++;
      continue;
    }
    const kept: Record<string, Exchange[]> = {};
    for (const [id, list] of Object.entries(characters)) {
      if (!Array.isArray(list)) {
        dropped++;
        continue;
      }
      const xs = list.map(exchangeOf).filter((x): x is Exchange => x !== null);
      dropped += list.length - xs.length;
      kept[id] = xs;
    }
    const at = typeof b.at === 'number' && Number.isFinite(b.at) ? { at: b.at } : {};
    const full = typeof b.full === 'number' && Number.isFinite(b.full) ? { full: b.full } : {};
    blocks.push(turn ? { turnId: b.turnId as string, turn, ...at, ...full, characters: kept } : { characters: kept });
  }
  return dropped > 0 ? { blocks, error: `the stored chatTurnsToRead had ${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'}, dropped` } : { blocks };
}
