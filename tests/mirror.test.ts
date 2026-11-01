import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error mirror.mjs is an untyped skill script; this test pins its runtime shape
import { parseRound } from '../.claude/skills/mirror/mirror.mjs';

const script = fileURLToPath(new URL('../.claude/skills/mirror/mirror.mjs', import.meta.url));
// Node 22 strips the .ts import only behind this flag; 23.6+ does it by default
const nodeArgs = process.features.typescript ? [] : ['--experimental-strip-types'];

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buddy-mirror-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One round file's end-of-turn call, as src/rounds.ts writes it, under `header`. */
function round(header: string): string {
  return [header, '', '─── IN: system ───', 'You are Fixy.', '', '─── IN: prompt ───', 'Turn 1. The user asked Claude:\nfix it', '', '─── OUT: answered · 12 ms · inTok 10 ───', 'VERDICT: RIGHT', ''].join('\n');
}

describe('mirror parseRound', () => {
  it('keeps a call whose header names no model or effort, those null (the default), sent as written', () => {
    const calls: Record<string, unknown>[] = parseRound(`${round('═══ BUDDY CALL 1 · end-of-turn call · sent 07:53:12.123 ═══')}${round('═══ BUDDY CALL 2 · end-of-turn call · sent 07:54:00.000 · model opus ═══')}`, 'round-1').calls;
    expect(calls.map(({ n, kind, sent, model, effort, reply }) => ({ n, kind, sent, model, effort, reply }))).toEqual([
      { n: 1, kind: 'end-of-turn call', sent: '07:53:12.123', model: null, effort: null, reply: 'VERDICT: RIGHT' },
      { n: 2, kind: 'end-of-turn call', sent: '07:54:00.000', model: 'opus', effort: null, reply: 'VERDICT: RIGHT' },
    ]);
  });
});

describe('mirror live', () => {
  it('names a round file it cannot read on stderr, exits 1, and still shows the rounds that read', () => {
    writeFileSync(join(dir, 'round-1.txt'), round('═══ BUDDY CALL 1 · end-of-turn call · sent 07:53:12.123 · model opus · effort low ═══'));
    mkdirSync(join(dir, 'round-2.txt'));
    const run = spawnSync(process.execPath, [...nodeArgs, script, 'live', dir], { encoding: 'utf8' });
    expect(run.stderr).toBe(`mirror: skipped ${join(dir, 'round-2.txt')}: EISDIR: illegal operation on a directory, read\n`);
    expect(run.status).toBe(1);
    expect(run.stdout.split('\n').slice(0, 3)).toEqual([`buddy folder: ${dir} · 2 rounds · 1 end-of-turn calls`, '', '── round-1 call 1 · sent 07:53:12.123 · answered 12 ms · in 10 · out ?']);
  });
});

describe('mirror replay', () => {
  it('leaves the cost of a reply neither claude nor the price table prices out, never $0', () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat >/dev/null\necho '{"result":"VERDICT: RIGHT","usage":{"input_tokens":10,"output_tokens":5},"duration_ms":7}'\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    const file = join(dir, 'round-1.txt');
    writeFileSync(file, round('═══ BUDDY CALL 1 · end-of-turn call · sent 07:53:12.123 · model gpt-x · effort low ═══'));
    const out = join(dir, 'out');
    const run = spawnSync(process.execPath, [...nodeArgs, script, 'replay', file, '--arms', 'old', '--runs', '1', '--out', out], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd().split('\n').at(-1)).toBe(`  1 calls · 0 failed · $0.000 (1 unpriced, left out) · ledger ${join(out, 'ledger.tsv')}`);
    const row = readFileSync(join(out, 'ledger.tsv'), 'utf8').trimEnd().split('\n')[1]!.split('\t');
    expect(row.slice(4, 10)).toEqual(['old', '1', '7', '10', '5', '']);
  });
});
