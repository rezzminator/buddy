import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { typedByUser } from '../plugins/buddy/src/chatTurnsToRead.ts';
import { ITEMS_HEAD } from '../plugins/buddy/src/memoryItems.ts';
import {
  type Answer,
  type Harness,
  type Round,
  type RoundCall,
  type SuiteRow,
  type Tags,
  LEDGER_HEADER,
  NOTES_HEAD,
  SUITE_HEADER,
  passes,
  promptFor,
  readSuite,
  runSuite,
  typedPrompts,
} from '../scripts/mirror-suite.ts';

const SRC = fileURLToPath(new URL('../plugins/buddy/src', import.meta.url));
const TAGS = ['DESIRE', 'VERDICT', 'WHY', 'COMMENT_AFTER_EACH_TURN', 'PROMPT_TO_MAIN_CHAT', 'SUGGEST_NEXT_PROMPT', 'MEMORY'];

// mirror.mjs's tagged, as the harness passes it.
function tagged(reply: string): Tags {
  const out: Record<string, string | string[]> = {};
  for (const raw of reply.split('\n')) {
    const m = /^([A-Z_]+):\s*(.*)$/.exec(raw.trim());
    if (!m || !TAGS.includes(m[1]!)) continue;
    if (m[1] === 'MEMORY') ((out.MEMORY ??= []) as string[]).push(m[2]!);
    else out[m[1]!] ??= m[2]!;
  }
  return out;
}

// A round file's call section, as rounds.ts writes it.
function section(n: number, kind: string, system: string, prompt: string, reply: string): string {
  return [
    `═══ BUDDY CALL ${n} · ${kind} · sent 07:53:12.123 · model opus · effort low ═══`,
    '',
    '─── IN: system ───',
    system,
    '',
    '─── IN: prompt ───',
    prompt,
    '',
    '─── OUT: answered · 812 ms · inTok 900 · outTok 12 ───',
    reply,
    '',
  ].join('\n');
}

// A minimal parseRound over the sections above.
function parseRound(text: string, file: string): Round {
  const calls: RoundCall[] = [];
  for (const chunk of text.split(/^(?=═══ BUDDY CALL )/m)) {
    const h = /^═══ BUDDY CALL (\d+) · ([^·]+?) · sent (\S+) · model (\S+) · effort (\S+)/.exec(chunk);
    if (!h) continue;
    const part = (head: RegExp): string => chunk.split(head)[1]?.split(/^─── /m)[0]?.trim() ?? '';
    const out = /^─── OUT: (.*) ───$/m.exec(chunk)?.[1] ?? '';
    calls.push({ file, n: Number(h[1]), kind: h[2]!.trim(), sent: h[3]!, model: h[4]!, effort: h[5]!, system: part(/^─── IN: system ───$/m), prompt: part(/^─── IN: prompt ───$/m), reply: part(/^─── OUT: .* ───$/m), out });
  }
  return { file, opening: '', calls };
}

type Fake = Harness & { asked: { system: string; prompt: string; model: string; effort: string }[]; lines: string[] };

function fakeHarness(answer: (system: string, prompt: string) => Answer = () => ({ text: 'PROMPT_TO_MAIN_CHAT: NONE.', ms: 5, usd: 0.01 }), src: string | null = null): Fake {
  const asked: Fake['asked'] = [];
  const lines: string[] = [];
  return {
    asked,
    lines,
    parseRound,
    tagged,
    systemFor: async (arm, captured) => (arm === 'old' ? captured : `${arm}|${captured}`),
    srcFor: (arm) => (arm === 'old' ? null : src),
    ask: async (system, prompt, model, effort) => {
      asked.push({ system, prompt, model, effort });
      return answer(system, prompt);
    },
    pool: async <T,>(jobs: (() => Promise<T>)[]) => {
      const out: T[] = [];
      for (const job of jobs) out.push(await job());
      return out;
    },
    armTag: (arm) => arm,
    log: (line) => lines.push(line),
  };
}

const SYSTEM = 'You are Quack.\n\nBecome this character completely.';
const reply = (p2m: string): string => `VERDICT: RIGHT\nPROMPT_TO_MAIN_CHAT: ${p2m}`;

