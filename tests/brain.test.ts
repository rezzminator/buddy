import { describe, expect, test } from 'vitest';
import {
  ANSWER_MS, COMPLETE_DEADLINE_MS, LAST_BASH_MAX, BUBBLE_MS, ERROR_MS, MODEL_MIN_MS, REST_LINE_CHANCE, SLEEP_IDLE_MS, TOOL_LINE_CHANCE, WAKE_LINE_CHANCE, WORKING_LINE_CHANCE, answer, beginQuestion, createBrain, currentPose, deadlineReason, endQuestion, endTurn, noAnswerReason,
  failAnswer, farewell, holdsAnswer, sayLine, isMainLoop, isSleepHour, observeBand, period, pet, react, refuseQuestion, sceneOf, setCharacter, tick, wake,
} from '../plugins/buddy/src/brain.ts';
import { validateCharacter, type Character } from '../plugins/buddy/src/character.ts';
import { raw } from './fixtures.ts';

type Brain = ReturnType<typeof createBrain>;

function char(over: Record<string, unknown> = {}): Character {
  const v = validateCharacter(raw(over));
  if (!v.ok) throw new Error(v.error);
  return v.character;
}
const never = () => 0.99;
/** Every chance taken: a line nobody asked for is said. */
const always = () => 0;
const DAY = 12;
const NIGHT = 3;

function ticks(b: ReturnType<typeof createBrain>, n: number, hour = DAY, rand = never) {
  for (let i = 0; i < n; i++) tick(b, hour, rand);
}

