// The words sent to a model: a completion on model, for /buddy questions
// and for the end-of-turn call, which writes the buddy's `commentAfterEachTurn`
// and, as its second brain, what the user most deeply wants, a verdict on
// Claude's last move and the `suggestNextPrompt` that follows, and its own
// notes on the chat, rewritten every turn, in one reply.
// Each demands short lines.

import { actionOf, failureReason, type Action } from './did.ts';
import type { TurnStats } from './stats.ts';
import { BUDDY_PROMPT, NOTES_MAX, cleanNotes, cleanPrompt, ends } from './chatTurnsToRead.ts';

export const ONE_LINE_RULE = 'Answer in ONE line, at most 25 words, in character. Do not use tools. Do not think out loud.';
/** A question asking for a prompt gets one, on a line of its own the plugin puts in the prompt box. */
export const ASKED_PROMPT_RULE =
  'When the user asks you to write, suggest or put a prompt in their prompt box, add a second line: ' +
  'SUGGEST_NEXT_PROMPT: that prompt, as the user would type it to the assistant: it asks, instructs or decides, stating no fact the chat has not shown. Never write that line otherwise.';
/** A question's output cap. The model's thinking counts against it, so it is far above the one line the rules ask for: a cap that cut the thinking would cut the answer, or leave none. */
export const QUESTION_MAX_TOKENS = 2048;
/** The end-of-turn call's output cap, a COMMENT_AFTER_EACH_TURN and the second brain's four lines, as high as a question's for the same reason. */
export const TURN_MAX_TOKENS = 2048;
/** How long the end-of-turn call, its chatTurnsToRead and settings reads included, may take before what it writes is given up. */
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

/** The rendered chatTurnsToRead, which carries its own heading, set apart before what is asked; '' without one. */
function chatTurnsToReadBlock(chatTurnsToRead: string): string {
  return chatTurnsToRead ? `${chatTurnsToRead}\n\n` : '';
}

/**
 * How far the character's memory reaches, `turns` being the chatTurnsToRead
 * option: it says so, in character, when asked about anything older, and
 * never makes it up.
 */
export function memoryRule(turns: number): string {
  return (
    `Your memory is short: you remember only the main chat's last ${turns === 1 ? 'turn' : `${turns} turns`} and what you and the user said around them. ` +
    "Asked about the main chat's past beyond it, say in character that your short-term memory doesn't reach that far; never guess it or make it up."
  );
}

/**
 * Said right after the persona, wherever the character speaks: the persona is
 * the voice, this is what the voice is for.
 */
export const CHARACTER_RULE =
  'Become this character completely, in voice and in attitude; stay in it for every word. ' +
  'Say ONE thing that is actually useful and that both the user and the assistant in the recent turns have missed: ' +
  'a risk, a gap, a wrong assumption, or a better next step. When the chat shows nothing missed, say so, or react to what did happen: never invent a miss. ' +
  "State as fact only what the chat shows or what is generally true; ask a guess about this chat's own state (a file, a process, what someone did) as a question, or name the check that settles it. " +
  'The character decides HOW it is said, never WHAT is true. ' +
  'Never repeat what the chat already said, nor remake a point of your own (your earlier lines and notes are your views, not evidence) unless this turn brings new evidence for it.';

/** The system prompt of a /buddy question's completion: persona, the character rule, the memory rule for `turns` remembered, the one-line rule and the asked-prompt rule. */
export function oneLineSystem(persona: string, turns: number): string {
  return `${persona}\n\n${CHARACTER_RULE}\n\n${memoryRule(turns)}\n\n${ONE_LINE_RULE} ${ASKED_PROMPT_RULE}`;
}

/** A completion's question, after what the buddy remembers (its chatTurnsToRead, rendered), when it remembers anything. */
export function questionPrompt(question: string, chatTurnsToRead = ''): string {
  return `${chatTurnsToReadBlock(chatTurnsToRead)}The user asks you directly: ${question}`;
}

