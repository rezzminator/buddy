// The engine of the mirror's `suite` command: reads a local defect suite,
// builds each arm's system and prompt, replays them through an injected
// harness (mirror.mjs passes its own), scores every reply by the row's check
// and prints the verdicts. Run by Node's type stripping: erasable syntax only,
// node built-ins only, nothing imported from plugins/ statically.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Check = 'none' | 'some' | 'match' | 'no-match' | 'no-new-rule';
export type Kind = 'defect' | 'control' | 'view';
export type SuiteRow = { id: string; round: string; call: number | null; kind: Kind; cause: string; line: string; check: Check; pattern: RegExp | null; prompt: string | null; why: string };
export type SuiteOptions = { file: string; arms: string[]; runs: number; out: string; rows: string[] | null; jobs: number };

export type RoundCall = { file: string; n: number; kind: string; sent: string; model: string; effort: string; system: string; prompt: string; reply: string; out: string };
export type Round = { file: string; opening: string; calls: RoundCall[] };
export type Tags = Record<string, string | string[]>;
export type Answer = { text?: string; error?: string; ms: number; inTok?: number; outTok?: number; usd?: number };
export type Harness = {
  parseRound: (text: string, file: string) => Round;
  tagged: (reply: string) => Tags;
  systemFor: (arm: string, captured: string, cache: Map<string, string>, want?: string[]) => Promise<string>;
  /** null for `old`, else the arm's `plugins/buddy/src` folder. */
  srcFor: (arm: string, cache: Map<string, string>) => string | null;
  ask: (system: string, prompt: string, model: string, effort: string) => Promise<Answer>;
  pool: <T>(jobs: (() => Promise<T>)[], width: number) => Promise<T[]>;
  armTag: (arm: string) => string;
  log: (line: string) => void;
};

export const SUITE_HEADER = ['id', 'round', 'call', 'kind', 'cause', 'line', 'check', 'pattern', 'prompt', 'why'].join('\t');
export const LEDGER_HEADER = ['when', 'id', 'kind', 'cause', 'arm', 'run', 'pass', 'ms', 'inTok', 'outTok', 'usd', 'line', 'error'].join('\t');
export const NOTES_HEAD = 'Your own notes on this chat, which you keep and rewrite yourself:';

const KINDS: readonly string[] = ['defect', 'control', 'view'];
const CHECKS: readonly string[] = ['none', 'some', 'match', 'no-match', 'no-new-rule'];
const LINES: readonly string[] = ['PROMPT_TO_MAIN_CHAT', 'SUGGEST_NEXT_PROMPT', 'COMMENT_AFTER_EACH_TURN', 'VERDICT', 'WHY', 'MEMORY'];
const READS_NONE = /^none[.!]*$/i;
const END_OF_TURN = 'end-of-turn call';