type Spec = { id: string; kind: string; captured: string; check?: string; call?: string; prompt?: string; round?: string };

/** A temp folder holding one round file per row (its prompt naming the row) and the suite file. */
function suite(specs: Spec[]): { dir: string; file: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-suite-test-'));
  mkdirSync(join(dir, 'rounds'));
  const rows = specs.map((s) => {
    const round = s.round ?? `rounds/${s.id}.txt`;
    if (!s.round) writeFileSync(join(dir, round), section(1, 'end-of-turn call', SYSTEM, `prompt of ${s.id}`, s.captured));
    return [s.id, round, s.call ?? '-', s.kind, s.kind === 'control' ? '-' : 'p2m-wrong', 'PROMPT_TO_MAIN_CHAT', s.check ?? 'none', '-', s.prompt ?? '-', 'what the audit found'].join('\t');
  });
  const file = join(dir, 'suite.tsv');
  writeFileSync(file, [SUITE_HEADER, ...rows, ''].join('\n'));
  return { dir, file, out: join(dir, 'out') };
}

function row(over: Partial<SuiteRow>): SuiteRow {
  return { id: 'x-r001', round: '/w/app/r.txt', call: null, kind: 'defect', cause: '-', line: 'PROMPT_TO_MAIN_CHAT', check: 'none', pattern: null, prompt: null, why: '', ...over };
}

describe('readSuite', () => {
  test('reads the rows, skipping a comment and a blank line, and resolves relative paths against the base folder', () => {
    const text = [
      SUITE_HEADER,
      '# a comment',
      '',
      ['s1-r001', 'rounds/round-001.txt', '-', 'defect', 'stale-rule', 'PROMPT_TO_MAIN_CHAT', 'match', "user'?s rule", '-', 'quoted a rule'].join('\t'),
      ['s1-r002-s', '/w/rounds/round-002.txt', '3', 'control', '-', 'SUGGEST_NEXT_PROMPT', 'some', '-', 'suite/p.txt', 'a fine suggestion'].join('\t'),
    ].join('\n');
    const rows = readSuite(text, '/w/app');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 's1-r001', round: '/w/app/rounds/round-001.txt', call: null, kind: 'defect', cause: 'stale-rule', check: 'match', prompt: null, why: 'quoted a rule' });
    expect(rows[0]!.pattern!.test("The User's rule")).toBe(true);
    expect(rows[1]).toMatchObject({ id: 's1-r002-s', round: '/w/rounds/round-002.txt', call: 3, kind: 'control', line: 'SUGGEST_NEXT_PROMPT', pattern: null, prompt: '/w/app/suite/p.txt' });
  });

  test('a first line other than the header throws, naming the header', () => {
    expect(() => readSuite('id\tround\tcall\n', '/w/app')).toThrow(/header/);
  });

  const good = ['s1-r001', 'r.txt', '-', 'defect', 'c', 'PROMPT_TO_MAIN_CHAT', 'none', '-', '-', 'why'];
  const swap = (at: number, v: string): string => good.map((f, i) => (i === at ? v : f)).join('\t');
  test.each([
    ['9 fields', good.slice(0, 9).join('\t'), 'fields'],
    ['an unknown kind', swap(3, 'bug'), 'kind'],
    ['an unknown check', swap(6, 'maybe'), 'check'],
    ['an unknown line', swap(5, 'DESIRE'), 'line'],
    ['match with a - pattern', swap(6, 'match'), 'pattern'],
    ['an invalid regex', good.map((f, i) => (i === 6 ? 'no-match' : i === 7 ? 'rule(' : f)).join('\t'), 'pattern'],
    ['a duplicate id', `${good.join('\t')}\n${good.join('\t')}`, 'id'],
  ])('%s throws naming the row id and the field', (_, line, field) => {
    expect(() => readSuite(`${SUITE_HEADER}\n${line}\n`, '/w/app')).toThrow(new RegExp(`row s1-r001: .*${field}`));
  });
});

