#!/usr/bin/env bash
# Live configuration proof: five real Claude Code sessions (the main chat on
# Haiku) with this checkout loaded by --plugin-dir, two user turns each, the
# buddy options pinned per session (model opus, effort low, logLevel debug,
# logFile in the session's folder, always), every turn measured:
#   S1 defaults (commentAfterEachTurn, suggestNextPrompt, rememberedExchanges 6): after each turn commentAfterEachTurn
#      shows in the bubble and suggestNextPrompt in the prompt box; a /buddy question is
#      answered, and a second one referring to it is answered from rememberedExchanges
#   S2 commentAfterEachTurn false: no commentAfterEachTurn after a turn, suggestNextPrompt still shown
#   S3 suggestNextPrompt false, rememberedExchanges 0: commentAfterEachTurn shows; no suggestNextPrompt; no rememberedExchanges kept
#      or read (the store holds nothing for the session)
#   S4 headless `claude -p`, then `-p --resume`: turn.skipped why headless and
#      no model call from the plugin
#   S5 customCharactersDir with one invalid character, the character option naming it:
#      the duck is drawn with a bubble naming the error
# Per turn, from the plugin log and the transcript: the turn's end to
# commentAfterEachTurn in the log (commentAfterEachTurn.outcome ts minus the transcript's reply), the plugin's own
# ms on commentAfterEachTurn.outcome and suggestNextPrompt.outcome, tokens, both outcomes, and every
# error record; the pane is sampled once after commentAfterEachTurn to match the bubble.
# Up to three sessions run at once, each on its own tmux socket and folder.
# Writes /tmp/buddy/configs-{timestamp}/report.md and report.json; exits 1
# when a check fails, 2 when a session could not be driven. Spends real tokens:
# Haiku for the main chats, opus at low effort for the buddy. The --plugin-dir
# store is set aside for the run and put back on exit.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLUGIN=$ROOT/plugins/buddy
CHARS=$PLUGIN/characters
# The helpers shared with scripts/live-proof.sh.
. "$ROOT/scripts/live-lib.sh"
live_require
command -v node >/dev/null || { echo "ERROR node not found"; exit 2; }
PROJECTS=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects
SESSIONS="S1 S2 S3 S4 S5"

# ---- one session (a child process: ./live-configs.sh --session S1 {folder}) ----

# The session's options on top of the pinned ones.
options_of() {
  case $1 in
    S1|S4) echo '{}' ;;
    S2) echo '{ "commentAfterEachTurn": false }' ;;
    S3) echo '{ "suggestNextPrompt": false, "rememberedExchanges": 0 }' ;;
    S5) jq -n --arg d "$RUN/chars" '{ customCharactersDir: $d, character: "broken" }' ;;
  esac
}
lines() { [ -f "$RUN/buddy.log" ] && wc -l < "$RUN/buddy.log" | tr -d ' ' || echo 0; }
# How many records of event $1 the log holds from line $2 on.
count() { tail -n +"$(($2 + 1))" "$RUN/buddy.log" 2>/dev/null | jq -c --arg e "$1" 'select(.event == $e)' 2>/dev/null | grep -c .; }
check() { printf '%s\t%s\t%s\n' "$1" "$2" "${3//$'\t'/ }" >> "$RUN/checks.tsv"; [ "$1" = PASS ] || log "FAIL $2: $3"; }
# The newest `kind` exchange of this session's rememberedExchanges in the store, or nothing.
stored() { local s; s=$(store_file); [ -n "$s" ] && jq -r --arg k "rememberedExchanges:$ID" --arg kind "$1" '[.[$k].characters[]?[]? | select(.kind == $kind)] | last | if . == null then empty elif .kind == "question" then "\(.question) -> \(.answer // "(no answer)")" else .text end' "$s" 2>/dev/null; }
# The transcript's reply holding $1: its timestamp, or nothing.
reply_ts() { local f; f=$(transcript); [ -n "$f" ] && jq -r --arg m "$1" 'select(.type=="assistant") | select(any(.message.content[]?; .type=="text" and (.text|contains($m)))) | .timestamp' "$f" 2>/dev/null | tail -1; }
squash() { tr -s ' \n' '  ' | sed 's/^ //; s/ $//'; }

