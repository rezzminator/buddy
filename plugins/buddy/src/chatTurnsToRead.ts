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

import { itemsOf, itemsText, type Items, type EndedItems } from './memoryItems.ts';
import { CUT, REPORT_LARGE_HEAD, REPORT_LARGE_TAIL, SIGNED_HEAD, SIGNED_TAIL, cutReport, ends } from './cuts.ts';
import { DID_LINE_CAP, DID_MAX, agentUsageOf, agentUsageText } from './did.ts';
import type { Said, Turn } from './prompts.ts';
import { isSignedMessage, isStoredSignedMessage, signedOf } from './signedMessage.ts';
import { afterSuggestion, suggestionUse } from './suggestNextPrompt.ts';
import { count, renderStats, turnStatsOf, type TurnStats } from './stats.ts';
import { strikesOf, type Strikes } from './steering.ts';

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
/** How much of the user's own prompt, and of a prompt the user added while Claude worked, is kept from its start and from its end: the buddy reads what the user wrote whole up to a large limit. */
export const USER_PROMPT_HEAD = 15000;
export const USER_PROMPT_TAIL = 5000;
/** The most prompts delivered into one turn while it ran that it keeps, the newest, each cut like its prompt. */
export const ADDED_MAX = 3;
/** The most agent reports one turn keeps, the newest. */
export const RETURNED_MAX = 4;
/** How a prompt delivered into a turn while it ran is said, in the memory and in the round file, when its position is not known. */
export const ADDED_LABEL = 'The user added while Claude worked:';
/** How much of what Claude wrote mid-turn is kept from its start and from its end, each text. */
export const SAID_HEAD = 2000;
export const SAID_TAIL = 800;
/** Past SAID_KEPT_FIRST + SAID_KEPT_LAST + 1 texts written mid-turn, the first and the last kept around a count of the rest. */
export const SAID_KEPT_FIRST = 2;
export const SAID_KEPT_LAST = 6;
/** The `from` of a turn whose prompt is a signed cross-chat message: another chat's, never the user's. */
export const SIGNED_MESSAGE_ORIGIN = 'signed-message';
/** The prefix of a stored prompt delivered into a turn that is a signed cross-chat message. */
export const SIGNED_ADDED = '(signed message from another chat, not typed by the user)';
/** How the turn a signed cross-chat message began is labelled. */
export const SIGNED_LABEL = 'Claude was sent a signed message from another chat, not typed by the user:';
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
/** How much of an older turn's own user prompt, and of each line the user added while Claude worked, is kept from its start and from its end. */
export const STORY_USER_PROMPT_HEAD = 3000;
export const STORY_USER_PROMPT_TAIL = 1000;
/** How much of an older turn's line of a signed message delivered while Claude worked, of what Claude wrote mid-turn, briefed or was returned, is kept, the label included. */
export const STORY_ADDED_HEAD = 400;
export const STORY_ADDED_TAIL = 100;
/** How much of an older turn's answer is kept from its start and from its end. */
export const STORY_ANSWER_HEAD = 500;
export const STORY_ANSWER_TAIL = 300;
/** How much of a compaction's summary, with the exchanges after it and without its canned lines, is kept when it is not the last turn. */
export const STORY_COMPACTION_HEAD = 4000;
export const STORY_COMPACTION_TAIL = 1000;
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

/** One exchange: a question and its answer (none when it got none), a canned line said on its own, or what a turn's end showed: its commentAfterEachTurn, the warning its verdict said (`warned`), the prompt it sent Claude itself (`promptToMainChat`), the one it wrote but never sent because the chat moved on (`unsentPrompt`) and its suggestNextPrompt, at least one. */
export type Exchange =
  | { kind: 'question'; question: string; answer?: string }
  | { kind: 'line'; text: string }
  | { kind: 'endOfTurn'; commentAfterEachTurn?: string; warned?: string; promptToMainChat?: string; unsentPrompt?: string; suggestNextPrompt?: string };
