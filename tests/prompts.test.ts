import { describe, expect, test } from 'vitest';
import { ONE_LINE_RULE, forkPrompt, lostThread, oneLine, oneLineSystem, questionPrompt, quipPrompt } from '../plugins/buddy/src/prompts.ts';

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