# One turn's metrics row from the log records since line $2 (node: JSON and ISO dates).
metrics() {
  node --input-type=module - "$RUN/buddy.log" "$2" "$S" "$1" "$3" "$4" "$5" "$6" >> "$RUN/turns.jsonl" <<'JS'
import { readFileSync } from 'node:fs';
const [log, from, session, turn, endTs, bubble, paneMatch, suggestNextPromptSeen] = process.argv.slice(2);
let recs = [];
try {
  recs = readFileSync(log, 'utf8').split('\n').slice(Number(from)).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { level: 'error', event: 'unparsed', line: l.slice(0, 80) }; } });
} catch (e) { recs = [{ level: 'error', event: 'log-unreadable', message: String(e) }]; }
const last = (e) => recs.filter((r) => r.event === e).at(-1) ?? null;
const lastWithUsage = (e) => recs.filter((r) => r.event === e && typeof r.inTok === 'number').at(-1) ?? null;
// A refused ask made no call and carries no usage: the ask is the last one that did.
const lastAsked = () => recs.filter((r) => r.event === 'ask.outcome' && r.outcome !== 'refused').at(-1) ?? null;
const q = last('commentAfterEachTurn.outcome'), s = last('suggestNextPrompt.outcome'), a = lastAsked(), p = last('turn.prompt') ?? last('ask.prompt');
// A call that writes no commentAfterEachTurn (off) logs its usage on suggestNextPrompt.outcome: on such a
// turn a later harness-shown/harness-not-shown record can follow it with no usage, so this
// takes the latest suggestNextPrompt.outcome record that actually carries it, not just the last one.
const call = q ?? a ?? lastWithUsage('suggestNextPrompt.outcome');
const end = endTs ? Date.parse(endTs) : NaN;
const n = (v) => (typeof v === 'number' ? v : null);
console.log(JSON.stringify({
  session, turn, turnEnd: endTs || null,
  endToCommentAfterEachTurnMs: q && !Number.isNaN(end) ? Date.parse(q.ts) - end : null,
  callMs: n(q?.ms ?? a?.ms), suggestNextPromptMs: n(s?.ms),
  inTok: n(call?.inTok), outTok: n(call?.outTok), cacheRead: n(call?.cacheRead), cacheWrite: n(call?.cacheWrite),
  outcome: q?.outcome ?? a?.outcome ?? last('turn.skipped')?.why?.replace(/^/, 'skipped: ') ?? 'none',
  suggestNextPrompt: s?.outcome ?? 'none', promptLength: n(p?.length),
  modelCalls: recs.filter((r) => r.event === 'turn.settings' || r.event === 'ask.settings').length,
  errors: recs.filter((r) => r.level === 'error' || /warn/i.test(r.event ?? '')).map((r) => `${r.level} ${r.event}: ${r.what ?? r.reason ?? r.message ?? ''}`.trim()),
  bubble: bubble || null, paneMatch: paneMatch || null, suggestNextPromptOnScreen: suggestNextPromptSeen || null,
}));
JS
}