describe('passes', () => {
  test('none passes on NONE. or an absent line and fails on a prompt; some the opposite', () => {
    const replies = [tagged('PROMPT_TO_MAIN_CHAT: NONE.'), tagged('PROMPT_TO_MAIN_CHAT: Run the tests before you tag.'), tagged('VERDICT: RIGHT')];
    expect(replies.map((t) => passes(row({ check: 'none' }), t))).toEqual([true, false, true]);
    expect(replies.map((t) => passes(row({ check: 'some' }), t))).toEqual([false, true, false]);
  });

  test("match and no-match test the line's pattern; an absent line fails match and passes no-match", () => {
    const pattern = new RegExp("user'?s (standing )?rule", 'i');
    const said = tagged("PROMPT_TO_MAIN_CHAT: The user's rule says ask before pushing.");
    const absent = tagged('VERDICT: RIGHT');
    expect(passes(row({ check: 'match', pattern }), said)).toBe(true);
    expect(passes(row({ check: 'no-match', pattern }), said)).toBe(false);
    expect(passes(row({ check: 'match', pattern }), absent)).toBe(false);
    expect(passes(row({ check: 'no-match', pattern }), absent)).toBe(true);
  });

  test.each(['none', 'no-match', 'no-new-rule'] as const)('a reply with no tagged line fails %s', (check) => {
    const pattern = check === 'no-match' ? /never/ : null;
    expect(passes(row({ check, pattern }), tagged('I could not judge this turn.'))).toBe(false);
    expect(passes(row({ check, pattern }), { MEMORY: [] })).toBe(false);
  });

  test('no-new-rule fails on a MEMORY line adding a rule with words, passes on an end or a line that is not JSON', () => {
    const check = row({ check: 'no-new-rule', line: 'MEMORY' });
    expect(passes(check, tagged('MEMORY: {"rule.ship-it":{"words":"god speed","covers":"x"}}'))).toBe(false);
    expect(passes(check, tagged('MEMORY: {"rule.ship-it":{"end":"lifted: x"}}'))).toBe(true);
    expect(passes(check, tagged('MEMORY: not json'))).toBe(true);
  });
});

const CAPTURED = [
  NOTES_HEAD,
  '- rule: never push without asking',
  '- rule: always squash merges',
  '- fact: the tests pass on develop',
  '',
  'What you remember, oldest first:',
  '',
  'Turn 1. The user asked Claude:',
  'fix the build',
  'and never push without asking',
  'Claude did: ran npm test',
  'Claude answered:',
  'Fixed.',
  '',
  'Turn 2. The user asked Claude:',
  'merge it — sid 0123abcd · to reply: chat_inject X <message>',
  'Claude answered:',
  'Merged.',
  '',
  'Turn 3. Claude was sent, not by the user (task-notification):',
  '<task-notification>done</task-notification>',
  'Claude answered:',
  'Noted.',
].join('\n');

describe('typedPrompts', () => {
  const typed = (prompt: string): string[] => typedPrompts(prompt, typedByUser);

  test('returns the typed turn of two lines, leaving out a signed message and a task notification', () => {
    expect(typed(CAPTURED)).toEqual(['fix the build\nand never push without asking']);
  });

  test('keeps a blank line inside a prompt, stops before an interrupted, errored or refused answer, and keeps each added line', () => {
    const prompt = [
      'Turn 1. The user asked Claude:',
      'fix the build',
      '',
      'and never push without asking',
      'Claude answered, before the user interrupted the turn:',
      'Pushing now.',
      '',
      'Turn 2. The user asked Claude:',
      'try again',
      'The user added while Claude worked: and keep the tests green',
      'The user added while Claude worked, after 2 tool calls: also squash',
      '',
      'the merge',
      'Claude did 2 steps: ran npm test; ran git status',
      'Numbers: 12s · 2 tool calls',
      'Claude answered, before an error ended the turn:',
      'Error.',
      '',
      'Turn 3. Claude was sent, not by the user (task-notification):',
      'done',
      'The user added while Claude worked: ship it',
      'Claude answered, before the model refused and ended the turn:',
      'No.',
    ].join('\n');
    expect(typed(prompt)).toEqual(['fix the build\n\nand never push without asking', 'try again', 'and keep the tests green', 'also squash\n\nthe merge', 'ship it']);
  });

  test("splits a turn's suggested and sent lines: an extended suggestion gives the user's words only, an unedited one nothing", () => {
    const turn = (k: number, suggested: string, sent: string): string[] => [`Turn ${k}. The user asked Claude:`, `suggested: ${suggested}`, `sent: ${sent}`, 'Claude answered:', 'Done.', ''];
    const prompt = [...turn(1, 'none', 'run the tests'), ...turn(2, 'Run the linter', 'Run the linter, then never push'), ...turn(3, 'Tag it', 'Tag it')].join('\n');
    expect(typed(prompt)).toEqual(['run the tests', 'then never push']);
  });
});