describe('brain', () => {
  test('greets, holds still while talking, then walks', () => {
    const b = createBrain(char(), true);
    setCharacter(b, b.character, undefined, never);
    expect(b.talk?.text).toBe('Hi from Fixy.');
    ticks(b, 5);
    expect(b.motion.x).toBe(0);
    ticks(b, BUBBLE_MS / 200);
    expect(b.talk).toBeNull();
    const x = b.motion.x;
    ticks(b, 3);
    expect(b.motion.x).toBe(x + 3);
    expect(currentPose(b)).toBe('walkRight');
  });
  test('an error bubble shows for 10 s', () => {
    const b = createBrain(char(), true);
    setCharacter(b, b.character, "Couldn't load x: no such character", never);
    expect(b.talk).toMatchObject({ text: "Couldn't load x: no such character", until: ERROR_MS });
  });
  test('the motion option or motion.walk false: stands on idle, still period', () => {
    const off = createBrain(char(), false);
    expect(period(off)).toBe(300);
    ticks(off, 10);
    expect(off.motion.x).toBe(0);
    expect(currentPose(off)).toBe('idle');
    const standing = createBrain(char({ poses: { idle: [['a']] }, motion: { walk: false } }), true);
    expect(period(standing)).toBe(300);
    expect(currentPose(standing)).toBe('idle');
  });
  test('reactions: pose, line, confetti, and the turn tally', () => {
    const b = createBrain(char({ lines: { testPass: ['Green!'] } }), true);
    expect(react(b, { tool: 'Bash', isError: false, denied: false, output: '4 passed', command: 'npm test' }, always)).toBe('testPass');
    expect(currentPose(b)).toBe('yay');
    expect(b.talk?.text).toBe('Green!');
    expect(b.confetti).not.toBeNull();
    expect(react(b, { tool: 'Edit', isError: false, denied: true, output: '', command: '' }, always)).toBe('toolFail');
    expect(currentPose(b)).toBe('oops');
    expect(react(b, { tool: 'Read', isError: false, denied: false, output: '', command: '' }, never)).toBeNull();
    expect(b.turn).toEqual({ tools: ['Bash', 'Edit', 'Read'], failures: 1, lastBash: 'npm test', actions: [] });
    const long = `node -e "${'x'.repeat(1500)}"`;
    react(b, { tool: 'Bash', isError: false, denied: false, output: '', command: long }, never);
    expect(b.turn.lastBash).toBe(long);
    react(b, { tool: 'Bash', isError: false, denied: false, output: '', command: 'y'.repeat(LAST_BASH_MAX + 500) }, never);
    expect(b.turn.lastBash).toBe('y'.repeat(LAST_BASH_MAX));
    ticks(b, 2000 / 200);
    expect(b.confetti).toBeNull();
  });
  test('pet, question, answer, lost thread', () => {
    const b = createBrain(char(), true);
    pet(b, never);
    expect(b.pets).toBe(1);
    expect(currentPose(b)).toBe('petted');
    beginQuestion(b, never);
    expect(b.questions).toBe(1);
    expect(currentPose(b)).toBe('thinking');
    answer(b, 'Forty-two.');
    expect(b.talk).toMatchObject({ text: 'Forty-two.', pose: null, until: b.now + ANSWER_MS });
    ticks(b, MODEL_MIN_MS / 200);
    failAnswer(b, 'api-error');
    expect(b.talk?.text).toBe("Fixy couldn't answer: api-error");
    expect(farewell(b, never)).toBe('Until next time.');
  });
  test('sleeps 00:00-05:59 after 60 s idle, with the sleep pose; any event wakes him with a line', () => {
    expect([0, 5, 6, 23].map(isSleepHour)).toEqual([true, true, false, false]);
    const b = createBrain(char(), true);
    ticks(b, SLEEP_IDLE_MS / 200, DAY);
    expect(b.sleeping).toBe(false);
    ticks(b, SLEEP_IDLE_MS / 200, NIGHT);
    expect(b.sleeping).toBe(true);
    expect(currentPose(b)).toBe('sleep');
    const x = b.motion.x;
    ticks(b, 5, NIGHT);
    expect(b.motion.x).toBe(x);
    expect(wake(b, always)).toBe(true);
    expect(b.sleeping).toBe(false);
    expect(b.talk?.text).toBe('Hi from Fixy.');
  });
  test('a sleeping buddy woken by a pet, a question, a refusal or a reacted tool call says only that: no wake line nobody sees', () => {
    const asleep = () => {
      const b = createBrain(char(), true);
      ticks(b, (2 * SLEEP_IDLE_MS) / 200, NIGHT);
      expect(b.sleeping).toBe(true);
      b.said.splice(0);
      return b;
    };
    const woken = (act: (b: ReturnType<typeof createBrain>) => void) => {
      const b = asleep();
      act(b);
      return { sleeping: b.sleeping, said: b.said.length };
    };
    expect(woken((b) => pet(b, never))).toEqual({ sleeping: false, said: 1 });
    expect(woken((b) => beginQuestion(b, never))).toEqual({ sleeping: false, said: 0 });
    expect(woken((b) => refuseQuestion(b))).toEqual({ sleeping: false, said: 0 });
    expect(woken((b) => react(b, { tool: 'Bash', isError: true, denied: false, output: '', command: 'false' }, always))).toEqual({ sleeping: false, said: 1 });
    expect(woken((b) => wake(b, never, { silent: true }))).toEqual({ sleeping: false, said: 0 });
    // Woken by nothing that speaks, the wake line is the one shown.
    expect(woken((b) => wake(b, always))).toEqual({ sleeping: false, said: 1 });
  });

  test('work: working pose, no walking, no sleep', () => {
    const b = createBrain(char(), true);
    observeBand(b, { cols: 90, maxRows: 8, isWorking: true }, never);
    expect(b.cols).toBe(90);
    expect(currentPose(b)).toBe('working');
    ticks(b, 2 * SLEEP_IDLE_MS / 200, NIGHT);
    expect(b.motion.x).toBe(0);
    expect(b.sleeping).toBe(false);
  });
  test('the turn\'s summary at every end, tools or none; commentAfterEachTurn due only when on and past secondsBetweenComments', () => {
    const b = createBrain(char(), true);
    const read = () => react(b, { tool: 'Read', isError: false, denied: false, output: '', command: '' }, never);
    expect(endTurn(b, true, 45)).toEqual({ turn: { tools: [], failures: 0, lastBash: '', actions: [] }, commentAfterEachTurnDue: true });
    read();
    expect(endTurn(b, false, 45)).toEqual({ turn: { tools: ['Read'], failures: 0, lastBash: '', actions: [] }, commentAfterEachTurnDue: false });
    expect(b.turn.tools).toEqual([]);
    read();
    expect(endTurn(b, true, 45)).toEqual({ turn: { tools: ['Read'], failures: 0, lastBash: '', actions: [] }, commentAfterEachTurnDue: false });
    ticks(b, 45000 / 200);
    expect(endTurn(b, true, 45).commentAfterEachTurnDue).toBe(true);
  });
  test('secondsBetweenComments 0: commentAfterEachTurn is due at every turn\'s end', () => {
    const b = createBrain(char(), true);
    expect(endTurn(b, true, 0).commentAfterEachTurnDue).toBe(true);
    expect(endTurn(b, true, 0).commentAfterEachTurnDue).toBe(true);
    expect(endTurn(b, true, 0).commentAfterEachTurnDue).toBe(true);
  });
  test('a new pose starts at its first frame and steps through every frame in order', () => {
    const b = createBrain(char({ poses: { idle: [['1'], ['2'], ['3'], ['2']], walkRight: [['a'], ['b']] }, motion: { walk: false } }), true);
    const seen: string[] = [];
    for (let i = 0; i < 9; i++) {
      seen.push(sceneOf(b)!.rows.join('').trim());
      ticks(b, 3);
    }
    expect(seen).toEqual(['1', '2', '3', '2', '1', '2', '3', '2', '1']);
    pet(b, never);
    ticks(b, 3);
    sceneOf(b);
    b.talk = null;
    expect(sceneOf(b)!.rows.join('').trim()).toBe('1');
  });

  test('the scene keeps the column a bubble pushed him to', () => {
    const b = createBrain(char(), true);
    observeBand(b, { cols: 100, maxRows: 8, isWorking: false }, never);
    b.motion = { ...b.motion, x: 90 };
    setCharacter(b, b.character, undefined, never);
    const s = sceneOf(b)!;
    expect(s.bubble?.side).toBe('left');
    expect(b.motion.x).toBe(s.x);
  });
});

