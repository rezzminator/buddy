import { describe, expect, test } from 'vitest';
import { ONE_LINE_RULE, SUGGESTION_MAX_CHARS, forkPrompt, lostThread, oneLine, oneLineSystem, questionPrompt, quipPrompt, suggestPrompt, suggestionText } from '../plugins/buddy/src/prompts.ts';

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
  test('the quip prompt counts tools and caps the command', () => {
    const p = quipPrompt({ tools: ['Bash', 'Read', 'Bash'], failures: 1, lastBash: 'x'.repeat(200) });
    expect(p).toBe(`The turn just ended. Tools used: Bash x2, Read. Failures: 1. Last shell command: ${'x'.repeat(120)}. React to it.`);
    expect(quipPrompt({ tools: ['Read'], failures: 0, lastBash: '' })).toContain('Last shell command: none.');
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
    const qp = quipPrompt({ tools: ['Read'], failures: 0, lastBash: '' }, memory);
    expect(qp.indexOf(memory)).toBeLessThan(qp.indexOf('The turn just ended.'));
  });
  test('no memory: the prompts as before', () => {
    expect(questionPrompt('hi', '')).toBe('The user asks you directly: hi');
    expect(forkPrompt('You are X.', 'why', '')).toBe(forkPrompt('You are X.', 'why'));
  });
});

describe('the prompt suggestion', () => {
  test('the fork prompt: the persona, then the next prompt in the person\'s own words, NONE when unclear, no tools', () => {
    const p = suggestPrompt('You are X.');
    expect(p.startsWith('You are X.\n\n')).toBe(true);
    expect(p).toContain('the prompt the user is most likely to send Claude next');
    expect(p).toContain("in the user's own words");
    expect(p).toContain('at most 15 words');
    expect(p).toContain('NONE');
    expect(p).toContain('Do not use tools.');
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
