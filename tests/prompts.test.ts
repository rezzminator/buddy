import { describe, expect, test } from 'vitest';
import {
  ONE_LINE_RULE, SUGGESTION_MAX_CHARS, TURN_DEADLINE_MS, TURN_MAX_TOKENS, forkPrompt, lastExchange, lostThread, oneLine, oneLineSystem, parseTurnReply, questionPrompt, suggestionText, turnPrompt, turnSystem,
} from '../plugins/buddy/src/prompts.ts';

describe('prompts', () => {
  test('the fork prompt: persona, the question, the one-line rule', () => {
    expect(forkPrompt('You are X.', 'why')).toBe(
      'You are X.\n\nThe user asks you directly: why. Answer in ONE line, at most 25 words, in character. Do not use tools. Do not think out loud.',
    );
  });
  test('the completion system and prompt', () => {
    expect(oneLineSystem('You are X.')).toBe(`You are X.\n\n${ONE_LINE_RULE}`);
    expect(questionPrompt('hi')).toBe('The user asks you directly: hi');
  });
  test('the turn prompt counts tools and caps the command', () => {
    const p = turnPrompt({ tools: ['Bash', 'Read', 'Bash'], failures: 1, lastBash: 'x'.repeat(200) }, 'fix it', 'Fixed.');
    expect(p).toContain(`Tools used: Bash x2, Read. Failures: 1. Last shell command: ${'x'.repeat(120)}.`);
    expect(turnPrompt({ tools: [], failures: 0, lastBash: '' }, 'hi', 'Hello.')).toContain('Tools used: none. Failures: 0. Last shell command: none.');
  });
  test('oneLine takes the first non-empty line, unquoted, capped', () => {
    expect(oneLine('\n  "Hello there."  \nmore')).toBe('Hello there.');
    expect(oneLine('')).toBe('');
    expect(oneLine('y'.repeat(300))).toHaveLength(240);
  });
  test('lostThread', () => {
    expect(lostThread('Fixy', 'api-error')).toBe("Fixy couldn't answer: api-error");
  });
});

describe('memory in the prompts', () => {
  const memory = 'Recently (oldest first):\nYou: remember pineapple\nCat: Noted.';
  test('before the question, with leave to refer back to it', () => {
    const f = forkPrompt('You are X.', 'what word', memory);
    expect(f.indexOf(memory)).toBeGreaterThan(f.indexOf('You are X.'));
    expect(f.indexOf(memory)).toBeLessThan(f.indexOf('The user asks you directly: what word'));
    expect(f).toContain('you may refer back to it');
    const c = questionPrompt('what word', memory);
    expect(c.startsWith(memory)).toBe(true);
    expect(c.endsWith('The user asks you directly: what word')).toBe(true);
    const tp = turnPrompt({ tools: ['Read'], failures: 0, lastBash: '' }, 'hi', 'Hello.', memory);
    expect(tp.startsWith(memory)).toBe(true);
    expect(tp).toContain('you may refer back to it');
  });
  test('a completion\'s question sees the main chat\'s last exchange, after the memory and before the question', () => {
    const exchange = lastExchange('build the thing', 'Built it.');
    expect(exchange).toContain('The user last asked Claude:\nbuild the thing');
    expect(exchange).toContain('Claude answered:\nBuilt it.');
    const q = questionPrompt('can you see the main chat?', memory, exchange);
    expect(q.startsWith(memory)).toBe(true);
    expect(q.indexOf('Built it.')).toBeGreaterThan(q.indexOf(memory));
    expect(q.endsWith('The user asks you directly: can you see the main chat?')).toBe(true);
    expect(lastExchange('', '')).toBe('');
    expect(questionPrompt('hi', '', '')).toBe('The user asks you directly: hi');
  });
  test('the last exchange keeps each end past its cap; the turn prompt reads the same block', () => {
    const long = lastExchange(`START${'a'.repeat(5000)}END`, `HEAD${'b'.repeat(9000)}TAIL`);
    expect(long).toContain('END');
    expect(long).toContain('TAIL');
    expect(long).not.toContain('START');
    expect(long).not.toContain('HEAD');
    expect(turnPrompt({ tools: [], failures: 0, lastBash: '' }, 'p', 'a')).toContain(lastExchange('p', 'a'));
  });
  test('no memory: the prompts as before', () => {
    expect(questionPrompt('hi', '')).toBe('The user asks you directly: hi');
    expect(forkPrompt('You are X.', 'why', '')).toBe(forkPrompt('You are X.', 'why'));
  });
});

