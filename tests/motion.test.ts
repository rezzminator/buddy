import { describe, expect, test } from 'vitest';
import { STILL_FRAME_MS, STILL_PERIOD_MS, initialMotion, maxX, periodMs, tickMotion, type MotionState, type TickInput } from '../plugins/buddy/src/motion.ts';

const base: TickInput = { now: 0, cols: 20, width: 4, walkOverPromptBar: true, still: false, restChance: 0, restTicks: 3 };
const never = () => 0.99;

function run(s: MotionState, n: number, over: Partial<TickInput> = {}, rand = never): MotionState {
  for (let i = 1; i <= n; i++) s = tickMotion(s, { ...base, ...over, now: (over.now ?? 0) + i * 200 }, rand).state;
  return s;
}

describe('motion', () => {
  test('walks one column per tick and bounces at cols - width - 1', () => {
    expect(maxX(20, 4)).toBe(15);
    let s = run(initialMotion(), 3);
    expect(s.x).toBe(3);
    expect(s.walkFrame).toBe(3);
    s = run(initialMotion(), 15);
    expect(s).toMatchObject({ x: 15, dir: -1 });
    s = run(s, 15);
    expect(s).toMatchObject({ x: 0, dir: 1 });
  });
  test('a rest holds him for restTicks ticks', () => {
    const r = tickMotion(initialMotion(), { ...base, now: 200, restChance: 0.02 }, () => 0);
    expect(r.restStarted).toBe(true);
    expect(r.state).toMatchObject({ x: 1, restLeft: 3 });
    const s = run(r.state, 3, { now: 200 });
    expect(s).toMatchObject({ x: 1, restLeft: 0 });
    expect(run(s, 1).x).toBe(2);
  });
  test('held still (bubble, work, sleep) or not walking: no step, frames every 900 ms', () => {
    for (const over of [{ still: true }, { walkOverPromptBar: false }]) {
      let s = initialMotion();
      s = tickMotion(s, { ...base, ...over, now: STILL_FRAME_MS - 1 }, never).state;
      expect(s).toMatchObject({ x: 0, stillFrame: 0 });
      s = tickMotion(s, { ...base, ...over, now: STILL_FRAME_MS }, never).state;
      expect(s).toMatchObject({ x: 0, stillFrame: 1, walkFrame: 0 });
    }
  });
  test('a narrower band pulls him in', () => {
    const s = tickMotion({ ...initialMotion(), x: 50 }, { ...base, still: true }, never).state;
    expect(s.x).toBe(15);
  });
  test('the clock period: a step, else STILL_PERIOD_MS', () => {
    expect(periodMs(true, 150)).toBe(150);
    expect(periodMs(false, 150)).toBe(STILL_PERIOD_MS);
  });
});
