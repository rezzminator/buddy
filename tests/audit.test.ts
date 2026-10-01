import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/audit.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const M = 1_000_000;

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buddy-audit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One `call.cost` log line in the shape the plugin writes; `over` replaces fields (a `usd` is added by naming it). */
function cost(over: Record<string, unknown>): string {
  return JSON.stringify({
    ts: '2026-09-30T10:00:00.000Z',
    level: 'info',
    event: 'call.cost',
    session: 's1',
    character: 'c',
    kind: 'endOfTurn',
    model: 'opus',
    outcome: 'answered',
    ms: 1000,
    inTok: 0,
    cacheRead: 0,
    cacheWrite: 0,
    outTok: 0,
    cachePct: 0,
    memTurns: 1,
    memKept: 10,
    memFull: 20,
    promptChars: 100,
    ...over,
  });
}

/** Writes the lines to a log file in the temp dir and runs the audit on it. */
function audit(lines: string[]): { out: string; status: number | null } {
  const file = join(dir, 'buddy.log');
  writeFileSync(file, `${lines.join('\n')}\n`);
  const run = spawnSync(process.execPath, [script, file], { cwd: root, encoding: 'utf8' });
  return { out: run.stdout, status: run.status };
}

/** The cells of the table row that starts with `name`: calls, failed, in tok, out tok, cost, /100 calls, turns, cut, avg. */
function rowCells(out: string, name: string): string[] {
  const line = out.split('\n').find((l) => l.startsWith(name));
  if (line === undefined) throw new Error(`no row ${name} in:\n${out}`);
  return line.trim().split(/\s{2,}/).slice(1);
}

describe('audit default logs', () => {
  it('reads every rotated archive and the live log under $CLAUDE_CONFIG_DIR/buddy', () => {
    const config = join(dir, 'config');
    const home = join(dir, 'home');
    mkdirSync(join(config, 'buddy'), { recursive: true });
    mkdirSync(home);
    for (const name of ['buddy.log', 'buddy.log.1', 'buddy.log.2']) writeFileSync(join(config, 'buddy', name), `${cost({ inTok: M })}\n`);
    // HOME is an empty dir, so the real ~/.claude/buddy is never read
    const run = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config, HOME: home } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Buddy model calls from 3 log file(s)');
    expect(rowCells(run.stdout, 'total')[0]).toBe('3');
  });
});

describe('audit cost', () => {
  it('totals the usd a line logged, even when its tokens would price differently', () => {
    const { out, status } = audit([cost({ usd: 1.5, inTok: M, outTok: M })]);
    expect(status).toBe(0);
    const total = rowCells(out, 'total');
    expect(total[4]).toBe('$1.500');
    expect(total[5]).toBe('$150.00');
    expect(out).toContain('priced: 1 as logged, 0 from the price table');
    expect(out).not.toContain('Not priced');
  });

  it('prices an old opus line with no usd from the table: input, cache read, cache write at the 5-minute rate, output', () => {
    const { out, status } = audit([cost({ inTok: M, cacheRead: M, cacheWrite: M, outTok: M })]);
    expect(status).toBe(0);
    const total = rowCells(out, 'total');
    expect(total[2]).toBe('3.0M');
    expect(total[4]).toBe('$29.200');
    expect(total[5]).toBe('$2920.00');
    expect(out).toContain('priced: 0 as logged, 1 from the price table');
    expect(out).not.toContain('Not priced');
  });

  it('names an unknown model, leaves its dollars out of the total and never counts it as $0', () => {
    const { out, status } = audit([
      cost({ inTok: M }),
      cost({ kind: 'ask', model: 'gpt-x', inTok: M, outTok: M }),
      cost({ kind: 'ask', model: 'gpt-x', inTok: M }),
    ]);
    expect(status).toBe(0);
    expect(out).toContain('Not priced, left out of the cost: gpt-x (2 calls)');
    expect(out).not.toMatch(/counted as \$0/);
    expect(out).toContain('priced: 0 as logged, 1 from the price table');

    // the total keeps every call and token but sums, and averages over, the one priced call
    const total = rowCells(out, 'total');
    expect(total[0]).toBe('3');
    expect(total[2]).toBe('3.0M');
    expect(total[4]).toBe('$4.000*');
    expect(total[5]).toBe('$400.00');

    // a row whose calls are all unpriced shows a dash in both money columns, and still counts its calls
    const ask = rowCells(out, 'ask');
    expect(ask[0]).toBe('2');
    expect(ask.slice(4, 6)).toEqual(['-', '-']);

    // a row with some unpriced calls is starred, a row with none is not
    expect(rowCells(out, '2026-09-30')[4]).toBe('$4.000*');
    expect(rowCells(out, 'endOfTurn')[4]).toBe('$4.000');
  });

  it('prices a dated id as the id without its date', () => {
    const { out } = audit([cost({ model: 'claude-haiku-4-5-20251001', inTok: M, outTok: M })]);
    expect(rowCells(out, 'total')[4]).toBe('$6.000');
    expect(out).not.toContain('Not priced');
  });

  it('prices a dated id from its own row, not from its family alias', () => {
    // claude-opus-4-5 is $5/$25; the opus alias is claude-opus-5-5 at $4/$20
    const { out } = audit([cost({ model: 'claude-opus-4-5-20251101', inTok: M, outTok: M })]);
    expect(rowCells(out, 'total')[4]).toBe('$30.000');
  });

  it('leaves a name that is neither an alias, an id nor an id with an 8-digit date unpriced', () => {
    const { out } = audit([cost({ model: 'claude-haiku-4-5-2025', inTok: M })]);
    expect(out).toContain('Not priced, left out of the cost: claude-haiku-4-5-2025 (1 calls)');
    expect(rowCells(out, 'total').slice(4, 6)).toEqual(['-', '-']);
  });
});

describe('audit price table', () => {
  it('prices a line with no usd through ../plugins/buddy/src/prices.ts and reads no other table', () => {
    // a copy of the script beside a stand-in prices.ts, and nothing else: the only table it can reach is that module's priceCall
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'plugins', 'buddy', 'src'), { recursive: true });
    copyFileSync(script, join(dir, 'scripts', 'audit.mjs'));
    writeFileSync(
      join(dir, 'plugins', 'buddy', 'src', 'prices.ts'),
      "export function priceCall(model: string): number | undefined {\n  return model === 'stand-in' ? 42 : undefined;\n}\n",
    );
    const file = join(dir, 'buddy.log');
    writeFileSync(file, `${cost({ model: 'stand-in', inTok: M })}\n${cost({ model: 'opus', inTok: M })}\n`);
    const run = spawnSync(process.execPath, [join(dir, 'scripts', 'audit.mjs'), file], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    const total = rowCells(run.stdout, 'total');
    expect(total[4]).toBe('$42.000*');
    expect(run.stdout).toContain('priced: 0 as logged, 1 from the price table');
    expect(run.stdout).toContain('Not priced, left out of the cost: opus (1 calls)');
  });
});
