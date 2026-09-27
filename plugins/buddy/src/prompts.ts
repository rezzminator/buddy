// The words sent to a model: a completion on quipModel, for /buddy questions
// and for the end-of-turn call, which writes the buddy's line and the prompt
// suggestion together. Each demands short lines.

export const ONE_LINE_RULE = 'Answer in ONE line, at most 25 words, in character. Do not use tools. Do not think out loud.';
export const QUESTION_MAX_TOKENS = 100;
/** The end-of-turn call's budget: a LINE and a NEXT, short. */
export const TURN_MAX_TOKENS = 120;
/** How long the end-of-turn call, its memory and settings reads included, may take before its line and suggestion are given up. */
export const TURN_DEADLINE_MS = 30_000;
/** How long past the buddy's own deadline a completion runs before the engine abandons it (`timeoutMs`): the deadline always ends it first, with one reason. */
export const REQUEST_MARGIN_MS = 5_000;

/**
 * The `timeoutMs` of a completion sent `elapsedMs` into a deadline of
 * `deadlineMs`: what is left of the deadline, plus the margin, so the buddy's
 * deadline decides and the request is abandoned the margin after it, however
 * late it was sent.
 */
export function requestTimeoutMs(deadlineMs: number, elapsedMs: number): number {
  return Math.max(0, deadlineMs - elapsedMs) + REQUEST_MARGIN_MS;
}
/** The least of a question's deadline a retry of an empty reply needs left. */
export const RETRY_MIN_MS = 10_000;
/** A question's completion that came back with no words is asked once more while RETRY_MIN_MS of its deadline is left: the model returned nothing, the question is still open. */
export function retriesEmpty(r: { isAnswered: boolean; reason?: string; text?: string }, leftMs: number): boolean {
  if (leftMs < RETRY_MIN_MS) return false;
  return r.isAnswered ? oneLine(r.text ?? '') === '' : r.reason === 'empty-reply';
}
/** How many of the main chat's latest turns a completion reads by default: the contextTurns option's default. */
export const TURN_WINDOW = 3;
/** The most of the main chat's latest turns a completion may read: the contextTurns option's ceiling. */
export const TURN_WINDOW_MAX = 10;
/** How much of each of those prompts a completion reads: its end. */
const TURN_PROMPT_CAP = 1500;
/** How much of each of those answers a completion reads: its end. */
const TURN_ANSWER_CAP = 3000;
const REPLY_CAP = 240;

/** The rendered memory before what is asked, and leave to refer back to it; '' without one. */
function recalled(memory: string): string {
  return memory ? `${memory}\nThat is what you and the user said to each other lately; you may refer back to it.\n\n` : '';
}

/**
 * Said right after the persona, wherever the character speaks: the persona is
 * the voice, this is what the voice is for.
 */
export const CHARACTER_RULE =
  'Become this character completely, in voice and in attitude; stay in it for every word. ' +
  'Say ONE thing that is actually useful and that both the user and the assistant in the recent turns have missed: ' +
  'a risk, a gap, a wrong assumption, or a better next step. ' +
  'The character decides HOW it is said, never WHAT is true. ' +
  'Never repeat what the chat already said.';

/** The system prompt of a completion: persona, the character rule and the one-line rule. */
export function oneLineSystem(persona: string): string {
  return `${persona}\n\n${CHARACTER_RULE}\n\n${ONE_LINE_RULE}`;
}

/** A completion's question, after the buddy's memory and the main chat's recent turns (`recentTurns`), when there are some. */
export function questionPrompt(question: string, memory = '', exchange = ''): string {
  return `${recalled(memory)}${exchange}The user asks you directly: ${question}`;
}

export type TurnSummary = { tools: string[]; failures: number; lastBash: string };

