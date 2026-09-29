// The rounds: one text file per main-chat turn, unless the saveRounds option
// is off, in the chat's own folder beside its transcript (src/chatFolder.ts),
// holding in the order it happened everything that went into the buddy
// and everything that came out of it, from the turn's start to the next
// turn's start: the prompt the turn began with; each tool call the buddy
// heard, with its arguments and output; every log record, at any level; each
// line the bubble drew; the turn's end as the buddy filed it; and every model
// call, its system prompt, prompt and reply verbatim. Each chat's folder keeps
// every round, round-001.txt on: a new round takes the number after the
// highest there, so none is ever overwritten. No I/O: the adapter lists the
// folder and writes the text.

import { ADDED_LABEL, BUDDY_PROMPT, BUDDY_PROMPT_LABEL, TAKEN_SUGGESTION } from './chatTurnsToRead.ts';

/** How much of one tool argument or output a round keeps; the rest is counted. */
export const ROUND_VALUE_CAP = 500;

/** The turn's end as the buddy filed it. */
export type RoundTurn = { turnId: string; reason: string; prompt: string; answer: string; did: readonly string[]; from?: string; added?: readonly string[] };

/** One model call, literally: what was sent and what came back. */
export type RoundCall = {
  kind: 'endOfTurn' | 'question';
  at: number;
  settings: Record<string, unknown>;
  system: string;
  prompt: string;
  /** `answered`, `not answered: {reason}` or `threw: {error}`. */
  outcome: string;
  reply: string;
  ms: number;
  usage: Record<string, number>;
};

/** The file name of round `n`, from 1, at least three digits. */
export function roundSlot(n: number): string {
  return `round-${String(n).padStart(3, '0')}.txt`;
}

/** The file name a new round takes among `names` (the folder's entries): the number after the highest round there, so no round is overwritten. */
export function newRoundSlot(names: readonly string[]): string {
  let highest = 0;
  for (const name of names) {
    const m = /^round-(\d+)\.txt$/.exec(name);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return roundSlot(highest + 1);
}

const rule = (title: string) => `─── ${title} ───`;
const clock = (at: number) => new Date(at).toISOString().slice(11, 23);

/** A round's head: when it opened, the session, and the turn with the prompt it began with; or, with no turn, that it came before any turn this buddy saw. */
export function roundHead(at: number, sessionId: string, start: { turnId: string; prompt: string } | null): string {
  const when = new Date(at).toISOString();
  if (!start) return `═══ ROUND · ${when} · session ${sessionId} · before any turn this buddy saw ═══\n`;
  return [`═══ ROUND · ${when} · session ${sessionId} · turn ${start.turnId} ═══`, '', rule('IN · the prompt the turn began with'), unruled(start.prompt) || '(none)', ''].join('\n');
}

/** One moment of the timeline, one line: its time, then what happened. */
export function eventLine(at: number, text: string): string {
  return `${clock(at)}  ${text}\n`;
}

/** A value for the timeline: a string as it is, anything else as JSON; past ROUND_VALUE_CAP cut, the rest counted. */
export function capValue(v: unknown): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    s = String(v);
  }
  return s.length > ROUND_VALUE_CAP ? `${s.slice(0, ROUND_VALUE_CAP)}… (${s.length - ROUND_VALUE_CAP} more characters)` : s;
}

/** A value's text under its field: every line after the first indented, so no line of a tool's text starts a section or a moment of the round. */
const underField = (text: string) => text.replace(/\n/g, '\n        ');
/** A chat text set in a round file: a line of it that opens like a section rule (`─── `, `═══ `) is moved in two spaces, so it never reads as one. */
const unruled = (text: string) => text.replace(/^(?=(?:───|═══) )/gm, '  ');

/** A tool call the buddy heard: its tool, each argument, its output, what the buddy made of it (the step, the reaction). */
export function toolLines(at: number, call: { tool: string; args: Record<string, unknown>; output: string; failed: boolean; step: string | null; reaction: string | null; agentId?: string }): string {
  const who = call.agentId ? ` · subagent ${call.agentId}, not the main turn's` : '';
  const lines = [eventLine(at, `IN · tool call ${call.tool}${call.failed ? ' (failed)' : ''}${who}`)];
  for (const [k, v] of Object.entries(call.args)) if (k !== 'tool' && k !== 'tool_use_id' && k !== 'agentId') lines.push(`      ${k}: ${underField(capValue(v))}\n`);
  lines.push(`      output: ${underField(capValue(call.output)) || '(none)'}\n`);
  if (!call.agentId) lines.push(`      → step: ${call.step ?? '(none, left out)'} · reaction: ${call.reaction ?? 'none'}\n`);
  return lines.join('');
}

/** The turn's end as the buddy filed it into its memory: why it ended, the prompt, its origin, the prompts the user added while it ran, the steps, the answer. */
export function turnEndSection(at: number, turn: RoundTurn): string {
  const origin =
    turn.from === undefined ? 'the user'
    : turn.from === TAKEN_SUGGESTION ? "the user: the buddy's suggestion, unedited"
    : turn.from === BUDDY_PROMPT ? BUDDY_PROMPT_LABEL
    : `not the user: ${turn.from}`;
  return [
    '',
    rule(`IN · ${clock(at)} · the turn ended (${turn.reason}), as the buddy filed it`),
    `prompt (from ${origin}):`,
    unruled(turn.prompt) || '(none seen)',
    ...(turn.added ?? []).map((a) => `${ADDED_LABEL} ${unruled(a)}`),
    'steps (the Claude did: line):',
    turn.did.length > 0 ? turn.did.join('\n') : '(none)',
    "Claude's answer:",
    unruled(turn.answer) || '(no text)',
    '',
    '',
  ].join('\n');
}

/** The `n`th call of a round, verbatim: its settings, system prompt and prompt going in, its outcome and reply coming out. */
export function callSection(n: number, call: RoundCall): string {
  const kind = call.kind === 'endOfTurn' ? 'end-of-turn call' : '/buddy question';
  const settings = Object.entries(call.settings).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${String(v)}`).join(' · ');
  const usage = Object.entries(call.usage).map(([k, v]) => `${k} ${v}`).join(' · ');
  return [
    '',
    `═══ BUDDY CALL ${n} · ${kind} · sent ${clock(call.at)}${settings ? ` · ${settings}` : ''} ═══`,
    '',
    rule('IN: system'),
    call.system,
    '',
    rule('IN: prompt'),
    call.prompt,
    '',
    rule(`OUT: ${call.outcome} · ${call.ms} ms${usage ? ` · ${usage}` : ''}`),
    call.reply || '(no text)',
    '',
    '',
  ].join('\n');
}
