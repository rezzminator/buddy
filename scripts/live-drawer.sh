#!/usr/bin/env bash
# Live drawer: drives a real interactive Claude Code session (Haiku) in tmux on
# a private socket, with this checkout loaded by --plugin-dir, the buddy on its
# default model with commentAfterEachTurn and suggestNextPrompt on; runs two
# turns and a /buddy question, then opens the drawer with /buddy, keeps what it drew,
# colors and all ($RUN/drawer.ansi, the screen with its escape codes, and
# drawer.txt), checks its thread spans the memory; ctrl+x t opens the
# personality pane, Down lights the entry after the duck and the preview follows,
# Enter switches the drawer's character to it, Esc closes the pane; then folds
# the drawer back with ctrl+x q from the prompt.
# Each check prints PASS or FAIL; the exit code counts the FAILs.
# Usage: scripts/live-drawer.sh [columns] [rows]  (default 200 x 60)
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLUGIN=$ROOT/plugins/buddy
CHARS=$PLUGIN/characters
. "$ROOT/scripts/live-lib.sh"
live_require
COLS=${1:-200}
ROWS=${2:-60}

RUN=/tmp/buddy/drawer-$(date +%Y%m%dT%H%M%S)
WORK=$RUN/work
mkdir -p "$WORK"
printf '%s\n' '{ "name": "proof", "private": true, "scripts": { "test": "echo Tests: 3 passed" } }' > "$WORK/package.json"
cat > "$RUN/settings.json" <<'EOF'
{ "pluginConfigs": { "buddy@inline": { "options": { "commentAfterEachTurn": true, "suggestNextPrompt": true, "logLevel": "debug", "logFile": "RUNDIR/buddy.log" } } } }
EOF
sed -i.bak "s|RUNDIR|$RUN|" "$RUN/settings.json" && rm -f "$RUN/settings.json.bak"
ID=$(uuidgen | tr 'A-Z' 'a-z')
live_isolate
T="tmux -L buddy-drawer"
TGT=drawer
LOG=$RUN/drive.log
echo "run dir: $RUN  session: $ID"
pool_of duck thinking > "$RUN/thinking.pool"

$T kill-session -t drawer 2>/dev/null
$T new-session -d -s drawer -x "$COLS" -y "$ROWS" -c "$WORK" \
  "'$LIVE_CLAUDE' --model haiku --setting-sources project --settings '$RUN/settings.json' \
   --allowedTools Bash --plugin-dir '$PLUGIN' --session-id $ID"
trap '$T capture-pane -p -t drawer -S -300 > "$RUN/pane.txt" 2>/dev/null; $T kill-server 2>/dev/null' EXIT
live_boot

FAILS=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; FAILS=$((FAILS + 1)); fi; }
wait_log() { for _ in $(seq 1 90); do grep -q -- "$1" "$RUN/buddy.log" 2>/dev/null && return 0; sleep 1; done; return 1; }

send "Run this Bash command: ls -a. Then reply in one short sentence about what is there."
check "turn 1: the buddy commented" "wait_log commentAfterEachTurn.outcome"
sleep 3
send "Now run: npm test. Then reply with the result in five words."
for _ in $(seq 1 90); do [ "$(grep -c commentAfterEachTurn.outcome "$RUN/buddy.log" 2>/dev/null)" -ge 2 ] && break; sleep 1; done
check "turn 2: the buddy commented" "[ \"\$(grep -c commentAfterEachTurn.outcome '$RUN/buddy.log')\" -ge 2 ]"
send "/buddy what do you make of this project so far?"
check "the question was answered" "wait_log '\"ask.outcome\"'"
sleep 2

# The drawer: the band above the prompt opened into it, captured, folded back.
send "/buddy"
sleep 4
$T capture-pane -e -p -t drawer > "$RUN/drawer.ansi"
$T capture-pane -p -t drawer > "$RUN/drawer.txt"
check "/buddy drew the drawer above the prompt, its shortcuts' guide" "grep -q -F 'ctrl+x q close' '$RUN/drawer.txt' && grep -q -F 'what do you make of this project' '$RUN/drawer.txt'"
check "the thread names the memory and holds both turns" "grep -q -F 'remembers your last 4 turns with Claude' '$RUN/drawer.txt' && grep -q -F 'you → Claude: Run this Bash command' '$RUN/drawer.txt' && grep -q -F 'you → Claude: Now run: npm test' '$RUN/drawer.txt'"
# Every act is a ctrl+x chord pressed from the prompt: ctrl+x t opens the
# personality pane, which takes the keys while the prompt is empty.
$T send-keys -t drawer C-x t; sleep 3
$T capture-pane -p -t drawer > "$RUN/personality.txt"
check "ctrl+x t: the personality pane lists the characters, the duck marked" "grep -q -F '* Quack (duck)' '$RUN/personality.txt' && grep -q -F 'Shipped' '$RUN/personality.txt'"
# The shipped entry after the duck, by id: Down moves the ring onto it.
NEXT=$(ls "$CHARS"/*.json | xargs -n1 basename | sed 's/\.json$//' | sort | grep -A1 -x duck | tail -1)
next_about=$(jq -r '.description | gsub("\\s+"; " ") | .[0:40]' "$CHARS/$NEXT.json")
duck_about=$(jq -r '.description | gsub("\\s+"; " ") | .[0:40]' "$CHARS/duck.json")
# The drawer's card spells the name drawn now in spaced capitals.
next_card=$(jq -r '.name' "$CHARS/$NEXT.json" | tr '[:lower:]' '[:upper:]' | sed 's/./& /g; s/ $//')
$T send-keys -t drawer Down; sleep 2
$T capture-pane -p -t drawer > "$RUN/personality-down.txt"
check "Down lights $NEXT, the preview following it" "grep -q -F -- '$next_about' '$RUN/personality-down.txt' && ! grep -q -F -- '$duck_about' '$RUN/personality-down.txt'"
$T send-keys -t drawer Enter; sleep 3
$T capture-pane -p -t drawer > "$RUN/personality-enter.txt"
check "Enter switches the drawer's character to $NEXT, the pane still open" "grep -q -F -- '$next_card' '$RUN/personality-enter.txt' && grep -q -F 'Shipped' '$RUN/personality-enter.txt'"
$T send-keys -t drawer Escape; sleep 2
check "Esc closes the pane, the drawer still open" "! pane | grep -q -F 'Shipped' && pane | grep -q -F 'ctrl+x q close'"
# ctrl+x tab steps into the ask box, which then shows its submit label; Esc steps out.
$T send-keys -t drawer C-x Tab; sleep 1
check "ctrl+x tab reaches the ask box" "pane | grep -q -F '⏎ ask'"
$T send-keys -t drawer Escape; sleep 1
# ctrl+x q from the prompt folds it back (confirm:previousField).
$T send-keys -t drawer C-x q
sleep 3
check "ctrl+x q from the prompt folded it back" "! pane | grep -q -F 'ctrl+x q close'"
echo "screen: $RUN/drawer.txt (and .ansi with colors)"
exit "$FAILS"