/** The rows of a suite file's text; relative `round` and `prompt` paths resolve against `baseDir`. Throws `row {id}: {field} …` on the first bad row. */
export function readSuite(text: string, baseDir: string): SuiteRow[] {
  const lines = text.replace(/^﻿/, '').split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0] !== SUITE_HEADER) throw new Error(`suite header: the first line must be ${JSON.stringify(SUITE_HEADER)}, not ${JSON.stringify(lines[0] ?? '')}`);
  const rows: SuiteRow[] = [];
  const ids = new Set<string>();
  lines.slice(1).forEach((line, i) => {
    if (line.trim() === '' || line.startsWith('#')) return;
    const f = line.split('\t');
    const id = f[0]?.trim() || `(line ${i + 2})`;
    const bad = (what: string): never => {
      throw new Error(`row ${id}: ${what}`);
    };
    if (f.length !== 10) bad(`fields: ${f.length}, not 10`);
    const [, round, call, kind, cause, tag, check, pattern, prompt, why] = f.map((x) => x.trim()) as [string, string, string, string, string, string, string, string, string, string];
    if (!f[0]?.trim()) bad('id is empty');
    if (ids.has(id)) bad('id is a duplicate');
    ids.add(id);
    if (round === '') bad('round is empty');
    if (call !== '-' && !/^[1-9]\d*$/.test(call)) bad(`call ${JSON.stringify(call)} is neither - nor a call number`);
    if (!KINDS.includes(kind)) bad(`kind ${JSON.stringify(kind)} is not one of ${KINDS.join(', ')}`);
    if (!LINES.includes(tag)) bad(`line ${JSON.stringify(tag)} is not one of ${LINES.join(', ')}`);
    if (!CHECKS.includes(check)) bad(`check ${JSON.stringify(check)} is not one of ${CHECKS.join(', ')}`);
    let regex: RegExp | null = null;
    if (check === 'match' || check === 'no-match') {
      if (pattern === '-' || pattern === '') bad(`pattern is required by check ${check}`);
      try {
        regex = new RegExp(pattern, 'i');
      } catch (error) {
        bad(`pattern ${JSON.stringify(pattern)} is not a valid regular expression: ${(error as Error).message}`);
      }
    } else if (pattern !== '-') bad(`pattern must be - for check ${check}`);
    rows.push({
      id,
      round: resolve(baseDir, round),
      call: call === '-' ? null : Number(call),
      kind: kind as Kind,
      cause,
      line: tag,
      check: check as Check,
      pattern: regex,
      prompt: prompt === '-' || prompt === '' ? null : resolve(baseDir, prompt),
      why,
    });
  });
  return rows;
}

/** The checked line's text, `MEMORY` lines joined by newline; undefined when absent. */
function lineOf(tags: Tags, line: string): string | undefined {
  const v = tags[line];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? (v.length ? v.join('\n') : undefined) : v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Whether a MEMORY line adds a rule: a JSON object with a `rule.` key whose value holds `words`; text that is not JSON adds none. */
function addsRule(memory: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(memory);
  } catch {
    return false;
  }
  return isRecord(value) && Object.entries(value).some(([key, item]) => key.startsWith('rule.') && isRecord(item) && Object.hasOwn(item, 'words'));
}

/** Whether one reply's tagged lines pass the row's check; a reply with no tagged line at all fails every check. */
export function passes(row: SuiteRow, tags: Tags): boolean {
  if (Object.values(tags).every((v) => Array.isArray(v) && v.length === 0)) return false;
  const value = lineOf(tags, row.line);
  const readsNone = value === undefined || READS_NONE.test(value.trim());
  switch (row.check) {
    case 'none':
      return readsNone;
    case 'some':
      return !readsNone;
    case 'match':
      return value !== undefined && row.pattern !== null && row.pattern.test(value);
    case 'no-match':
      return value === undefined || row.pattern === null || !row.pattern.test(value);
    case 'no-new-rule': {
      const memory = tags.MEMORY;
      const lines = memory === undefined ? [] : Array.isArray(memory) ? memory : [memory];
      return !lines.some(addsRule);
    }
  }
}

const TURN_HEAD = /^Turn \d+\. (.*)$/;
const USER_HEAD = 'The user asked Claude:';
const COMPACTED = /The main chat was compacted/;
/** A line that ends a turn's prompt or an added line: a turn head, anything rendered after the prompt (mid-turn lines, steps, briefs, numbers, failed calls), or the answer's head in any of its endings. */
const PROMPT_END = /^(?:Turn \d+\. |The user added while Claude worked\b|Claude was sent while it worked\b|Claude wrote mid-turn, |Claude did(?: \d+ steps?)?: |Claude briefed its agent |Its agent |Numbers: |\d+ tool calls? failed\.$|Claude answered(?:, before [^:\n]*)?:$)/;
const ANSWERED = /^Claude answered(?:, before [^:\n]*)?:$/;
const ADDED = /^The user added while Claude worked(?:, (?:before any tool call|after \d+ tool calls?))?: ?(.*)$/;

/** A captured turn as the engine's Block holds it: what typedByUser reads (origin, prompt, suggestion, added lines). */
export type CapturedBlock = { turn: { prompt: string; answer: string; from?: string; suggested?: string; added?: string[] }; characters: Record<string, never[]> };