describe('a held answer', () => {
  test('a reaction during it is dropped outright: never queued, never said once the answer ends', () => {
    const b = createBrain(char(), false);
    answer(b, 'My own answer.');
    react(b, { tool: 'Bash', isError: true, denied: false, output: '', command: 'false' }, always);
    expect(b.talk?.text).toBe('My own answer.');
    expect(b.said).toEqual([]);
    ticks(b, ANSWER_MS / 300);
    expect(b.talk).toBeNull();
  });
  test('an answer belongs to the character asked: after a switch it is dropped, never said by the new one', () => {
    const b = createBrain(char({ id: 'asker', name: 'Asker' }), true);
    const other = char({ id: 'other', name: 'Other' });
    setCharacter(b, other, undefined, never);
    const greeting = b.talk?.text;
    expect(answer(b, 'the asker\'s answer', null, 'asker')).toBe(false);
    expect(failAnswer(b, 'timeout', 'asker')).toBe(false);
    expect(b.talk?.text).toBe(greeting);
    expect(answer(b, 'its own answer', null, 'other')).toBe(true);
    expect(b.talk?.text).toBe('its own answer');
    expect(answer(b, 'unbound', null)).toBe(true);
  });
});

describe('holdsAnswer', () => {
  test('true while an answer, a failure or the thinking line holds the bubble; false once it ends or for a canned line', () => {
    const b = createBrain(char(), false);
    b.talk = null;
    expect(holdsAnswer(b)).toBe(false);
    answer(b, 'Held.');
    expect(holdsAnswer(b)).toBe(true);
    b.now += ANSWER_MS - 1;
    expect(holdsAnswer(b)).toBe(true);
    b.now += 1;
    expect(holdsAnswer(b)).toBe(false);
    failAnswer(b, 'timeout');
    expect(holdsAnswer(b)).toBe(true);
    beginQuestion(b, () => 0);
    b.now += COMPLETE_DEADLINE_MS * 10;
    expect(holdsAnswer(b)).toBe(true);
    b.talk = { text: 'a canned line', pose: null, until: b.now + BUBBLE_MS };
    expect(holdsAnswer(b)).toBe(false);
  });
  test('a commentAfterEachTurn, or its failure, holds the bubble like any model bubble: a canned line is dropped, the next turn\'s waits its turn', () => {
    const b = createBrain(char(), false);
    expect(answer(b, 'Turn one.', 'yay', undefined, true)).toBe(true);
    expect(holdsAnswer(b)).toBe(true);
    sayLine(b, 'toolFail', 'oops', BUBBLE_MS, always);
    expect(b.talk?.text).toBe('Turn one.');
    expect(failAnswer(b, 'timeout', undefined, true)).toBe(true);
    expect(b.talk?.text).toBe('Turn one.');
    ticks(b, Math.ceil(MODEL_MIN_MS / 300));
    expect(b.talk?.text).toBe("Fixy couldn't answer: timeout");
    expect(holdsAnswer(b)).toBe(true);
  });
});