/**
 * One main-chat turn, by its turnId, and each character's exchanges after it
 * ended, before the next one did. Only the first block may have no turn: what
 * was exchanged before the first turn remembered. `at`: when the turn was
 * filed. `full`: its prompt's and answer's length before they were cut to
 * their start and end, for the audit of what is lost.
 */
export type Block = { turnId?: string; turn?: Turn; no?: number; at?: number; full?: number; characters: Record<string, Exchange[]> };
/** What memory.json holds (and the store held under storeKey(sessionId) before 1.0.0): when it was last written, the timeline, and each live rule's strikes (src/steering.ts). */
export type Stored = { version: 2; at: number; turnNo: number; blocks: Block[]; items: Items; ended: EndedItems; strikes?: Strikes };

export function storeKey(sessionId: string): string {
  return `${CHAT_TURNS_TO_READ_KEY_PREFIX}${sessionId}`;
}

/** A text as said, whole: only the blank space around it goes. */
export function keepText(text: string): string {
  return text.trim();
}

// ends moved to cuts.ts; kept here for the modules that import it from the memory.
export { ends } from './cuts.ts';

/** A text without markup: a system reminder goes whole, every other tag goes and its text stays; folded to one line. */
function stripped(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** What a task notification's note says when the agent has work still running: its report may not be its last word. */
const INTERIM = '(its report may be interim: the agent still has background work running)';

/**
 * A prompt without the markup the chat wraps around it: a task notification
 * is its summary, its status when not `completed`, its usage when a `<usage>`
 * block gives it, that its report may be interim when its note says the agent
 * is still running, and its result, its size said, cut by cutReport, as the
 * report it brought; a system reminder goes whole, every other tag goes and
 * its text stays; folded to one line.
 */
export function cleanPrompt(text: string): string {
  const at = text.indexOf('<task-notification>');
  const found = at < 0 ? null : /<summary>([\s\S]*?)<\/summary>/.exec(text.slice(at));
  if (!found) return stripped(text);
  const body = text.slice(at);
  const result = /<result>([\s\S]*)<\/result>/.exec(body);
  const rest = result ? body.replace(result[0], ' ') : body;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(rest)?.[1] ?? found[1]!;
  const status = /<status>([\s\S]*?)<\/status>/.exec(rest)?.[1]?.trim();
  const usage = agentUsageText(agentUsageOf(null, body));
  const interim = /still running/i.test(/<note>([\s\S]*?)<\/note>/.exec(rest)?.[1] ?? '');
  const report = result ? stripped(result[1]!.replace(/<usage>[\s\S]*?<\/usage>/g, ' ')) : '';
  const parts = [
    summary,
    status && status !== 'completed' ? `(status: ${status})` : '',
    usage ? `(${usage})` : '',
    interim ? INTERIM : '',
    report ? `Its report (${count(report.length)} chars): ${cutReport(report)}` : '',
  ];
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** A signed cross-chat message as the memory keeps it: its body cleaned and cut, then its session id and the chat it came from; null for any other text. */
function signedForm(raw: string): string | null {
  const s = isSignedMessage(raw) ? signedOf(raw) : null;
  return s ? `${ends(cleanPrompt(s.body), SIGNED_HEAD, SIGNED_TAIL)} — sid ${s.sid} · from chat ${s.peer}` : null;
}

/** A prompt delivered into a turn as the memory keeps it: one already kept as a signed message as it is, a signed message raw in its kept form after SIGNED_ADDED, the user's own cleaned and cut. */
function addedForm(raw: string): string {
  if (raw.startsWith(SIGNED_ADDED)) return raw.trim();
  const signed = signedForm(raw);
  return signed === null ? ends(cleanPrompt(raw), USER_PROMPT_HEAD, USER_PROMPT_TAIL) : `${SIGNED_ADDED} ${signed}`;
}

/** What Claude wrote mid-turn as the memory keeps it: each text cleaned like an answer and cut, blanks gone, the last gone when it is the answer itself; past SAID_KEPT_FIRST + SAID_KEPT_LAST + 1, the first and last around a `[cut: N more]` entry. */
function cappedSaid(said: readonly Said[], answer: string): Said[] {
  let kept = said.map((x) => ({ after: x.after, text: cleanAnswer(x.text) })).filter((x) => x.text !== '');
  if (kept.length > 0 && kept.at(-1)!.text === answer) kept = kept.slice(0, -1);
  kept = kept.map((x) => ({ after: x.after, text: ends(x.text, SAID_HEAD, SAID_TAIL) }));
  if (kept.length <= SAID_KEPT_FIRST + SAID_KEPT_LAST + 1) return kept;
  const dropped = kept.length - SAID_KEPT_FIRST - SAID_KEPT_LAST;
  return [...kept.slice(0, SAID_KEPT_FIRST), { after: kept[SAID_KEPT_FIRST]!.after, text: `[cut: ${dropped} more]` }, ...kept.slice(-SAID_KEPT_LAST)];
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
    const unsentPrompt = keepText(x.unsentPrompt ?? '');
    const suggestNextPrompt = keepText(x.suggestNextPrompt ?? '');
    if (!commentAfterEachTurn && !warned && !promptToMainChat && !unsentPrompt && !suggestNextPrompt) return null;
    return { kind: 'endOfTurn', ...(commentAfterEachTurn ? { commentAfterEachTurn } : {}), ...(warned ? { warned } : {}), ...(promptToMainChat ? { promptToMainChat } : {}), ...(unsentPrompt ? { unsentPrompt } : {}), ...(suggestNextPrompt ? { suggestNextPrompt } : {}) };
  }
  const question = keepText(x.question);
  if (!question) return null;
  const answer = keepText(x.answer ?? '');
  return answer ? { kind: 'question', question, answer } : { kind: 'question', question };
}

/**
 * The turn cleaned and kept to the start and end of its prompt and answer,
 * with what it did, if anything, its numbers, the newest prompts delivered
 * into it with their positions, what Claude wrote mid-turn, its agents'
 * briefs and reports, and the suggestion shown when it was sent. The user's
 * own prompt and added lines are kept up to USER_PROMPT_HEAD and TAIL, any
 * other origin's prompt to TURN_PROMPT_HEAD and TAIL; a signed cross-chat
 * message, prompt or added, is kept in its signed form, never as the user's.
 * Capping it again keeps it: a kept signed form no longer reads as signed.
 */
function cappedTurn(t: Turn): Turn {
  const signed = t.from === undefined ? signedForm(t.prompt) : null;
  const from = signed === null ? t.from : SIGNED_MESSAGE_ORIGIN;
  const prompt = signed ?? (from === undefined ? ends(cleanPrompt(t.prompt), USER_PROMPT_HEAD, USER_PROMPT_TAIL) : ends(cleanPrompt(t.prompt), TURN_PROMPT_HEAD, TURN_PROMPT_TAIL));
  const answer = cleanAnswer(t.answer);
  const turn: Turn = { prompt, answer: ends(answer, TURN_ANSWER_HEAD, TURN_ANSWER_TAIL) };
  const did = (t.did ?? []).slice(0, DID_MAX).map((d) => (d.length > DID_LINE_CAP ? `${d.slice(0, DID_LINE_CAP - CUT.length - 1)} ${CUT}` : d)).filter((d) => d);
  // Each added prompt keeps its position while blanks go and the oldest past ADDED_MAX drop; positions that do not pair one to one are read as unknown.
  const positioned = t.added !== undefined && t.addedAfter !== undefined && t.addedAfter.length === t.added.length;
  const pairs = (t.added ?? []).map((a, i) => ({ text: addedForm(a), after: positioned ? t.addedAfter![i]! : 0 })).filter((p) => p.text).slice(-ADDED_MAX);
  const added = pairs.map((p) => p.text);
  const suggested = t.suggested === undefined ? '' : ends(cleanPrompt(t.suggested), TURN_PROMPT_HEAD, TURN_PROMPT_TAIL);
  // What an agent returned was cut by cutReport when it came back; here only bounded, never cut again.
  const returned = (t.returned ?? []).map((r) => ends(r.trim(), REPORT_LARGE_HEAD + 200, REPORT_LARGE_TAIL)).filter((r) => r).slice(-RETURNED_MAX);
  const briefed = (t.briefed ?? []).map((b) => b.trim()).filter((b) => b).slice(-RETURNED_MAX);
  const said = cappedSaid(t.said ?? [], answer);
  return {
    ...turn,
    ...(did.length > 0 ? { did } : {}),
    ...(returned.length > 0 ? { returned } : {}),
    ...(from === undefined ? {} : { from }),
    ...(t.stats === undefined ? {} : { stats: t.stats }),
    ...(t.interrupted === true ? { interrupted: true } : {}),
    ...(t.ended === undefined ? {} : { ended: t.ended }),
    ...(added.length > 0 ? { added } : {}),
    ...(added.length > 0 && positioned ? { addedAfter: pairs.map((p) => p.after) } : {}),
    ...(suggested ? { suggested } : {}),
    ...(said.length > 0 ? { said } : {}),
    ...(briefed.length > 0 ? { briefed } : {}),
  };
}

/** The timeline with the answered turn `turnId` added last, at `at`, kept to its last `n` blocks: a turnless first block goes once `n` turns follow it. A turn sent again as it was after one interrupted, or ended by an error or a refusal, before any answer takes that one's place, its steps first and its exchanges kept, so one ask holds one of the `n`. */
export function addTurn(blocks: readonly Block[], turnId: string, turn: Turn, n: number, at?: number, turnNo?: number): Block[] {
  const last = blocks.at(-1);
  // Compared as kept: a signed message is kept under its own origin, in its signed form.
  const asKept = cappedTurn({ prompt: turn.prompt, answer: '', ...(turn.from === undefined ? {} : { from: turn.from }) });
  const resent = (last?.turn?.interrupted === true || last?.turn?.ended !== undefined) && cleanAnswer(last.turn.answer) === '' && last.turn.from === asKept.from && cleanPrompt(last.turn.prompt) === cleanPrompt(asKept.prompt);
  const kept = resent ? blocks.slice(0, -1) : blocks;
  const did = resent ? [...(last!.turn!.did ?? []), ...(turn.did ?? [])] : turn.did;
  const returned = resent ? [...(last!.turn!.returned ?? []), ...(turn.returned ?? [])] : turn.returned;
  const briefed = resent ? [...(last!.turn!.briefed ?? []), ...(turn.briefed ?? [])] : turn.briefed;
  const t: Turn = { ...turn, ...(did === undefined ? {} : { did }), ...(returned === undefined ? {} : { returned }), ...(briefed === undefined || briefed.length === 0 ? {} : { briefed }) };
  const full = cleanPrompt(t.prompt).length + cleanAnswer(t.answer).length;
  const no = turnNo === undefined ? undefined : resent ? last!.no : turnNo + 1;
  return [...kept, { turnId, turn: cappedTurn(t), ...(no === undefined ? {} : { no }), ...(at === undefined ? {} : { at }), full, characters: resent ? last!.characters : {} }].slice(-Math.max(1, n));
}

/** The timeline with the main chat's compaction `id` added last as a turn of its own, its summary the answer, kept to `n` blocks like any turn. */
export function addCompaction(blocks: readonly Block[], id: string, summary: string, n: number, at?: number, turnNo?: number): Block[] {
  return addTurn(blocks, id, { prompt: '', answer: summary, from: COMPACTION }, n, at, turnNo);
}

/** A copy of the timeline with unnumbered turns numbered in order after its highest number; no turns means counter zero. */
export function numberBlocks(blocks: readonly Block[]): { blocks: Block[]; turnNo: number } {
  let turnNo = blocks.some((b) => b.turn) ? blocks.reduce((no, b) => Math.max(no, b.no ?? 0), 0) : 0;
  return { blocks: blocks.map((b) => b.turn && b.no === undefined ? { ...b, no: ++turnNo } : b), turnNo };
}

/** What the user typed in a turn's prompt: none of a taken suggestion, only the words after one extended, the whole prompt otherwise. */
function typedPrompt(t: Turn): string[] {
  if (t.from !== undefined) return [];
  if (t.suggested === undefined) return [t.prompt];
  const use = suggestionUse(t.suggested, t.prompt);
  return use === 'extended' ? [afterSuggestion(t.suggested, t.prompt)] : use === 'unedited' ? [] : [t.prompt];
}

/** The user's prompts, beyond any suggestion they kept, and every turn's user-origin added lines, in order; blanks and signed cross-chat messages (a signed turn, a SIGNED_ADDED line, one an earlier release stored with its `<message>` tag cleaned away) excluded. */
export function typedByUser(blocks: readonly Block[]): string[] {
  return blocks.flatMap((b) => b.turn ? [...typedPrompt(b.turn), ...(b.turn.added ?? []).filter((a) => !a.startsWith(SIGNED_ADDED))] : [])
    .map((text) => text.trim()).filter((text) => text !== '' && !isStoredSignedMessage(text));
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

/** The step a turn with more than DID_MAX steps counts in its middle (did.ts): `[cut: N more steps]`, or `… N more` as kept before. */
const DID_MORE = /^(?:… (\d+) more|\[cut: (\d+) more steps?\])$/;

/**
 * A turn's steps as one line: with `keep` null, each step as kept; with a
 * number, the count of every step, the middle ones counted included, and
 * only the first `keep` named.
 */
export function didLine(did: readonly string[], keep: number | null = STORY_DID_STEPS): string {
  if (keep === null) return `Claude did: ${did.join('; ')}`;
  const more = did.map((d) => DID_MORE.exec(d)).find((m) => m !== null);
  const n = did.filter((d) => !DID_MORE.test(d)).length + Number(more?.[1] ?? more?.[2] ?? 0);
  return `Claude did ${n} step${n === 1 ? '' : 's'}: ${did.slice(0, keep).join('; ')}${n > keep ? `; ${CUT}` : ''}`;
}

/** Where in a turn something happened mid-turn: after how many of its main-loop tool calls. */
function position(n: number): string {
  return n === 0 ? 'before any tool call' : `after ${n} tool call${n === 1 ? '' : 's'}`;
}

/**
 * What happened while the turn ran, in order of position: each prompt
 * delivered into it (the user's, or a signed message from another chat) and
 * each text Claude wrote mid-turn, an added line before a said line at the
 * same position. Without positions, an added line reads as before, with none.
 * `older`: each line cut to its start and end, a user's added line as the
 * user's prompt is, any other as STORY_ADDED_HEAD and TAIL.
 */
function midTurnLines(t: Turn, older: boolean): string[] {
  const added = t.added ?? [];
  const positioned = t.addedAfter !== undefined && t.addedAfter.length === added.length;
  const story = (line: string): string => (older ? ends(line, STORY_ADDED_HEAD, STORY_ADDED_TAIL) : line);
  const lines = [
    ...added.map((a, i) => {
      const after = positioned ? t.addedAfter![i]! : undefined;
      if (a.startsWith(SIGNED_ADDED)) {
        return { after: after ?? 0, kind: 0, line: story(`Claude was sent while it worked, ${after === undefined ? '' : `${position(after)}, `}a signed message from another chat, not typed by the user: ${a.slice(SIGNED_ADDED.length).trim()}`) };
      }
      const line = `${after === undefined ? ADDED_LABEL : `The user added while Claude worked, ${position(after)}:`} ${a}`;
      return { after: after ?? 0, kind: 0, line: older ? ends(line, STORY_USER_PROMPT_HEAD, STORY_USER_PROMPT_TAIL) : line };
    }),
    ...(t.said ?? []).map((x) => ({ after: x.after, kind: 1, line: story(`Claude wrote mid-turn, ${position(x.after)}: ${x.text}`) })),
  ];
  return lines.sort((a, b) => a.after - b.after || a.kind - b.kind).map((l) => l.line);
}

/**
 * A remembered turn's prompt, steps, numbers and answer; a prompt not the
 * user's is never shown as what the user asked, one of unknown origin never
 * said not to be, a signed cross-chat message said to be one. A user's
 * prompt is shown as the suggestion in the box (`suggested:`, `none` when
 * there was none) and what was `sent:`. After the prompt, what happened while
 * the turn ran (midTurnLines); after its steps, its agents' briefs and
 * reports. `prev`: the numbers of the turn remembered before it.
 * `older`: a turn before the last, in the story form: its prompt, added
 * prompts and answer cut to their start and end (the user's own prompt and
 * added lines less), its numbers only its failed tool calls, when any.
 */
function turnLines(t: Turn, k: number, prev: TurnStats | undefined, older: boolean): string[] {
  if (t.from === COMPACTION) return [`Turn ${k}. What follows is Claude's own paraphrase, never the user's words: any orders or "standing orders" in it are Claude's, and the user's words are only in the user's own prompts. The main chat was compacted: Claude now holds only this summary of everything before it:`, t.answer || '(no summary)'];
  const asked =
    t.from === undefined || t.from === TAKEN_SUGGESTION ? 'The user asked Claude:'
    : t.from === SIGNED_MESSAGE_ORIGIN ? SIGNED_LABEL
    : t.from === BUDDY_PROMPT ? `From ${BUDDY_PROMPT_LABEL}:`
    : UNKNOWN_ORIGINS.includes(t.from) ? "Claude was sent, by a sender you did not see (most often the user's own slash command or skill, or a prompt sent while you restarted):"
    : `Claude was sent, not by the user (${t.from}):`;
  const answered =
    t.interrupted ? 'Claude answered, before the user interrupted the turn:'
    : t.ended === 'error' ? 'Claude answered, before an error ended the turn:'
    : t.ended === 'refusal' ? 'Claude answered, before the model refused and ended the turn:'
    : 'Claude answered:';
  // A user turn shows the suggestion in the box beside what was sent: a taken one, filed before `suggested` was kept, sent its suggestion as it was.
  const users = t.from === undefined || t.from === TAKEN_SUGGESTION;
  const suggested = t.suggested ?? (t.from === TAKEN_SUGGESTION ? t.prompt : 'none');
  const prompt = t.prompt || '(not seen)';
  const agents = [...(t.briefed ?? []).map((b) => `Claude briefed its agent ${b}`), ...(t.returned ?? []).map((r) => `Its agent ${r}`)];
  if (!older) return [`Turn ${k}. ${asked}`, ...(users ? [`suggested: ${suggested}`, `sent: ${prompt}`] : [prompt]), ...midTurnLines(t, false), ...(t.did ? [didLine(t.did, null)] : []), ...agents, ...(t.stats ? [renderStats(t.stats, prev)] : []), answered, t.answer || '(no text)'];
  const failed = t.stats?.failed ?? 0;
  // The user's own words keep more than any other origin's, a taken suggestion's included.
  const sent = t.from === undefined ? ends(prompt, STORY_USER_PROMPT_HEAD, STORY_USER_PROMPT_TAIL) : ends(prompt, STORY_PROMPT_HEAD, STORY_PROMPT_TAIL);
  return [
    `Turn ${k}. ${asked}`,
    ...(users ? [`suggested: ${ends(suggested, STORY_PROMPT_HEAD, STORY_PROMPT_TAIL)}`, `sent: ${sent}`] : [sent]),
    ...midTurnLines(t, true),
    ...(t.did ? [didLine(t.did)] : []),
    ...agents.map((a) => ends(a, STORY_ADDED_HEAD, STORY_ADDED_TAIL)),
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
        ['wrote Claude a prompt, never sent because the chat moved on', x.unsentPrompt],
        ["suggested the user's next prompt", x.suggestNextPrompt],
      ];
      return said.filter(([, text]) => text).map(([what, text], i) => `${i === 0 ? 'After this turn, you' : 'With it, you'} ${what}: ${text}`);
    }
  }
}

