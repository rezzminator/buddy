#!/usr/bin/env node
// npm run audit [-- --since 7d] [log files...]
//
// What the buddy's model calls cost, and how much of the main chat its memory
// cut, from the `call.cost` lines the plugin logs (one per call). With no
// files given, reads buddy.log and its rotated buddy.log.1 under
// $CLAUDE_CONFIG_DIR/buddy/ and ~/.claude/buddy/. Prints one row per day and
// one per kind of call, then the totals. The prices are list prices per
// million tokens and are an estimate: the account's own bill is the truth.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** $ per million tokens: input, output. A cache read is 0.1x input, a cache write 1.25x. */
const PRICES = { haiku: [1, 5], sonnet: [2, 10], opus: [4, 20], fable: [10, 50] };

function priceOf(model) {
  const m = String(model).toLowerCase();
  const key = Object.keys(PRICES).find((k) => m.includes(k));
  return key ? { key, rates: PRICES[key] } : null;
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
  for (const dir of [...new Set(dirs)]) for (const f of ['buddy.log.1', 'buddy.log']) files.push(join(dir, f));
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
  console.log(`No call.cost lines in ${read} log file(s)${since ? ' in that span' : ''}: the plugin logs one per model call from 0.4.0.`);
  process.exit(0);
}

const unpriced = new Set();
function add(acc, r) {
  const inTok = r.inTok ?? 0;
  const cacheRead = r.cacheRead ?? 0;
  const cacheWrite = r.cacheWrite ?? 0;
  const outTok = r.outTok ?? 0;
  const p = priceOf(r.model);
  if (!p) unpriced.add(r.model);
  const [i, o] = p ? p.rates : [0, 0];
  acc.calls++;
  acc.failed += r.outcome === 'answered' ? 0 : 1;
  acc.inTok += inTok + cacheRead + cacheWrite;
  acc.outTok += outTok;
  acc.usd += (inTok * i + cacheRead * i * 0.1 + cacheWrite * i * 1.25 + outTok * o) / 1e6;
  acc.kept += r.memKept ?? 0;
  acc.full += r.memFull ?? 0;
  acc.turns += r.memTurns ?? 0;
  acc.ms += r.ms ?? 0;
  return acc;
}
const empty = () => ({ calls: 0, failed: 0, inTok: 0, outTok: 0, usd: 0, kept: 0, full: 0, turns: 0, ms: 0 });

const byDay = new Map();
const byKind = new Map();
const total = empty();
for (const r of calls) {
  const day = String(r.ts).slice(0, 10);
  add(byDay.get(day) ?? byDay.set(day, empty()).get(day), r);
  add(byKind.get(r.kind) ?? byKind.set(r.kind, empty()).get(r.kind), r);
  add(total, r);
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const cut = (a) => (a.full > 0 ? `${((1 - a.kept / a.full) * 100).toFixed(1)}%` : '-');
const row = (name, a) =>
  [name.padEnd(12), String(a.calls).padStart(6), String(a.failed).padStart(6), k(a.inTok).padStart(8), k(a.outTok).padStart(8), `$${a.usd.toFixed(3)}`.padStart(9), `$${((a.usd / a.calls) * 100).toFixed(2)}`.padStart(9), (a.calls ? (a.turns / a.calls).toFixed(1) : '-').padStart(6), cut(a).padStart(7), `${(a.ms / a.calls / 1000).toFixed(1)}s`.padStart(7)].join('  ');
const head = ['', 'calls', 'failed', 'in tok', 'out tok', 'cost', '/100 calls', 'turns', 'cut', 'avg'].map((h, i) => (i === 0 ? h.padEnd(12) : h.padStart([6, 6, 8, 8, 9, 9, 6, 7, 7][i - 1]))).join('  ');

console.log(`Buddy model calls from ${read} log file(s)${since ? `, since ${new Date(since).toISOString().slice(0, 16)}Z` : ''}.`);
console.log('cost: list prices per million tokens (sonnet $2/$10, haiku $1/$5, opus $4/$20, fable $10/$50), cache read 0.1x, cache write 1.25x; an estimate, the bill is the truth.');
console.log("turns: the main chat's turns each call's memory held; cut: how much of those turns' prompt and answer text the memory left out.\n");
console.log(head);
for (const [day, a] of [...byDay].sort()) console.log(row(day, a));
console.log('');
for (const [kind, a] of [...byKind].sort()) console.log(row(kind, a));
console.log('');
console.log(row('total', total));
if (unpriced.size > 0) console.log(`\nNot priced (counted as $0): ${[...unpriced].join(', ')}`);
if (malformed > 0) console.log(`\n${malformed} call.cost line(s) did not parse and were skipped.`);
