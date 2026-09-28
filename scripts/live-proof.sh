#!/usr/bin/env bash
# Live proof: drives a real interactive Claude Code session (Haiku) in tmux on
# a private socket, with this checkout loaded by --plugin-dir, and reads the
# band from the pane and the /buddy replies from the transcript:
#   (a) the default character, the duck, is drawn above the prompt
#   (b) it walks: the band changes between samples while nothing is said
#   (c) the drawer's pet button pets it and counts; its personality tab
#       marks it with *
#   (d) a /buddy question before the first reply is answered: `model`
#       needs no turns to read
#   (e) a Bash `npm test` run printing a test pass shows a testPass line
#   (f) a /buddy question after a reply is answered
#   (g) Enter on another character in the personality tab draws it, and the
#       reopened tab marks it with *; picking the duck there returns
#   (h) /buddy off hides the band; /buddy on brings it back
#   (i) /buddy opens the drawer and its personality tab, the duck marked;
#       Right moves the focus and the preview to the next entry; Esc leaves and
#       ctrl+x x folds it, nothing changed; Enter on cat draws the cat, the tab
#       open with cat marked, and the reopened tab marks it; picking the duck
#       returns. HOME stays real (a fake one logs the session out), so
#       no row reads or prints the "Yours" group: hook tests prove that path.
#   (j) chatTurnsToRead: /buddy remember the word pineapple, then /buddy what word did I
#       ask you to remember? is answered with pineapple; the plugin's store
#       holds both as exchanges, no thinking filler (its chatTurnsToRead:{session} key,
#       nothing else read)
#   (k) a /buddy question while a main turn runs (`sleep 15` via Bash) is
#       answered at once, before that turn ends, and a second immediate ask
#       gets a visible outcome: refused out loud, or asked
#   (l) the plugin log (logFile set to this run's folder) holds the ask's
#       start and its answered outcome, and /buddy log prints its path and lines
# Prints a table, one row per check, and exits 1 when any check fails,
# 2 when the session could not be driven (no transcript, a turn timed out).
# Spends real tokens: a few cents of Haiku. It runs in a config dir of its own
# ($RUN/config, live_isolate in live-lib.sh), so nothing lands in yours, and
# --setting-sources project keeps your settings, and so your character option,
# out of the run.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLUGIN=$ROOT/plugins/buddy
CHARS=$PLUGIN/characters
# The helpers shared with scripts/live-configs.sh.
. "$ROOT/scripts/live-lib.sh"
live_require
# The plugin's default character (DEFAULT_ID); OTHER is the first other one by id.
DEFAULT=duck
[ -f "$CHARS/$DEFAULT.json" ] || { echo "ERROR $CHARS/$DEFAULT.json not found"; exit 2; }
OTHER=$(ls "$CHARS"/*.json | xargs -n1 basename | sed 's/\.json$//' | grep -v -x "$DEFAULT" | head -1)
[ -n "$OTHER" ] || { echo "ERROR no second character in $CHARS"; exit 2; }

RUN=/tmp/buddy/run-$(date +%Y%m%dT%H%M%S)
WORK=$RUN/work
mkdir -p "$WORK"
# Only a test runner's output reacts as a test: (e) runs `npm test` here, which prints a pass summary.
printf '%s\n' '{ "name": "proof", "private": true, "scripts": { "test": "echo Tests: 3 passed" } }' > "$WORK/package.json"
cat > "$RUN/settings.json" <<'EOF'
{ "pluginConfigs": { "buddy@inline": { "options": { "commentAfterEachTurn": false, "suggestNextPrompt": false, "walkOverPromptBar": true, "logLevel": "debug", "logFile": "RUNDIR/buddy.log" } } } }
EOF
sed -i.bak "s|RUNDIR|$RUN|" "$RUN/settings.json" && rm -f "$RUN/settings.json.bak"
ID=$(uuidgen | tr 'A-Z' 'a-z')
live_isolate
T="tmux -L buddy-proof"
TGT=proof
LOG=$RUN/drive.log
echo "run dir: $RUN  session: $ID"

# The sprite rows of the default and the other character, and the default's line pools.
rows_of "$DEFAULT" > "$RUN/default.rows"
rows_of "$OTHER" | grep -v -x -F -f "$RUN/default.rows" > "$RUN/other.rows"
pool_of "$DEFAULT" thinking > "$RUN/thinking.pool"
pool_of "$DEFAULT" testPass > "$RUN/testpass.pool"
[ -s "$RUN/testpass.pool" ] || printf '%s\n' 'Tests pass!' 'All green.' 'It passes. Nice.' > "$RUN/testpass.pool"
[ -s "$RUN/thinking.pool" ] || printf '%s\n' 'Let me think...' 'Hmm...' 'One moment...' > "$RUN/thinking.pool"

$T kill-session -t proof 2>/dev/null
$T new-session -d -s proof -x 160 -y 50 -c "$WORK" \
  "'$LIVE_CLAUDE' --model haiku --setting-sources project --settings '$RUN/settings.json' \
   --allowedTools Bash --plugin-dir '$PLUGIN' --session-id $ID"
trap '$T capture-pane -p -t proof -S -300 > "$RUN/pane.txt" 2>/dev/null; $T kill-server 2>/dev/null' EXIT
live_boot
$T capture-pane -p -t proof > "$RUN/boot.txt"

# The personality tab: Shipped lists characters/ sorted by id; * marks the
# entry drawn now; the preview follows the focus, drawn in inverse video.
IDS=$(ls "$CHARS"/*.json | xargs -n1 basename | sed 's/\.json$//' | sort)
# The start of a description as the preview's one line shows it (never the persona).
about_of() { jq -r '.description | gsub("\\s+"; " ") | .[0:40]' "$CHARS/$1.json"; }
persona_of() { jq -r '.persona | gsub("\\s+"; " ") | .[0:40]' "$CHARS/$1.json"; }
name_of() { jq -r '.name' "$CHARS/$1.json"; }
DEF_NAME=$(name_of "$DEFAULT")
in_pane() { pane | grep -q -F -- "$1"; }
index_of() { grep -n -x -- "$1" <<<"$IDS" | cut -d: -f1; }
# The newest menu's Shipped group as drawn, or nothing when no menu is drawn.
shipped() { pane | awk '/Shipped/ { buf = ""; on = 1 } on { buf = buf $0 "\n" } /Yours/ { on = 0 } END { printf "%s", buf }'; }
# The shipped id the open menu marks with *, or nothing.
marked() { local id g; g=$(shipped); for id in $IDS; do grep -q -F -- "* $(name_of "$id") ($id)" <<<"$g" && { echo "$id"; return 0; }; done; return 1; }
# /buddy opens the drawer on its talk tab; ctrl+x tab steps in on `talk`,
# Right moves to `personality`, Enter opens it.
tab_open() {
  command_out "/buddy" >/dev/null || { echo "ERROR /buddy gave no reply" >&2; exit 2; }
  sleep 2
  $T send-keys -t proof C-x; $T send-keys -t proof Tab; sleep 1
  $T send-keys -t proof Right; sleep 1
  $T send-keys -t proof Enter; sleep 3
}
# Esc leaves the drawer for the prompt; ctrl+x x from the prompt folds it.
tab_close() { $T send-keys -t proof Escape; sleep 1; $T send-keys -t proof C-x; $T send-keys -t proof x; sleep 2; }
# The lines holding the focus, which the band draws in inverse video, escapes stripped.
focused() { $T capture-pane -e -p -t proof | grep -a -E $'\e\\[(1;)?7m' | sed $'s/\e\\[[0-9;]*m//g'; }
# Moves the focus right to the entry of id $1, up to 15 steps; fails when it never gets there.
focus_on() {
  local k
  for ((k = 0; k < 15; k++)); do focused | grep -q -F -- "($1)" && return 0; $T send-keys -t proof Right; sleep 0.7; done
  focused | grep -q -F -- "($1)"
}
# Opens the personality tab, says which shipped entry it marks, folds the drawer.
menu_mark() {
  local m
  tab_open
  m=$(marked); pane > "$RUN/menu-$1.txt"
  tab_close
  echo "$m"
}
# Opens the personality tab, moves the focus to $1, Enter, folds the drawer.
# Fails loudly when no shipped entry is marked or $1 is never focused: the steps are unknown.
menu_pick() {
  local from
  tab_open
  from=$(marked) || { pane > "$RUN/menu-unmarked.txt"; echo "ERROR the personality tab marks no shipped character; pane in $RUN/menu-unmarked.txt" >&2; exit 2; }
  focus_on "$1" || { pane > "$RUN/menu-to-$1.txt"; echo "ERROR the focus never reached $1; pane in $RUN/menu-to-$1.txt" >&2; exit 2; }
  in_pane "$(about_of "$1")" || { pane > "$RUN/menu-to-$1.txt"; log "no $1 preview with the focus on it"; }
  $T send-keys -t proof Enter; sleep 3
  tab_close
  log "picked $1 from $from"
}

fail=0
row() { local name=$1 verdict=$2 got=$3; printf '| %-46s | %-4s | %s |\n' "$name" "$verdict" "${got:0:90}"; }
results=()
# Not in a subshell: a FAIL must reach the exit code.
add() { [ "$2" = PASS ] || fail=1; results+=("$(row "$@")"); }

command_out "/buddy on" >/dev/null
menu_pick "$DEFAULT"
if shows_any "$RUN/default.rows"; then add "(a) the default ($DEFAULT) is drawn" PASS "sprite row in the pane"; else add "(a) the default ($DEFAULT) is drawn" FAIL "no $DEFAULT row"; fi
pane > "$RUN/a.txt"

sleep 8
s1=$(pane | grep -F -f "$RUN/default.rows"); sleep 2; s2=$(pane | grep -F -f "$RUN/default.rows"); sleep 2; s3=$(pane | grep -F -f "$RUN/default.rows")
if [ -n "$s1" ] && { [ "$s1" != "$s2" ] || [ "$s2" != "$s3" ]; }; then add "(b) it walks" PASS "the band changed across samples"; else add "(b) it walks" FAIL "no change in 4 s"; fi

# The pet button: ctrl+x tab steps in on `talk`; two steps right is `♥ pet · N`.
command_out "/buddy" >/dev/null || exit 2; sleep 2
pets() { pane | sed -n 's/.*♥ pet · \([0-9][0-9]*\).*/\1/p' | head -1; }
p0=$(pets)
$T send-keys -t proof C-x; $T send-keys -t proof Tab; sleep 1
$T send-keys -t proof Right; sleep 0.7; $T send-keys -t proof Right; sleep 1
onpet=$(focused | grep -c -F '♥ pet')
$T send-keys -t proof Enter; sleep 2
p1=$(pets); pane > "$RUN/c-pet.txt"
tab_close
if [ "$onpet" -gt 0 ] && [ -n "$p0" ] && [ "${p1:-0}" -eq $((p0 + 1)) ]; then add "(c) the drawer's pet button pets" PASS "♥ pet · $p0 -> $p1"; else add "(c) the drawer's pet button pets" FAIL "focus on pet: $onpet, $p0 -> ${p1:-none}; pane in $RUN/c-pet.txt"; fi
m=$(menu_mark c) || exit 2
if [ "$m" = "$DEFAULT" ]; then add "(c) the personality tab marks the current one" PASS "* $DEF_NAME ($DEFAULT)"; else add "(c) the personality tab marks the current one" FAIL "marked: ${m:-none}; pane in $RUN/menu-c.txt"; fi

out=$(command_out "/buddy what is your favourite tool") || exit 2
got=$(answered); v=$?
if [ $v -eq 0 ] && grep -q 'Asked' <<<"$out"; then add "(d) question before a reply" PASS "$got"; else add "(d) question before a reply" FAIL "$out / $got"; fi

send "Run this Bash command: npm test. Then reply with exactly: T1"
seen=""
for _ in $(seq 1 180); do
  sleep 0.5
  [ -z "$seen" ] && bubble_has_any "$RUN/testpass.pool" && { seen=$(bubble); pane > "$RUN/e.txt"; }
  f=$(transcript)
  [ -n "$f" ] && jq -e 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | select(.text|contains("T1"))' "$f" >/dev/null 2>&1 && [ -n "$seen" ] && break
done
[ -n "$(transcript)" ] || { echo "ERROR no transcript for $ID under $PROJECTS"; exit 2; }
if [ -n "$seen" ]; then add "(e) a test pass shows a testPass line" PASS "$seen"; else add "(e) a test pass shows a testPass line" FAIL "no testPass line seen"; fi
sleep 7

out=$(command_out "/buddy what did we just run") || exit 2
got=$(answered); v=$?
[ $v -eq 0 ] && add "(f) question after a reply" PASS "$got" || add "(f) question after a reply" FAIL "$out / $got"

menu_pick "$OTHER"
if shows_any "$RUN/other.rows"; then add "(g) a personality tab pick of $OTHER draws it" PASS "$OTHER sprite row in the pane"; else add "(g) a personality tab pick of $OTHER draws it" FAIL "no $OTHER row"; fi
m=$(menu_mark g)
if [ "$m" = "$OTHER" ]; then add "(g) reopened, the tab marks $OTHER" PASS "* $(name_of "$OTHER") ($OTHER)"; else add "(g) reopened, the tab marks $OTHER" FAIL "marked: ${m:-none}; pane in $RUN/menu-g.txt"; fi
menu_pick "$DEFAULT"
if shows_any "$RUN/default.rows"; then add "(g) picking the default returns" PASS "$DEFAULT sprite row in the pane"; else add "(g) picking the default returns" FAIL "no $DEFAULT row"; fi

out=$(command_out "/buddy off") || exit 2; sleep 3
if ! shows_any "$RUN/default.rows"; then add "(h) /buddy off hides" PASS "$out"; else add "(h) /buddy off hides" FAIL "still drawn"; fi
out=$(command_out "/buddy on") || exit 2; sleep 3
if shows_any "$RUN/default.rows"; then add "(h) /buddy on shows" PASS "$out"; else add "(h) /buddy on shows" FAIL "not drawn"; fi

# The personality tab lists characters/ sorted by id; NEXT is the entry after the default.
PICK=cat
grep -q -x "$PICK" <<<"$IDS" || { echo "ERROR no $PICK.json in $CHARS"; exit 2; }
NEXT=$(grep -A1 -x "$DEFAULT" <<<"$IDS" | tail -1)
rows_of "$PICK" | grep -v -x -F -f "$RUN/default.rows" > "$RUN/pick.rows"
tab_open
pane > "$RUN/i-open.txt"
if in_pane "* $DEF_NAME ($DEFAULT)" && in_pane "Shipped" && in_pane "customCharactersDir" && in_pane "$(about_of "$DEFAULT")" && ! in_pane "$(persona_of "$DEFAULT")"; then
  add "(i) /buddy opens the personality tab" PASS "* $DEF_NAME ($DEFAULT), the groups, its description"
else add "(i) /buddy opens the personality tab" FAIL "pane in $RUN/i-open.txt"; fi
focus_on "$NEXT"; sleep 1
pane > "$RUN/i-down.txt"
if focused | grep -q -F "($NEXT)" && in_pane "$(about_of "$NEXT")" && ! in_pane "$(about_of "$DEFAULT")"; then add "(i) Right moves the preview to $NEXT" PASS "preview shows the $NEXT description"
else add "(i) Right moves the preview to $NEXT" FAIL "pane in $RUN/i-down.txt"; fi
tab_close
pane > "$RUN/i-esc.txt"
if ! in_pane "customCharactersDir" && shows_any "$RUN/default.rows"; then add "(i) Esc, ctrl+x x: folded, nothing changed" PASS "drawer folded, $DEFAULT still drawn"
else add "(i) Esc, ctrl+x x: folded, nothing changed" FAIL "pane in $RUN/i-esc.txt"; fi
tab_open
if focus_on "$PICK" && in_pane "$(about_of "$PICK")"; then pre=ok; else pre="no $PICK preview"; fi
$T send-keys -t proof Enter; sleep 3
pane > "$RUN/i-pick.txt"
m=$(marked)
tab_close
pane > "$RUN/i-picked.txt"
if [ "$pre" = ok ] && [ "$m" = "$PICK" ] && shows_any "$RUN/pick.rows"; then add "(i) Enter on $PICK draws it, the tab marks it" PASS "* $(name_of "$PICK") ($PICK); its sprite in the band"
else add "(i) Enter on $PICK draws it, the tab marks it" FAIL "$pre / marked: ${m:-none} / panes in $RUN/i-pick.txt, i-picked.txt"; fi
m=$(menu_mark i) || exit 2
if [ "$m" = "$PICK" ]; then add "(i) reopened, the tab marks $PICK" PASS "* $(name_of "$PICK") ($PICK)"; else add "(i) reopened, the tab marks $PICK" FAIL "marked: ${m:-none}; pane in $RUN/menu-i.txt"; fi
menu_pick "$DEFAULT"
if shows_any "$RUN/default.rows"; then add "(i) picking the default returns" PASS "$DEFAULT sprite row in the pane"; else add "(i) picking the default returns" FAIL "no $DEFAULT row"; fi

out=$(command_out "/buddy remember the word pineapple") || exit 2
got=$(answered); v=$?
[ $v -eq 0 ] && grep -q 'Asked' <<<"$out" && add "(j) /buddy remember the word pineapple" PASS "$got" || add "(j) /buddy remember the word pineapple" FAIL "$out / $got"
echo "$got" > "$RUN/j-first.txt"
out=$(command_out "/buddy what word did I ask you to remember?") || exit 2
got=$(answered); v=$?
echo "$got" > "$RUN/j-second.txt"
if [ $v -eq 0 ] && grep -q -i 'pineapple' <<<"$got"; then add "(j) the next answer remembers pineapple" PASS "$got"; else add "(j) the next answer remembers pineapple" FAIL "$out / $got"; fi
# This plugin's store in the run's config dir: only the key of this session is read.
STORE=$(store_file)
mem=$([ -n "$STORE" ] && jq -r --arg k "chatTurnsToRead:$ID" --arg d "$DEFAULT" '.[$k].blocks[]?.characters[$d][]? | if .kind == "question" then "question: \(.question) -> \(.answer // "(no answer)")" elif .kind == "endOfTurn" then "endOfTurn: \(.commentAfterEachTurn // "-") | \(.suggestNextPrompt // "-")" else "\(.kind): \(.text)" end' "$STORE" 2>&1)
echo "$mem" > "$RUN/j-chatTurnsToRead.txt"
if grep -q -F 'question: remember the word pineapple -> ' <<<"$mem" && grep -q -F 'question: what word did I ask you to remember? -> ' <<<"$mem" && ! grep -q -F -f "$RUN/thinking.pool" <<<"$mem"; then
  add "(j) the store holds this session's chatTurnsToRead" PASS "$(grep -c . <<<"$mem") exchanges under chatTurnsToRead:$ID, no thinking filler"
else add "(j) the store holds this session's chatTurnsToRead" FAIL "${STORE:-no buddy_inline store file}: $(head -c 80 <<<"$mem")"; fi

# (k) Ask while a main turn runs: `model` answers at once, the turn still running.
send "Run this Bash command: sleep 15. Then reply with exactly: K1"
for _ in $(seq 1 40); do sleep 0.5; f=$(transcript); [ -n "$f" ] && jq -e 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | select(.input.command? // "" | contains("sleep 15"))' "$f" >/dev/null 2>&1 && break; done
# Both asks back to back, the second before the first's reply row is awaited.
before=$(stdout_rows | wc -l)
send "/buddy do you like yourself?"
send "/buddy say ack"
for _ in $(seq 1 20); do sleep 1; [ "$(stdout_rows | wc -l)" -ge "$((before + 2))" ] && break; done
out=$(stdout_rows | tail -n +"$((before + 1))" | sed -n 1p); out2=$(stdout_rows | tail -n +"$((before + 1))" | sed -n 2p)
got=$(answered); v=$?
sleep 3
mem=$([ -n "$STORE" ] && jq -r --arg k "chatTurnsToRead:$ID" --arg d "$DEFAULT" '.[$k].blocks[]?.characters[$d][]? | select(.kind == "question") | "\(.question) -> \(.answer // "(no answer)")"' "$STORE" 2>&1)
a1=$(grep -F 'do you like yourself? -> ' <<<"$mem" | tail -1 | sed 's/.* -> //')
route=$(jq -r -s '([.[] | select(.event == "ask.outcome" and .outcome != "refused")] | last) as $o | "\($o.outcome // "none") in \($o.ms // "-") ms"' "$RUN/buddy.log" 2>&1)
# The answer came before the main turn ended: by the log, its answered outcome
# precedes the turn's end (turn.call or turn.skipped, logged at every main turn end).
for _ in $(seq 1 60); do jq -e -s 'any(.[]; .event == "turn.call" or .event == "turn.skipped")' "$RUN/buddy.log" >/dev/null 2>&1 && [ "$(jq -r -s '([.[] | select(.event == "ask.outcome" and .outcome != "refused")] | last | .ts) as $a | if $a == null then 0 else ([.[] | select((.event == "turn.call" or .event == "turn.skipped") and .ts > $a)] | length) end' "$RUN/buddy.log" 2>/dev/null)" -gt 0 ] && break; sleep 0.5; done
ended=$(jq -r -s '([.[] | select(.event == "ask.outcome" and .outcome != "refused")] | last | .ts) as $a | if $a == null then "no answer" elif any(.[]; (.event == "turn.call" or .event == "turn.skipped") and .ts > $a) then "no" else "yes" end' "$RUN/buddy.log" 2>&1)
echo "$out / $out2 / $got / $a1 / turn ended first: $ended / $route" > "$RUN/k.txt"
if grep -q 'Asked' <<<"$out" && [ -n "$a1" ] && [ "$a1" != "(no answer)" ] && [ "$ended" = no ] && grep -q '^answered' <<<"$route"; then add "(k) a question during a busy main turn: answered before the turn ends" PASS "$a1 ($route)"; else add "(k) a question during a busy main turn: answered before the turn ends" FAIL "$out / ${a1:-not in chatTurnsToRead} / turn ended first: $ended / $route"; fi
if grep -q 'still thinking about your last question' <<<"$out2" || { grep -q 'Asked' <<<"$out2" && [ $v -eq 0 ]; }; then add "(k) a second immediate ask: a visible outcome" PASS "$out2 / bubble: $got"; else add "(k) a second immediate ask: a visible outcome" FAIL "${out2:-no reply} / $got"; fi
for _ in $(seq 1 60); do sleep 0.5; f=$(transcript); jq -e 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | select(.text|contains("K1"))' "$f" >/dev/null 2>&1 && break; done
# (l) The plugin log: this run's file, the ask's start and outcome.
BLOG=$RUN/buddy.log
if [ -s "$BLOG" ] && jq -e -s 'any(.[]; .event == "ask.start") and any(.[]; .event == "ask.outcome" and .outcome == "answered")' "$BLOG" >/dev/null 2>&1; then
  add "(l) the log holds the ask's start and outcome" PASS "$(jq -r -s '[.[] | select(.event == "ask.outcome")] | map("\(.outcome) \(.ms)ms") | join(", ")' "$BLOG")"
else add "(l) the log holds the ask's start and outcome" FAIL "$(tail -c 200 "$BLOG" 2>&1)"; fi
out=$(command_out "/buddy log") || exit 2
if grep -q -F "Log: $BLOG" <<<"$out" && grep -q '"event":' <<<"$out"; then add "(l) /buddy log prints its path and lines" PASS "$(head -c 90 <<<"$out")"; else add "(l) /buddy log prints its path and lines" FAIL "$(head -c 200 <<<"$out")"; fi

cp "$(transcript)" "$RUN/main.jsonl"
echo
echo "| check | verdict | evidence |"
echo "| --- | --- | --- |"
printf '%s\n' "${results[@]}"
echo "evidence: $RUN"
exit $fail
