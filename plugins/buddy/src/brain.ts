import type { Character, LineEvent, Pose } from './character.ts';
import { pickLine, poolFor } from './lines.ts';
import { initialMotion, maxX, periodMs, tickMotion, type MotionState } from './motion.ts';
import { CONFETTI_MS, CONFETTI_TICK_MS } from './particles.ts';
import { lostThread, stillThinking, type TurnSummary } from './prompts.ts';
import { REACTIONS, classifyToolCall, type Outcome, type ToolCall } from './reactions.ts';
import { buildScene, type Scene } from './scene.ts';

// The buddy's state and every transition, with no I/O: the adapter feeds it
// events and the clock, and draws what `sceneOf` returns. Time is the clock's,
// advanced by one period per tick, so a test drives it exactly.

export const BUBBLE_MS = 6000;
export const ANSWER_MS = 15000;
export const ERROR_MS = 10000;
/** One deadline per /buddy question, from when it is asked: every model call it makes shares it. */
export const ASK_DEADLINE_MS = 90_000;
/** What the bubble says, after "{name} couldn't answer: ", once the deadline passed. */
export const ASK_DEADLINE_REASON = `no answer in ${ASK_DEADLINE_MS / 1000} s`;
export const SLEEP_IDLE_MS = 60000;
export const REST_LINE_CHANCE = 0.25;
export const WORKING_LINE_CHANCE = 0.25;

/** `held`: an answer, a failure or a refusal; no canned line replaces it before `until`. */
/** Lines nobody asked for: they never cover a held answer. */
const AMBIENT: ReadonlySet<LineEvent> = new Set(['toolFail', 'testPass', 'testFail', 'working', 'rest', 'wake']);

export type Talk = { text: string; pose: Pose | null; until: number; held?: boolean };

export type Brain = {
  character: Character;
  /** The motion option; the character's own motion.walk also has to allow it. */
  walkOption: boolean;
  now: number;
  motion: MotionState;
  talk: Talk | null;
  confetti: { seed: number; start: number } | null;
  cols: number;
  maxRows: number;
  working: boolean;
  lastActivity: number;
  sleeping: boolean;
  pets: number;
  questions: number;
  lastLines: Partial<Record<LineEvent, string>>;
  turn: TurnSummary;
  lastQuipAt: number | null;
  /** The pose last drawn: a new pose starts at its first frame. */
  lastPose: Pose | null;
  /** The latest line nobody asked for that came while an answer held the bubble: said once it ends. */
  after: { event: LineEvent; pose: Pose | null; ms: number } | null;
  /** Canned lines said since the adapter last took them, with who said them: its memory records the shown ones. The thinking filler is never among them. */
  said: { id: string; text: string }[];
  /** East Asian ambiguous-width characters take two columns (the ambiguousWidth option). */
  ambiguousWide: boolean;
  /** The /buddy question waiting for its answer: its thinking line, said again whenever the bubble frees up while its asker is drawn; null when none. */
  pending: { askerId: string; talk: Talk } | null;
};

export function createBrain(character: Character, walkOption: boolean, ambiguousWide = false): Brain {
  return {
    character,
    walkOption,
    now: 0,
    motion: initialMotion(0),
    talk: null,
    confetti: null,
    cols: 80,
    maxRows: 10,
    working: false,
    lastActivity: 0,
    sleeping: false,
    pets: 0,
    questions: 0,
    lastLines: {},
    turn: { tools: [], failures: 0, lastBash: '' },
    lastQuipAt: null,
    lastPose: null,
    said: [],
    ambiguousWide,
    after: null,
    pending: null,
  };
}

export function walks(b: Brain): boolean {
  return b.walkOption && b.character.motion.walk;
}

/** The clock period the brain wants now. */
export function period(b: Brain): number {
  return periodMs(walks(b), b.character.motion.stepMs);
}

export function speak(b: Brain, text: string, pose: Pose | null, ms: number): void {
  b.talk = { text, pose, until: b.now + ms };
}

export function sayLine(b: Brain, event: LineEvent, pose: Pose | null, ms: number, rand: () => number): void {
  // An answer the user asked for stays up; lines nobody asked for wait their turn.
  if (AMBIENT.has(event) && b.talk?.held && b.now < b.talk.until) {
    b.after = { event, pose, ms };
    return;
  }
  const line = pickLine(poolFor(b.character, event), b.lastLines[event], rand);
  b.lastLines[event] = line;
  b.said.push({ id: b.character.id, text: line });
  speak(b, line, pose, ms);
}

