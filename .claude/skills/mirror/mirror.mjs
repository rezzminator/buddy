#!/usr/bin/env node
// The mirror's harness: reads the buddy's round files, where every end-of-turn
// call is kept verbatim (system, prompt, reply), and replays a captured call
// through another commit's system prompt, so a prompt change is measured on
// the very turns that exposed the flaw. Node >= 23 (TypeScript imports are
// stripped natively).
//
//   node mirror.mjs live [buddy-dir | session-id] [--last N]
//   node mirror.mjs calls <round-file>...
//   node mirror.mjs replay <round-file> [--call N] [--arms old,HEAD,tree] [--runs K] [--out DIR] [--model M] [--effort E] [--jobs J] [--want W,...]
//
// --want asks for lines the captured call did not (promptToMainChat, suggestNextPrompt, commentAfterEachTurn), in
// every arm but old: a round captured with an option off is replayed as if it had been on.

import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This file lives at {repo}/.claude/skills/mirror/; a symlink to it resolves here too.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TAGS = ['DESIRE', 'VERDICT', 'WHY', 'COMMENT_AFTER_EACH_TURN', 'PROMPT_TO_MAIN_CHAT', 'SUGGEST_NEXT_PROMPT', 'MEMORY'];
// Where the captured system's persona ends: every version's character rule opens with it.
const PERSONA_END = '\n\nBecome this character completely';