describe('promptFor', () => {
  test('converts the notes block to the source item memory: a typed rule a rule, an untyped one an unverified fact, a fact kept', async () => {
    const got = await promptFor(SRC, CAPTURED);
    const block = [
      ITEMS_HEAD,
      'rule.never-push-without-asking · never push without asking · user · 0',
      "fact.always-squash-merges · Noted earlier as the user's rule, unverified: always squash merges · buddy · 0",
      'fact.the-tests-pass-on · the tests pass on develop · shown · 0',
    ].join('\n');
    expect(got).toBe([block, ...CAPTURED.split('\n').slice(4)].join('\n'));
    expect(got).not.toContain(NOTES_HEAD);
  });

  test('keeps the prompt unchanged with no source, a source without memoryItems.ts, or no notes block', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'buddy-suite-src-'));
    const plain = CAPTURED.split('\n').slice(5).join('\n');
    expect(await promptFor(null, CAPTURED)).toBe(CAPTURED);
    expect(await promptFor(empty, CAPTURED)).toBe(CAPTURED);
    expect(await promptFor(SRC, plain)).toBe(plain);
  });
});

const opts = (s: { file: string; out: string }, over: Partial<Parameters<typeof runSuite>[0]> = {}) => ({ file: s.file, out: s.out, arms: ['old', 'HEAD', 'tree'], runs: 0, rows: null, jobs: 6, ...over });

describe('runSuite: dry run', () => {
  test('calls no model, ledgers each captured reply, writes every arm system and prompt, and returns 0 when every row agrees', async () => {
    const s = suite([
      { id: 'd1', kind: 'defect', captured: reply('Check the tests.') },
      { id: 'c1', kind: 'control', captured: reply('NONE.') },
    ]);
    const h = fakeHarness();
    expect(await runSuite(opts(s), h)).toBe(0);
    expect(h.asked).toEqual([]);
    const ledger = readFileSync(join(s.out, 'suite.tsv'), 'utf8').trim().split('\n');
    expect(ledger[0]).toBe(LEDGER_HEADER);
    expect(ledger.slice(1).map((l) => l.split('\t').slice(1, 7))).toEqual([
      ['d1', 'defect', 'p2m-wrong', 'captured', '0', 'fail'],
      ['c1', 'control', '-', 'captured', '0', 'pass'],
    ]);
    for (const id of ['d1', 'c1']) {
      for (const arm of ['old', 'HEAD', 'tree']) {
        expect(existsSync(join(s.out, `${id}-${arm}.system.txt`))).toBe(true);
        expect(readFileSync(join(s.out, `${id}-${arm}.prompt.txt`), 'utf8')).toBe(`prompt of ${id}`);
      }
    }
    expect(readFileSync(join(s.out, 'd1-tree.system.txt'), 'utf8')).toBe(`tree|${SYSTEM}`);
    expect(h.lines).toEqual(['d1 · defect · p2m-wrong · captured fail AGREES', 'c1 · control · - · captured pass AGREES', '2 rows · 0/1 defects hold · 0/1 controls hold · 0 view · 0 disagree · 0 calls · 0 failed · $0.000']);
  });

  test('returns 1 when a row disagrees', async () => {
    const s = suite([{ id: 'd1', kind: 'defect', captured: reply('NONE.') }]);
    const h = fakeHarness();
    expect(await runSuite(opts(s), h)).toBe(1);
    expect(h.lines[0]).toBe('d1 · defect · p2m-wrong · captured pass DISAGREES');
  });
});