/** A main turn's tally so far: its tools, its failures, its last shell command, and its steps for the chatTurnsToRead (actionOf). */
export type TurnSummary = { tools: string[]; failures: number; lastBash: string; actions: Action[] };

/** How much of the last shell command the fallback tally keeps from its start and from its end, where a pipeline's filter sits. */
export const LAST_BASH_HEAD = 240;
export const LAST_BASH_TAIL = 120;

/** What the turn did: the tools it used, counted, its failures, its last shell command's start and end. */
function turnFacts(t: TurnSummary): string {
  const counts = new Map<string, number>();
  for (const tool of t.tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  const tools = [...counts].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(', ') || 'none';
  const bash = t.lastBash ? ends(t.lastBash.replace(/\s+/g, ' ').trim(), LAST_BASH_HEAD, LAST_BASH_TAIL) : 'none';
  return `Tools used: ${tools}. Failures: ${t.failures}. Last shell command: ${bash}.`;
}

/** What the end-of-turn call writes: commentAfterEachTurn, the second brain with its suggestNextPrompt, the prompt the buddy sends the main chat itself, or any of them together. */
export type TurnWants = { commentAfterEachTurn: boolean; suggestNextPrompt: boolean; promptToMainChat: boolean };

/** What an ended main-loop turn and the session look like to the end-of-turn call; `mainChatPromptArmed`: a prompt of the user's entered since the buddy last prompted the main chat. */
export type TurnGate = { answered: boolean; hidden: boolean; interactive: boolean; bandSeen: boolean; commentAfterEachTurn: boolean; suggestNextPrompt: boolean; promptToMainChat: boolean; mainChatPromptArmed: boolean };

/**
 * What an ended main turn may ask the model for, before secondsBetweenComments:
 * nothing for a turn not answered, while hidden, or with nobody at the prompt;
 * commentAfterEachTurn only once the band has drawn in this session (one nobody
 * can see is never paid for); suggestNextPrompt wherever the prompt box is;
 * promptToMainChat only while armed, so at most one per prompt of the user's,
 * and never from the turn the buddy's own prompt began.
 */
export function turnMay(g: TurnGate): TurnWants {
  const calls = g.answered && !g.hidden && g.interactive;
  return { commentAfterEachTurn: g.commentAfterEachTurn && calls && g.bandSeen, suggestNextPrompt: g.suggestNextPrompt && calls, promptToMainChat: g.promptToMainChat && calls && g.mainChatPromptArmed };
}

/** Why an ended main turn makes no call; `commentAfterEachTurnDue` false with commentAfterEachTurn allowed is secondsBetweenComments. */
export function skipReason(g: TurnGate): string {
  if (!g.answered) return 'not an answered turn';
  if (!g.interactive) return 'headless';
  if (g.hidden) return 'hidden';
  if (!g.commentAfterEachTurn && !g.suggestNextPrompt) return g.promptToMainChat ? 'promptToMainChat unarmed until the user prompts' : 'commentAfterEachTurn and suggestNextPrompt off';
  if (g.commentAfterEachTurn && !g.bandSeen && !g.suggestNextPrompt) return 'band never drawn';
  return 'secondsBetweenComments';
}

/** The second brain's judgement of Claude's last move: the proper way, the fast or easy way that costs later, or against what the user wants. */
export const VERDICTS = ['RIGHT', 'SHORTCUT', 'WRONG'] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * The buddy's own memory, asked for at every turn's end: its whole set of
 * notes, rewritten, one MEMORY line each; its notes so far lead what it
 * remembers (renderNotes).
 */
export const MEMORY_LINE =
  `MEMORY: one note of your own on this chat, one sentence, each on a line of its own shaped MEMORY: kind: note, never a list under one MEMORY line. Write up to ${NOTES_MAX} MEMORY lines: your whole memory, rewritten every turn. The kinds: ` +
  "rule: an instruction or decision of the user's that still binds (a stop, a wait, a never, an only, a way they want things done), in their words, kept until they lift it or it is met; " +
  'open: what the user asked for that is still unfinished or unproven; ' +
  'fact: what the chat showed done, found or decided; ' +
  'doubt: your own suspicion, not checked: drop it once a turn checks it or the user decides otherwise, and never state it anywhere as fact. ' +
  "Rules first, then open, fact, doubt; past the limit, drop doubts first. Copy a note word for word unless a turn in view changes it; a user's rule beats any doubt of yours. " +
  'Your notes so far lead what you remember. Write MEMORY: NONE only to forget them all.';

/** The longest DESIRE kept and carried to the next turn's call: past it, it is not one plain aim. */
export const DESIRE_MAX_CHARS = 160;

/**
 * The end-of-turn call's system prompt, the character's prompt and the
 * suggestion's combined as the options ask: the persona, the character rule,
 * then the tagged lines wanted, in one reply. COMMENT_AFTER_EACH_TURN is the
 * buddy's own reaction, written after the verdict when both are wanted. With
 * suggestNextPrompt, the second brain: DESIRE, what
 * the user most deeply wants (`desire`, the one named at the last turn's end,
 * kept unless the chat shows it changed, so it holds from turn to turn);
 * VERDICT on Claude's last move against it; WHY, in character, screamed for
 * WRONG; and SUGGEST_NEXT_PROMPT, following the verdict, as the user would
 * type it: an ask, an instruction or a decision, never the user's report.
 * PROMPT_TO_MAIN_CHAT, with promptToMainChat, before the suggestion: a prompt
 * the buddy sends Claude itself; it brings the judgement with it, and with
 * both the suggestion is NONE after one.
 * MEMORY last, always: the buddy's own notes, rewritten.
 */
export function turnSystem(persona: string, wants: TurnWants, desire: string | null = null): string {
  // The judgement first, so the character's comment is written knowing it; the suggestion last, following the verdict.
  const lines: string[] = [];
  const judges = wants.suggestNextPrompt || wants.promptToMainChat;
  if (judges) {
    lines.push(
      'DESIRE: what the user most deeply wants from this chat, beneath the words of this turn: the outcome they are really after, in plain words, at most 15 words.',
      "VERDICT: RIGHT, SHORTCUT or WRONG, judging Claude's last move (what it did, what it claimed, what it proposes next) against DESIRE. " +
        'RIGHT: it serves the desire, the proper way. ' +
        'SHORTCUT: the fast or easy way that costs later: a skipped check, a symptom patched instead of its cause, a guess where reading was possible, "done" claimed without evidence. ' +
        'WRONG: it works against the desire: the wrong problem, a destructive or irreversible step, a false claim, a drift away from what was asked. ' +
        "Judge how Claude carried out the ask, never the ask itself: doing what the user ordered, or what your own suggestion they sent asked, the proper way, is RIGHT; a step Claude only proposes, awaiting the user's go, is not taken yet.",
      'WHY: the concrete reason for the verdict, naming the thing (a file, a claim, a step), in character, at most 20 words. For WRONG, scream it, as loud as your character gets.',
    );
  }
  if (wants.commentAfterEachTurn) {
    lines.push(`COMMENT_AFTER_EACH_TURN: your own reaction to the turn, in character, one line, at most 20 words${judges ? ', knowing your verdict, never repeating WHY' : ''}.`);
  }
  if (wants.promptToMainChat) {
    lines.push(
      'PROMPT_TO_MAIN_CHAT: a prompt you send Claude yourself, right now, before the user reads on. ' +
        "Send one only on evidence inside this turn that the user's own ask is unmet or unproven: a step marked failed, or failed test runs, that the answer passes over or contradicts (a step marked failed ended in an error, so a result the answer draws from it is unproven, unless the error was the point, such as a crash reproduced or a test watched failing); " +
        'a conclusion the answer states (done, installed, verified, none left, all pass) that rests on less than it names, such as a check of some of the items or a change made in one of the places; ' +
        'an instruction in the ask (a stop, a condition, an order) Claude did not follow; a part of the ask the answer never addresses. ' +
        'Your own doubts are never a reason: a better method, a risk that might bite, a hypothesis to test, a tidy-up, a gap Claude named while leaving its conclusion open: those' +
        (wants.suggestNextPrompt ? ' go in SUGGEST_NEXT_PROMPT. ' : ' never go here. ') +
        "Plain words, not in character, at most 40 words: name the evidence, then the one fix or check it needs; it reaches Claude as yours, never as the user's. " +
        'Write PROMPT_TO_MAIN_CHAT: NONE otherwise.',
    );
  }
  if (wants.suggestNextPrompt) {
    lines.push(
      'SUGGEST_NEXT_PROMPT: the prompt the user should send Claude next, as they would type it into the prompt box: not in character, no quotes, at most 20 words. ' +
        "Safety first: never suggest searching for, printing, copying or checking a secret (a password, token or key), which puts its value in the chat; a deletion is a prompt of its own, naming exactly what it deletes, never bundled with other work. " +
        'It asks, instructs or decides, and every fact in it is already in the chat: the user may send it with one key, unread, so it never reports what the user did, ran, saw or saved. ' +
        "When the next step is the user's own (a key to make, a check only they can run), suggest what they would ask Claude about it. " +
        'After RIGHT, say yes and move to the next step; after SHORTCUT, ask for the proper way; after WRONG, stop Claude and name what to do instead. ' +
        'Never ask whether work Claude left running (a background command or agent, a push, a review) has finished: it reports back by itself; while Claude waits on it, suggest only a decision the user owes. ' +
        'Write SUGGEST_NEXT_PROMPT: NONE when the work is finished, or waiting on such a report with nothing for the user to decide.' +
        (wants.promptToMainChat ? ' After a PROMPT_TO_MAIN_CHAT of yours, write SUGGEST_NEXT_PROMPT: NONE: Claude is about to act on it.' : ''),
    );
  }
  lines.push(MEMORY_LINE);
  const brain = judges
    ? "You are also the user's second brain: you watch the work with Claude and judge it, a second pair of eyes on every decision.\n" +
      (desire ? `At the last turn's end you named the user's deepest desire: ${desire}\nKeep it while the user's work still serves it; when the user turns to other work, name what that work is for.\n` : '')
    : '';
  return `${persona}\n\n${CHARACTER_RULE}\n\n${brain}A turn of the user's work with Claude just ended. Reply with exactly these lines and nothing else:\n${lines.join('\n')}\nDo not use tools. Do not think out loud.`;
}

/**
 * One main-thread turn: the prompt it began with, what Claude did (one line
 * per step, didOf; absent when it used no tool), and what Claude answered.
 * `from`, set when that prompt was not known to be the user's: its origin (a
 * peer, a task notification, a plugin), `unclassified` when the engine could
 * not place it, or `unknown` when no submission of it was seen. `stats`: its
 * numbers (src/stats.ts), counted as it ran; absent for a compaction, or a
 * turn remembered before they were kept. `interrupted`: the user interrupted
 * the turn, its answer what Claude said before that. `ended`: an API error or
 * a refusal ended it, its answer what Claude said before that. `added`: the prompts the
 * user typed while it ran that Claude Code delivered into it, oldest first.
 */
/** How a turn that was not answered or interrupted ended (Claude Code's `turn.complete` reasons). */
export type TurnCut = 'error' | 'refusal';
export type Turn = { prompt: string; answer: string; did?: string[]; from?: string; stats?: TurnStats; interrupted?: true; ended?: TurnCut; added?: string[] };

/** Prompt origins that are the user's own: Enter at the terminal, a Remote Control message, an SDK host's turn, the session owner's Slack ping, a follow-up to the user's own action. */
const USER_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk', 'slack-ping', 'auto-continuation'];

/** Whether a prompt of origin `kind` (prompt.submit's `origin.kind`) is the user's own. */
export function isUserOrigin(kind: string): boolean {
  return USER_ORIGINS.includes(kind);
}

/** The most prompts, entered or started, the ledger keeps unmatched: past it the oldest go. */
const PROMPTS_KEPT = 10;

/**
 * The prompts given to the main chat, matched to the turns they start by their
 * text: `entered`, the prompts that entered (prompt.submit's result) and
 * started no turn yet, oldest first, `over` the running turn one was typed
 * over; `started`, the main turns begun (turn.start), by id, with their text
 * and whose it was (`seen` false until its submission settles; `queued` when
 * it took a waiting prompt; `added`, the prompts delivered into it).
 */
export type PromptLedger = {
  entered: readonly { text: string; from?: string; over?: string }[];
  started: readonly { turnId: string; text: string; from?: string; seen: boolean; queued?: boolean; added?: readonly string[] }[];
};
export const NO_PROMPTS: PromptLedger = { entered: [], started: [] };

/**
 * A prompt that entered the session, `origin` its origin's kind. One typed
 * over the running turn `turnId` waits, recording that turn: delivered into
 * it at its next request (deliverPrompts), or else starting a turn of its
 * own; it never matches that turn. One not the user's with a `turnId` was delivered into
 * that turn and starts none. A turn already started with this text (its
 * turn.start came first) takes its origin; so does one that took a waiting
 * prompt of the same text when this one arrives idle, since an idle prompt's
 * turn starts inside its own submission: the waiting one started no turn.
 */
export function submitPrompt(l: PromptLedger, text: string, origin: string, turnId?: string): PromptLedger {
  const user = isUserOrigin(origin);
  if (turnId !== undefined && !user) return l;
  const from = user ? undefined : origin;
  const i = l.started.findIndex((s) => s.turnId !== turnId && !s.seen && s.text === text);
  const j = i >= 0 || turnId !== undefined ? i : l.started.findLastIndex((s) => s.queued === true && s.text === text);
  if (j >= 0) return { ...l, started: l.started.map((s, k) => (k === j ? { turnId: s.turnId, text: s.text, from, seen: true, ...(s.added ? { added: s.added } : {}) } : s)) };
  return { ...l, entered: [...l.entered, { text, from, ...(turnId === undefined ? {} : { over: turnId }) }].slice(-PROMPTS_KEPT) };
}

/**
 * The main turn `turnId` is about to send a model request (turn.step), and
 * Claude Code delivers the prompts typed over it into that request: each
 * entered prompt `over` it joins that turn's `added`, in order. With no
 * started entry for that turn they stay waiting.
 */
export function deliverPrompts(l: PromptLedger, turnId: string): PromptLedger {
  const i = l.started.findIndex((s) => s.turnId === turnId);
  const moved = l.entered.filter((p) => p.over === turnId).map((p) => p.text);
  if (i < 0 || moved.length === 0) return l;
  return {
    entered: l.entered.filter((p) => p.over !== turnId),
    started: l.started.map((s, k) => (k === i ? { ...s, added: [...(s.added ?? []), ...moved] } : s)),
  };
}

/**
 * The main turn `turnId` began with `text` (turn.start): it takes the oldest
 * entered prompt of that text, and its origin. Every prompt entered before
 * that one, or all when none matches, started no turn (delivered into an
 * earlier one unseen): dropped, never handed to a later turn.
 */
export function startPromptTurn(l: PromptLedger, turnId: string, text: string): PromptLedger {
  const i = l.entered.findIndex((p) => p.text === text);
  const turn = i >= 0 ? { turnId, text, from: l.entered[i]!.from, seen: true, queued: true } : { turnId, text, seen: false };
  return { entered: i >= 0 ? l.entered.slice(i + 1) : [], started: [...l.started, turn].slice(-PROMPTS_KEPT) };
}

/**
 * The main turn `turnId` ended, in any way: the prompt it began with and,
 * when that was not the user's, its origin (`unknown` when its submission
 * was never seen), the prompts delivered into it (`added`, none left out),
 * and the ledger without it.
 */
export function endPromptTurn(l: PromptLedger, turnId: string): { prompt: string; from?: string; added?: string[]; ledger: PromptLedger } {
  const turn = l.started.find((s) => s.turnId === turnId);
  const ledger = { ...l, started: l.started.filter((s) => s.turnId !== turnId) };
  if (!turn) return { prompt: '', from: 'unknown', ledger };
  const from = turn.seen ? turn.from : 'unknown';
  const added = turn.added && turn.added.length > 0 ? { added: [...turn.added] } : {};
  return from === undefined ? { prompt: turn.text, ...added, ledger } : { prompt: turn.text, from, ...added, ledger };
}

/** A transcript row a turn is read back from: `$.session.messages()`'s rows, an assistant row's tool calls with their outcome. */
export type MessageRow = { role: string; text: string; toolUses?: readonly { tool: string; input: Record<string, unknown>; text?: string; isError?: true }[]; toolResults?: readonly unknown[] };

/** A user row the engine files for a local command's output: never a prompt. The rows carry no mark of an injected message, so it is told by its markup. */
const LOCAL_COMMAND_OUTPUT = /^\s*<local-command-(?:caveat|stdout|stderr)>/;

/**
 * A turn read back from the transcript when the ledger no longer holds it (a
 * plugin hot reload empties it, and the buddy saw none of the turn's tool
 * calls before it): the prompt, the text of the last user row that is neither
 * a tool result nor a local command's output and says something once its
 * markup goes, '' when no row is one; and the steps of every tool call the
 * assistant rows after it hold, a failed one with why.
 */
export function lostTurnOf(rows: readonly MessageRow[]): { prompt: string; steps: Action[] } {
  const i = rows.findLastIndex((r) => r.role === 'user' && (r.toolResults?.length ?? 0) === 0 && !LOCAL_COMMAND_OUTPUT.test(r.text) && cleanPrompt(r.text) !== '');
  if (i < 0) return { prompt: '', steps: [] };
  const steps = rows
    .slice(i + 1)
    .filter((r) => r.role === 'assistant')
    .flatMap((r) => r.toolUses ?? [])
    .map((u) => actionOf({ ...u.input, tool: u.tool }, u.isError ? { kind: 'failed', reason: failureReason(u.text ?? '') } : null))
    .filter((a): a is Action => a !== null);
  return { prompt: rows[i]!.text, steps };
}

/** A session end that leaves the process on a fresh conversation (`/clear`, a resume): the chat's chatTurnsToRead turns, its prompts and a pending commentAfterEachTurn are the old one's. */
export function endsConversation(reason: string): boolean {
  return reason === 'clear' || reason === 'resume';
}

/**
 * What Claude reads beside a prompt that is the buddy's suggestion, sent
 * unedited (prompt.submit's `context`, never shown to the user): the user
 * chose it, but its claims are the buddy's.
 */
export const TAKEN_SUGGESTION_CONTEXT =
  "This prompt is the buddy's suggestion, a plugin's guess at the user's next prompt, sent by the user unedited. " +
  "Any claim in it about what the user did, ran, saw or saved is the buddy's guess, not the user's report: check it before acting on it.";

/**
 * What Claude reads beside the buddy's own prompt (promptToMainChat), attached
 * by the buddy's prompt.submit hook: whose it is, and how to take it.
 */
export const BUDDY_PROMPT_CONTEXT =
  'This prompt was sent by the buddy plugin, not by the user: a second model that watches this chat and judged your last turn. ' +
  "The user did not write it and may not have read it. Treat it as a reviewer's note: check what it claims, act on what holds up, and say plainly what does not.";

/** The origin a prompt is filed under: this plugin's own (`self`, its manifest name) is BUDDY_PROMPT; any other goes by its kind, `unclassified` when the engine left it out. */
export function originOf(origin: { kind: string; name?: string } | undefined, self: string): string {
  if (origin === undefined) return 'unclassified';
  return origin.kind === 'plugin' && origin.name === self ? BUDDY_PROMPT : origin.kind;
}

/**
 * Whether a submitted prompt is the buddy's own (promptToMainChat's): its
 * origin names this plugin `self`, or, since the engine may hand a plugin's
 * own hook its submission with no origin, it is the text the buddy just sent
 * (`pending`, compared one-spaced) and not of a user's origin.
 */
export function isOwnPrompt(origin: { kind: string; name?: string } | undefined, self: string, text: string, pending: string | undefined): boolean {
  if (originOf(origin, self) === BUDDY_PROMPT) return true;
  const oneSpaced = (s: string): string => s.replace(/\s+/g, ' ').trim();
  return pending !== undefined && !isUserOrigin(origin?.kind ?? 'unclassified') && oneSpaced(text) === oneSpaced(pending);
}

/** The end-of-turn prompt's last line when the memory holds the turn just ended. */
export const JUST_ENDED = 'The turn that just ended is the last one above.';

/**
 * The end-of-turn call's prompt: what the buddy remembers (its chatTurnsToRead,
 * rendered). When it holds the turn just ended (`holdsTurn`, its last, with
 * what Claude did and its numbers), a pointer to it; else, its memory missing
 * that turn, what the turn did, counted here.
 */
export function turnPrompt(t: TurnSummary, chatTurnsToRead = '', holdsTurn = false): string {
  if (holdsTurn && chatTurnsToRead) return `${chatTurnsToReadBlock(chatTurnsToRead)}${JUST_ENDED}`;
  return `${chatTurnsToReadBlock(chatTurnsToRead)}In the turn that just ended: ${turnFacts(t)}`;
}

const TAGGED = /^[\s\-*]*(comment_after_each_turn|suggest_next_prompt|prompt_to_main_chat|desire|verdict|why|memory)\s*:\s*(.*)$/i;

/** A reply's tagged lines, by lowercased tag, the first of each; untagged lines are left out. */
function taggedLines(reply: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const raw of reply.split('\n')) {
    const m = TAGGED.exec(raw);
    if (m && !tags.has(m[1]!.toLowerCase())) tags.set(m[1]!.toLowerCase(), m[2]!);
  }
  return tags;
}

