# Shared helpers of the live scripts (scripts/live-proof.sh, scripts/live-configs.sh):
# the claude binary, the --plugin-dir store set aside, and one interactive
# session in tmux on a private socket, read from its pane and its transcript.
# Sourced, never run. The caller sets, before calling a helper:
#   T       the tmux command on the private socket (tmux -L {socket})
#   TGT     the tmux session name
#   RUN     the run folder; LOG=$RUN/drive.log
#   ID      the Claude session id; PROJECTS the config dir's projects/
#   CHARS   the characters folder (rows_of, pool_of)
# answered() reads $RUN/thinking.pool; command_out exits 2 when no row comes.

# The claude binary (CLAUDE_BIN, else the native one behind a `claude` shell
# wrapper), tmux and jq; exits 2 when one is missing.
live_require() {
  if [ -z "${CLAUDE_BIN:-}" ]; then
    CLAUDE_BIN=$(command -v claude)
    if file -L -b "$CLAUDE_BIN" 2>/dev/null | grep -q text; then
      CLAUDE_BIN=$(ls -d "$HOME"/.local/share/claude/versions/* 2>/dev/null | sort -V | tail -1)
    fi
  fi
  [ -x "$CLAUDE_BIN" ] || { echo "ERROR no claude binary found (set CLAUDE_BIN)"; exit 2; }
  command -v tmux >/dev/null || { echo "ERROR tmux not found"; exit 2; }
  command -v jq >/dev/null || { echo "ERROR jq not found"; exit 2; }
}

# A run starts on the default character: the --plugin-dir store keeps picks and pets from earlier runs,
# so it is moved aside into $RUN/store-aside and put back by restore_store.
STORE_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/store
live_store_aside() {
  mkdir -p "$RUN/store-aside"
  mv "$STORE_DIR"/buddy_inline-*.json "$RUN/store-aside/" 2>/dev/null
}
restore_store() { rm -f "$STORE_DIR"/buddy_inline-*.json; mv "$RUN/store-aside"/*.json "$STORE_DIR/" 2>/dev/null; }
# This plugin's store file (the --plugin-dir copy), or nothing.
store_file() { ls "$STORE_DIR"/buddy_inline-*.json 2>/dev/null | head -1; }

log() { echo "$(date +%T) $*" >> "$LOG"; }

# Distinctive sprite rows of a character (4+ visible characters), and a line pool.
rows_of() { jq -r '[.poses[][][]] | map(gsub("^ +| +$"; "")) | map(select(length >= 4)) | unique[]' "$CHARS/$1.json"; }
pool_of() { jq -r --arg e "$2" '.lines[$e][]? | gsub(" +"; " ")' "$CHARS/$1.json"; }

# Boot: the trust dialog defaults to "No, exit", so Down then Enter; waits for the prompt, 30 s at most.
live_boot() {
  local pane
  for _ in $(seq 1 30); do
    sleep 1
    pane=$($T capture-pane -p -t "$TGT")
    if grep -q -i 'trust' <<<"$pane"; then $T send-keys -t "$TGT" Down; sleep 1; $T send-keys -t "$TGT" Enter; log "trust accepted"; sleep 3; fi
    if grep -q -E 'Enter to confirm' <<<"$pane"; then $T send-keys -t "$TGT" Enter; log "confirm accepted"; sleep 3; fi
    # The prompt glyph is followed by a space or a no-break space (U+00A0), as Claude Code draws it.
    grep -q -E $'^ *(>|❯)( |\xc2\xa0)' <<<"$pane" && ! grep -q -i -E 'trust|Enter to confirm' <<<"$pane" && break
  done
}

# -H: a config dir's projects/ may be a symlink (accounts sharing one), which find does not enter without it.
transcript() { find -H "$PROJECTS" -maxdepth 2 -name "$ID.jsonl" 2>/dev/null | head -1; }
pane() { $T capture-pane -p -t "$TGT"; }
# The bubble's text: what sits between the round border's side bars, joined.
bubble() { pane | grep '│' | sed -n 's/.*│ *\(.*[^ ]\) *│.*/\1/p' | tr '\n' ' ' | tr -s ' '; }
shows_any() { local p; p=$(pane); while IFS= read -r r; do [ -n "$r" ] && grep -q -F -- "$r" <<<"$p" && return 0; done < "$1"; return 1; }
bubble_has_any() { local b; b=$(bubble); while IFS= read -r l; do [ -n "$l" ] && grep -q -F -- "$l" <<<"$b" && return 0; done < "$1"; return 1; }
send() { $T send-keys -t "$TGT" -l "$1"; sleep 1; $T send-keys -t "$TGT" Enter; log "<- $1"; }
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
  local b
  for _ in $(seq 1 100); do
    sleep 1
    b=$(bubble)
    if grep -q "couldn't answer" <<<"$b"; then echo "FAILED: $b"; return 1; fi
    grep -q 'still thinking about your last question' <<<"$b" && continue
    [ -n "$b" ] && ! bubble_has_any "$RUN/thinking.pool" && { echo "$b"; return 0; }
  done
  echo "TIMEOUT: $(bubble)"; return 1
}