describe('runSuite: paid run', () => {
  // Each row's tree arm passes on the runs listed; HEAD always passes.
  function scripted(treePasses: Record<string, boolean[]>, fail?: string): Fake {
    const seen = new Map<string, number>();
    return fakeHarness((system, prompt) => {
      const id = prompt.replace('prompt of ', '');
      const arm = system.split('|')[0]!;
      const k = seen.get(`${id}-${arm}`) ?? 0;
      seen.set(`${id}-${arm}`, k + 1);
      if (fail === id && arm === 'tree' && k === 0) return { error: 'claude -p failed: boom', ms: 3 };
      const pass = arm === 'HEAD' || treePasses[id]![k]!;
      return { text: reply(pass ? 'NONE.' : 'Run the tests.'), ms: 10, inTok: 100, outTok: 5, usd: 0.5 };
    });
  }
  const rows: Spec[] = [
    { id: 'd-hold', kind: 'defect', captured: reply('Run it.') },
    { id: 'c-hold', kind: 'control', captured: reply('NONE.') },
    { id: 'v', kind: 'view', captured: reply('Run it.') },
  ];

  test('6 calls per row on the captured model and effort; the tree is judged: a defect at 3/3 and a control at 2/3 hold, a failing view never counts', async () => {
    const s = suite(rows);
    const h = scripted({ 'd-hold': [true, true, true], 'c-hold': [true, false, true], v: [false, false, false] });
    expect(await runSuite(opts(s, { arms: ['HEAD', 'tree'], runs: 3 }), h)).toBe(0);
    expect(h.asked).toHaveLength(18);
    for (const id of ['d-hold', 'c-hold', 'v']) expect(h.asked.filter((a) => a.prompt === `prompt of ${id}`)).toHaveLength(6);
    expect(h.asked.every((a) => a.model === 'opus' && a.effort === 'low')).toBe(true);
    expect(h.lines).toEqual([
      'd-hold · defect · p2m-wrong · captured fail AGREES · HEAD 3/3 · tree 3/3 · HOLDS',
      'c-hold · control · - · captured pass AGREES · HEAD 3/3 · tree 2/3 · HOLDS',
      'v · view · p2m-wrong · captured fail AGREES · HEAD 3/3 · tree 0/3 · view',
      '3 rows · 1/1 defects hold · 1/1 controls hold · 1 view · 0 disagree · 18 calls · 0 failed · $9.000',
    ]);
    expect(readFileSync(join(s.out, 'suite.tsv'), 'utf8').trim().split('\n')).toHaveLength(1 + 3 + 18);
    expect(readFileSync(join(s.out, 'c-hold-tree-r2.reply.txt'), 'utf8')).toBe(reply('Run the tests.'));
  });

  test.each([
    ['a defect at 2/3', { id: 'd-fail', kind: 'defect', captured: reply('Run it.') }, [true, false, true], 'tree 2/3 · FAILS'],
    ['a control at 1/3', { id: 'c-fail', kind: 'control', captured: reply('NONE.') }, [false, true, false], 'tree 1/3 · FAILS'],
  ] as const)('%s fails and returns 1', async (_, spec, runs, said) => {
    const s = suite([spec]);
    const h = scripted({ [spec.id]: [...runs] });
    expect(await runSuite(opts(s, { arms: ['HEAD', 'tree'], runs: 3 }), h)).toBe(1);
    expect(h.lines[0]).toContain(said);
  });

  test('a failed call writes ERROR to its reply file, counts as failed and returns 1', async () => {
    const s = suite([rows[0]!]);
    const h = scripted({ 'd-hold': [true, true, true] }, 'd-hold');
    expect(await runSuite(opts(s, { arms: ['HEAD', 'tree'], runs: 3 }), h)).toBe(1);
    expect(readFileSync(join(s.out, 'd-hold-tree-r1.reply.txt'), 'utf8')).toBe('ERROR claude -p failed: boom\n');
    expect(h.lines[0]).toContain('tree 2/3 · FAILS');
    expect(h.lines[1]).toContain('6 calls · 1 failed');
  });
});

