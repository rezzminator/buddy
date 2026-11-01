// The live configuration proof's report (scripts/live-configs.sh): every session's checks and turns under the run folder,
// as report.md and report.json, printed; exit 2 when a session was not driven, 1 when a check failed.
//   node scripts/live-configs-report.mjs {run folder} {session}...
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const [top, ...sessions] = process.argv.slice(2);
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const rows = [], turns = [], unparsed = [];
for (const s of sessions) {
  const code = Number(read(`${top}/${s}/exit`).trim() || 2);
  const checks = read(`${top}/${s}/checks.tsv`).split('\n').filter(Boolean).map((l) => { const [verdict, check, evidence] = l.split('\t'); return { verdict, check, evidence }; });
  const err = read(`${top}/${s}.err`).trim();
  const driven = code !== 2;
  const verdict = !driven ? 'NOT DRIVEN' : checks.length && checks.every((c) => c.verdict === 'PASS') ? 'PASS' : 'FAIL';
  rows.push({ session: s, verdict, exit: code, why: driven ? null : err || 'no error text', checks });
  // A turns.jsonl line that is no JSON costs only itself, counted in the report.
  let bad = 0;
  for (const l of read(`${top}/${s}/turns.jsonl`).split('\n').filter(Boolean)) {
    try {
      turns.push(JSON.parse(l));
    } catch {
      bad++;
    }
  }
  if (bad) unparsed.push({ session: s, lines: bad });
}
const cell = (v) => (v === null || v === undefined || v === '' ? 'unread' : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 70));
const md = [
  `# buddy live configuration proof`, '', `Run folder: ${top}`, '',
  '| session | verdict | check | evidence |', '| --- | --- | --- | --- |',
  ...rows.flatMap((r) => (r.checks.length ? r.checks : [{ verdict: r.verdict, check: r.why ?? 'no check ran', evidence: '' }]).map((c, i) => `| ${i ? '' : `${r.session} ${r.verdict}`} | ${c.verdict} | ${cell(c.check)} | ${cell(c.evidence)} |`)),
  '', '## Per turn', '',
  '| session | turn | end→commentAfterEachTurn ms | call ms | suggestNextPrompt ms | inTok | outTok | cacheRead | cacheWrite | outcome | suggestNextPrompt | model calls | errors | pane |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...turns.map((t) => `| ${t.session} | ${t.turn} | ${cell(t.endToCommentAfterEachTurnMs)} | ${cell(t.callMs)} | ${cell(t.suggestNextPromptMs)} | ${cell(t.inTok)} | ${cell(t.outTok)} | ${cell(t.cacheRead)} | ${cell(t.cacheWrite)} | ${cell(t.outcome)} | ${cell(t.suggestNextPrompt)} | ${t.modelCalls} | ${t.errors.length ? cell(t.errors.join('; ')) : '0'} | ${cell(t.paneMatch)}${t.suggestNextPromptOnScreen ? ` / suggestNextPrompt on screen: ${cell(t.suggestNextPromptOnScreen)}` : ''} |`),
  '', '"unread" is a metric the run could not read (no record carried it), never a zero.', '',
  ...unparsed.map((u) => `${u.lines} line(s) of ${u.session}'s turns.jsonl did not parse and are left out of the per-turn table.`),
];
writeFileSync(`${top}/report.md`, md.join('\n'));
writeFileSync(`${top}/report.json`, JSON.stringify({ top, sessions: rows, turns, unparsed }, null, 2));
console.log(md.join('\n'));
process.exitCode = rows.some((r) => r.verdict === 'NOT DRIVEN') ? 2 : rows.some((r) => r.verdict !== 'PASS') ? 1 : 0;
