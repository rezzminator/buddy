// The buddy's memory, `chatTurnsToRead`: the main chat's last N answered turns,
// each filtered to what carries meaning (the prompt without its markup, what
// Claude did as one line per step, its numbers as one line, the start and end of its answer), and under each what the buddy and you exchanged after it, oldest first, one
// timeline per session. The buddy remembers of itself exactly as far back as
// it remembers of the chat, so it never holds words about a turn it can no
// longer see. An exchange is one /buddy question with its answer, one canned
// line the bubble showed on its own, or what a turn's end showed: its
// commentAfterEachTurn, the second brain's warning, its suggestNextPrompt, any
// of them, kept together.
// What you and the buddy said to each other is kept whole, never cut. A
// compaction of the main chat is remembered as a turn of its own: its summary
// is what Claude holds of everything before it.
// No I/O: the adapter keeps a session's timeline in memory.json in the chat's
// own folder, beside its transcript (src/chatFolder.ts), and what the drawn
// character reads of it in memory.md beside it (memoryText), each character's
// exchanges under its id, so a switched character never claims another's
// words. Before 1.0.0 it was kept in $.store under storeKey(sessionId): the
// adapter moves it into the file the first time the chat is opened again.

import { DID_LINE_CAP, DID_MAX } from './did.ts';
import type { Turn } from './prompts.ts';
import { renderStats, turnStatsOf, type TurnStats } from './stats.ts';

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
/** The most prompts delivered into one turn while it ran that it keeps, the newest, each cut like its prompt. */
export const ADDED_MAX = 3;
/** The most agent reports one turn keeps, the newest. */
export const RETURNED_MAX = 4;
/** How a prompt delivered into a turn while it ran is said, in the memory and in the round file. */
export const ADDED_LABEL = 'The user added while Claude worked:';
/** How much of a task notification's result, the report it brought, is kept from its start and from its end. */
export const NOTIFICATION_RESULT_HEAD = 1200;
export const NOTIFICATION_RESULT_TAIL = 400;
/** How much of a remembered turn's answer is kept from its start, where Claude says what came of it, and from its end, where it says what is next. */
export const TURN_ANSWER_HEAD = 8000;
export const TURN_ANSWER_TAIL = 3200;
/**
 * The story form: every remembered turn but the last one rendered is cut
 * further, to what steers the buddy (the user's words, the start and end of
 * Claude's answer, the buddy's own exchanges whole); the last stays as above.
 * Benched on 189 real end-of-turn calls: 27.8% fewer input tokens, the
 * reactions held. How much of an older turn's prompt is kept from its start
 * and from its end, as rendered.
 */
export const STORY_PROMPT_HEAD = 600;
export const STORY_PROMPT_TAIL = 200;
/** How much of an older turn's line of a prompt added while Claude worked is kept, the label included. */
export const STORY_ADDED_HEAD = 400;
export const STORY_ADDED_TAIL = 100;
/** How much of an older turn's answer is kept from its start and from its end. */
export const STORY_ANSWER_HEAD = 500;
export const STORY_ANSWER_TAIL = 300;
/** How much of a compaction's summary, with the exchanges after it and without its canned lines, is kept when it is not the last turn. */
export const STORY_COMPACTION_HEAD = 1500;
export const STORY_COMPACTION_TAIL = 500;
/** How many of an older turn's steps its line names, every step counted; null keeps the line as the last turn's is (didLine). */
export const STORY_DID_STEPS: number | null = null;
/** The most canned lines one character keeps under one turn: past it the oldest go. Questions, answers, comments and suggestions are never dropped. */
export const LINES_PER_TURN_MAX = 3;
/** The `from` of a remembered compaction: its turn's answer is the summary. */
export const COMPACTION = 'compaction';
/** The `from` of a turn the user began with the buddy's own suggestion, sent unedited: the user's choice, the buddy's words. */
export const TAKEN_SUGGESTION = 'taken-suggestion';
/** The `from` of a turn the buddy's own prompt began (promptToMainChat): this plugin's own origin. */
export const BUDDY_PROMPT = 'buddy-prompt';
/** How the turn the buddy's own prompt began is labelled, to the buddy and in its rounds. */
export const BUDDY_PROMPT_LABEL = 'the buddy (you), sent to Claude';
/** The store key prefix a session's chatTurnsToRead was kept under before 1.0.0. */
export const CHAT_TURNS_TO_READ_KEY_PREFIX = 'chatTurnsToRead:';
/** How long one chatTurnsToRead write may take before it is abandoned and later reads and writes go ahead; a read is bounded by its caller's deadline. */
export const CHAT_TURNS_TO_READ_WRITE_DEADLINE_MS = 60_000;
/** How many times a write that failed or was abandoned is made, in all, while the next main turn has not started. */
export const CHAT_TURNS_TO_READ_WRITE_TRIES = 3;
/** How long after a failed or abandoned write the next try waits: the reads queued meanwhile go first. */
export const CHAT_TURNS_TO_READ_RETRY_MS = 5_000;

