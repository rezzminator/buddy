# Prepares the README demo (docs/demo/buddy.tape): sourced by the tape's hidden
# first step, from the repository root, never run by hand.
# - /tmp/demo-app: a tiny project whose one test fails (an off-by-one in cart.js);
# - /tmp/buddy-demo: a throwaway Claude config dir signed in the way the live
#   proofs are (scripts/live-lib.sh: BUDDY_LIVE_TOKEN_FILE or
#   BUDDY_LIVE_CREDENTIALS_FROM), so the screen shows no account, plugin or
#   status line of yours;
# - a `claude` shell function: the plugin loaded with --plugin-dir, Terry as the
#   character, the folder trusted, edits and Bash allowed.

PLUGIN="$PWD/plugins/buddy"
[ -f "$PLUGIN/hooks/buddy.tsx" ] || { echo "run vhs from the repository root" >&2; return 2; }
RUN=/tmp/buddy-demo
WORK=/tmp/demo-app
rm -rf "$RUN" "$WORK"
mkdir -p "$RUN" "$WORK"

. "$PWD/scripts/live-lib.sh"
live_require
live_isolate

# Trust the demo folder up front: no trust dialog on screen.
jq --arg w "$WORK" '.projects[$w] = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }' \
  "$LIVE_CONFIG/.claude.json" > "$RUN/claude.json" && mv "$RUN/claude.json" "$LIVE_CONFIG/.claude.json"

jq -n --arg log "$RUN/buddy.log" '{ pluginConfigs: { "buddy@inline": { options: {
  character: "terry", model: "sonnet", effort: "low", logFile: $log } } } }' > "$RUN/settings.json"

cat > "$WORK/package.json" <<'EOF'
{ "name": "demo-app", "private": true, "type": "module", "scripts": { "test": "node --test" } }
EOF
cat > "$WORK/cart.js" <<'EOF'
export function total(items) {
  let sum = 0;
  for (let i = 1; i < items.length; i++) sum += items[i].price * items[i].qty;
  return sum;
}
EOF
cat > "$WORK/cart.test.js" <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { total } from './cart.js';

test('total adds every line', () => {
  assert.equal(total([{ price: 2, qty: 3 }, { price: 5, qty: 1 }]), 11);
});
EOF

claude() {
  "$LIVE_CLAUDE" --setting-sources project --settings "$RUN/settings.json" \
    --plugin-dir "$PLUGIN" --model haiku --allowedTools 'Bash Edit Read Write' "$@"
}
cd "$WORK" || return 2