/** The end-of-turn reply, each part or null: a VERDICT not one of VERDICTS, a DESIRE past DESIRE_MAX_CHARS, or an empty line is none; SUGGEST_NEXT_PROMPT as suggestNextPromptText reads it, PROMPT_TO_MAIN_CHAT too, up to PROMPT_TO_MAIN_CHAT_MAX_CHARS. */
export type TurnReply = {
  commentAfterEachTurn: string | null;
  desire: string | null;
  verdict: Verdict | null;
  why: string | null;
  suggestNextPrompt: string | null;
  /** The prompt the buddy sends the main chat itself. */
  promptToMainChat: string | null;
  /** The buddy's notes, rewritten (cleanNotes); [] for MEMORY: NONE; null when the reply wrote no MEMORY line, which keeps the notes it had. */
  memory: string[] | null;
};

/**
 * Every MEMORY line of a reply, in order, and the lines listed under a bare
 * MEMORY line up to the next tagged line: [] only when NONE is said and no
 * note is; null when there is no note and no NONE, so a reply that slipped out
 * of the line shape never forgets the notes.
 */
function memoryLines(reply: string): string[] | null {
  const notes: string[] = [];
  let listing = false;
  let forget = false;
  for (const raw of reply.split('\n')) {
    const m = TAGGED.exec(raw);
    if (m) {
      const isMemory = m[1]!.toLowerCase() === 'memory';
      const text = m[2]!.trim();
      listing = isMemory && text === '';
      if (isMemory && /^none[.!]*$/i.test(text)) forget = true;
      else if (isMemory && text !== '') notes.push(text);
    } else if (listing && raw.trim() !== '') notes.push(raw);
  }
  const kept = cleanNotes(notes);
  return kept.length > 0 ? kept : forget ? [] : null;
}

