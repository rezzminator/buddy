#!/usr/bin/env bash
# Live drawer: drives a real interactive Claude Code session (Haiku) in tmux on
# a private socket, with this checkout loaded by --plugin-dir, the buddy on its
# default model with commentAfterEachTurn and suggestNextPrompt on; runs two
# turns and a /buddy question, then opens the drawer with /buddy, keeps what it drew,
# colors and all ($RUN/drawer.ansi, the screen with its escape codes, and
# drawer.txt), checks its talk tab spans the memory and its personality tab
# lists the characters, each reached by its ctrl+x chord, and folds it back
# with ctrl+x q from the prompt.
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
check "/buddy drew the drawer above the prompt, its shortcuts' guide" "grep -q -F 'ctrl+x b previous character' '$RUN/drawer.txt' && grep -q -F 'what do you make of this project' '$RUN/drawer.txt'"
check "the talk tab names the memory and holds both turns" "grep -q -F 'remembers: your last 4 turns with Claude' '$RUN/drawer.txt' && grep -q -F 'you → Claude: Run this Bash command' '$RUN/drawer.txt' && grep -q -F 'you → Claude: Now run: npm test' '$RUN/drawer.txt'"
# Every act is a ctrl+x chord pressed from the prompt: ctrl+x t opens the personality tab, and again goes back to talk.
$T send-keys -t drawer C-x t; sleep 3
$T capture-pane -p -t drawer > "$RUN/personality.txt"
check "ctrl+x t: the personality tab lists the characters, the duck marked" "grep -q -F '* Quack (duck)' '$RUN/personality.txt' && grep -q -F 'Shipped' '$RUN/personality.txt'"
$T send-keys -t drawer C-x t; sleep 2
check "ctrl+x t again goes back to the thread" "pane | grep -q -F 'what do you make of this project'"
# ctrl+x tab steps into the ask box, which then shows its submit label; Esc steps out.
$T send-keys -t drawer C-x Tab; sleep 1
check "ctrl+x tab reaches the ask box" "pane | grep -q -F '⏎ ask'"
$T send-keys -t drawer Escape; sleep 1
# ctrl+x q from the prompt folds it back (confirm:previousField).
$T send-keys -t drawer C-x q
sleep 3
check "ctrl+x q from the prompt folded it back" "! pane | grep -q -F 'ctrl+x b previous character'"
echo "screen: $RUN/drawer.txt (and .ansi with colors)"
exit "$FAILS"