describe('runSuite: unresolvable rows throw before any call', () => {
  test.each([
    ['a missing round file', (dir: string) => ({ id: 'bad', kind: 'defect', captured: '', round: join(dir, 'rounds/none.txt') })],
    ['a call number not in the round', () => ({ id: 'bad', kind: 'defect', captured: reply('x'), call: '9' })],
    ['a missing prompt file', () => ({ id: 'bad', kind: 'defect', captured: reply('x'), prompt: 'suite/none.txt' })],
  ] as const)('%s names the row id', async (_, make) => {
    const probe = mkdtempSync(join(tmpdir(), 'buddy-suite-none-'));
    const s = suite([{ id: 'ok', kind: 'control', captured: reply('NONE.') }, make(probe) as Spec]);
    const h = fakeHarness();
    await expect(runSuite(opts(s, { runs: 3 }), h)).rejects.toThrow(/row bad: /);
    expect(h.asked).toEqual([]);
  });

  test('a round with no end-of-turn call names the row id', async () => {
    const s = suite([{ id: 'ok', kind: 'control', captured: reply('NONE.') }]);
    writeFileSync(join(s.dir, 'rounds/q.txt'), section(1, 'question call', SYSTEM, 'why?', 'Because.'));
    writeFileSync(s.file, `${readFileSync(s.file, 'utf8')}${['bad', 'rounds/q.txt', '-', 'defect', 'c', 'PROMPT_TO_MAIN_CHAT', 'none', '-', '-', 'w'].join('\t')}\n`);
    const h = fakeHarness();
    await expect(runSuite(opts(s, { runs: 3 }), h)).rejects.toThrow(/row bad: .*no end-of-turn call/);
    expect(h.asked).toEqual([]);
  });

  test('a --rows name matching no row id or kind names it', async () => {
    const s = suite([{ id: 'ok', kind: 'control', captured: reply('NONE.') }]);
    const h = fakeHarness();
    await expect(runSuite(opts(s, { runs: 3, rows: ['ok', 'nope'] }), h)).rejects.toThrow(/row nope: /);
    expect(h.asked).toEqual([]);
  });
});

describe('runSuite: --runs and --jobs', () => {
  test.each([
    ['--runs', { runs: Number.NaN }],
    ['--runs', { runs: -1 }],
    ['--runs', { runs: 1.5 }],
    ['--jobs', { jobs: 0 }],
    ['--jobs', { jobs: Number.NaN }],
    ['--jobs', { jobs: 2.5 }],
  ] as const)('%s %o throws naming the flag, before any call', async (flag, over) => {
    const s = suite([{ id: 'c1', kind: 'control', captured: reply('NONE.') }]);
    const h = fakeHarness();
    await expect(runSuite(opts(s, over), h)).rejects.toThrow(new RegExp(`^${flag} `));
    expect(h.asked).toEqual([]);
    expect(existsSync(s.out)).toBe(false);
  });
});

describe('runSuite: --rows', () => {
  test('rows ["control"] reads, resolves and runs only the control rows', async () => {
    const s = suite([
      { id: 'c1', kind: 'control', captured: reply('NONE.') },
      { id: 'd1', kind: 'defect', captured: '', round: 'rounds/missing.txt' },
    ]);
    const h = fakeHarness();
    expect(await runSuite(opts(s, { arms: ['tree'], runs: 3, rows: ['control'] }), h)).toBe(0);
    expect(h.asked.map((a) => a.prompt)).toEqual(['prompt of c1', 'prompt of c1', 'prompt of c1']);
    expect(h.lines).toEqual(['c1 · control · - · captured pass AGREES · tree 3/3 · HOLDS', '1 rows · 0/0 defects hold · 1/1 controls hold · 0 view · 0 disagree · 3 calls · 0 failed · $0.030']);
  });

  test('an arm with a source converts the notes block; old sends the captured prompt as is', async () => {
    const s = suite([{ id: 'c1', kind: 'control', captured: reply('NONE.') }]);
    writeFileSync(join(s.dir, 'rounds/c1.txt'), section(1, 'end-of-turn call', SYSTEM, CAPTURED, reply('NONE.')));
    const h = fakeHarness(undefined, SRC);
    expect(await runSuite(opts(s, { arms: ['old', 'tree'] }), h)).toBe(0);
    expect(readFileSync(join(s.out, 'c1-old.prompt.txt'), 'utf8')).toBe(CAPTURED);
    expect(readFileSync(join(s.out, 'c1-tree.prompt.txt'), 'utf8')).toContain(ITEMS_HEAD);
  });
});
