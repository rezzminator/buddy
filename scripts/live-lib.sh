# Shared helpers of the live scripts (scripts/live-proof.sh, scripts/live-configs.sh):
# the claude binary, a config dir of the run's own (live_isolate), and one interactive
# session in tmux on a private socket, read from its pane and its transcript.
# Sourced, never run. The caller sets, before calling a helper:
#   T       the tmux command on the private socket (tmux -L {socket})
#   TGT     the tmux session name
#   RUN     the run folder; LOG=$RUN/drive.log
#   ID      the Claude session id; PROJECTS the config dir's projects/
#   CHARS   the characters folder (rows_of, pool_of)
# answered() reads $RUN/thinking.pool; command_out exits 2 when no row comes (inside $(…) its caller adds `|| exit 2`).

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

# Every session runs isolated from yours: its own config dir in the run folder
# ($RUN/config: transcripts, plugin store, settings, sessions, and the drawer's
# chords in keybindings.json), a clean
# environment (env -i: nothing of the calling chat, its session ids, sockets
# or wrappers), and the native binary, never a `claude` wrapper. So a run
# leaves no transcript, store entry or fleet row in your own config dir, and
# every run starts on the default character with an empty store.
# It signs in with a long-lived token from `claude setup-token`, read from
# $BUDDY_LIVE_TOKEN_FILE (default ~/.config/buddy/live-token) at launch, never
# written into the run folder or a command line.
# Sets LIVE_CONFIG, PROJECTS and LIVE_CLAUDE, the launcher to run in
# place of claude; exits 2 without a token.
live_isolate() {
  local token=${BUDDY_LIVE_TOKEN_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/buddy/live-token}
  [ -s "$token" ] || { printf '%s\n' "ERROR no sign-in token at $token: run \`claude setup-token\`, then save the token it prints there (chmod 600), or point BUDDY_LIVE_TOKEN_FILE at it" >&2; exit 2; }
  LIVE_CONFIG=$RUN/config
  PROJECTS=$LIVE_CONFIG/projects
  mkdir -p "$LIVE_CONFIG"
  # A fresh config dir would open on the first-run screens.
  printf '%s\n' '{ "hasCompletedOnboarding": true, "theme": "dark" }' > "$LIVE_CONFIG/.claude.json"
  # The drawer's four chords the engine does not bind itself (README: Shortcuts).
  printf '%s\n' '{"bindings":[{"context":"Global","bindings":{"ctrl+x t":"pane:next","ctrl+x u":"pane:previous","ctrl+x n":"diff:back","ctrl+x p":"permission:toggleDebug"}}]}' > "$LIVE_CONFIG/keybindings.json"
  LIVE_CLAUDE=$RUN/claude
  cat > "$LIVE_CLAUDE" <<LAUNCH
#!/bin/sh
exec env -i HOME="\$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" TERM="\${TERM:-xterm-256color}" COLORTERM="\${COLORTERM:-truecolor}" LANG="\${LANG:-en_US.UTF-8}" TMPDIR="\${TMPDIR:-/tmp}" \\
  CLAUDE_CONFIG_DIR="$LIVE_CONFIG" CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 CLAUDE_CODE_OAUTH_TOKEN="\$(cat '$token')" \\
  '$CLAUDE_BIN' "\$@"
LAUNCH
  chmod 700 "$LIVE_CLAUDE"
}
# The buddy's folder in session $ID's own chat folder, beside its transcript, as the plugin names it from the working directory $WORK.
buddy_dir() { echo "$PROJECTS/$(cd "$WORK" && pwd -P | sed 's/[^a-zA-Z0-9]/-/g')/$ID/buddy"; }
# Session $ID's memory file in whichever project folder holds its transcript, or nothing.
memory_file() { ls "$PROJECTS"/*/"$ID"/buddy/memory.json 2>/dev/null | head -1; }

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
