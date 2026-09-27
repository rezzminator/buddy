// The walk: one column per step, a bounce at the edges, a random rest. Time is
// the clock's own (ms since start), passed in, so a test drives it exactly.

export type MotionState = { x: number; dir: 1 | -1; walkFrame: number; stillFrame: number; restLeft: number; lastFrameAt: number };

/** A pose that is not walking changes frame this often. */
export const STILL_FRAME_MS = 900;
/** The clock period of a character that does not walk. */
export const STILL_PERIOD_MS = 300;

export type TickInput = {
  now: number;
  cols: number;
  width: number;
  /** Walking is on: the character's motion.walk and the walkAlongPrompt option. */
  walk: boolean;
  /** Something holds him still: a bubble, work, sleep. */
  still: boolean;
  restChance: number;
  restTicks: number;
};

export function initialMotion(now = 0): MotionState {
  return { x: 0, dir: 1, walkFrame: 0, stillFrame: 0, restLeft: 0, lastFrameAt: now };
}

/** The last column the sprite's left edge may take. */
export function maxX(cols: number, width: number): number {
  return Math.max(0, cols - width - 1);
}

/** The clock period: a walker's step, else STILL_PERIOD_MS. */
export function periodMs(walk: boolean, stepMs: number): number {
  return walk ? stepMs : STILL_PERIOD_MS;
}

/** One clock tick. `restStarted` is true on the tick a rest begins. */
export function tickMotion(s: MotionState, i: TickInput, rand: () => number): { state: MotionState; restStarted: boolean } {
  const n: MotionState = { ...s };
  const max = maxX(i.cols, i.width);
  if (n.x > max) n.x = max;
  let restStarted = false;
  const moving = i.walk && !i.still;
  if (moving && n.restLeft > 0) n.restLeft--;
  else if (moving) {
    n.x += n.dir;
    n.walkFrame++;
    if (n.x >= max) {
      n.x = max;
      n.dir = -1;
    }
    if (n.x <= 0) {
      n.x = 0;
      n.dir = 1;
    }
    if (rand() < i.restChance) {
      n.restLeft = i.restTicks;
      restStarted = true;
    }
  }
  const walkingNow = moving && n.restLeft === 0;
  if (walkingNow) n.lastFrameAt = i.now;
  else if (i.now - n.lastFrameAt >= STILL_FRAME_MS) {
    n.stillFrame++;
    n.lastFrameAt = i.now;
  }
  return { state: n, restStarted };
}