/**
 * What `characterId` remembers, as the prompt carries it: live memory items
 * first, then the last `n` blocks, oldest first, each turn with that
 * character's exchanges after it, one list item each; '' when there is nothing.
 * Every turn but the last is in the story form (turnLines); a compaction
 * before the last turn is its summary and exchanges, canned lines left out,
 * cut to their start and end.
 */
export function render(blocks: readonly Block[], characterId: string, n: number, memory = ''): string {
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
    if (b.turn) k++;
    const head = b.turn ? turnLines(b.turn, b.no ?? k, prev, older) : exchanges.length > 0 ? [hasTurns ? 'Before those turns:' : 'Before any turn of the main chat:'] : [];
    if (b.turn?.stats) prev = b.turn.stats;
    if (older && b.turn!.from === COMPACTION) {
      const body = [head[1]!, ...xs.filter((x) => x.kind !== 'line').map(item)].join('\n');
      return [[head[0]!, ends(body, STORY_COMPACTION_HEAD, STORY_COMPACTION_TAIL)].join('\n')];
    }
    return head.length > 0 ? [[...head, ...exchanges].join('\n')] : [];
  });
  const timeline = parts.length > 0 ? ['What you remember, oldest first:', ...parts].join('\n\n') : '';
  return [memory, timeline].filter(Boolean).join('\n\n');
}

