import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const lib = fileURLToPath(new URL('../scripts/live-lib.sh', import.meta.url));
const report = fileURLToPath(new URL('../scripts/live-configs-report.mjs', import.meta.url));

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buddy-live-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** `call` run in bash with scripts/live-lib.sh sourced, RUN, PROJECTS and ID set to this test's folder. */
function helper(call: string): { out: string; err: string; status: number | null } {
  const run = spawnSync('bash', ['-c', `. "$LIB"; ${call}`], { encoding: 'utf8', env: { ...process.env, LIB: lib, RUN: dir, PROJECTS: join(dir, 'projects'), ID: 'sid-1' } });
  return { out: run.stdout, err: run.stderr, status: run.status };
}

describe('live-lib reads line by line', () => {
  it('log_from: a buddy log line that is no JSON costs only itself, from the line asked', () => {
    mkdirSync(join(dir, 'logs', 'buddy'), { recursive: true });
    writeFileSync(join(dir, 'logs', 'buddy', 'buddy.log'), ['{"event":"a"}', '{"event":"b"}', '{"event":', '{"event":"c"}', ''].join('\n'));
    expect(helper('log_from 1')).toEqual({ out: '{"event":"b"}\n{"event":"c"}\n', err: '', status: 0 });
  });

  it('stdout_rows: every /buddy reply of the transcript, a line that is no JSON between them skipped', () => {
    const row = (text: string) => JSON.stringify({ type: 'system', content: `<local-command-stdout>${text}</local-command-stdout>` });
    mkdirSync(join(dir, 'projects', 'slug'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'slug', 'sid-1.jsonl'), [row('first\nsecond line'), '{"type":"user","mess', row('third'), ''].join('\n'));
    expect(helper('stdout_rows')).toEqual({ out: 'first / second line\nthird\n', err: '', status: 0 });
  });
});

describe('live configuration report', () => {
  it('leaves a turns.jsonl line that is no JSON out of the per-turn table and says how many, the other turns kept', () => {
    const s = join(dir, 'S1');
    mkdirSync(s);
    writeFileSync(join(s, 'exit'), '0\n');
    writeFileSync(join(s, 'checks.tsv'), 'PASS\tthe check\tits evidence\n');
    const turn = (t: string) => JSON.stringify({ session: 'S1', turn: t, modelCalls: 1, errors: [] });
    writeFileSync(join(s, 'turns.jsonl'), [turn('T1'), '{"session":"S1","tu', turn('T2'), ''].join('\n'));
    const run = spawnSync(process.execPath, [report, dir, 'S1'], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const json = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    expect(json.turns.map((t: { turn: string }) => t.turn)).toEqual(['T1', 'T2']);
    expect(json.unparsed).toEqual([{ session: 'S1', lines: 1 }]);
    expect(readFileSync(join(dir, 'report.md'), 'utf8').split('\n').at(-1)).toBe("1 line(s) of S1's turns.jsonl did not parse and are left out of the per-turn table.");
  });
});
