import { describe, expect, test } from 'vitest';
import { BACKUP_LIMITS, backupCandidates, configSources, type Listed } from '../plugins/buddy/src/config-source.ts';

// Layout measured on Claude Code 2.1.283 with a scratch HOME: with
// CLAUDE_CONFIG_DIR set it writes `$CLAUDE_CONFIG_DIR/.claude.json` and
// `$CLAUDE_CONFIG_DIR/backups/.claude.json.backup.{ms}` and nothing under HOME;
// without it, `$HOME/.claude.json`, `$HOME/.claude/backups/…`, and a
// `.claude.json.tmp.{pid}.{hex}` left beside the config.

const HOME = '/x/home';
const WORK = '/x/work-config';
const MB = 1024 * 1024;

describe('configSources', () => {
  test('CLAUDE_CONFIG_DIR wins: the config and both backup places are under it, none under HOME', () => {
    const s = configSources({ HOME, CLAUDE_CONFIG_DIR: WORK });
    expect(s).toEqual({
      configFile: `${WORK}/.claude.json`,
      shownConfig: '$CLAUDE_CONFIG_DIR/.claude.json',
      backupDirs: [
        { dir: WORK, shown: '$CLAUDE_CONFIG_DIR', where: 'beside' },
        { dir: `${WORK}/backups`, shown: '$CLAUDE_CONFIG_DIR/backups', where: 'folder' },
      ],
    });
  });

  test('CLAUDE_CONFIG_DIR at HOME/.claude reads HOME/.claude/.claude.json, never HOME/.claude.json', () => {
    const s = configSources({ HOME, CLAUDE_CONFIG_DIR: `${HOME}/.claude` });
    if ('error' in s) throw new Error(s.error);
    expect(s.configFile).toBe(`${HOME}/.claude/.claude.json`);
    expect(s.backupDirs.map((d) => d.dir)).toEqual([`${HOME}/.claude`, `${HOME}/.claude/backups`]);
  });

  test('without CLAUDE_CONFIG_DIR: HOME/.claude.json and HOME/.claude/backups', () => {
    expect(configSources({ HOME })).toEqual({
      configFile: `${HOME}/.claude.json`,
      shownConfig: '~/.claude.json',
      backupDirs: [
        { dir: HOME, shown: '~', where: 'beside' },
        { dir: `${HOME}/.claude/backups`, shown: '~/.claude/backups', where: 'folder' },
      ],
    });
  });

  test('an empty CLAUDE_CONFIG_DIR is unset; trailing slashes are dropped', () => {
    const s = configSources({ HOME: `${HOME}//`, CLAUDE_CONFIG_DIR: '' });
    if ('error' in s) throw new Error(s.error);
    expect(s.configFile).toBe(`${HOME}/.claude.json`);
    const c = configSources({ CLAUDE_CONFIG_DIR: `${WORK}/` });
    if ('error' in c) throw new Error(c.error);
    expect(c.configFile).toBe(`${WORK}/.claude.json`);
    expect(c.backupDirs[1]?.dir).toBe(`${WORK}/backups`);
  });

  test('a root directory joins without a double slash', () => {
    const s = configSources({ CLAUDE_CONFIG_DIR: '/' });
    if ('error' in s) throw new Error(s.error);
    expect(s.configFile).toBe('/.claude.json');
    expect(s.backupDirs.map((d) => d.dir)).toEqual(['/', '/backups']);
  });

  test('neither set: an error naming both, not a path', () => {
    for (const env of [{}, { HOME: '', CLAUDE_CONFIG_DIR: '' }]) {
      const s = configSources(env);
      expect(s).toEqual({ error: expect.stringContaining('neither CLAUDE_CONFIG_DIR nor HOME is set') });
    }
  });
});