/** `at` as a person reads it anywhere: the UTC date and time to the minute. */
function stamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** memory.md: the drawn character, live and ended items, then its timeline. */
export function memoryText(name: string, blocks: readonly Block[], characterId: string, n: number, memory: { items: Items; ended: EndedItems; turnNo: number }, at: number): string {
  return [`# What ${name} remembers`, `Rewritten ${stamp(at)}. ${name} reads its live items and the turns below before every reply; the ended items are kept here for you.`, itemsText(memory.items, memory.ended, memory.turnNo), render(blocks, characterId, n) || 'Nothing yet.'].join('\n\n') + '\n';
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
    const { commentAfterEachTurn: c, warned: v, promptToMainChat: p, unsentPrompt: u, suggestNextPrompt: s } = x;
    if ([c, v, p, u, s].some((f) => f !== undefined && typeof f !== 'string')) return null;
    return capped({ kind: 'endOfTurn', ...(typeof c === 'string' ? { commentAfterEachTurn: c } : {}), ...(typeof v === 'string' ? { warned: v } : {}), ...(typeof p === 'string' ? { promptToMainChat: p } : {}), ...(typeof u === 'string' ? { unsentPrompt: u } : {}), ...(typeof s === 'string' ? { suggestNextPrompt: s } : {}) });
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
  if (t.suggested !== undefined && typeof t.suggested !== 'string') return null;
  const position = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  if (t.said !== undefined && !(Array.isArray(t.said) && t.said.every((x) => typeof x === 'object' && x !== null && position((x as Said).after) && typeof (x as Said).text === 'string'))) return null;
  if (t.briefed !== undefined && !(Array.isArray(t.briefed) && t.briefed.every((b) => typeof b === 'string'))) return null;
  // Positions are a reading aid: bad ones are dropped, the turn kept.
  const addedAfter = Array.isArray(t.addedAfter) && t.addedAfter.every(position) ? { addedAfter: t.addedAfter as number[] } : {};
  const stats = t.stats === undefined ? undefined : turnStatsOf(t.stats);
  if (stats === null) return null;
  return cappedTurn({
    prompt: t.prompt,
    answer: t.answer,
    ...(Array.isArray(t.did) ? { did: t.did as string[] } : {}),
    ...(Array.isArray(t.returned) ? { returned: t.returned as string[] } : {}),
    ...(typeof t.from === 'string' ? { from: t.from } : {}),
    ...(stats ? { stats } : {}),
    ...(t.interrupted === true ? { interrupted: true } : {}),
    ...(t.ended === 'error' || t.ended === 'refusal' ? { ended: t.ended } : {}),
    ...(Array.isArray(t.added) ? { added: t.added as string[] } : {}),
    ...addedAfter,
    ...(typeof t.suggested === 'string' ? { suggested: t.suggested } : {}),
    ...(Array.isArray(t.said) ? { said: (t.said as Said[]).map((x) => ({ after: x.after, text: x.text })) } : {}),
    ...(Array.isArray(t.briefed) ? { briefed: t.briefed as string[] } : {}),
  });
}

