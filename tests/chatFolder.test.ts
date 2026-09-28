import { describe, expect, test } from 'vitest';
import { buddyFolder, isSessionId, projectSlug, projectsDir, transcriptPath } from '../plugins/buddy/src/chatFolder.ts';

describe("the chat's own folder", () => {
  test('the projects folder follows CLAUDE_CONFIG_DIR, else HOME; none without either', () => {
    expect(projectsDir({ CLAUDE_CONFIG_DIR: '/cfg', HOME: '/h' })).toBe('/cfg/projects');
    expect(projectsDir({ HOME: '/h' })).toBe('/h/.claude/projects');
    expect(projectsDir({})).toBeNull();
  });
  test("a project's folder is its path with every character but a letter or digit made '-'", () => {
    expect(projectSlug('/work/my.app')).toBe('-work-my-app');
    expect(projectSlug('/a/b_c d')).toBe('-a-b-c-d');
  });
  test('the buddy folder sits in the folder named after the session, beside its transcript', () => {
    expect(transcriptPath('/p', '-w', 'abc-1')).toBe('/p/-w/abc-1.jsonl');
    expect(buddyFolder('/p', '-w', 'abc-1')).toBe('/p/-w/abc-1/buddy');
  });
  test('only a session id of letters, digits, - and _ names a folder', () => {
    expect(isSessionId('0b1c2d3e-aaaa-4bbb-8ccc-123456789abc')).toBe(true);
    expect(['', '../x', 'a/b', 'a b'].map(isSessionId)).toEqual([false, false, false, false]);
  });
});