// A suggestion that reads like the user reporting what they did, ran or saw. Triage for the reader, never the verdict.
const REPORT = [
  // A leading "did" asks ("did gitter commit it?"); "I did" is the second pattern's.
  /^(?:ok(?:ay)?,?\s+|yes,?\s+)?(?:i\s+(?:just\s+)?)?(?:ran|saved|copied|pasted|made|created|installed|checked|added|restarted|reloaded|deleted|typed|tried|opened|generated|pushed|committed|fixed|tested|set up|logged in)\b/i,
  /\b(?:i|i've|i have|we|we've)\s+(?:just\s+|already\s+)?(?:ran|saved|copied|pasted|made|created|installed|checked|added|restarted|reloaded|deleted|typed|did|tried|opened|generated|pushed|committed|fixed|tested|done)\b/i,
  /\b(?:saved|copied|pasted|installed|created|generated)\s+(?:at|to|in|it|the|with|already|now)\b/i,
  /\b(?:it says|says|shows|showed|file exists|exists now|is there|it's there|works now|worked|passed|is saved|are saved)\b/i,
];

function fail(message) {
  console.error(`mirror: ${message}`);
  process.exit(2);
}

function opts(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`);
      o[a.slice(2)] = v;
      i++;
    } else o._.push(a);
  }
  return o;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

// A clause that looks ahead ("once out.txt appears", "if the tests passed") or asks for a check ("confirm it says done") reports nothing.
const NOT_A_REPORT = /\b(?:when|once|after|until|if|whether|unless|confirm|check|verify|ensure|make sure)\b[^,.;?]*/gi;

export function reportFlag(suggestion) {
  if (!suggestion || /^none$/i.test(suggestion.trim())) return '';
  const said = suggestion.replace(NOT_A_REPORT, '');
  return REPORT.some((r) => r.test(said)) ? 'REPORT?' : '';
}

export function tagged(reply) {
  const out = {};
  for (const raw of reply.split('\n')) {
    const m = /^([A-Z_]+):\s*(.*)$/.exec(raw.trim());
    if (!m || !TAGS.includes(m[1])) continue;
    if (m[1] === 'MEMORY') (out.MEMORY ??= []).push(m[2]);
    else out[m[1]] ??= m[2];
  }
  return out;
}

/** A round file as its opening prompt and its end-of-turn calls: each call's header fields, system, prompt, reply and OUT status. */
export function parseRound(text, file = 'round') {
  const lines = text.split('\n');
  const openAt = lines.findIndex((l) => l.startsWith('─── IN · the prompt the turn began with ───'));
  const opening = openAt < 0 ? '' : blockAfter(lines, openAt).join('\n').trim();
  const calls = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^═══ BUDDY CALL (\d+) · ([^·]+?) · sent (\S+) · model (\S+) · effort (\S+)/.exec(lines[i]);
    if (!h) continue;
    const call = { file, n: Number(h[1]), kind: h[2].trim(), sent: h[3], model: h[4], effort: h[5], system: '', prompt: '', reply: '', out: '' };
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('═══ '); j++) {
      if (lines[j] === '─── IN: system ───') call.system = blockAfter(lines, j).join('\n').trim();
      else if (lines[j] === '─── IN: prompt ───') call.prompt = blockAfter(lines, j).join('\n').trim();
      else if (lines[j].startsWith('─── OUT')) {
        call.out = lines[j].replace(/^─── OUT: /, '').replace(/ ───$/, '');
        call.reply = blockAfter(lines, j).join('\n').trim();
      }
    }
    calls.push(call);
  }
  return { file, opening, calls };
}

// The lines after a section header, up to the next header or timestamped event line.
function blockAfter(lines, at) {
  const out = [];
  for (let k = at + 1; k < lines.length; k++) {
    if (/^(═══ |─── )/.test(lines[k]) || /^\d\d:\d\d:\d\d\.\d{3}\s/.test(lines[k])) break;
    out.push(lines[k]);
  }
  return out;
}

/** The turn a call judged: the last "The user asked Claude:" in its prompt, one line. */
function judgedTurn(prompt) {
  const heads = [...prompt.matchAll(/^Turn \d+\. (.*):\n(.*)$/gm)];
  if (!heads.length) return '(no turn in the prompt)';
  const [, who, text] = heads[heads.length - 1];
  return who === 'The user asked Claude' ? text : `[${who}] ${text}`;
}

function outStats(out) {
  const ms = /(\d+) ms/.exec(out)?.[1] ?? '?';
  const inTok = /inTok (\d+)/.exec(out)?.[1] ?? '?';
  const outTok = /outTok (\d+)/.exec(out)?.[1] ?? '?';
  return { status: out.split(' · ')[0] || '?', ms, inTok, outTok };
}

// A buddy folder given, or the one of a session id, by default this chat's own: several chats may run, so the newest folder proves nothing.
function buddyDirOf(arg) {
  if (arg && existsSync(arg) && statSync(arg).isDirectory()) return arg;
  const session = arg || process.env.CLAUDE_CODE_SESSION_ID;
  if (!session) fail('live needs a buddy folder or a session id: CLAUDE_CODE_SESSION_ID is not set');
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  try {
    for (const slug of readdirSync(projects)) {
      const b = join(projects, slug, session, 'buddy');
      if (existsSync(b)) return b;
    }
  } catch (error) {
    fail(`reading ${projects}: ${error.message}`);
  }
  return fail(`no buddy folder for session ${session} under ${projects}`);
}

function rounds(dir) {
  return readdirSync(dir).filter((f) => /^round-\d+\.txt$/.test(f)).sort((x, y) => parseInt(x.slice(6), 10) - parseInt(y.slice(6), 10)).map((f) => join(dir, f));
}

function live(o) {
  const dir = buddyDirOf(o._[0]);
  const files = rounds(dir);
  if (!files.length) fail(`${dir} has no round files: is saveRounds on?`);
  const last = Number(o.last ?? 3);
  const parsed = files.map((f) => parseRound(readFileSync(f, 'utf8'), basename(f, '.txt')));
  const calls = parsed.flatMap((r) => r.calls.filter((c) => c.kind === 'end-of-turn call'));
  // Each opening prompt, in order: a suggestion was taken when a later round opened with its exact text.
  const openings = parsed.map((r) => norm(r.opening.split('\n')[0] ?? ''));
  console.log(`buddy folder: ${dir} · ${files.length} rounds · ${calls.length} end-of-turn calls`);
  for (const c of calls.slice(-last)) {
    const t = tagged(c.reply);
    const s = outStats(c.out);
    const sug = t.SUGGEST_NEXT_PROMPT ?? '';
    const roundAt = parsed.findIndex((r) => r.file === c.file);
    const taken = sug && openings.slice(roundAt + 1).some((p) => p === norm(sug)) ? 'TAKEN' : '';
    console.log(`\n── ${c.file} call ${c.n} · sent ${c.sent} · ${s.status} ${s.ms} ms · in ${s.inTok} · out ${s.outTok}`);
    console.log(`  judged: ${judgedTurn(c.prompt).slice(0, 140)}`);
    if (t.VERDICT) console.log(`  VERDICT ${t.VERDICT}${t.WHY ? ` · WHY ${t.WHY}` : ''}`);
    if (t.COMMENT_AFTER_EACH_TURN) console.log(`  COMMENT ${t.COMMENT_AFTER_EACH_TURN}`);
    console.log(`  SUGGEST ${sug || '(none)'} ${[reportFlag(sug), taken].filter(Boolean).join(' ')}`);
    const toClaude = t.PROMPT_TO_MAIN_CHAT ?? '';
    if (toClaude && !/^none[.!]*$/i.test(toClaude)) console.log(`  TO CLAUDE ${toClaude}`);
    if (!Object.keys(t).length) console.log(`  (no tagged line in the reply: ${c.reply.slice(0, 160)})`);
  }
}

function calls(o) {
  if (!o._.length) fail('calls needs a round file');
  for (const f of o._) {
    const r = parseRound(readFileSync(f, 'utf8'), basename(f, '.txt'));
    console.log(`${r.file}: opening ${JSON.stringify(r.opening.split('\n')[0]?.slice(0, 100))}`);
    for (const c of r.calls) {
      const t = tagged(c.reply);
      console.log(`  call ${c.n} · ${c.kind} · sent ${c.sent} · system ${c.system.length} chars · prompt ${c.prompt.length} chars · ${c.out || 'no OUT'}`);
      console.log(`    SUGGEST ${t.SUGGEST_NEXT_PROMPT ?? '(none)'} ${reportFlag(t.SUGGEST_NEXT_PROMPT)}`);
    }
  }
}

// A commit's plugin source, extracted once per run into a scratch folder.
function srcAt(rev, cache) {
  if (cache.has(rev)) return cache.get(rev);
  const dir = mkdtempSync(join(tmpdir(), 'buddy-mirror-src-'));
  try {
    execFileSync('sh', ['-c', 'git -C "$1" archive "$2" plugins/buddy/src | tar -x -C "$3"', 'sh', REPO, rev, dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    fail(`extracting plugins/buddy/src at ${rev} from ${REPO}: ${error.stderr?.toString().trim() || error.message}`);
  }
  const src = join(dir, 'plugins/buddy/src');
  cache.set(rev, src);
  return src;
}

async function systemFor(arm, captured, cache, want = []) {
  if (arm === 'old') return captured;
  // A folder holding prompts.ts is a snapshot of an earlier try; otherwise the working tree, or a git rev.
  const src = existsSync(join(arm, 'prompts.ts')) ? resolve(arm) : arm === 'tree' ? join(REPO, 'plugins/buddy/src') : srcAt(arm, cache);
  const { turnSystem } = await import(pathToFileURL(join(src, 'prompts.ts')).href);
  if (typeof turnSystem !== 'function') fail(`${src}/prompts.ts exports no turnSystem`);
  const cut = captured.indexOf(PERSONA_END);
  if (cut < 0) fail('the captured system has no character rule to split the persona at');
  const wants = { commentAfterEachTurn: captured.includes('COMMENT_AFTER_EACH_TURN:'), suggestNextPrompt: captured.includes('SUGGEST_NEXT_PROMPT:'), promptToMainChat: captured.includes('PROMPT_TO_MAIN_CHAT:') };
  for (const w of want) wants[w] = true;
  const desire = /you named the user's deepest desire: (.*)\n/.exec(captured)?.[1] ?? null;
  return turnSystem(captured.slice(0, cut), wants, desire);
}

// One replayed call: the buddy's model and effort, nothing loaded but the system prompt (no CLAUDE.md, plugins, hooks or MCP), no tools.
function ask(system, prompt, model, effort) {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = execFile(
      'claude',
      ['-p', '--safe-mode', '--model', model, '--effort', effort, '--tools', '', '--no-session-persistence', '--output-format', 'json', '--system-prompt', system],
      { maxBuffer: 1 << 24, timeout: 180_000 },
      (error, stdout, stderr) => {
        const ms = Date.now() - t0;
        if (error) return done({ error: `claude -p failed: ${error.message.split('\n')[0]}${stderr ? ` · ${stderr.trim().slice(0, 300)}` : ''}`, ms });
        let j;
        try {
          j = JSON.parse(stdout);
        } catch (e) {
          return done({ error: `claude -p printed no JSON (${e.message}): ${stdout.slice(0, 200)}`, ms });
        }
        if (j.is_error) return done({ error: `claude -p answered an error: ${String(j.result).slice(0, 300)}`, ms });
        const u = j.usage ?? {};
        done({ text: String(j.result ?? ''), ms: j.duration_ms ?? ms, inTok: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outTok: u.output_tokens ?? 0, usd: j.total_cost_usd ?? 0 });
      },
    );
    child.stdin.end(prompt);
  });
}

async function pool(jobs, width) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  }));
  return results;
}

const cell = (s) => String(s ?? '').replace(/[\t\n]+/g, ' ');
// An arm as named in file names and the ledger: a snapshot folder by its own name.
const armTag = (arm) => (existsSync(join(arm, 'prompts.ts')) ? basename(resolve(arm)) : arm);

async function replay(o) {
  const file = o._[0];
  if (!file) fail('replay needs a round file');
  const r = parseRound(readFileSync(file, 'utf8'), basename(file, '.txt'));
  const eot = r.calls.filter((c) => c.kind === 'end-of-turn call' && c.system && c.prompt);
  if (!eot.length) fail(`${file} has no end-of-turn call with a system and a prompt`);
  const call = o.call ? eot.find((c) => c.n === Number(o.call)) : eot[eot.length - 1];
  if (!call) fail(`${file} has no end-of-turn call ${o.call}; it has ${eot.map((c) => c.n).join(', ')}`);
  const arms = (o.arms ?? 'old,HEAD,tree').split(',').filter(Boolean);
  const WANTS = ['commentAfterEachTurn', 'suggestNextPrompt', 'promptToMainChat'];
  const want = String(o.want ?? '').split(',').filter(Boolean);
  for (const w of want) if (!WANTS.includes(w)) fail(`--want ${w}: not one of ${WANTS.join(', ')}`);
  if (want.length && arms.includes('old')) fail('--want asks the arms for lines the captured call never had; the old arm replays it verbatim, so leave old out');
  const runs = Number(o.runs ?? 3);
  const out = o.out ?? join(tmpdir(), 'buddy-mirror');
  const model = o.model ?? call.model;
  const effort = o.effort ?? call.effort;
  mkdirSync(out, { recursive: true });
  const cache = new Map();
  const systems = {};
  for (const arm of arms) {
    systems[arm] = await systemFor(arm, call.system, cache, want);
    writeFileSync(join(out, `${r.file}-c${call.n}-${armTag(arm)}.system.txt`), systems[arm]);
  }
  writeFileSync(join(out, `${r.file}-c${call.n}.prompt.txt`), call.prompt);
  const jobs = arms.flatMap((arm) => Array.from({ length: runs }, (_, k) => async () => ({ arm: armTag(arm), run: k + 1, ...(await ask(systems[arm], call.prompt, model, effort)) })));
  const results = await pool(jobs, Number(o.jobs ?? 6));
  const ledger = join(out, 'ledger.tsv');
  if (!existsSync(ledger)) writeFileSync(ledger, ['when', 'round', 'call', 'judged', 'arm', 'run', 'ms', 'inTok', 'outTok', 'usd', 'verdict', 'report', 'comment', 'suggest', 'error', 'toClaude'].join('\t') + '\n');
  const when = new Date().toISOString();
  console.log(`${r.file} call ${call.n} · judged: ${judgedTurn(call.prompt).slice(0, 110)}`);
  const captured = tagged(call.reply);
  console.log(`  captured · ${captured.VERDICT ?? '-'} · SUGGEST ${captured.SUGGEST_NEXT_PROMPT ?? '(none)'} ${reportFlag(captured.SUGGEST_NEXT_PROMPT)}`);
  for (const x of results) {
    const t = x.text ? tagged(x.text) : {};
    const sug = t.SUGGEST_NEXT_PROMPT ?? '';
    const toClaude = t.PROMPT_TO_MAIN_CHAT ?? '';
    writeFileSync(join(out, `${r.file}-c${call.n}-${x.arm}-r${x.run}.reply.txt`), x.error ? `ERROR ${x.error}\n` : x.text);
    appendFileSync(ledger, [when, r.file, call.n, judgedTurn(call.prompt).slice(0, 80), x.arm, x.run, x.ms, x.inTok, x.outTok, x.usd, t.VERDICT, reportFlag(sug), t.COMMENT_AFTER_EACH_TURN, sug, x.error, toClaude].map(cell).join('\t') + '\n');
    if (x.error) console.log(`  ${x.arm} r${x.run} · ERROR ${x.error}`);
    else console.log(`  ${x.arm} r${x.run} · ${x.ms} ms · ${t.VERDICT ?? '-'} · COMMENT ${t.COMMENT_AFTER_EACH_TURN ?? '-'}\n    SUGGEST ${sug || '(none)'} ${reportFlag(sug)}${toClaude ? `\n    TO CLAUDE ${toClaude}` : ''}`);
  }
  const usd = results.reduce((a, x) => a + (x.usd ?? 0), 0);
  const errors = results.filter((x) => x.error).length;
  console.log(`  ${results.length} calls · ${errors} failed · $${usd.toFixed(3)} · ledger ${ledger}`);
  if (errors) process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = opts(rest);
  const run = { live, calls, replay }[cmd];
  if (!run) fail('usage: mirror.mjs live [buddy-dir|session-id] [--last N] | calls <round-file>... | replay <round-file> [--call N] [--arms old,HEAD,tree] [--runs K] [--out DIR] [--want W,...]');
  Promise.resolve(run(o)).catch((error) => fail(`${cmd}: ${error.stack ?? error}`));
}