# A main turn: sends $2, waits for the reply holding marker $1, then for the end-of-turn records.
turn() {
  local marker=$1 prompt=$2 from end want_commentAfterEachTurn want_suggestNextPrompt b commentAfterEachTurn_text suggestNextPrompt_text pm="" ss="" t0
  from=$(lines); send "$prompt"; t0=$SECONDS
  until end=$(reply_ts "$marker"); [ -n "$end" ]; do
    [ $((SECONDS - t0)) -gt 150 ] && { echo "ERROR no reply holding $marker in 150 s; pane in $RUN/pane.txt" >&2; exit 2; }
    sleep 0.5
  done
  log "reply $marker at $end"
  # The turn's own records: turn.call (then its outcomes) or turn.skipped, 45 s at most (the call's deadline is 30 s).
  t0=$SECONDS
  while [ $((SECONDS - t0)) -lt 45 ]; do
    want_commentAfterEachTurn=$(tail -n +"$((from + 1))" "$RUN/buddy.log" 2>/dev/null | jq -r 'select(.event == "turn.call") | .commentAfterEachTurn' | tail -1)
    want_suggestNextPrompt=$(tail -n +"$((from + 1))" "$RUN/buddy.log" 2>/dev/null | jq -r 'select(.event == "turn.call") | .suggestNextPrompt' | tail -1)
    if [ -n "$want_commentAfterEachTurn" ]; then
      { [ "$want_commentAfterEachTurn" != true ] || [ "$(count commentAfterEachTurn.outcome "$from")" -gt 0 ]; } && { [ "$want_suggestNextPrompt" != true ] || [ "$(count suggestNextPrompt.outcome "$from")" -gt 0 ]; } && break
    elif [ "$(count turn.skipped "$from")" -gt 0 ]; then break; fi
    sleep 0.5
  done
  sleep 1
  pane > "$RUN/pane-$marker.txt"
  b=$(bubble)
  commentAfterEachTurn_text=$(stored commentAfterEachTurn | squash); suggestNextPrompt_text=$(stored suggestNextPrompt | squash)
  if [ "$(count commentAfterEachTurn.outcome "$from")" -gt 0 ]; then
    case $(tail -n +"$((from + 1))" "$RUN/buddy.log" | jq -r 'select(.event == "commentAfterEachTurn.outcome") | .outcome' | tail -1) in
      answered) if [ -n "$commentAfterEachTurn_text" ]; then grep -q -F -- "${commentAfterEachTurn_text:0:24}" <<<"$b" && pm=match || pm="mismatch: stored '${commentAfterEachTurn_text:0:40}'"; else [ -n "$b" ] && pm="non-empty (no rememberedExchanges to match)" || pm="empty bubble"; fi ;;
      failed) grep -q "couldn't answer" <<<"$b" && pm="failure shown" || pm="no failure in the bubble" ;;
      *) pm="n/a" ;;
    esac
  fi
  [ -n "$suggestNextPrompt_text" ] && [ "$(count suggestNextPrompt.outcome "$from")" -gt 0 ] && { grep -q -F -- "${suggestNextPrompt_text:0:20}" "$RUN/pane-$marker.txt" && ss=yes || ss="no: '${suggestNextPrompt_text:0:30}'"; }
  metrics "$marker" "$from" "$end" "$b" "$pm" "$ss"
}

# A /buddy question: waits for its ask.outcome, then reads the bubble; its reply row in ASK_OUT.
ask() {
  local from t0
  from=$(lines); ASK_OUT=$(command_out "/buddy $1") || exit 2; t0=$SECONDS
  until [ "$(count ask.outcome "$from")" -gt 0 ]; do
    [ $((SECONDS - t0)) -gt 100 ] && break
    sleep 0.5
  done
  sleep 1
  metrics "$2" "$from" "" "$(bubble)" "" ""
}

# A turn's suggestNextPrompt: shown by the buddy and on screen; or the model's SUGGEST_NEXT_PROMPT: NONE, which by design hands
# the prompt box back to the engine's own suggestion (suggestNextPrompt.outcome none, no harness-* record needed).
sugg_check() {
  if [ "$2" = shown ] && [ "$3" = yes ]; then check PASS "T$1: suggestNextPrompt is shown" "suggestNextPrompt.outcome shown, on screen"
  elif [ "$2" = none ] || [ "$2" = harness-shown ]; then check PASS "T$1: suggestNextPrompt is shown" "suggestNextPrompt.outcome $2: the model answered SUGGEST_NEXT_PROMPT: NONE, the engine's own suggestion passes"
  else check FAIL "T$1: suggestNextPrompt is shown" "suggestNextPrompt.outcome $2, on screen: ${3:-unread}"; fi
}