/** The turns a captured prompt shows, as blocks: each turn's prompt (blank lines inside it kept) up to the first line rendered after it, a user turn's `suggested:`/`sent:` pair split, its added lines; a turn not the user's carries its head as `from`, a compaction is left out. */
export function capturedBlocks(prompt: string): CapturedBlock[] {
  const lines = prompt.split('\n');
  const blocks: CapturedBlock[] = [];
  const upTo = (i: number, end: RegExp): number => {
    while (i < lines.length && !end.test(lines[i]!)) i++;
    return i;
  };
  let i = 0;
  while (i < lines.length) {
    const head = TURN_HEAD.exec(lines[i]!)?.[1];
    i++;
    if (head === undefined || COMPACTED.test(head)) continue;
    const end = upTo(i, PROMPT_END);
    const body = lines.slice(i, end);
    i = end;
    let text = body.join('\n');
    if (text === '(not seen)') text = '';
    let suggested: string | undefined;
    const sent = body.findIndex((l) => l.startsWith('sent: '));
    if (head === USER_HEAD && body[0]?.startsWith('suggested: ') && sent > 0) {
      const was = body.slice(0, sent).join('\n').slice('suggested: '.length);
      suggested = was === 'none' ? undefined : was;
      text = body.slice(sent).join('\n').slice('sent: '.length);
    }
    const added: string[] = [];
    while (i < lines.length && !ANSWERED.test(lines[i]!) && !TURN_HEAD.test(lines[i]!)) {
      const m = ADDED.exec(lines[i]!);
      if (!m) {
        i++;
        continue;
      }
      const stop = upTo(i + 1, PROMPT_END);
      added.push([m[1]!, ...lines.slice(i + 1, stop)].join('\n'));
      i = stop;
    }
    blocks.push({
      turn: { prompt: text, answer: '', ...(head === USER_HEAD ? {} : { from: head }), ...(suggested === undefined ? {} : { suggested }), ...(added.length > 0 ? { added } : {}) },
      characters: {},
    });
  }
  return blocks;
}

/** The prompts the user typed, as production builds them: the captured turns (capturedBlocks) through the engine's own `typedByUser`. */
export function typedPrompts(prompt: string, typedByUser: (blocks: CapturedBlock[]) => string[]): string[] {
  return typedByUser(capturedBlocks(prompt));
}

type MemoryModule = {
  migrateNotes: (notes: Record<string, string[]>, drawnId: string | null, ctx: { turn: number; at: number; typed: readonly string[] }) => { items: unknown };
  renderItems: (items: unknown, turn: number) => string;
};
type TurnsModule = { typedByUser: (blocks: CapturedBlock[]) => string[] };

/** A prompt for an arm whose source is `src`: an old notes block becomes that source's item memory when it has one; otherwise the prompt unchanged. */
export async function promptFor(src: string | null, prompt: string): Promise<string> {
  if (src === null) return prompt;
  const lines = prompt.split('\n');
  const at = lines.indexOf(NOTES_HEAD);
  if (at < 0) return prompt;
  const file = join(src, 'memoryItems.ts');
  if (!existsSync(file)) return prompt;
  const mod = (await import(pathToFileURL(file).href)) as Partial<MemoryModule>;
  if (typeof mod.migrateNotes !== 'function' || typeof mod.renderItems !== 'function') throw new Error(`${file} exports no migrateNotes or renderItems`);
  const turnsFile = join(src, 'chatTurnsToRead.ts');
  const turns = (existsSync(turnsFile) ? await import(pathToFileURL(turnsFile).href) : {}) as Partial<TurnsModule>;
  if (typeof turns.typedByUser !== 'function') throw new Error(`${turnsFile} exports no typedByUser`);
  let end = at + 1;
  while (end < lines.length && lines[end]!.startsWith('- ')) end++;
  const notes = lines.slice(at + 1, end).map((l) => l.slice(2));
  const result = mod.migrateNotes({ captured: notes }, null, { turn: 0, at: 0, typed: typedPrompts(prompt, turns.typedByUser) });
  return [...lines.slice(0, at), mod.renderItems(result.items, 0), ...lines.slice(end)].join('\n');
}