describe('the end-of-turn call', () => {
  test('the system: the persona, then a LINE in character and a NEXT in the user\'s own words, NONE only when finished', () => {
    const s = turnSystem('You are X.', { line: true, next: true });
    expect(s.startsWith('You are X.\n\n')).toBe(true);
    expect(s).toContain('LINE:');
    expect(s).toContain('at most 20 words');
    expect(s).toContain('NEXT:');
    expect(s).toContain('the prompt the user is most likely to send Claude next');
    expect(s).toContain("in the user's own words");
    expect(s).toContain('at most 15 words');
    expect(s).toContain('NEXT: NONE');
    expect(s).toContain('Do not use tools.');
  });
  test('the system asks only for what is wanted', () => {
    const line = turnSystem('You are X.', { line: true, next: false });
    expect(line).toContain('LINE:');
    expect(line).not.toContain('NEXT:');
    const next = turnSystem('You are X.', { line: false, next: true });
    expect(next).toContain('NEXT:');
    expect(next).not.toContain('LINE:');
  });
  test('the prompt: the user\'s last prompt, then Claude\'s answer, each keeping its end past its cap', () => {
    const t = { tools: [], failures: 0, lastBash: '' };
    const p = turnPrompt(t, 'add a login page', 'Done: login.tsx is in.');
    expect(p).toContain('The user last asked Claude:\nadd a login page');
    expect(p).toContain('Claude answered:\nDone: login.tsx is in.');
    expect(p.indexOf('add a login page')).toBeLessThan(p.indexOf('Done: login.tsx is in.'));
    const long = turnPrompt(t, `START${'a'.repeat(5000)}END`, `HEAD${'b'.repeat(9000)}TAIL`);
    expect(long).toContain('END');
    expect(long).toContain('TAIL');
    expect(long).not.toContain('START');
    expect(long).not.toContain('HEAD');
    expect(long.length).toBeLessThan(1500 + 4000 + 400);
  });
  test('parseTurnReply: the tagged lines, in any case, bullets tolerated', () => {
    expect(parseTurnReply('LINE: "Tests are green!"\nNEXT: commit this')).toEqual({ line: 'Tests are green!', next: 'commit this' });
    expect(parseTurnReply('  - line: Nice.\n * next:  run   the tests ')).toEqual({ line: 'Nice.', next: 'run the tests' });
    expect(parseTurnReply('NEXT: add a test\nLINE: Onward.')).toEqual({ line: 'Onward.', next: 'add a test' });
  });
  test('parseTurnReply: NEXT NONE, empty or past the cap is no suggestion; an empty LINE is no line', () => {
    expect(parseTurnReply('LINE: Done and dusted.\nNEXT: NONE')).toEqual({ line: 'Done and dusted.', next: null });
    expect(parseTurnReply('LINE:\nNEXT:')).toEqual({ line: null, next: null });
    expect(parseTurnReply(`NEXT: ${'y'.repeat(SUGGESTION_MAX_CHARS + 1)}`)).toEqual({ line: null, next: null });
  });
  test('parseTurnReply: an untagged reply is the line alone', () => {
    expect(parseTurnReply('\n  Quack, that went well.\nmore')).toEqual({ line: 'Quack, that went well.', next: null });
    expect(parseTurnReply('')).toEqual({ line: null, next: null });
  });
  test('one short call: 120 tokens, 30 s', () => {
    expect(TURN_MAX_TOKENS).toBe(120);
    expect(TURN_DEADLINE_MS).toBe(30_000);
  });
  test('suggestionText: the first non-empty line, unquoted, whitespace collapsed', () => {
    expect(suggestionText('\n  "run   the tests"  \nmore')).toBe('run the tests');
    expect(suggestionText('`commit this`')).toBe('commit this');
    expect(suggestionText("'fix the\tlinter'")).toBe('fix the linter');
  });
  test('suggestionText: nothing for an empty reply, NONE in any case, or a line past the cap', () => {
    expect(suggestionText('')).toBeNull();
    expect(suggestionText('  \n ')).toBeNull();
    expect(suggestionText('NONE')).toBeNull();
    expect(suggestionText('none.')).toBeNull();
    expect(suggestionText('"None"')).toBeNull();
    expect(suggestionText('None of the tests ran, rerun them')).toBe('None of the tests ran, rerun them');
    expect(SUGGESTION_MAX_CHARS).toBe(160);
    expect(suggestionText('y'.repeat(SUGGESTION_MAX_CHARS))).toHaveLength(SUGGESTION_MAX_CHARS);
    expect(suggestionText('y'.repeat(SUGGESTION_MAX_CHARS + 1))).toBeNull();
  });
});