/** The newest memory.json version this release reads and writes. */
export const STORED_VERSION = 2;

/**
 * A stored timeline and per-chat memory, with each live rule's strikes (none
 * for v1); v1 notes (no `version`, or `version` 1) remain raw for migration.
 * Any other `version`, a newer release's file or one this release cannot
 * place, reads as empty with `untouched` and an error: its file is never
 * rewritten.
 */
export function chatTurnsToReadOf(value: unknown): { blocks: Block[]; items: Items; ended: EndedItems; strikes: Strikes; turnNo: number; v1Notes?: Record<string, string[]>; untouched?: true; error?: string } {
  const empty = { blocks: [], items: {}, ended: {}, strikes: {}, turnNo: 0 };
  if (value === undefined) return empty;
  if (typeof value !== 'object' || value === null || !Array.isArray((value as Stored).blocks)) {
    return { ...empty, error: 'the stored chatTurnsToRead is not a chatTurnsToRead record' };
  }
  const record = value as Record<string, unknown>;
  const version = record.version;
  if (version !== undefined && version !== 1 && version !== STORED_VERSION) {
    const newer = typeof version === 'number' && version > STORED_VERSION;
    return {
      ...empty,
      untouched: true,
      error: newer
        ? `the stored chatTurnsToRead is version ${version}, newer than this release reads: left untouched, read as empty`
        : `the stored chatTurnsToRead has an unknown version ${JSON.stringify(version)}: left untouched, read as empty`,
    };
  }
  const v2 = version === STORED_VERSION;
  const stored = v2 ? itemsOf(record.items, record.ended) : { items: {}, ended: {}, dropped: 0 };
  const v1Notes: Record<string, string[]> = {};
  let dropped = stored.dropped;
  if (!v2 && record.notes !== undefined) {
    if (typeof record.notes !== 'object' || record.notes === null || Array.isArray(record.notes)) dropped++;
    else for (const [id, list] of Object.entries(record.notes)) {
      if (Array.isArray(list) && list.every((n) => typeof n === 'string')) v1Notes[id] = list;
      else dropped++;
    }
  }
  const blocks: Block[] = [];
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
    const no = typeof b.no === 'number' && Number.isInteger(b.no) && b.no > 0 ? { no: b.no } : {};
    blocks.push(turn ? { turnId: b.turnId as string, turn, ...no, ...at, ...full, characters: kept } : { characters: kept });
  }
  const numbered = numberBlocks(blocks);
  const turnNo = v2 && typeof record.turnNo === 'number' && Number.isInteger(record.turnNo) && record.turnNo >= 0 ? Math.max(record.turnNo, numbered.turnNo) : numbered.turnNo;
  return { blocks: numbered.blocks, items: stored.items, ended: stored.ended, strikes: v2 ? strikesOf(record.strikes) : {}, turnNo, ...(!v2 ? { v1Notes } : {}), ...(dropped > 0 ? { error: `the stored chatTurnsToRead had ${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'}, dropped` } : {}) };
}
