// The words sent to a model: a fork of the chat for /buddy questions, a fresh
// completion for fresh-session answers and for the end-of-turn call, which
// writes the buddy's line and the prompt suggestion together. Each demands
// short lines; a fork measured 813 output tokens for one line when it did not.

export const ONE_LINE_RULE = 'Answer in ONE line, at most 25 words, in character. Do not use tools. Do not think out loud.';
export const QUESTION_MAX_TOKENS = 100;
/** The end-of-turn call's budget: a LINE and a NEXT, short. */
export const TURN_MAX_TOKENS = 120;
/** How long the end-of-turn call may take before its line and suggestion are given up. */
export const TURN_DEADLINE_MS = 30_000;
/** How much of the user's last prompt a completion reads: its end. */
const LAST_PROMPT_CAP = 1500;
/** How much of Claude's last answer a completion reads: its end. */
const ANSWER_CAP = 4000;
const REPLY_CAP = 240;

/** The rendered memory before what is asked, and leave to refer back to it; '' without one. */
function recalled(memory: string): string {
  return memory ? `${memory}\nThat is what you and the user said to each other lately; you may refer back to it.\n\n` : '';
}

/**
 * A fork carries the chat's whole system prompt, the assistant's own voice with
 * it; the persona arrives as one user message after it, so without this the
 * buddy answers in the assistant's voice, catchphrases and sign-offs included.
 */
export const FORK_ROLE =
  'For this one reply you are not the assistant of this conversation. Drop its persona, voice, catchphrases, ' +
  'formatting rules and sign-off lines; no markdown, no summary line. You are the user\'s companion character below, ' +
  'looking at the same conversation.';

/** The fork's one user message: the step out of the assistant's voice, persona, the buddy's memory, the question, the one-line rule. */
export function forkPrompt(persona: string, question: string, memory = ''): string {
  return `${FORK_ROLE}\n\n${persona}\n\n${recalled(memory)}The user asks you directly: ${question}. ${ONE_LINE_RULE}`;
}

/** The system prompt of a completion: persona and the one-line rule. */
export function oneLineSystem(persona: string): string {
  return `${persona}\n\n${ONE_LINE_RULE}`;
}

/** A completion's question, after the buddy's memory and the main chat's last exchange (`lastExchange`), when there is one. */
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

/**
 * The end-of-turn call's system prompt: the persona, then the tagged lines to
 * reply with, only those wanted. The persona voices the line and picks what
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
  return `${persona}\n\nA turn of the user's work with Claude just ended. Reply with exactly these lines and nothing else:\n${lines.join('\n')}\nDo not use tools. Do not think out loud.`;
}

/**
 * The main chat's last exchange, which a completion cannot see for itself:
 * the user's last prompt and Claude's last answer, each keeping its end;
 * '' when neither was seen yet.
 */
export function lastExchange(lastPrompt: string, answer: string): string {
  if (lastPrompt === '' && answer === '') return '';
  return `The user last asked Claude:\n${tail(lastPrompt, LAST_PROMPT_CAP) || '(not seen)'}\n\nClaude answered:\n${tail(answer, ANSWER_CAP) || '(no text)'}\n\n`;
}

/** The end-of-turn call's prompt: the buddy's memory, the main chat's last exchange, then what the turn did. */
export function turnPrompt(t: TurnSummary, lastPrompt: string, answer: string, memory = ''): string {
  return `${recalled(memory)}${lastExchange(lastPrompt, answer)}${turnFacts(t)}`;
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