/** One exchange: a question and its answer (none when it got none), a canned line said on its own, or what a turn's end showed: its commentAfterEachTurn, the warning its verdict said (`warned`), the prompt it sent Claude itself (`promptToMainChat`) and its suggestNextPrompt, at least one. */
export type Exchange =
  | { kind: 'question'; question: string; answer?: string }
  | { kind: 'line'; text: string }
  | { kind: 'endOfTurn'; commentAfterEachTurn?: string; warned?: string; promptToMainChat?: string; suggestNextPrompt?: string };
/**
 * One main-chat turn, by its turnId, and each character's exchanges after it
 * ended, before the next one did. Only the first block may have no turn: what
 * was exchanged before the first turn remembered. `at`: when the turn was
 * filed. `full`: its prompt's and answer's length before they were cut to
 * their start and end, for the audit of what is lost.
 */
export type Block = { turnId?: string; turn?: Turn; at?: number; full?: number; characters: Record<string, Exchange[]> };
/** What memory.json holds (and the store held under storeKey(sessionId) before 1.0.0): when it was last written, and the timeline. */
/** Each character's own notes for this chat, which it writes and rewrites itself at every turn's end: at most NOTES_MAX, one sentence each. */
export type Notes = Record<string, string[]>;
export type Stored = { at: number; blocks: Block[]; notes?: Notes };

/** The most notes a character keeps: past it, notes go by their kind (noteRank). */
export const NOTES_MAX = 8;
/** The longest note kept: past it, it is not one sentence, and it is dropped. */
export const NOTE_MAX_CHARS = 300;

/** How soon a note goes when there are too many, by the kind it starts with (MEMORY_LINE): a doubt first, then a fact or an untyped note, then an open item; a rule of the user's last. */
function noteRank(note: string): number {
  const kind = /^(rule|open|fact|doubt)\s*:/i.exec(note)?.[1]?.toLowerCase();
  return kind === 'doubt' ? 3 : kind === 'open' ? 1 : kind === 'rule' ? 0 : 2;
}

/** Notes as the buddy wrote them, cleaned: each trimmed, a leading bullet or number stripped, empty, too long and repeated ones dropped; past NOTES_MAX, the latest of the kind that goes first (noteRank) dropped until they fit, the rest in their order. */
export function cleanNotes(lines: readonly string[]): string[] {
  const kept: string[] = [];
  for (const raw of lines) {
    const note = raw.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (note === '' || note.length > NOTE_MAX_CHARS || kept.includes(note)) continue;
    kept.push(note);
  }
  while (kept.length > NOTES_MAX) {
    const worst = Math.max(...kept.map(noteRank));
    kept.splice(kept.findLastIndex((n) => noteRank(n) === worst), 1);
  }
  return kept;
}

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