describe('a question\'s deadline and failures', () => {
  test('a question gets 90 s on `model`; the bubble names the deadline that passed', () => {
    expect(COMPLETE_DEADLINE_MS).toBe(90_000);
    expect(deadlineReason(COMPLETE_DEADLINE_MS)).toBe('no answer in 90 s');
  });
  test('why a model call gave no answer, as the bubble says it', () => {
    expect(noAnswerReason({ reason: 'api-error', status: 529 })).toBe('api-error 529');
    expect(noAnswerReason({ reason: 'api-error', status: null })).toBe('api-error (no response)');
    expect(noAnswerReason({ reason: 'empty-reply' })).toBe('empty-reply');
    expect(noAnswerReason({ reason: 'aborted' })).toBe('aborted');
  });
});

describe('a pending question', () => {
  const lines = { greeting: ['Hi from Fixy.'], thinking: ['Hmm.'], petted: ['Purr.'], toolFail: ['Ouch.'] };
  test('the thinking line has no timer of its own: it stays past any timer, over reactions, until the question ends', () => {
    const b = createBrain(char({ lines }), true);
    beginQuestion(b, never);
    ticks(b, 120_000 / 200);
    expect(b.talk).toMatchObject({ text: 'Hmm.', pose: 'thinking' });
    react(b, { tool: 'Edit', isError: true, denied: false, output: '', command: '' }, always);
    expect(b.talk?.text).toBe('Hmm.');
    endQuestion(b);
    answer(b, 'Done.');
    ticks(b, ANSWER_MS / 200);
    // The reaction the thinking line kept out is dropped, never said after the answer; the thinking line never again.
    expect(b.talk).toBeNull();
    expect(b.said).toEqual([]);
  });
  test('a pet or a refusal covers it for its own time, then it comes back; a switched-in character never says it', () => {
    const b = createBrain(char({ lines }), true);
    beginQuestion(b, never);
    pet(b, never);
    expect(b.talk?.text).toBe('Purr.');
    ticks(b, BUBBLE_MS / 200);
    expect(b.talk?.text).toBe('Hmm.');
    refuseQuestion(b);
    ticks(b, BUBBLE_MS / 200);
    expect(b.talk?.text).toBe('Hmm.');
    setCharacter(b, char({ id: 'other', name: 'Other', lines: { greeting: ['Other here.'] } }), undefined, never);
    ticks(b, BUBBLE_MS / 200);
    expect(b.talk).toBeNull();
    endQuestion(b);
    expect(failAnswer(b, deadlineReason(COMPLETE_DEADLINE_MS), 'fixy')).toBe(false);
    expect(b.talk).toBeNull();
  });
  test('ended with no answer to replace it, the thinking line goes at the next tick', () => {
    const b = createBrain(char({ lines }), true);
    beginQuestion(b, never);
    endQuestion(b);
    ticks(b, 1);
    expect(b.talk).toBeNull();
  });
});

