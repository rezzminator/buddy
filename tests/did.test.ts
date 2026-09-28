import { describe, expect, test } from 'vitest';
import { DID_FILES_MAX, DID_MAX, DID_TEXT_CAP, actionOf, didOf, type Action } from '../plugins/buddy/src/did.ts';

const did = (...calls: [Record<string, unknown> & { tool: string }, boolean?][]): string[] =>
  didOf(calls.map(([c, failed]) => actionOf(c, failed === true)).filter((a): a is Action => a !== null));

describe('a step', () => {
  test('a shell command is its description, never its output; failed marked', () => {
    expect(did([{ tool: 'Bash', command: 'npm test', description: 'Run the unit tests' }, true])).toEqual(['Run the unit tests (failed)']);
  });
  test('an undescribed command without its cds, paths cut to their last part, at most 50', () => {
    expect(did([{ tool: 'Bash', command: 'cd /Users/x/repo && cat /Users/x/repo/src/a.ts' }])).toEqual(['ran cat a.ts']);
    expect(did([{ tool: 'Bash', command: `echo ${'y'.repeat(80)}` }])[0]).toHaveLength(54);
  });
  test('a file tool by its verb and the file name; an agent, a skill, the web, an MCP tool by what they did', () => {
    expect(did(
      [{ tool: 'Agent', description: 'Audit the diff', prompt: 'long…' }],
      [{ tool: 'Skill', skill: 'dev' }],
      [{ tool: 'WebFetch', url: 'https://example.com/a/b?c=1' }],
      [{ tool: 'mcp__professor__chat_new', name: 'x' }],
      [{ tool: 'SendMessage', to: 'gitter', message: 'm' }],
    )).toEqual(['agent: Audit the diff', 'skill dev', 'fetched example.com', 'chat new', 'messaged gitter']);
  });
  test('bookkeeping says nothing of the work: dropped', () => {
    expect(did([{ tool: 'ToolSearch', query: 'x' }], [{ tool: 'TaskStop', task_id: '1' }], [{ tool: 'Monitor' }])).toEqual([]);
    expect(actionOf({ tool: 'Read' }, false)).toBeNull();
  });
});

describe('the turn', () => {
  test('files gathered under their verb, each once, where the verb first came', () => {
    expect(did(
      [{ tool: 'Read', file_path: '/r/src/a.ts' }],
      [{ tool: 'Bash', command: 'x', description: 'Run the tests' }],
      [{ tool: 'Edit', file_path: '/r/src/a.ts' }],
      [{ tool: 'Read', file_path: '/r/src/b.ts' }],
      [{ tool: 'Edit', file_path: '/r/src/a.ts' }],
      [{ tool: 'Grep', pattern: 'turnFacts' }],
    )).toEqual(['read a.ts, b.ts', 'Run the tests', 'edited a.ts', 'searched turnFacts']);
  });
  test('a step said twice in a row once; past DID_FILES_MAX files counted; each step capped', () => {
    const edits = Array.from({ length: DID_FILES_MAX + 2 }, (_, i) => [{ tool: 'Edit', file_path: `f${i}.ts` }] as [{ tool: string; file_path: string }]);
    expect(did(...edits)).toEqual([`edited ${Array.from({ length: DID_FILES_MAX }, (_, i) => `f${i}.ts`).join(', ')} +2`]);
    expect(did([{ tool: 'Bash', command: 'a', description: 'Wait' }], [{ tool: 'Bash', command: 'a', description: 'Wait' }])).toEqual(['Wait']);
    expect(did([{ tool: 'Bash', command: 'a', description: 'z'.repeat(200) }])[0]).toHaveLength(DID_TEXT_CAP);
  });
  test('past DID_MAX steps: the first and the last stay around a count of the rest', () => {
    const steps = Array.from({ length: 20 }, (_, i) => [{ tool: 'Bash', command: 'a', description: `step ${i}` }] as [{ tool: string; command: string; description: string }]);
    const d = did(...steps);
    expect(d).toHaveLength(DID_MAX);
    expect(d.slice(0, 5)).toEqual(['step 0', 'step 1', 'step 2', 'step 3', '… 9 more']);
    expect(d.at(-1)).toBe('step 19');
  });
});