describe('backupCandidates', () => {
  const beside = (name: string, size?: number, mtimeMs?: number): Listed => ({ name, where: 'beside', kind: 'file', size, mtimeMs });
  const folder = (name: string, size?: number, mtimeMs?: number): Listed => ({ name, where: 'folder', kind: 'file', size, mtimeMs });

  test('the limits: newest 10, nothing over 5 MB', () => {
    expect(BACKUP_LIMITS).toEqual({ maxCount: 10, maxBytes: 5 * MB });
  });

  test('keeps real backup names; drops the atomic-write temp file and names no backup has', () => {
    const r = backupCandidates([
      beside('.claude.json', 900),
      beside('.zshrc', 40),
      beside('.claude.json.backup', 100, 1),
      beside('.claude.json.backup.1790479661744', 100, 2),
      beside('.claude.json.bak', 100, 3),
      beside('.claude.json.bak-20260101-120000', 100, 4),
      beside('.claude.json.pre-tool-20260101-120000', 100, 5),
      beside('.claude.json.tmp.19619.f8ffd46122d4', 100, 6),
      beside('.claude.json.corrupted.1790000000000', 100, 7),
      beside('.claude.json.lock', 100, 8),
      folder('.claude.json.backup.1790479664737', 100, 9),
      folder('notes.txt', 100, 10),
    ]);
    expect(r.keep.map((e) => e.name)).toEqual([
      '.claude.json.backup.1790479664737',
      '.claude.json.pre-tool-20260101-120000',
      '.claude.json.bak-20260101-120000',
      '.claude.json.bak',
      '.claude.json.backup.1790479661744',
      '.claude.json.backup',
    ]);
    expect(r.dropped).toEqual([
      { name: '.claude.json.tmp.19619.f8ffd46122d4', where: 'beside', reason: 'an unfinished write (.tmp)' },
      { name: '.claude.json.corrupted.1790000000000', where: 'beside', reason: 'not a backup name' },
      { name: '.claude.json.lock', where: 'beside', reason: 'not a backup name' },
      { name: 'notes.txt', where: 'folder', reason: 'not a backup name' },
    ]);
  });

  test('files beside the config that are not .claude.json.* are ignored, not reported', () => {
    const r = backupCandidates([beside('.claude.json'), beside('.bashrc', 10), beside('notes.claude.json.backup', 10)]);
    expect(r).toEqual({ keep: [], dropped: [] });
  });

  test('the 0-byte temp file is dropped before it can read as a skipped backup', () => {
    const r = backupCandidates([beside('.claude.json.tmp.19619.f8ffd46122d4', 0), beside('.claude.json.backup', 0)]);
    expect(r.keep).toEqual([]);
    expect(r.dropped.map((d) => d.reason)).toEqual(['an unfinished write (.tmp)', 'empty (0 bytes)']);
  });

  test('a folder entry is dropped; a link is kept for its stat to size', () => {
    const r = backupCandidates([
      { name: '.claude.json.backup.1', where: 'folder', kind: 'dir' },
      { name: '.claude.json.backup.2', where: 'folder', kind: 'other' },
    ]);
    expect(r.keep.map((e) => e.name)).toEqual(['.claude.json.backup.2']);
    expect(r.dropped).toEqual([{ name: '.claude.json.backup.1', where: 'folder', reason: 'a folder' }]);
  });

  test('over 5 MB is dropped with its size; exactly 5 MB and an unknown size are kept', () => {
    const r = backupCandidates([folder('.claude.json.backup.1', 5 * MB + 1, 3), folder('.claude.json.backup.2', 5 * MB, 2), folder('.claude.json.backup.3', undefined, 1)]);
    expect(r.keep.map((e) => e.name)).toEqual(['.claude.json.backup.2', '.claude.json.backup.3']);
    expect(r.dropped).toEqual([{ name: '.claude.json.backup.1', where: 'folder', reason: 'too big to read (5.0 MB, the cap is 5 MB)' }]);
  });

  test('capped at the newest 10 by modification time; the rest say why', () => {
    const listing = Array.from({ length: 14 }, (_, i) => folder(`.claude.json.backup.${1000 + i}`, 100, 1000 + i));
    const r = backupCandidates(listing);
    expect(r.keep.map((e) => e.mtimeMs)).toEqual([1013, 1012, 1011, 1010, 1009, 1008, 1007, 1006, 1005, 1004]);
    expect(r.dropped).toEqual([1003, 1002, 1001, 1000].map((t) => ({ name: `.claude.json.backup.${t}`, where: 'folder', reason: 'past the newest 10' })));
  });

  test('newest first, then by name; an entry with no time sorts last', () => {
    const r = backupCandidates([beside('.claude.json.bak-a', 1), beside('.claude.json.bak-b', 1), beside('.claude.json.bak-c', 1, 5), beside('.claude.json.bak-d', 1, 9)]);
    expect(r.keep.map((e) => e.name)).toEqual(['.claude.json.bak-d', '.claude.json.bak-c', '.claude.json.bak-b', '.claude.json.bak-a']);
  });

  test("the caller's own fields ride along, and a second pass over what it kept keeps it all", () => {
    const listing = [{ ...folder('.claude.json.backup.7', 10, 7), path: '/p/7', label: 'l7' }];
    const first = backupCandidates(listing, { maxCount: Number.POSITIVE_INFINITY, maxBytes: BACKUP_LIMITS.maxBytes });
    expect(first.keep[0]).toEqual({ name: '.claude.json.backup.7', where: 'folder', kind: 'file', size: 10, mtimeMs: 7, path: '/p/7', label: 'l7' });
    expect(backupCandidates(first.keep)).toEqual({ keep: first.keep, dropped: [] });
  });
});