describe('isMainLoop', () => {
  test('only the main loop, which carries no agent id, is the user\'s turn; a subagent\'s loop is not', () => {
    expect(isMainLoop(undefined)).toBe(true);
    expect(isMainLoop('a1b2')).toBe(false);
    expect(isMainLoop('')).toBe(false);
  });
});

describe('a model bubble', () => {
  test('a canned line stays 10 s, a model bubble 15 s, an error 10 s; a newer model bubble waits until the current one has had 10 s', () => {
    expect({ BUBBLE_MS, ANSWER_MS, ERROR_MS, MODEL_MIN_MS }).toEqual({ BUBBLE_MS: 10_000, ANSWER_MS: 15_000, ERROR_MS: 10_000, MODEL_MIN_MS: 10_000 });
  });
  const says: [string, (b: Brain) => boolean][] = [
    ['a /buddy answer', (b) => answer(b, 'Model words.')],
    ['a turn comment', (b) => answer(b, 'Model words.', 'yay', undefined, true)],
    ['a verdict', (b) => answer(b, 'Model words.', null, undefined, true, 'warn')],
    ['a steer', (b) => answer(b, 'Model words.', null, undefined, true, undefined, 'claude')],
    ['a failed call', (b) => failAnswer(b, 'timeout', undefined, true)],
  ];
  for (const [name, say] of says) {
    test(`${name} stays its whole time: no canned line of any event, turn start or end, working band, render pass or tool call replaces it, and none is said after it`, () => {
      const b = createBrain(char(), true);
      expect(say(b)).toBe(true);
      const text = b.talk!.text;
      expect(holdsAnswer(b)).toBe(true);
      for (const event of ['greeting', 'petted', 'toolFail', 'testPass', 'testFail', 'working', 'rest', 'wake'] as const) sayLine(b, event, null, BUBBLE_MS, always);
      react(b, { tool: 'Bash', isError: false, denied: false, output: '4 passed', command: 'npm test' }, always);
      react(b, { tool: 'Bash', isError: true, denied: false, output: '', command: 'false' }, always);
      pet(b, always);
      b.sleeping = true;
      wake(b, always);
      endTurn(b, true, 0);
      observeBand(b, { cols: 90, maxRows: 8, isWorking: true }, always);
      observeBand(b, { cols: 30, maxRows: 2, isWorking: false }, always);
      expect(JSON.stringify(sceneOf(b))).toContain(text.slice(0, 8));
      expect(b.talk?.text).toBe(text);
      expect(b.said).toEqual([]);
      ticks(b, ANSWER_MS / 200 - 1);
      expect(b.talk?.text).toBe(text);
      ticks(b, 1);
      expect(b.talk).toBeNull();
      expect(b.said).toEqual([]);
    });
  }
  test('alone it lasts its full 15 s; newer ones wait in a FIFO of 2, the oldest pending dropped, each shown once the current one has had 10 s', () => {
    const b = createBrain(char(), true);
    answer(b, 'A');
    answer(b, 'B', null, undefined, true);
    answer(b, 'C', null, undefined, true, undefined, 'claude');
    answer(b, 'D');
    expect(b.talk?.text).toBe('A');
    ticks(b, MODEL_MIN_MS / 200 - 1);
    expect(b.talk?.text).toBe('A');
    ticks(b, 1);
    expect(b.talk).toMatchObject({ text: 'C', to: 'claude' });
    ticks(b, MODEL_MIN_MS / 200 - 1);
    expect(b.talk?.text).toBe('C');
    ticks(b, 1);
    expect(b.talk?.text).toBe('D');
    ticks(b, ANSWER_MS / 200 - 1);
    expect(b.talk?.text).toBe('D');
    ticks(b, 1);
    expect(b.talk).toBeNull();
    // One that comes once the current one has had its 10 s replaces it at once.
    answer(b, 'E');
    ticks(b, MODEL_MIN_MS / 200);
    answer(b, 'F');
    expect(b.talk?.text).toBe('F');
  });
  test('only the thinking line, a character switch or an error replace it sooner; a switch drops the ones waiting', () => {
    const b = createBrain(char(), true);
    answer(b, 'G');
    beginQuestion(b, never);
    expect(b.talk?.pose).toBe('thinking');
    // The question's own answer replaces its thinking line; a turn's bubble waits behind it.
    answer(b, 'a turn comment', null, undefined, true);
    expect(b.talk?.pose).toBe('thinking');
    answer(b, 'the answer');
    endQuestion(b);
    expect(b.talk?.text).toBe('a turn comment');
    ticks(b, MODEL_MIN_MS / 200);
    expect(b.talk?.text).toBe('the answer');
    answer(b, 'H');
    setCharacter(b, b.character, 'bad file', never);
    expect(b.talk?.text).toBe('bad file');
    ticks(b, ERROR_MS / 200);
    expect(b.talk).toBeNull();
    answer(b, 'I');
    setCharacter(b, char({ id: 'other', name: 'Other', lines: { greeting: ['Other here.'] } }), undefined, never);
    expect(b.talk?.text).toBe('Other here.');
  });
});

