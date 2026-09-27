#!/usr/bin/env bash
# Live proof: drives a real interactive Claude Code session (Haiku) in tmux on
# a private socket, with this checkout loaded by --plugin-dir, and reads the
# band from the pane and the /buddy replies from the transcript:
#   (a) the default character, the duck, is drawn above the prompt
#   (b) it walks: the band changes between samples while nothing is said
#   (c) /buddy pets it and counts; /buddy-personality marks it with *
#   (d) a /buddy question before the first reply (nothing to fork, so the
#       quip model answers) fills the bubble with an answer
#   (e) a Bash `npm test` run printing a test pass shows a testPass line
#   (f) a /buddy question after a reply (a fork of the chat) is answered
#   (g) Enter on another character in /buddy-personality draws it, and the
#       reopened menu marks it with *; picking the duck there returns
#   (h) /buddy off hides the band; /buddy on brings it back
#   (i) /buddy-personality opens the menu pane, the duck marked; Down
#       moves the preview to the next entry; Esc closes it and changes nothing;
#       Enter on cat draws the cat and the reopened menu marks it; picking
#       the duck returns. HOME stays real (a fake one logs the session out), so
#       no row reads or prints the "Yours" group: hook tests prove that path.
#   (j) memory: /buddy remember the word pineapple, then /buddy what word did I
#       ask you to remember? is answered with pineapple; the plugin's store
#       holds both as exchanges, no thinking filler (its memory:{session} key,
#       nothing else read)
#   (k) a /buddy question while a main turn runs (`sleep 8` via Bash, after a
#       marker line) is answered without the main turn's text, and a second
#       immediate ask gets a visible outcome: refused out loud, or asked
#   (l) the plugin log (logFile set to this run's folder) holds the ask's
#       start and outcome, and /buddy log prints its path and lines
# Prints a table, one row per check, and exits 1 when any check fails,
# 2 when the session could not be driven (no transcript, a turn timed out).
# Spends real tokens: a few cents of Haiku. It resets this plugin's own
# /buddy on and /buddy-personality choices (the --plugin-dir copy,
# buddy@inline). --setting-sources project keeps the user's own settings, and
# so their character option, out of the run.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLUGIN=$ROOT/plugins/buddy
CHARS=$PLUGIN/characters
if [ -z "${CLAUDE_BIN:-}" ]; then
  CLAUDE_BIN=$(command -v claude)
  if file -L -b "$CLAUDE_BIN" 2>/dev/null | grep -q text; then
    CLAUDE_BIN=$(ls -d "$HOME"/.local/share/claude/versions/* 2>/dev/null | sort -V | tail -1)
  fi
fi
[ -x "$CLAUDE_BIN" ] || { echo "ERROR no claude binary found (set CLAUDE_BIN)"; exit 2; }
command -v tmux >/dev/null || { echo "ERROR tmux not found"; exit 2; }
command -v jq >/dev/null || { echo "ERROR jq not found"; exit 2; }
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
{ "pluginConfigs": { "buddy@inline": { "options": { "questionMode": "fork", "quips": false, "motion": true, "logLevel": "debug", "logFile": "RUNDIR/buddy.log" } } } }
EOF
sed -i.bak "s|RUNDIR|$RUN|" "$RUN/settings.json" && rm -f "$RUN/settings.json.bak"
ID=$(uuidgen | tr 'A-Z' 'a-z')
PROJECTS=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects
T="tmux -L buddy-proof"
LOG=$RUN/drive.log
log() { echo "$(date +%T) $*" >> "$LOG"; }
echo "run dir: $RUN  session: $ID"

# Distinctive sprite rows of a character (4+ visible characters), and a line pool.
rows_of() { jq -r '[.poses[][][]] | map(gsub("^ +| +$"; "")) | map(select(length >= 4)) | unique[]' "$CHARS/$1.json"; }
pool_of() { jq -r --arg e "$2" '.lines[$e][]? | gsub(" +"; " ")' "$CHARS/$1.json"; }
rows_of "$DEFAULT" > "$RUN/default.rows"
rows_of "$OTHER" | grep -v -x -F -f "$RUN/default.rows" > "$RUN/other.rows"
pool_of "$DEFAULT" thinking > "$RUN/thinking.pool"
pool_of "$DEFAULT" testPass > "$RUN/testpass.pool"
[ -s "$RUN/testpass.pool" ] || printf '%s\n' 'Tests pass!' 'All green.' 'It passes. Nice.' > "$RUN/testpass.pool"
[ -s "$RUN/thinking.pool" ] || printf '%s\n' 'Let me think...' 'Hmm...' 'One moment...' > "$RUN/thinking.pool"

$T kill-session -t proof 2>/dev/null
$T new-session -d -s proof -x 160 -y 50 -c "$WORK" \
  "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 '$CLAUDE_BIN' --model haiku --setting-sources project --settings '$RUN/settings.json' \
   --allowedTools Bash --plugin-dir '$PLUGIN' --session-id $ID"
trap '$T capture-pane -p -t proof -S -300 > "$RUN/pane.txt" 2>/dev/null; $T kill-server 2>/dev/null' EXIT
# Boot: the trust dialog defaults to "No, exit", so Down then Enter.
for _ in $(seq 1 30); do
  sleep 1
  pane=$($T capture-pane -p -t proof)
  if grep -q -i 'trust' <<<"$pane"; then $T send-keys -t proof Down; sleep 1; $T send-keys -t proof Enter; log "trust accepted"; sleep 3; fi
  if grep -q -E 'Enter to confirm' <<<"$pane"; then $T send-keys -t proof Enter; log "confirm accepted"; sleep 3; fi
  grep -q -E '^ *(>|❯) ' <<<"$pane" && ! grep -q -i -E 'trust|Enter to confirm' <<<"$pane" && break
done
$T capture-pane -p -t proof > "$RUN/boot.txt"

transcript() { find "$PROJECTS" -maxdepth 2 -name "$ID.jsonl" 2>/dev/null | head -1; }
pane() { $T capture-pane -p -t proof; }
# The bubble's text: what sits between the round border's side bars, joined.
bubble() { pane | grep '│' | sed -n 's/.*│ *\(.*[^ ]\) *│.*/\1/p' | tr '\n' ' ' | tr -s ' '; }
shows_any() { local p; p=$(pane); while IFS= read -r r; do [ -n "$r" ] && grep -q -F -- "$r" <<<"$p" && return 0; done < "$1"; return 1; }
bubble_has_any() { local b; b=$(bubble); while IFS= read -r l; do [ -n "$l" ] && grep -q -F -- "$l" <<<"$b" && return 0; done < "$1"; return 1; }
send() { $T send-keys -t proof -l "$1"; sleep 1; $T send-keys -t proof Enter; log "<- $1"; }
# Each /buddy reply as one line (a multi-line reply joined by " / ").
stdout_rows() {
  local f; f=$(transcript); [ -n "$f" ] || return 0
  jq -r 'select(.type=="system" or .type=="user") | (.content // .message.content // "") | strings
    | select(contains("<local-command-stdout>")) | capture("<local-command-stdout>(?<o>[\\s\\S]*?)</local-command-stdout>").o
    | gsub("\n"; " / ")' "$f"
}
# A slash command: its output row from the transcript, or fail loudly.
command_out() {
  local before; before=$(stdout_rows | wc -l)
  send "$1"
  for _ in $(seq 1 20); do
    sleep 1
    [ "$(stdout_rows | wc -l)" -gt "$before" ] && { stdout_rows | tail -n +"$((before + 1))" | tr '\n' ' '; log "done $1"; return 0; }
  done
  echo "ERROR $1 printed no output row; pane in $RUN/pane.txt" >&2; exit 2
}
# Waits for the bubble to hold an answer: not empty, no thinking line, no refusal, no failure.
answered() {
  for _ in $(seq 1 100); do
    sleep 1
    b=$(bubble)
    if grep -q "couldn't answer" <<<"$b"; then echo "FAILED: $b"; return 1; fi
    grep -q 'still thinking about your last question' <<<"$b" && continue
    [ -n "$b" ] && ! bubble_has_any "$RUN/thinking.pool" && { echo "$b"; return 0; }
  done
  echo "TIMEOUT: $(bubble)"; return 1
}

# The menu: Shipped lists characters/ sorted by id; the highlight opens on the
# marked (*) entry, the one drawn now.
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
# Opens /buddy-personality and says which shipped entry it marks; Esc closes it.
menu_mark() {
  local m
  command_out "/buddy-personality" >/dev/null; sleep 3
  m=$(marked); pane > "$RUN/menu-$1.txt"
  $T send-keys -t proof Escape; sleep 2
  echo "$m"
}
# Opens /buddy-personality, moves from the marked entry to $1 (Up or Down), Enter.
# Fails loudly when the marked entry is not a shipped one: the steps are unknown.
menu_pick() {
  local from n key
  command_out "/buddy-personality" >/dev/null; sleep 3
  from=$(marked) || { pane > "$RUN/menu-unmarked.txt"; echo "ERROR /buddy-personality marks no shipped character; pane in $RUN/menu-unmarked.txt" >&2; exit 2; }
  n=$(( $(index_of "$1") - $(index_of "$from") )); key=Down
  [ "$n" -lt 0 ] && { n=$(( -n )); key=Up; }
  # Never seq 1 "$n": macOS seq 1 0 counts down and sends two keys.
  for ((k = 0; k < n; k++)); do $T send-keys -t proof "$key"; sleep 0.5; done
  sleep 1
  # A key the pane dropped leaves the highlight short: one more at a time, up to 3.
  for _ in 1 2 3; do
    [ "$n" -gt 0 ] && ! in_pane "$(about_of "$1")" || break
    log "no $1 preview after $n $key; one more"; $T send-keys -t proof "$key"; n=$((n + 1)); sleep 1
  done
  in_pane "$(about_of "$1")" || { pane > "$RUN/menu-to-$1.txt"; log "no $1 preview after $n $key"; }
  $T send-keys -t proof Enter; sleep 3
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

out=$(command_out "/buddy")
if grep -q -E ': [0-9]+ pets' <<<"$out"; then add "(c) /buddy pets" PASS "$out"; else add "(c) /buddy pets" FAIL "$out"; fi
m=$(menu_mark c)
if [ "$m" = "$DEFAULT" ]; then add "(c) /buddy-personality marks the current one" PASS "* $DEF_NAME ($DEFAULT)"; else add "(c) /buddy-personality marks the current one" FAIL "marked: ${m:-none}; pane in $RUN/menu-c.txt"; fi

out=$(command_out "/buddy what is your favourite tool")
got=$(answered); v=$?
[ $v -eq 0 ] && grep -q 'Asked' <<<"$out" && add "(d) question before a reply (quip model)" PASS "$got" || add "(d) question before a reply (quip model)" FAIL "$out / $got"

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

out=$(command_out "/buddy what did we just run")
got=$(answered); v=$?
[ $v -eq 0 ] && add "(f) question after a reply (fork)" PASS "$got" || add "(f) question after a reply (fork)" FAIL "$out / $got"

menu_pick "$OTHER"
if shows_any "$RUN/other.rows"; then add "(g) a menu pick of $OTHER draws it" PASS "$OTHER sprite row in the pane"; else add "(g) a menu pick of $OTHER draws it" FAIL "no $OTHER row"; fi
m=$(menu_mark g)
if [ "$m" = "$OTHER" ]; then add "(g) reopened, the menu marks $OTHER" PASS "* $(name_of "$OTHER") ($OTHER)"; else add "(g) reopened, the menu marks $OTHER" FAIL "marked: ${m:-none}; pane in $RUN/menu-g.txt"; fi
menu_pick "$DEFAULT"
if shows_any "$RUN/default.rows"; then add "(g) picking the default returns" PASS "$DEFAULT sprite row in the pane"; else add "(g) picking the default returns" FAIL "no $DEFAULT row"; fi

out=$(command_out "/buddy off"); sleep 3
if ! shows_any "$RUN/default.rows"; then add "(h) /buddy off hides" PASS "$out"; else add "(h) /buddy off hides" FAIL "still drawn"; fi
out=$(command_out "/buddy on"); sleep 3
if shows_any "$RUN/default.rows"; then add "(h) /buddy on shows" PASS "$out"; else add "(h) /buddy on shows" FAIL "not drawn"; fi

# The menu lists characters/ sorted by id: Up from the default's row reaches cat.
PICK=cat
grep -q -x "$PICK" <<<"$IDS" || { echo "ERROR no $PICK.json in $CHARS"; exit 2; }
ups=$(( $(grep -n -x "$DEFAULT" <<<"$IDS" | cut -d: -f1) - $(grep -n -x "$PICK" <<<"$IDS" | cut -d: -f1) ))
NEXT=$(grep -A1 -x "$DEFAULT" <<<"$IDS" | tail -1)
rows_of "$PICK" | grep -v -x -F -f "$RUN/default.rows" > "$RUN/pick.rows"
out=$(command_out "/buddy-personality"); sleep 3
pane > "$RUN/i-open.txt"
if in_pane "* $DEF_NAME ($DEFAULT)" && in_pane "Shipped" && in_pane "Your folder" && in_pane "$(about_of "$DEFAULT")" && ! in_pane "$(persona_of "$DEFAULT")"; then
  add "(i) /buddy-personality opens the menu" PASS "$out"
else add "(i) /buddy-personality opens the menu" FAIL "$out / pane in $RUN/i-open.txt"; fi
$T send-keys -t proof Down; sleep 2
pane > "$RUN/i-down.txt"
if in_pane "$(about_of "$NEXT")" && ! in_pane "$(about_of "$DEFAULT")"; then add "(i) Down moves the preview to $NEXT" PASS "preview shows the $NEXT description"
else add "(i) Down moves the preview to $NEXT" FAIL "pane in $RUN/i-down.txt"; fi
$T send-keys -t proof Escape; sleep 2
pane > "$RUN/i-esc.txt"
if ! in_pane "$(about_of "$NEXT")" && ! in_pane "Your folder" && shows_any "$RUN/default.rows"; then add "(i) Esc closes it, nothing changed" PASS "pane gone, $DEFAULT still drawn"
else add "(i) Esc closes it, nothing changed" FAIL "pane in $RUN/i-esc.txt"; fi
command_out "/buddy-personality" >/dev/null; sleep 3
for ((k = 0; k < ups; k++)); do $T send-keys -t proof Up; sleep 0.5; done
sleep 1
if in_pane "$(about_of "$PICK")"; then pre=ok; else pre="no $PICK preview"; fi
$T send-keys -t proof Enter; sleep 3
pane > "$RUN/i-pick.txt"
if [ "$pre" = ok ] && shows_any "$RUN/pick.rows" && ! in_pane "Your folder"; then add "(i) Enter on $PICK draws it, pane closed" PASS "$PICK sprite row in the pane"
else add "(i) Enter on $PICK draws it, pane closed" FAIL "$pre / pane in $RUN/i-pick.txt"; fi
m=$(menu_mark i)
if [ "$m" = "$PICK" ]; then add "(i) reopened, the menu marks $PICK" PASS "* $(name_of "$PICK") ($PICK)"; else add "(i) reopened, the menu marks $PICK" FAIL "marked: ${m:-none}; pane in $RUN/menu-i.txt"; fi
menu_pick "$DEFAULT"
if shows_any "$RUN/default.rows"; then add "(i) picking the default returns" PASS "$DEFAULT sprite row in the pane"; else add "(i) picking the default returns" FAIL "no $DEFAULT row"; fi

out=$(command_out "/buddy remember the word pineapple")
got=$(answered); v=$?
[ $v -eq 0 ] && grep -q 'Asked' <<<"$out" && add "(j) /buddy remember the word pineapple" PASS "$got" || add "(j) /buddy remember the word pineapple" FAIL "$out / $got"
echo "$got" > "$RUN/j-first.txt"
out=$(command_out "/buddy what word did I ask you to remember?")
got=$(answered); v=$?
echo "$got" > "$RUN/j-second.txt"
if [ $v -eq 0 ] && grep -q -i 'pineapple' <<<"$got"; then add "(j) the next answer remembers pineapple" PASS "$got"; else add "(j) the next answer remembers pineapple" FAIL "$out / $got"; fi
# This plugin's store (the --plugin-dir copy): only the key of this session is read.
STORE=$(ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/store/buddy_inline-*.json 2>/dev/null | head -1)
mem=$([ -n "$STORE" ] && jq -r --arg k "memory:$ID" --arg d "$DEFAULT" '.[$k].characters[$d][]? | if .kind == "question" then "question: \(.question) -> \(.answer // "(no answer)")" else "\(.kind): \(.text)" end' "$STORE" 2>&1)
echo "$mem" > "$RUN/j-memory.txt"
if grep -q -F 'question: remember the word pineapple -> ' <<<"$mem" && grep -q -F 'question: what word did I ask you to remember? -> ' <<<"$mem" && ! grep -q -F -f "$RUN/thinking.pool" <<<"$mem"; then
  add "(j) the store holds this session's memory" PASS "$(grep -c . <<<"$mem") exchanges under memory:$ID, no thinking filler"
else add "(j) the store holds this session's memory" FAIL "${STORE:-no buddy_inline store file}: $(head -c 80 <<<"$mem")"; fi

# (k) Ask while a main turn runs: the fork would replay that turn's words.
MARK=ZEBRA-7Q
send "First write exactly this sentence: $MARK the release is still running. Then run this Bash command: sleep 8. Then reply with exactly: K1"
for _ in $(seq 1 40); do sleep 0.5; f=$(transcript); [ -n "$f" ] && jq -e 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | select(.input.command? // "" | contains("sleep 8"))' "$f" >/dev/null 2>&1 && break; done
# Both asks back to back, the second before the first's reply row is awaited.
before=$(stdout_rows | wc -l)
send "/buddy do you like yourself?"
send "/buddy say ack"
for _ in $(seq 1 20); do sleep 1; [ "$(stdout_rows | wc -l)" -ge "$((before + 2))" ] && break; done
out=$(stdout_rows | tail -n +"$((before + 1))" | sed -n 1p); out2=$(stdout_rows | tail -n +"$((before + 1))" | sed -n 2p)
got=$(answered); v=$?
sleep 3
mem=$([ -n "$STORE" ] && jq -r --arg k "memory:$ID" --arg d "$DEFAULT" '.[$k].characters[$d][]? | select(.kind == "question") | "\(.question) -> \(.answer // "(no answer)")"' "$STORE" 2>&1)
a1=$(grep -F 'do you like yourself? -> ' <<<"$mem" | tail -1 | sed 's/.* -> //')
why=$(jq -r -s '[.[] | select(.event == "ask.fallback") | .why] | last // "none"' "$RUN/buddy.log" 2>&1)
echo "$out / $out2 / $got / $a1 / $why" > "$RUN/k.txt"
if grep -q 'Asked' <<<"$out" && [ -n "$a1" ] && [ "$a1" != "(no answer)" ] && ! grep -q -F "$MARK" <<<"$a1"; then add "(k) a question during a busy main turn: its own answer" PASS "$a1 (fallback: $why)"; else add "(k) a question during a busy main turn: its own answer" FAIL "$out / ${a1:-not in memory} / $why"; fi
if grep -q 'still thinking about your last question' <<<"$out2" || { grep -q 'Asked' <<<"$out2" && [ $v -eq 0 ]; }; then add "(k) a second immediate ask: a visible outcome" PASS "$out2 / bubble: $got"; else add "(k) a second immediate ask: a visible outcome" FAIL "${out2:-no reply} / $got"; fi
for _ in $(seq 1 60); do sleep 0.5; f=$(transcript); jq -e 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | select(.text|contains("K1"))' "$f" >/dev/null 2>&1 && break; done
# (l) The plugin log: this run's file, the ask's start and outcome.
BLOG=$RUN/buddy.log
if [ -s "$BLOG" ] && jq -e -s 'any(.[]; .event == "ask.start") and any(.[]; .event == "ask.outcome" and .outcome != "refused")' "$BLOG" >/dev/null 2>&1; then
  add "(l) the log holds the ask's start and outcome" PASS "$(jq -r -s '[.[] | select(.event == "ask.outcome")] | map("\(.outcome) via \(.via // "-") \(.ms)ms") | join(", ")' "$BLOG")"
else add "(l) the log holds the ask's start and outcome" FAIL "$(tail -c 200 "$BLOG" 2>&1)"; fi
out=$(command_out "/buddy log")
if grep -q -F "Log: $BLOG" <<<"$out" && grep -q '"event":' <<<"$out"; then add "(l) /buddy log prints its path and lines" PASS "$(head -c 90 <<<"$out")"; else add "(l) /buddy log prints its path and lines" FAIL "$(head -c 200 <<<"$out")"; fi

cp "$(transcript)" "$RUN/main.jsonl"
echo
echo "| check | verdict | evidence |"
echo "| --- | --- | --- |"
printf '%s\n' "${results[@]}"
echo "evidence: $RUN"
exit $fail