/** The end-of-turn reply by its tagged lines, in any order and case, bullets tolerated; an untagged reply is the commentAfterEachTurn alone. */
export function parseTurnReply(reply: string): TurnReply {
  const tags = taggedLines(reply);
  if (tags.size === 0) return { commentAfterEachTurn: oneLine(reply) || null, desire: null, verdict: null, why: null, suggestNextPrompt: null, promptToMainChat: null, memory: null };
  const line = (tag: string) => oneLine(tags.get(tag) ?? '') || null;
  const desire = line('desire');
  const word = /^[A-Za-z]+/.exec(line('verdict') ?? '')?.[0]?.toUpperCase();
  const next = tags.get('suggest_next_prompt');
  const toMainChat = tags.get('prompt_to_main_chat');
  return {
    commentAfterEachTurn: line('comment_after_each_turn'),
    desire: desire !== null && desire.length <= DESIRE_MAX_CHARS ? desire : null,
    verdict: VERDICTS.find((v) => v === word) ?? null,
    why: line('why'),
    suggestNextPrompt: next === undefined ? null : suggestNextPromptText(next),
    promptToMainChat: toMainChat === undefined ? null : suggestNextPromptText(toMainChat, PROMPT_TO_MAIN_CHAT_MAX_CHARS),
    memory: memoryLines(reply),
  };
}