const cell = (s: unknown): string => String(s ?? '').replace(/[\t\n]+/g, ' ');

type Resolved = { row: SuiteRow; call: RoundCall; systems: Map<string, string>; prompts: Map<string, string>; captured: boolean };
type Result = Answer & { row: SuiteRow; arm: string; run: number };

/** Reads, resolves and (runs > 0) replays the suite; the exit code, 0 or 1. Throws, before anything is read, on `--runs` not a whole number ≥ 0 or `--jobs` not one ≥ 1 (mirror.mjs exits 2 on a throw). Everything is validated, and every system and prompt written, before the first `ask`. */
export async function runSuite(o: SuiteOptions, h: Harness): Promise<number> {
  if (!Number.isInteger(o.runs) || o.runs < 0) throw new Error(`--runs ${o.runs} is not a whole number of 0 or more`);
  if (!Number.isInteger(o.jobs) || o.jobs < 1) throw new Error(`--jobs ${o.jobs} is not a whole number of 1 or more`);
  let text: string;
  try {
    text = readFileSync(o.file, 'utf8');
  } catch (error) {
    throw new Error(`suite ${o.file} cannot be read: ${(error as Error).message}`);
  }
  const all = readSuite(text, dirname(resolve(o.file)));
  if (o.rows !== null) for (const name of o.rows) if (!all.some((r) => r.id === name || r.kind === name)) throw new Error(`row ${name}: --rows names no row id or kind of the suite`);
  const rows = o.rows === null ? all : all.filter((r) => o.rows!.includes(r.id) || o.rows!.includes(r.kind));

  mkdirSync(o.out, { recursive: true });
  const cache = new Map<string, string>();
  const resolved: Resolved[] = [];
  for (const row of rows) {
    let roundText: string;
    try {
      roundText = readFileSync(row.round, 'utf8');
    } catch (error) {
      throw new Error(`row ${row.id}: round ${row.round} cannot be read: ${(error as Error).message}`);
    }
    const round = h.parseRound(roundText, basename(row.round, '.txt'));
    const eot = round.calls.filter((c) => c.kind === END_OF_TURN && c.system && c.prompt);
    if (!eot.length) throw new Error(`row ${row.id}: round ${row.round} has no end-of-turn call with a system and a prompt`);
    const call = row.call === null ? eot[eot.length - 1]! : eot.find((c) => c.n === row.call);
    if (!call) throw new Error(`row ${row.id}: call ${row.call} is not an end-of-turn call of ${row.round}; it has ${eot.map((c) => c.n).join(', ')}`);
    let promptFile: string | null = null;
    if (row.prompt !== null) {
      try {
        promptFile = readFileSync(row.prompt, 'utf8');
      } catch (error) {
        throw new Error(`row ${row.id}: prompt ${row.prompt} cannot be read: ${(error as Error).message}`);
      }
    }
    const systems = new Map<string, string>();
    const prompts = new Map<string, string>();
    for (const arm of o.arms) {
      try {
        systems.set(arm, await h.systemFor(arm, call.system, cache, []));
        prompts.set(arm, arm === 'old' ? call.prompt : await promptFor(h.srcFor(arm, cache), promptFile ?? call.prompt));
      } catch (error) {
        throw new Error(`row ${row.id}: arm ${arm}: ${(error as Error).message}`);
      }
      const tag = h.armTag(arm);
      writeFileSync(join(o.out, `${row.id}-${tag}.system.txt`), systems.get(arm)!);
      writeFileSync(join(o.out, `${row.id}-${tag}.prompt.txt`), prompts.get(arm)!);
    }
    resolved.push({ row, call, systems, prompts, captured: passes(row, h.tagged(call.reply)) });
  }

  const ledger = join(o.out, 'suite.tsv');
  if (!existsSync(ledger)) writeFileSync(ledger, `${LEDGER_HEADER}\n`);
  const when = new Date().toISOString();
  const record = (row: SuiteRow, arm: string, run: number, pass: boolean, x: Partial<Answer>, line: string | undefined): void => {
    appendFileSync(ledger, [when, row.id, row.kind, row.cause, arm, run, pass ? 'pass' : 'fail', x.ms, x.inTok, x.outTok, x.usd, line, x.error].map(cell).join('\t') + '\n');
  };
  for (const r of resolved) {
    const out = r.call.out;
    const stat = (re: RegExp): number | undefined => {
      const m = re.exec(out);
      return m ? Number(m[1]) : undefined;
    };
    record(r.row, 'captured', 0, r.captured, { ms: stat(/(\d+) ms/), inTok: stat(/inTok (\d+)/), outTok: stat(/outTok (\d+)/), usd: 0 }, lineOf(h.tagged(r.call.reply), r.row.line));
  }

  const agrees = (r: Resolved): boolean => (r.row.kind === 'control' ? r.captured : !r.captured);
  const disagree = resolved.filter((r) => !agrees(r)).length;
  const head = (r: Resolved): string => `${r.row.id} · ${r.row.kind} · ${r.row.cause} · captured ${r.captured ? 'pass' : 'fail'} ${agrees(r) ? 'AGREES' : 'DISAGREES'}`;
  const count = (kind: Kind): number => resolved.filter((r) => r.row.kind === kind).length;
  const total = (holds: number, controls: number, calls: number, failed: number, usd: number): string =>
    `${resolved.length} rows · ${holds}/${count('defect')} defects hold · ${controls}/${count('control')} controls hold · ${count('view')} view · ${disagree} disagree · ${calls} calls · ${failed} failed · $${usd.toFixed(3)}`;

  if (o.runs <= 0) {
    for (const r of resolved) h.log(head(r));
    h.log(total(0, 0, 0, 0, 0));
    return disagree > 0 ? 1 : 0;
  }

  const jobs = resolved.flatMap((r) =>
    o.arms.flatMap((arm) =>
      Array.from({ length: o.runs }, (_, k) => async (): Promise<Result> => {
        const base = { row: r.row, arm, run: k + 1 };
        try {
          return { ...base, ...(await h.ask(r.systems.get(arm)!, r.prompts.get(arm)!, r.call.model, r.call.effort)) };
        } catch (error) {
          return { ...base, ms: 0, error: (error as Error).message ?? String(error) };
        }
      }),
    ),
  );
  const results = await h.pool(jobs, o.jobs);

  const passed = new Map<string, number>();
  for (const x of results) {
    const tag = h.armTag(x.arm);
    writeFileSync(join(o.out, `${x.row.id}-${tag}-r${x.run}.reply.txt`), x.error ? `ERROR ${x.error}\n` : (x.text ?? ''));
    const tags = x.error ? {} : h.tagged(x.text ?? '');
    const pass = !x.error && passes(x.row, tags);
    record(x.row, tag, x.run, pass, x, lineOf(tags, x.row.line));
    if (pass) passed.set(`${x.row.id}\t${x.arm}`, (passed.get(`${x.row.id}\t${x.arm}`) ?? 0) + 1);
  }

  const judged = o.arms[o.arms.length - 1]!;
  const need = { defect: o.runs, control: Math.ceil((2 * o.runs) / 3) };
  let holds = 0;
  let controls = 0;
  let fails = 0;
  for (const r of resolved) {
    const arms = o.arms.map((arm) => ` · ${h.armTag(arm)} ${passed.get(`${r.row.id}\t${arm}`) ?? 0}/${o.runs}`).join('');
    let verdict = 'view';
    if (r.row.kind !== 'view') {
      const hold = (passed.get(`${r.row.id}\t${judged}`) ?? 0) >= need[r.row.kind];
      verdict = hold ? 'HOLDS' : 'FAILS';
      if (!hold) fails++;
      else if (r.row.kind === 'defect') holds++;
      else controls++;
    }
    h.log(`${head(r)}${arms} · ${verdict}`);
  }
  const failed = results.filter((x) => x.error).length;
  const usd = results.reduce((a, x) => a + (x.usd ?? 0), 0);
  h.log(total(holds, controls, results.length, failed, usd));
  return fails > 0 || failed > 0 ? 1 : 0;
}
