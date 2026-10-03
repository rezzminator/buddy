import type { Character, LineEvent } from './character.ts';

// Canned one-liners. A character's own pool wins; a missing pool falls back
// to this neutral one, never to another character's voice.

export const GENERIC_LINES: Record<LineEvent, readonly string[]> = {
  greeting: ['Hello there.', 'Ready when you are.', 'Hi! What are we building?'],
  toolFail: ['Hm, that did not work.', 'A small setback.', 'That one failed.'],
  testPass: ['Tests pass!', 'All green.', 'It passes. Nice.'],
  testFail: ['Some tests failed.', 'Red, for now.', 'The tests say no.'],
  thinking: ['Let me think...', 'Hmm...', 'One moment...'],
  rest: ['Short break.', 'Just a breather.', 'Catching my breath.'],
  working: ['Working on it...', 'Busy, busy.', 'Reading along.'],
  wake: ['Oh! I am awake.', 'Huh? Just resting my eyes.', 'Back again.'],
  farewell: ['Bye for now.', 'See you later.', 'Until next time.'],
};

/** The pool an event draws from: the character's, `wake` its `greeting`, then generic. */
export function poolFor(c: Character, event: LineEvent): readonly string[] {
  return c.lines[event] ?? (event === 'wake' ? c.lines.greeting : undefined) ?? GENERIC_LINES[event];
}

/** A random line of the pool, never the one said last from it (when it has two). */
export function pickLine(pool: readonly string[], last: string | undefined, rand: () => number): string {
  const choices = pool.length > 1 ? pool.filter((l) => l !== last) : pool;
  const list = choices.length > 0 ? choices : pool;
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))] ?? '';
}