describe('lines nobody asked for, a third as often', () => {
  const pass = { tool: 'Bash', isError: false, denied: false, output: '4 passed', command: 'npm test' };
  test('the chances', () => {
    expect({ REST_LINE_CHANCE, WORKING_LINE_CHANCE, TOOL_LINE_CHANCE, WAKE_LINE_CHANCE }).toEqual({ REST_LINE_CHANCE: 0.08, WORKING_LINE_CHANCE: 0.08, TOOL_LINE_CHANCE: 1 / 3, WAKE_LINE_CHANCE: 1 / 3 });
  });
  test('a tool reaction says its words only below TOOL_LINE_CHANCE; its pose and confetti come every time', () => {
    const quiet = createBrain(char({ lines: { testPass: ['Green!'] } }), true);
    expect(react(quiet, pass, () => TOOL_LINE_CHANCE)).toBe('testPass');
    expect(quiet.talk).toBeNull();
    expect(quiet.said).toEqual([]);
    expect(currentPose(quiet)).toBe('yay');
    expect(quiet.confetti).not.toBeNull();
    ticks(quiet, BUBBLE_MS / 200);
    expect(currentPose(quiet)).not.toBe('yay');
    const loud = createBrain(char({ lines: { testPass: ['Green!'] } }), true);
    react(loud, pass, () => TOOL_LINE_CHANCE - 0.01);
    expect(loud.talk).toMatchObject({ text: 'Green!', pose: 'yay' });
    expect(loud.confetti).not.toBeNull();
  });
  test('work starting says a line only below WORKING_LINE_CHANCE, waking only below WAKE_LINE_CHANCE', () => {
    const working = (r: number) => {
      const b = createBrain(char(), true);
      observeBand(b, { cols: 90, maxRows: 8, isWorking: true }, () => r);
      return b.said.length;
    };
    expect([working(WORKING_LINE_CHANCE), working(WORKING_LINE_CHANCE - 0.01)]).toEqual([0, 1]);
    const woken = (r: number) => {
      const b = createBrain(char(), true);
      b.sleeping = true;
      wake(b, () => r);
      return { sleeping: b.sleeping, said: b.said.length };
    };
    expect([woken(WAKE_LINE_CHANCE), woken(WAKE_LINE_CHANCE - 0.01)]).toEqual([{ sleeping: false, said: 0 }, { sleeping: false, said: 1 }]);
  });
});
