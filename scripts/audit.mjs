#!/usr/bin/env node
// npm run audit [-- --since 7d] [log files...]
//
// What the buddy's model calls cost, and how much of the main chat its memory
// cut, from the `call.cost` lines the plugin logs (one per call). With no
// files given, reads every rotated archive (buddy.log.1, buddy.log.2, ...,
// oldest first) and then buddy.log, under $CLAUDE_CONFIG_DIR/buddy/ and
// ~/.claude/buddy/. Prints one row per day and one per kind of call, then the
// totals.
//
// A call's cost is the `usd` its line logged. A line with no `usd` (the plugin
// before it logged one) is priced by priceCall of plugins/buddy/src/prices.ts,
// the one price table, list prices per million tokens: the model name is an
// alias, an id or an id with an 8-digit date, and a cache write bills at the
// 5-minute rate. A model the table does not know is named and left out of the
// dollars (its calls, tokens and turns still count). It is an estimate: the
// account's own bill is the truth.
//
// Needs Node >= 23.6, where type stripping is on by default: it imports the
// .ts module as it is.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { priceCall } from '../plugins/buddy/src/prices.ts';

/** What one call cost: the `usd` its line logged, else its tokens at list price through priceCall; null when the model is unknown or not a string. */
function costOf(r) {
  if (typeof r.usd === 'number') return { usd: r.usd, logged: true };
  if (typeof r.model !== 'string') return null;
  const usd = priceCall(r.model, r);
  return usd === undefined ? null : { usd, logged: false };
}

function parseSince(text) {
  const m = /^(\d+)([hd])$/.exec(text ?? '');
  if (!m) throw new Error(`--since takes a count and h or d, as 24h or 7d; got ${text}`);
  return Date.now() - Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 86_400_000);
}

const args = process.argv.slice(2);
let since = 0;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--since') files.push(args[i]);
  else {
    try {
      since = parseSince(args[++i]);
    } catch (error) {
      console.error(`audit: ${error.message}`);
      process.exit(2);
    }
  }
}
if (files.length === 0) {
  const dirs = [process.env.CLAUDE_CONFIG_DIR && join(process.env.CLAUDE_CONFIG_DIR, 'buddy'), join(homedir(), '.claude', 'buddy')].filter(Boolean);
  for (const dir of [...new Set(dirs)]) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      // no such directory: nothing to read there
    }
    const archives = names
      .map((n) => /^buddy\.log\.(\d+)$/.exec(n))
      .filter((m) => m !== null)
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map((m) => m[0]);
    for (const f of [...archives, 'buddy.log']) files.push(join(dir, f));
  }
}

const calls = [];
let read = 0;
let malformed = 0;
for (const file of files) {
  if (!existsSync(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`audit: couldn't read ${file}: ${error.message}`);
    process.exitCode = 1;
    continue;
  }
  read++;
  for (const line of text.split('\n')) {
    if (!line.includes('"call.cost"')) continue;
    try {
      const r = JSON.parse(line);
      if (r.event === 'call.cost' && Date.parse(r.ts) >= since) calls.push(r);
    } catch {
      malformed++;
    }
  }
}
if (read === 0) {
  console.error(`audit: no log found; looked at:\n  ${files.join('\n  ')}`);
  process.exit(1);
}
if (calls.length === 0) {
  console.log(`No call.cost lines in ${read} log file(s)${since ? ' in that span' : ''}: the plugin logs one per model call from 1.0.0.`);
  process.exit(0);
}

function add(acc, r, cost) {
  const inTok = r.inTok ?? 0;
  const cacheRead = r.cacheRead ?? 0;
  const cacheWrite = r.cacheWrite ?? 0;
  const outTok = r.outTok ?? 0;
  acc.calls++;
  acc.failed += r.outcome === 'answered' ? 0 : 1;
  acc.inTok += inTok + cacheRead + cacheWrite;
  acc.outTok += outTok;
  if (cost) {
    acc.priced++;
    acc.usd += cost.usd;
  }
  acc.kept += r.memKept ?? 0;
  acc.full += r.memFull ?? 0;
  acc.turns += r.memTurns ?? 0;
  acc.ms += r.ms ?? 0;
  return acc;
}
const empty = () => ({ calls: 0, failed: 0, inTok: 0, outTok: 0, priced: 0, usd: 0, kept: 0, full: 0, turns: 0, ms: 0 });

const byDay = new Map();
const byKind = new Map();
const total = empty();
const unpriced = new Map();
let logged = 0;
let fromTable = 0;
for (const r of calls) {
  const day = String(r.ts).slice(0, 10);
  const cost = costOf(r);
  if (!cost) unpriced.set(String(r.model), (unpriced.get(String(r.model)) ?? 0) + 1);
  else if (cost.logged) logged++;
  else fromTable++;
  add(byDay.get(day) ?? byDay.set(day, empty()).get(day), r, cost);
  add(byKind.get(r.kind) ?? byKind.set(r.kind, empty()).get(r.kind), r, cost);
  add(total, r, cost);
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const cut = (a) => (a.full > 0 ? `${((1 - a.kept / a.full) * 100).toFixed(1)}%` : '-');
/** The cost and /100 calls cells: only priced calls are summed and divided by; `-` when none was priced, a trailing `*` when some were not. */
const money = (a) => (a.priced === 0 ? ['-', '-'] : [`$${a.usd.toFixed(3)}${a.priced < a.calls ? '*' : ''}`, `$${((a.usd / a.priced) * 100).toFixed(2)}`]);
const row = (name, a) =>
  [name.padEnd(12), String(a.calls).padStart(6), String(a.failed).padStart(6), k(a.inTok).padStart(8), k(a.outTok).padStart(8), ...money(a).map((c) => c.padStart(9)), (a.calls ? (a.turns / a.calls).toFixed(1) : '-').padStart(6), cut(a).padStart(7), `${(a.ms / a.calls / 1000).toFixed(1)}s`.padStart(7)].join('  ');
const head = ['', 'calls', 'failed', 'in tok', 'out tok', 'cost', '/100 calls', 'turns', 'cut', 'avg'].map((h, i) => (i === 0 ? h.padEnd(12) : h.padStart([6, 6, 8, 8, 9, 9, 6, 7, 7][i - 1]))).join('  ');

console.log(`Buddy model calls from ${read} log file(s)${since ? `, since ${new Date(since).toISOString().slice(0, 16)}Z` : ''}.`);
console.log('cost: the usd each call logged, else list price per million tokens from plugins/buddy/src/prices.ts (a cache write at the 5-minute rate); an estimate, the bill is the truth. A * marks a row that left unpriced calls out, a - a row with none priced.');
console.log("turns: the main chat's turns each call's memory held; cut: how much of those turns' prompt and answer text the memory left out.\n");
console.log(head);
for (const [day, a] of [...byDay].sort()) console.log(row(day, a));
console.log('');
for (const [kind, a] of [...byKind].sort()) console.log(row(kind, a));
console.log('');
console.log(row('total', total));
console.log(`\npriced: ${logged} as logged, ${fromTable} from the price table`);
if (unpriced.size > 0) console.log(`Not priced, left out of the cost: ${[...unpriced].map(([model, n]) => `${model} (${n} calls)`).join(', ')}`);
if (malformed > 0) console.log(`\n${malformed} call.cost line(s) did not parse and were skipped.`);