/** A text without markup: a system reminder goes whole, every other tag goes and its text stays; folded to one line. */
function stripped(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A prompt without the markup the chat wraps around it: a task notification
 * is its summary, its status when not `completed`, and its result, cut to its
 * start and end, as the report it brought; a system reminder goes whole, every
 * other tag goes and its text stays; folded to one line.
 */
export function cleanPrompt(text: string): string {
  const at = text.indexOf('<task-notification>');
  const note = at < 0 ? null : /<summary>([\s\S]*?)<\/summary>/.exec(text.slice(at));
  if (!note) return stripped(text);
  const body = text.slice(at);
  const result = /<result>([\s\S]*)<\/result>/.exec(body);
  const rest = result ? body.replace(result[0], ' ') : body;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(rest)?.[1] ?? note[1]!;
  const status = /<status>([\s\S]*?)<\/status>/.exec(rest)?.[1]?.trim();
  const report = result ? stripped(result[1]!) : '';
  const parts = [summary, status && status !== 'completed' ? `(status: ${status})` : '', report ? `Its report: ${ends(report, NOTIFICATION_RESULT_HEAD, NOTIFICATION_RESULT_TAIL)}` : ''];
  return parts.join(' ').replace(/\s+/g, ' ').trim();
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
    const warned = keepText(x.warned ?? '');
    const promptToMainChat = keepText(x.promptToMainChat ?? '');
    const suggestNextPrompt = keepText(x.suggestNextPrompt ?? '');
    if (!commentAfterEachTurn && !warned && !promptToMainChat && !suggestNextPrompt) return null;
    return { kind: 'endOfTurn', ...(commentAfterEachTurn ? { commentAfterEachTurn } : {}), ...(warned ? { warned } : {}), ...(promptToMainChat ? { promptToMainChat } : {}), ...(suggestNextPrompt ? { suggestNextPrompt } : {}) };
  }
  const question = keepText(x.question);
  if (!question) return null;
  const answer = keepText(x.answer ?? '');
  return answer ? { kind: 'question', question, answer } : { kind: 'question', question };
}

/** The turn cleaned and kept to the start and end of its prompt and answer, with what it did, if anything, its numbers, and the newest prompts delivered into it, each cut like its prompt; capping it again keeps it. */
function cappedTurn(t: Turn): Turn {
  const turn: Turn = { prompt: ends(cleanPrompt(t.prompt), TURN_PROMPT_HEAD, TURN_PROMPT_TAIL), answer: ends(cleanAnswer(t.answer), TURN_ANSWER_HEAD, TURN_ANSWER_TAIL) };
  const did = (t.did ?? []).slice(0, DID_MAX).map((d) => (d.length > DID_LINE_CAP ? `${d.slice(0, DID_LINE_CAP - 1)}…` : d)).filter((d) => d);
  const added = (t.added ?? []).map((a) => ends(cleanPrompt(a), TURN_PROMPT_HEAD, TURN_PROMPT_TAIL)).filter((a) => a).slice(-ADDED_MAX);
  // What an agent returned, cut like a task notification's report: the same report, whether it came back at once or later.
  const returned = (t.returned ?? []).map((r) => ends(r.trim(), NOTIFICATION_RESULT_HEAD, NOTIFICATION_RESULT_TAIL)).filter((r) => r).slice(-RETURNED_MAX);
  return { ...turn, ...(did.length > 0 ? { did } : {}), ...(returned.length > 0 ? { returned } : {}), ...(t.from === undefined ? {} : { from: t.from }), ...(t.stats === undefined ? {} : { stats: t.stats }), ...(t.interrupted === true ? { interrupted: true } : {}), ...(t.ended === undefined ? {} : { ended: t.ended }), ...(added.length > 0 ? { added } : {}) };
}