# The last metrics row's field $1.
row_of() { tail -1 "$RUN/turns.jsonl" | jq -r --arg f "$1" '.[$f] // "" | tostring'; }

run_session() {
  S=$1; RUN=$2; WORK=$RUN/work; LOG=$RUN/drive.log
  mkdir -p "$WORK"; : > "$RUN/checks.tsv"; : > "$RUN/turns.jsonl"
  ID=$(uuidgen | tr 'A-Z' 'a-z'); echo "$ID" > "$RUN/session-id"
  if [ "$S" = S5 ]; then mkdir -p "$RUN/chars"; printf '%s\n' '{ "name": "Broken", "poses": 3 }' > "$RUN/chars/broken.json"; fi
  jq -n --arg log "$RUN/buddy.log" --argjson o "$(options_of "$S")" \
    '{ pluginConfigs: { "buddy@inline": { options: ({ model: "opus", effort: "low", logLevel: "debug", logFile: $log } + $o) } } }' > "$RUN/settings.json"
  pool_of duck thinking > "$RUN/thinking.pool"
  [ -s "$RUN/thinking.pool" ] || printf '%s\n' 'Let me think...' 'Hmm...' 'One moment...' > "$RUN/thinking.pool"
  rows_of duck > "$RUN/duck.rows"

  if [ "$S" = S4 ]; then
    local f1 f2 from=0 end
    (cd "$WORK" && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 "$CLAUDE_BIN" -p --model haiku --setting-sources project --settings "$RUN/settings.json" \
      --plugin-dir "$PLUGIN" --session-id "$ID" "Reply with exactly: S4T1" < /dev/null > "$RUN/p1.txt" 2>&1) || { echo "ERROR claude -p exited $?: $(head -c 200 "$RUN/p1.txt")" >&2; exit 2; }
    end=$(reply_ts S4T1); metrics S4T1 0 "$end" "" "" ""
    from=$(lines)
    (cd "$WORK" && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 "$CLAUDE_BIN" -p --model haiku --setting-sources project --settings "$RUN/settings.json" \
      --plugin-dir "$PLUGIN" --resume "$ID" "Reply with exactly: S4T2" < /dev/null > "$RUN/p2.txt" 2>&1) || { echo "ERROR claude -p --resume exited $?: $(head -c 200 "$RUN/p2.txt")" >&2; exit 2; }
    end=$(reply_ts S4T2); metrics S4T2 "$from" "$end" "" "" ""
    grep -q S4T1 "$RUN/p1.txt" && grep -q S4T2 "$RUN/p2.txt" || { echo "ERROR a -p reply lacks its marker: $(head -c 80 "$RUN/p1.txt") / $(head -c 80 "$RUN/p2.txt")" >&2; exit 2; }
    f1=$(jq -c -s '[.[] | select(.event == "turn.skipped" and .why == "headless")] | length' "$RUN/buddy.log" 2>&1)
    f2=$(jq -r -s '[.[] | select(.event | test("^(turn\\.call|turn\\.settings|turn\\.prompt|ask\\.settings|ask\\.start)$")) | .event] | join(",")' "$RUN/buddy.log" 2>&1)
    [ "$f1" = 2 ] && check PASS "two turns skipped, why headless" "turn.skipped headless x$f1" || check FAIL "two turns skipped, why headless" "turn.skipped headless x${f1:-none}"
    [ -z "$f2" ] && [ -s "$RUN/buddy.log" ] && check PASS "no model call from the plugin" "no turn.call/turn.settings/ask.settings/ask.start record" || check FAIL "no model call from the plugin" "${f2:-the log is empty}"
    return 0
  fi

  T="tmux -L buddy-cfg-$S"; TGT=$S
  $T kill-server 2>/dev/null
  $T new-session -d -s "$S" -x 160 -y 50 -c "$WORK" \
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 '$CLAUDE_BIN' --model haiku --setting-sources project --settings '$RUN/settings.json' \
     --allowedTools Bash --plugin-dir '$PLUGIN' --session-id $ID"
  trap '$T capture-pane -p -t "$TGT" -S -300 > "$RUN/pane.txt" 2>/dev/null; f=$(transcript); [ -n "$f" ] && cp "$f" "$RUN/main.jsonl"; $T kill-server 2>/dev/null' EXIT
  live_boot
  pane > "$RUN/boot.txt"

  if [ "$S" = S5 ]; then
    # The error holds the bubble ERROR_MS (10 s) from the session's start, part of it behind the trust dialog;
    # when it is gone by the prompt, /buddy reload applies the choice again and says it again.
    local seen="" via=start t0=$SECONDS
    while [ $((SECONDS - t0)) -lt 5 ]; do seen=$(bubble); grep -q "Couldn't load broken" <<<"$seen" && break; sleep 0.3; done
    if ! grep -q "Couldn't load broken" <<<"$seen"; then
      via="/buddy reload"; command_out "/buddy reload" > /dev/null || exit 2; t0=$SECONDS
      while [ $((SECONDS - t0)) -lt 12 ]; do seen=$(bubble); grep -q "Couldn't load broken" <<<"$seen" && break; sleep 0.3; done
    fi
    pane > "$RUN/pane-error.txt"
    if grep -q "Couldn't load broken" <<<"$seen" && grep -q '/buddy-personality' <<<"$seen" && shows_any "$RUN/duck.rows"; then check PASS "the duck is drawn with a bubble naming the error" "at $via: $seen"
    else check FAIL "the duck is drawn with a bubble naming the error" "at $via, bubble: ${seen:-empty}; duck drawn: $(shows_any "$RUN/duck.rows" && echo yes || echo no); pane in $RUN/pane-error.txt"; fi
  fi

  turn "${S}T1" "Run this Bash command: ls. Then reply with exactly: ${S}T1"
  turn "${S}T2" "Reply with exactly: ${S}T2"
  local r q s pm ss
  for t in 1 2; do
    r=$(sed -n "${t}p" "$RUN/turns.jsonl")
    q=$(jq -r '.outcome' <<<"$r"); s=$(jq -r '.suggestNextPrompt' <<<"$r"); pm=$(jq -r '.paneMatch // ""' <<<"$r"); ss=$(jq -r '.suggestNextPromptOnScreen // ""' <<<"$r")
    case $S in
      S1|S5)
        [ "$q" = answered ] && [ "$pm" = match ] && check PASS "T$t: commentAfterEachTurn shows in the bubble" "$(jq -r '.bubble' <<<"$r")" || check FAIL "T$t: commentAfterEachTurn shows in the bubble" "outcome $q, pane $pm"
        sugg_check "$t" "$s" "$ss" ;;
      S2)
        [ "$q" = none ] && check PASS "T$t: no commentAfterEachTurn after the turn" "no commentAfterEachTurn.outcome" || check FAIL "T$t: no commentAfterEachTurn after the turn" "commentAfterEachTurn.outcome $q"
        sugg_check "$t" "$s" "$ss" ;;
      S3)
        [ "$q" = answered ] && [ -n "$(jq -r '.bubble // ""' <<<"$r")" ] && check PASS "T$t: commentAfterEachTurn shows in the bubble" "$(jq -r '.bubble' <<<"$r")" || check FAIL "T$t: commentAfterEachTurn shows in the bubble" "outcome $q, pane $pm"
        [ "$s" = none ] && check PASS "T$t: no suggestNextPrompt" "no suggestNextPrompt.outcome" || check FAIL "T$t: no suggestNextPrompt" "suggestNextPrompt.outcome $s" ;;
    esac
  done
  if [ "$S" = S3 ]; then
    local st mem
    st=$(store_file); mem=$([ -n "$st" ] && jq -r --arg k "rememberedExchanges:$ID" '.[$k] // empty | tostring' "$st" 2>&1)
    [ -z "$mem" ] && check PASS "rememberedExchanges 0: nothing kept or read for the session" "$([ -n "$st" ] && echo "the store has no rememberedExchanges:$ID" || echo "no store file"); turn.prompt lengths $(jq -r -s 'map(.promptLength) | join(",")' "$RUN/turns.jsonl")" || check FAIL "rememberedExchanges 0: nothing kept or read for the session" "${mem:0:120}"
  fi
  if [ "$S" = S1 ]; then
    local a1 a2
    ask "remember the word tangerine" "ask1"; a1=$(stored question)
    [ "$(row_of outcome)" = answered ] && check PASS "/buddy question answered" "$a1" || check FAIL "/buddy question answered" "$ASK_OUT / $(row_of outcome) / bubble $(row_of bubble)"
    ask "what word did I ask you to remember?" "ask2"; a2=$(stored question)
    [ "$(row_of outcome)" = answered ] && grep -q -i tangerine <<<"$a2 $(row_of bubble)" && check PASS "a second question is answered from rememberedExchanges" "$a2" || check FAIL "a second question is answered from rememberedExchanges" "$ASK_OUT / $(row_of outcome) / ${a2:-nothing stored} / bubble $(row_of bubble)"
  fi
}