/** What the turn did: the tools it used, counted, its failures, its last shell command capped. */
function turnFacts(t: TurnSummary): string {
  const counts = new Map<string, number>();
  for (const tool of t.tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  const tools = [...counts].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(', ') || 'none';
  const bash = t.lastBash ? t.lastBash.slice(0, 120) : 'none';
  return `Tools used: ${tools}. Failures: ${t.failures}. Last shell command: ${bash}.`;
}

/** `text` whole when it fits `cap`, else its end, marked cut. */
function tail(text: string, cap: number): string {
  return text.length > cap ? `...${text.slice(text.length - cap)}` : text;
}

/** What the end-of-turn call writes: the buddy's line, the user's next prompt, or both. */
export type TurnWants = { line: boolean; next: boolean };

/** What an ended main-loop turn and the session look like to the end-of-turn call. */
export type TurnGate = { answered: boolean; hidden: boolean; interactive: boolean; bandSeen: boolean; quips: boolean; suggestions: boolean };

/**
 * What an ended main turn may ask the model for, before the line's cooldown:
 * nothing for a turn not answered, while hidden, or with nobody at the prompt;
 * a line only once the band has drawn in this session (a line nobody can see
 * is never paid for); a suggestion wherever the prompt box is.
 */
export function turnMay(g: TurnGate): TurnWants {
  const calls = g.answered && !g.hidden && g.interactive;
  return { line: g.quips && calls && g.bandSeen, next: g.suggestions && calls };
}

/** Why an ended main turn makes no call; `lineDue` false with quips allowed is the cooldown. */
export function skipReason(g: TurnGate): string {
  if (!g.answered) return 'not an answered turn';
  if (!g.interactive) return 'headless';
  if (g.hidden) return 'hidden';
  if (!g.quips && !g.suggestions) return 'quips and suggestions off';
  if (g.quips && !g.bandSeen && !g.suggestions) return 'band never drawn';
  return 'cooldown';
}

/**
 * The end-of-turn call's system prompt: the persona, the character rule when a
 * LINE is wanted, then the tagged lines to reply with, only those wanted. The persona voices the line and picks what
 * the suggestion nudges toward; the suggestion's words are the user's own.
 */
export function turnSystem(persona: string, wants: TurnWants): string {
  const lines: string[] = [];
  if (wants.line) lines.push('LINE: your own reaction to the turn, in character, one line, at most 20 words.');
  if (wants.next) {
    lines.push(
      "NEXT: the prompt the user is most likely to send Claude next, in the user's own words as they would type it into the prompt box: " +
        'not in character, no quotes, at most 15 words. Almost every turn leaves a next step: a check, a fix, a follow-up, the next piece, a commit. ' +
        'Write NEXT: NONE only when the work is plainly finished and nothing follows.',
    );
  }
  const rule = wants.line ? `${CHARACTER_RULE}\n\n` : '';
  return `${persona}\n\n${rule}A turn of the user's work with Claude just ended. Reply with exactly these lines and nothing else:\n${lines.join('\n')}\nDo not use tools. Do not think out loud.`;
}

/**
 * One main-thread turn: the prompt it began with and what Claude answered.
 * `from`, set when that prompt was not the user's: its origin (a peer, a task
 * notification, a plugin), or `unknown` when no submission of it was seen.
 */
export type Turn = { prompt: string; answer: string; from?: string };

/** Prompt origins that are the user's own: Enter at the terminal, a Remote Control message, an SDK host's turn. */
const USER_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk'];

/** Whether a prompt of origin `kind` (prompt.submit's `origin.kind`) is the user's own. */
export function isUserOrigin(kind: string): boolean {
  return USER_ORIGINS.includes(kind);
}

/** The most prompts, entered or started, the ledger keeps unmatched: past it the oldest go. */
const PROMPTS_KEPT = 10;

/**
 * The prompts given to the main chat, matched to the turns they start by their
 * text: `entered`, the prompts that entered (prompt.submit's result) and
 * started no turn yet, oldest first; `started`, the main turns begun
 * (turn.start), by id, with their text and whose it was (`seen` false until
 * its submission settles).
 */
export type PromptLedger = {
  entered: readonly { text: string; from?: string }[];
  started: readonly { turnId: string; text: string; from?: string; seen: boolean }[];
};
export const NO_PROMPTS: PromptLedger = { entered: [], started: [] };

/**
 * A prompt that entered the session, `origin` its origin's kind. One typed
 * over the running turn `turnId` waits for a turn of its own; one not the
 * user's with a `turnId` was delivered into that turn and starts none. A turn
 * already started with this text (its turn.start came first) takes its origin.
 */
export function submitPrompt(l: PromptLedger, text: string, origin: string, turnId?: string): PromptLedger {
  const user = isUserOrigin(origin);
  if (turnId !== undefined && !user) return l;
  const from = user ? undefined : origin;
  const i = l.started.findIndex((s) => !s.seen && s.text === text);
  if (i >= 0) return { ...l, started: l.started.map((s, k) => (k === i ? { ...s, from, seen: true } : s)) };
  return { ...l, entered: [...l.entered, { text, from }].slice(-PROMPTS_KEPT) };
}

/** The main turn `turnId` began with `text` (turn.start): it takes the oldest entered prompt of that text, and its origin. */
export function startPromptTurn(l: PromptLedger, turnId: string, text: string): PromptLedger {
  const i = l.entered.findIndex((p) => p.text === text);
  const turn = i >= 0 ? { turnId, text, from: l.entered[i]!.from, seen: true } : { turnId, text, seen: false };
  return { entered: l.entered.filter((_, k) => k !== i), started: [...l.started, turn].slice(-PROMPTS_KEPT) };
}

/**
 * The main turn `turnId` ended, in any way: the prompt it began with and,
 * when that was not the user's, its origin (`unknown` when its submission
 * was never seen), and the ledger without it.
 */
export function endPromptTurn(l: PromptLedger, turnId: string): { prompt: string; from?: string; ledger: PromptLedger } {
  const turn = l.started.find((s) => s.turnId === turnId);
  const ledger = { ...l, started: l.started.filter((s) => s.turnId !== turnId) };
  if (!turn) return { prompt: '', from: 'unknown', ledger };
  const from = turn.seen ? turn.from : 'unknown';
  return from === undefined ? { prompt: turn.text, ledger } : { prompt: turn.text, from, ledger };
}

/** A session end that leaves the process on a fresh conversation (`/clear`, a resume): the chat's window, its prompts and a pending line are the old one's. */
export function endsConversation(reason: string): boolean {
  return reason === 'clear' || reason === 'resume';
}

/** The window with `turn` added last, the oldest dropped past `size` turns (the contextTurns option); `turns` itself unchanged. */
export function pushTurn(turns: readonly Turn[], turn: Turn, size = TURN_WINDOW): Turn[] {
  return [...turns, turn].slice(-size);
}

/**
 * The main chat's recent turns, which a completion cannot see for itself:
 * oldest first, each prompt and answer keeping its end; '' for none.
 */
export function recentTurns(turns: readonly Turn[]): string {
  if (turns.length === 0) return '';
  const blocks = turns.map((t) => {
    // A prompt that was not the user's is never shown as what the user asked.
    const asked = t.from === undefined ? 'The user asked Claude:' : `Claude was sent, not by the user (${t.from}):`;
    return `${asked}\n${tail(t.prompt, TURN_PROMPT_CAP) || '(not seen)'}\n\nClaude answered:\n${tail(t.answer, TURN_ANSWER_CAP) || '(no text)'}\n\n`;
  });
  return `The main chat's last ${turns.length === 1 ? 'turn' : `${turns.length} turns`}, oldest first:\n\n${blocks.join('')}`;
}

/** The end-of-turn call's prompt: the buddy's memory, the main chat's recent turns, then what the turn did. */
export function turnPrompt(t: TurnSummary, turns: readonly Turn[], memory = ''): string {
  return `${recalled(memory)}${recentTurns(turns)}${turnFacts(t)}`;
}

const TAGGED = /^[\s\-*]*(line|next)\s*:\s*(.*)$/i;

/** The end-of-turn reply as its line and suggestion; an untagged reply is the line alone. */
export function parseTurnReply(reply: string): { line: string | null; next: string | null } {
  let line: string | undefined;
  let next: string | undefined;
  for (const raw of reply.split('\n')) {
    const m = TAGGED.exec(raw);
    if (!m) continue;
    if (m[1]!.toLowerCase() === 'line') line ??= m[2]!;
    else next ??= m[2]!;
  }
  if (line === undefined && next === undefined) return { line: oneLine(reply) || null, next: null };
  return { line: line === undefined ? null : oneLine(line) || null, next: next === undefined ? null : suggestionText(next) };
}

/** A reply as one bubble line: the first non-empty line, unquoted, capped. */
export function oneLine(reply: string): string {
  const line = reply.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const unquoted = line.replace(/^["'`]+|["'`]+$/g, '').trim();
  return unquoted.length > REPLY_CAP ? `${unquoted.slice(0, REPLY_CAP - 3)}...` : unquoted;
}

/** The longest prompt suggestion kept: past it, the reply is not a prompt someone would type. */
export const SUGGESTION_MAX_CHARS = 160;

/** A suggestion reply as the prompt it proposes: its first non-empty line, unquoted, one-spaced; null for none, NONE, or past the cap. */
export function suggestionText(reply: string): string | null {
  const line = reply.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const text = line.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
  if (text === '' || /^none[.!]*$/i.test(text) || text.length > SUGGESTION_MAX_CHARS) return null;
  return text;
}

/** A failed model call, shown in the bubble. */
export function lostThread(name: string, reason: string): string {
  return `${name} couldn't answer: ${reason}`;
}

/** An ask refused because the last one has no outcome yet, shown in the bubble and the reply. */
export function stillThinking(name: string): string {
  return `${name} is still thinking about your last question; ask again once it answers.`;
}