/** The timeline with the answered turn `turnId` added last, at `at`, kept to its last `n` blocks: a turnless first block goes once `n` turns follow it. A turn sent again as it was after one interrupted, or ended by an error or a refusal, before any answer takes that one's place, its steps first and its exchanges kept, so one ask holds one of the `n`. */
export function addTurn(blocks: readonly Block[], turnId: string, turn: Turn, n: number, at?: number): Block[] {
  const last = blocks.at(-1);
  const resent = (last?.turn?.interrupted === true || last?.turn?.ended !== undefined) && cleanAnswer(last.turn.answer) === '' && last.turn.from === turn.from && cleanPrompt(last.turn.prompt) === cleanPrompt(turn.prompt);
  const kept = resent ? blocks.slice(0, -1) : blocks;
  const did = resent ? [...(last!.turn!.did ?? []), ...(turn.did ?? [])] : turn.did;
  const returned = resent ? [...(last!.turn!.returned ?? []), ...(turn.returned ?? [])] : turn.returned;
  const t: Turn = { ...turn, ...(did === undefined ? {} : { did }), ...(returned === undefined ? {} : { returned }) };
  const full = cleanPrompt(t.prompt).length + cleanAnswer(t.answer).length;
  return [...kept, { turnId, turn: cappedTurn(t), ...(at === undefined ? {} : { at }), full, characters: resent ? last!.characters : {} }].slice(-Math.max(1, n));
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
 * A canned line already kept under that turn (a greeting after each reload) is
 * not kept twice.
 */
export function addExchange(blocks: readonly Block[], characterId: string, x: Exchange, after?: string): Block[] {
  const c = capped(x);
  if (!c) return [...blocks];
  if (blocks.length === 0) return after === undefined ? [{ characters: { [characterId]: [c] } }] : [];
  const i = after === undefined ? blocks.length - 1 : blocks.findIndex((b) => b.turnId === after);
  if (i < 0) return [...blocks];
  const b = blocks[i]!;
  const had = b.characters[characterId] ?? [];
  if (c.kind === 'line' && had.some((y) => y.kind === 'line' && y.text === c.text)) return [...blocks];
  const exchanges = dropOldLines([...had, c]);
  return blocks.map((y, k) => (k === i ? { ...b, characters: { ...b.characters, [characterId]: exchanges } } : y));
}

/** `xs` with only its newest LINES_PER_TURN_MAX canned lines: every other exchange stays. */
function dropOldLines(xs: Exchange[]): Exchange[] {
  let lines = xs.filter((x) => x.kind === 'line').length;
  return xs.filter((x) => x.kind !== 'line' || lines-- <= LINES_PER_TURN_MAX);
}

/** Prompt origins that say nothing of whose a prompt was: no submission seen (`unknown`), or one the engine could not place. */
const UNKNOWN_ORIGINS: readonly string[] = ['unknown', 'unclassified'];

/** The step a turn with more than DID_MAX steps counts in its middle (did.ts). */
const DID_MORE = /^… (\d+) more$/;

/**
 * A turn's steps as one line: with `keep` null, each step as kept; with a
 * number, the count of every step, the middle ones counted included, and
 * only the first `keep` named.
 */
export function didLine(did: readonly string[], keep: number | null = STORY_DID_STEPS): string {
  if (keep === null) return `Claude did: ${did.join('; ')}`;
  const n = did.filter((d) => !DID_MORE.test(d)).length + Number(did.map((d) => DID_MORE.exec(d)?.[1]).find((m) => m !== undefined) ?? 0);
  return `Claude did ${n} step${n === 1 ? '' : 's'}: ${did.slice(0, keep).join('; ')}${n > keep ? '; …' : ''}`;
}

/**
 * A remembered turn's prompt, steps, numbers and answer; a prompt not the
 * user's is never shown as what the user asked, one of unknown origin never
 * said not to be. `prev`: the numbers of the turn remembered before it.
 * `older`: a turn before the last, in the story form: its prompt, added
 * prompts and answer cut to their start and end, its numbers only its failed
 * tool calls, when any.
 */
function turnLines(t: Turn, k: number, prev: TurnStats | undefined, older: boolean): string[] {
  if (t.from === COMPACTION) return [`Turn ${k}. The main chat was compacted: Claude now holds only this summary of everything before it:`, t.answer || '(no summary)'];
  const asked =
    t.from === undefined ? 'The user asked Claude:'
    : t.from === TAKEN_SUGGESTION ? 'The user sent Claude your own suggested prompt, unedited:'
    : t.from === BUDDY_PROMPT ? `From ${BUDDY_PROMPT_LABEL}:`
    : UNKNOWN_ORIGINS.includes(t.from) ? "Claude was sent, by a sender you did not see (most often the user's own slash command or skill, or a prompt sent while you restarted):"
    : `Claude was sent, not by the user (${t.from}):`;
  const answered =
    t.interrupted ? 'Claude answered, before the user interrupted the turn:'
    : t.ended === 'error' ? 'Claude answered, before an error ended the turn:'
    : t.ended === 'refusal' ? 'Claude answered, before the model refused and ended the turn:'
    : 'Claude answered:';
  if (!older) return [`Turn ${k}. ${asked}`, t.prompt || '(not seen)', ...(t.added ?? []).map((a) => `${ADDED_LABEL} ${a}`), ...(t.did ? [didLine(t.did, null)] : []), ...(t.returned ?? []).map((r) => `Its agent ${r}`), ...(t.stats ? [renderStats(t.stats, prev)] : []), answered, t.answer || '(no text)'];
  const failed = t.stats?.failed ?? 0;
  return [
    `Turn ${k}. ${asked}`,
    ends(t.prompt || '(not seen)', STORY_PROMPT_HEAD, STORY_PROMPT_TAIL),
    ...(t.added ?? []).map((a) => ends(`${ADDED_LABEL} ${a}`, STORY_ADDED_HEAD, STORY_ADDED_TAIL)),
    ...(t.did ? [didLine(t.did)] : []),
    ...(t.returned ?? []).map((r) => ends(`Its agent ${r}`, STORY_ADDED_HEAD, STORY_ADDED_TAIL)),
    ...(failed > 0 ? [`${failed} tool call${failed === 1 ? '' : 's'} failed.`] : []),
    answered,
    ends(t.answer || '(no text)', STORY_ANSWER_HEAD, STORY_ANSWER_TAIL),
  ];
}

/** The lines of one exchange, addressed to the character as "you": its first line a list item, the rest indented under it. */
function exchangeLines(x: Exchange): string[] {
  switch (x.kind) {
    case 'question':
      return [`The user asked you: ${x.question}`, x.answer ? `You answered: ${x.answer}` : 'You gave no answer.'];
    case 'line':
      return [`You said: ${x.text}`];
    case 'endOfTurn': {
      const said: [string, string | undefined][] = [
        ['commented', x.commentAfterEachTurn],
        ['warned the user', x.warned],
        ['sent Claude this prompt yourself', x.promptToMainChat],
        ["suggested the user's next prompt", x.suggestNextPrompt],
      ];
      return said.filter(([, text]) => text).map(([what, text], i) => `${i === 0 ? 'After this turn, you' : 'With it, you'} ${what}: ${text}`);
    }
  }
}

/** A character's notes as the prompt carries them, first; '' when it has none. */
export function renderNotes(notes: readonly string[]): string {
  return notes.length > 0 ? ['Your own notes on this chat, which you keep and rewrite yourself:', ...notes.map((n) => `- ${n}`)].join('\n') : '';
}

/**
 * What `characterId` remembers, as the prompt carries it: its own `notes`
 * first, then the last `n` blocks, oldest first, each turn with that
 * character's exchanges after it, one list item each; '' when there is nothing.
 * Every turn but the last is in the story form (turnLines); a compaction
 * before the last turn is its summary and exchanges, canned lines left out,
 * cut to their start and end.
 */
export function render(blocks: readonly Block[], characterId: string, n: number, notes: readonly string[] = []): string {
  const kept = blocks.slice(-Math.max(1, n));
  const hasTurns = kept.some((b) => b.turn);
  let k = 0;
  // The numbers of the turn before, whose model and effort a turn's numbers repeat only when they changed.
  let prev: TurnStats | undefined;
  const lastTurn = kept.findLastIndex((b) => b.turn);
  const parts = kept.flatMap((b, i) => {
    const xs = b.characters[characterId] ?? [];
    // A text of several lines stays under its item: every line after the first indented.
    const item = (x: Exchange): string => exchangeLines(x).map((l, j) => `${j === 0 ? '- ' : '  '}${l.replace(/\n/g, '\n    ')}`).join('\n');
    const exchanges = xs.map(item);
    const older = b.turn !== undefined && i < lastTurn;
    const head = b.turn ? turnLines(b.turn, ++k, prev, older) : exchanges.length > 0 ? [hasTurns ? 'Before those turns:' : 'Before any turn of the main chat:'] : [];
    if (b.turn?.stats) prev = b.turn.stats;
    if (older && b.turn!.from === COMPACTION) {
      const body = [head[1]!, ...xs.filter((x) => x.kind !== 'line').map(item)].join('\n');
      return [[head[0]!, ends(body, STORY_COMPACTION_HEAD, STORY_COMPACTION_TAIL)].join('\n')];
    }
    return head.length > 0 ? [[...head, ...exchanges].join('\n')] : [];
  });
  const timeline = parts.length > 0 ? ['What you remember, oldest first:', ...parts].join('\n\n') : '';
  return [renderNotes(notes), timeline].filter(Boolean).join('\n\n');
}

/** `at` as a person reads it anywhere: the UTC date and time to the minute. */
function stamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * memory.md, the copy of the memory a person reads: a heading naming the
 * character (`name`), when it was rewritten (`at`) and that it is the very
 * text the character reads before every reply, then that text (render).
 */
export function memoryText(name: string, blocks: readonly Block[], characterId: string, n: number, notes: readonly string[], at: number): string {
  const text = render(blocks, characterId, n, notes);
  return [`# What ${name} remembers`, `Rewritten ${stamp(at)}. This is the same text ${name} reads before every reply.`, text || 'Nothing yet.'].join('\n\n') + '\n';
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
    const { commentAfterEachTurn: c, warned: v, promptToMainChat: p, suggestNextPrompt: s } = x;
    if ([c, v, p, s].some((f) => f !== undefined && typeof f !== 'string')) return null;
    return capped({ kind: 'endOfTurn', ...(typeof c === 'string' ? { commentAfterEachTurn: c } : {}), ...(typeof v === 'string' ? { warned: v } : {}), ...(typeof p === 'string' ? { promptToMainChat: p } : {}), ...(typeof s === 'string' ? { suggestNextPrompt: s } : {}) });
  }
  return null;
}