/** Switches character; an error shows for ERROR_MS, else the new one greets. */
export function setCharacter(b: Brain, c: Character, error: string | undefined, rand: () => number): void {
  b.character = c;
  b.lastLines = {};
  b.motion = { ...b.motion, x: Math.min(b.motion.x, maxX(b.cols, c.width)) };
  if (error) speak(b, error, null, ERROR_MS);
  else greet(b, rand);
}

/** The greeting line: at session start, on a switch, on /buddy on. */
export function greet(b: Brain, rand: () => number): void {
  sayLine(b, 'greeting', null, BUBBLE_MS, rand);
}

export function isSleepHour(hour: number): boolean {
  return hour >= 0 && hour < 6;
}

/**
 * Any event: resets the idle time; a sleeping buddy wakes with a line.
 * `silent`: the caller speaks at once, so a wake line would be covered unseen and never said.
 */
export function wake(b: Brain, rand: () => number, opts: { silent?: boolean } = {}): boolean {
  b.lastActivity = b.now;
  if (!b.sleeping) return false;
  b.sleeping = false;
  if (!opts.silent) sayLine(b, 'wake', null, BUBBLE_MS, rand);
  return true;
}

/** One clock tick at local `hour`. */
export function tick(b: Brain, hour: number, rand: () => number): void {
  b.now += period(b);
  if (b.talk && b.now >= b.talk.until) {
    // A pending question's thinking line comes back once whatever covered it ends, while its asker is drawn.
    b.talk = b.pending && isAsker(b, b.pending.askerId) ? b.pending.talk : null;
    const next = b.after;
    b.after = null;
    if (next) sayLine(b, next.event, next.pose, next.ms, rand);
  }
  if (b.confetti && b.now - b.confetti.start >= CONFETTI_MS) b.confetti = null;
  if (b.working) b.lastActivity = b.now;
  if (!b.sleeping && !b.talk && !b.working && isSleepHour(hour) && b.now - b.lastActivity >= SLEEP_IDLE_MS) b.sleeping = true;
  const m = b.character.motion;
  const r = tickMotion(
    b.motion,
    { now: b.now, cols: b.cols, width: b.character.width, walk: walks(b), still: b.talk !== null || b.working || b.sleeping, restChance: m.restChance, restTicks: m.restTicks },
    rand,
  );
  b.motion = r.state;
  if (r.restStarted && rand() < REST_LINE_CHANCE) sayLine(b, 'rest', 'rest', BUBBLE_MS, rand);
}

/** What the band reported on its last draw. Work starting wakes him, sometimes with a line. */
export function observeBand(b: Brain, band: { cols: number; maxRows: number; isWorking: boolean }, rand: () => number): void {
  b.cols = band.cols;
  b.maxRows = band.maxRows;
  if (band.isWorking === b.working) return;
  b.working = band.isWorking;
  if (!band.isWorking) return;
  wake(b, rand);
  if (b.talk === null && rand() < WORKING_LINE_CHANCE) sayLine(b, 'working', 'working', BUBBLE_MS, rand);
}

export function currentPose(b: Brain): Pose {
  if (b.talk?.pose) return b.talk.pose;
  if (b.sleeping) return 'sleep';
  if (b.working) return 'working';
  if (b.talk) return 'idle';
  if (walks(b) && b.motion.restLeft > 0) return 'rest';
  if (walks(b)) return b.motion.dir > 0 ? 'walkRight' : 'walkLeft';
  return 'idle';
}

/** A finished tool call: counted for the turn, and reacted to per REACTIONS. */
export function react(b: Brain, call: ToolCall & { command: string }, rand: () => number): Outcome | null {
  const outcome = classifyToolCall(call);
  wake(b, rand, { silent: outcome !== null });
  b.turn.tools.push(call.tool);
  if (call.isError || call.denied) b.turn.failures++;
  if (call.tool === 'Bash' && call.command) b.turn.lastBash = call.command.slice(0, 120);
  if (!outcome) return null;
  const r = REACTIONS[outcome];
  sayLine(b, r.line, r.pose, BUBBLE_MS, rand);
  if (r.confetti) b.confetti = { seed: Math.floor(rand() * 2 ** 31), start: b.now };
  return outcome;
}

export function pet(b: Brain, rand: () => number): void {
  wake(b, rand, { silent: true });
  b.pets++;
  sayLine(b, 'petted', 'petted', BUBBLE_MS, rand);
}

