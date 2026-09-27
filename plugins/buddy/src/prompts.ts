// The words sent to a model: a fork of the chat for /buddy questions, a fresh
// completion for quips and fresh-session answers. Each demands one line; a
// fork measured 813 output tokens for one line when it did not.

export const ONE_LINE_RULE = 'Answer in ONE line, at most 25 words, in character. Do not use tools. Do not think out loud.';
export const QUESTION_MAX_TOKENS = 100;
export const QUIP_MAX_TOKENS = 60;
const REPLY_CAP = 240;

/** The rendered memory before what is asked, and leave to refer back to it; '' without one. */
function recalled(memory: string): string {
  return memory ? `${memory}\nThat is what you and the user said to each other lately; you may refer back to it.\n\n` : '';
}

/** The fork's one user message: persona, the buddy's memory, the question, the one-line rule. */
export function forkPrompt(persona: string, question: string, memory = ''): string {
  return `${persona}\n\n${recalled(memory)}The user asks you directly: ${question}. ${ONE_LINE_RULE}`;
}

/** The system prompt of a completion: persona and the one-line rule. */
export function oneLineSystem(persona: string): string {
  return `${persona}\n\n${ONE_LINE_RULE}`;
}

/** A completion's question, after the buddy's memory. */
export function questionPrompt(question: string, memory = ''): string {
  return `${recalled(memory)}The user asks you directly: ${question}`;
}

export type TurnSummary = { tools: string[]; failures: number; lastBash: string };

/** What a quip reacts to: the buddy's memory, then the tools the turn used, its failures, its last shell command. */
export function quipPrompt(t: TurnSummary, memory = ''): string {
  const counts = new Map<string, number>();
  for (const tool of t.tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  const tools = [...counts].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(', ');
  const bash = t.lastBash ? t.lastBash.slice(0, 120) : 'none';
  return `${recalled(memory)}The turn just ended. Tools used: ${tools}. Failures: ${t.failures}. Last shell command: ${bash}. React to it.`;
}

/** A reply as one bubble line: the first non-empty line, unquoted, capped. */
export function oneLine(reply: string): string {
  const line = reply.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const unquoted = line.replace(/^["'`]+|["'`]+$/g, '').trim();
  return unquoted.length > REPLY_CAP ? `${unquoted.slice(0, REPLY_CAP - 3)}...` : unquoted;
}

/** The longest prompt suggestion kept: past it, the reply is not a prompt someone would type. */
export const SUGGESTION_MAX_CHARS = 160;

/**
 * The fork's one user message for a prompt suggestion: the persona picks what
 * to nudge toward; the words are the user's own, as they would type them.
 */
export function suggestPrompt(persona: string): string {
  return (
    `${persona}\n\n` +
    'Looking at this conversation as that companion, write the prompt the user is most likely to send Claude next, ' +
    "in the user's own words, as they would type it into the prompt box: not in character, no quotes, no preamble, at most 15 words. " +
    'Almost every turn leaves a next step: a check, a fix, a follow-up, the next piece, a commit. ' +
    'Reply exactly NONE only when the work is plainly finished and nothing follows. Do not use tools. Do not think out loud.'
  );
}

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