/** A stored turn, checked field by field, or null when malformed. */
function turnOf(v: unknown): Turn | null {
  if (typeof v !== 'object' || v === null) return null;
  const t = v as Record<string, unknown>;
  if (typeof t.prompt !== 'string' || typeof t.answer !== 'string' || (t.from !== undefined && typeof t.from !== 'string')) return null;
  if (t.did !== undefined && !(Array.isArray(t.did) && t.did.every((d) => typeof d === 'string'))) return null;
  if (t.interrupted !== undefined && typeof t.interrupted !== 'boolean') return null;
  if (t.ended !== undefined && t.ended !== 'error' && t.ended !== 'refusal') return null;
  if (t.added !== undefined && !(Array.isArray(t.added) && t.added.every((a) => typeof a === 'string'))) return null;
  if (t.returned !== undefined && !(Array.isArray(t.returned) && t.returned.every((r) => typeof r === 'string'))) return null;
  const stats = t.stats === undefined ? undefined : turnStatsOf(t.stats);
  if (stats === null) return null;
  return cappedTurn({ prompt: t.prompt, answer: t.answer, ...(Array.isArray(t.did) ? { did: t.did as string[] } : {}), ...(Array.isArray(t.returned) ? { returned: t.returned as string[] } : {}), ...(typeof t.from === 'string' ? { from: t.from } : {}), ...(stats ? { stats } : {}), ...(t.interrupted === true ? { interrupted: true } : {}), ...(t.ended === 'error' || t.ended === 'refusal' ? { ended: t.ended } : {}), ...(Array.isArray(t.added) ? { added: t.added as string[] } : {}) });
}