/** The longest prompt a question's answer puts in the prompt box: asked for, it may be longer than a guessed one. */
export const ASKED_PROMPT_MAX_CHARS = 600;

/** A question's reply as its answer and the prompt it was asked for: the untagged text the answer, one line; a SUGGEST_NEXT_PROMPT line the prompt, null when there is none and `tooLong` when it passed ASKED_PROMPT_MAX_CHARS. */
export function parseAskReply(reply: string): { answer: string; prompt: string | null; tooLong: boolean } {
  const rest: string[] = [];
  let tagged: string | undefined;
  for (const raw of reply.split('\n')) {
    const m = TAGGED.exec(raw);
    if (m && m[1]!.toLowerCase() === 'suggest_next_prompt') tagged ??= m[2]!;
    else rest.push(raw);
  }
  const prompt = tagged === undefined ? null : suggestNextPromptText(tagged, ASKED_PROMPT_MAX_CHARS);
  return { answer: oneLine(rest.join('\n')), prompt, tooLong: tagged !== undefined && prompt === null && suggestNextPromptText(tagged, Infinity) !== null };
}

/** A reply as one bubble line: the first non-empty line, unquoted, whole: what the buddy says is never cut. */
export function oneLine(reply: string): string {
  const line = reply.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line.replace(/^["'`]+|["'`]+$/g, '').trim();
}

/** The longest PROMPT_TO_MAIN_CHAT kept: past it, it is not a short note to Claude. */
export const PROMPT_TO_MAIN_CHAT_MAX_CHARS = 400;

/** The longest suggestNextPrompt kept: past it, the reply is not a prompt someone would type. */
export const SUGGEST_NEXT_PROMPT_MAX_CHARS = 200;

/** A suggestNextPrompt reply as the prompt it proposes: its first non-empty line, unquoted, one-spaced; null for none, NONE, or past `max`. */
export function suggestNextPromptText(reply: string, max = SUGGEST_NEXT_PROMPT_MAX_CHARS): string | null {
  const line = reply.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const text = line.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
  if (text === '' || /^none[.!]*$/i.test(text) || text.length > max) return null;
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