if [ "${1:-}" = --session ]; then run_session "$2" "$3"; exit $?; fi

# ---- the run: sessions in two waves, then the report ----
TOP=/tmp/buddy/configs-$(date +%Y%m%dT%H%M%S)
RUN=$TOP; LOG=$TOP/drive.log
mkdir -p "$TOP"
live_store_aside
trap restore_store EXIT
echo "run dir: $TOP"
# Each session's exit code lands in {folder}/exit: 2 = not driven.
for wave in "S1 S2 S3" "S4 S5"; do
  pids=()
  for S in $wave; do mkdir -p "$TOP/$S"; "$0" --session "$S" "$TOP/$S" > "$TOP/$S.out" 2> "$TOP/$S.err" & pids+=("$!:$S"); done
  for p in "${pids[@]}"; do wait "${p%%:*}"; echo $? > "$TOP/${p#*:}/exit"; done
done
node --input-type=module - "$TOP" $SESSIONS <<'JS'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const [top, ...sessions] = process.argv.slice(2);
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const rows = [], turns = [];
for (const s of sessions) {
  const code = Number(read(`${top}/${s}/exit`).trim() || 2);
  const checks = read(`${top}/${s}/checks.tsv`).split('\n').filter(Boolean).map((l) => { const [verdict, check, evidence] = l.split('\t'); return { verdict, check, evidence }; });
  const err = read(`${top}/${s}.err`).trim();
  const driven = code !== 2;
  const verdict = !driven ? 'NOT DRIVEN' : checks.length && checks.every((c) => c.verdict === 'PASS') ? 'PASS' : 'FAIL';
  rows.push({ session: s, verdict, exit: code, why: driven ? null : err || 'no error text', checks });
  for (const l of read(`${top}/${s}/turns.jsonl`).split('\n').filter(Boolean)) turns.push(JSON.parse(l));
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
];
writeFileSync(`${top}/report.md`, md.join('\n'));
writeFileSync(`${top}/report.json`, JSON.stringify({ top, sessions: rows, turns }, null, 2));
console.log(md.join('\n'));
process.exitCode = rows.some((r) => r.verdict === 'NOT DRIVEN') ? 2 : rows.some((r) => r.verdict !== 'PASS') ? 1 : 0;
JS