/** Stored notes, each character's cleaned (cleanNotes); a character whose notes are not a list of text is dropped, counted in `dropped`. */
function notesOf(value: unknown): { notes: Notes; dropped: number } {
  const notes: Notes = {};
  let dropped = 0;
  if (value === undefined) return { notes, dropped };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { notes, dropped: 1 };
  for (const [id, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list) || !list.every((n) => typeof n === 'string')) {
      dropped++;
      continue;
    }
    notes[id] = cleanNotes(list as string[]);
  }
  return { notes, dropped };
}

/** The timeline stored under a session's key, with each character's notes: none is an empty timeline; a malformed one keeps what reads and says how much it dropped. */
export function chatTurnsToReadOf(value: unknown): { blocks: Block[]; notes: Notes; error?: string } {
  if (value === undefined) return { blocks: [], notes: {} };
  if (typeof value !== 'object' || value === null || !Array.isArray((value as Stored).blocks)) {
    return { blocks: [], notes: {}, error: 'the stored chatTurnsToRead is not a chatTurnsToRead record' };
  }
  const stored = notesOf((value as Stored).notes);
  const notes = stored.notes;
  const blocks: Block[] = [];
  let dropped = stored.dropped;
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
  return dropped > 0 ? { blocks, notes, error: `the stored chatTurnsToRead had ${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'}, dropped` } : { blocks, notes };
}