/** The thinking line, held with no timer of its own: only endQuestion ends it (the answer, the failure or the deadline). */
export function beginQuestion(b: Brain, rand: () => number): void {
  wake(b, rand, { silent: true });
  b.questions++;
  const line = pickLine(poolFor(b.character, 'thinking'), b.lastLines.thinking, rand);
  b.lastLines.thinking = line;
  // The thinking filler is noise, never remembered: it is not among `said`.
  const talk: Talk = { text: line, pose: 'thinking', until: Number.POSITIVE_INFINITY, held: true };
  b.pending = { askerId: b.character.id, talk };
  b.talk = talk;
}

/** The pending question ended: its thinking line goes, at the next tick when nothing replaced it. */
export function endQuestion(b: Brain): void {
  if (b.pending && b.talk === b.pending.talk) b.talk = { ...b.talk, until: b.now };
  b.pending = null;
}

/** What is left of the one deadline of a question asked at `askedAt`, at `now`; 0 once it passed, never more than the whole. */
export function askLeft(askedAt: number, now: number): number {
  return Math.min(ASK_DEADLINE_MS, Math.max(0, Math.ceil(askedAt + ASK_DEADLINE_MS - now)));
}

/** Whether an answer of `askerId` may be said: always without one, else only while that character is drawn. */
function isAsker(b: Brain, askerId: string | undefined): boolean {
  return askerId === undefined || askerId === b.character.id;
}

/** The answer in the bubble; false, and nothing said, when `askerId` was asked and another character is drawn now. */
export function answer(b: Brain, text: string, pose: Pose | null = null, askerId?: string): boolean {
  if (!isAsker(b, askerId)) return false;
  b.talk = { text, pose, until: b.now + ANSWER_MS, held: true };
  return true;
}

/** The failure in the bubble; false, and nothing said, when `askerId` was asked and another character is drawn now. */
export function failAnswer(b: Brain, reason: string, askerId?: string): boolean {
  if (!isAsker(b, askerId)) return false;
  b.talk = { text: lostThread(b.character.name, reason), pose: 'oops', until: b.now + ANSWER_MS, held: true };
  return true;
}

/** An answer, a failure or the thinking line holds the bubble: a line nobody asked for must not replace it yet. */
export function holdsAnswer(b: Brain): boolean {
  return b.talk?.held === true && b.now < b.talk.until;
}

/** A /buddy question refused because the last one is still waiting. */
export function refuseQuestion(b: Brain): void {
  wake(b, () => 0, { silent: true });
  b.talk = { text: stillThinking(b.character.name), pose: 'thinking', until: b.now + BUBBLE_MS, held: true };
}

export function farewell(b: Brain, rand: () => number): string {
  const line = pickLine(poolFor(b.character, 'farewell'), b.lastLines.farewell, rand);
  b.lastLines.farewell = line;
  return line;
}

/**
 * The turn ended: its summary, tools or none, and whether the buddy's line is
 * due (quips on and the cooldown passed; cooldown 0 is every turn). The
 * turn's tally starts over either way.
 */
export function endTurn(b: Brain, quips: boolean, cooldownSec: number): { turn: TurnSummary; lineDue: boolean } {
  const turn = b.turn;
  b.turn = { tools: [], failures: 0, lastBash: '' };
  const lineDue = quips && (b.lastQuipAt === null || b.now - b.lastQuipAt >= cooldownSec * 1000);
  if (lineDue) b.lastQuipAt = b.now;
  return { turn, lineDue };
}

/** The scene to draw now; the sprite keeps the column the bubble pushed it to. */
export function sceneOf(b: Brain): Scene | null {
  const pose = currentPose(b);
  if (pose !== b.lastPose) {
    b.lastPose = pose;
    b.motion = { ...b.motion, stillFrame: 0, lastFrameAt: b.now };
  }
  const walking = pose === 'walkRight' || pose === 'walkLeft';
  const scene = buildScene({
    character: b.character,
    pose,
    frame: walking ? b.motion.walkFrame : b.motion.stillFrame,
    x: b.motion.x,
    cols: b.cols,
    maxRows: b.maxRows,
    bubble: b.talk?.text ?? null,
    confetti: b.confetti ? { seed: b.confetti.seed, tick: Math.floor((b.now - b.confetti.start) / CONFETTI_TICK_MS) } : null,
    sleeping: b.sleeping,
    zTick: b.motion.stillFrame,
    stats: { pets: b.pets, questions: b.questions },
    now: b.now,
    ambiguousWide: b.ambiguousWide,
  });
  if (scene && scene.x !== b.motion.x) b.motion = { ...b.motion, x: scene.x };
  return scene;
}
