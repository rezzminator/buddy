# The README demo: Terry, buddy's lone-wolf systems programmer, above a real
# Claude Code session fixing a failing test in a tiny project.
#
# Regenerate, from the repository root (needs vhs, ttyd, jq, node and claude;
# CLAUDE_CODE_ENABLE_FUNCTION_HOOKS is set by the launcher):
#
#   BUDDY_LIVE_CREDENTIALS_FROM=<a logged-in Claude config dir> vhs docs/demo/buddy.tape
#
# (or a `claude setup-token` token in BUDDY_LIVE_TOKEN_FILE, as for the live
# proofs). docs/demo/setup.sh builds /tmp/demo-app and a throwaway config dir in
# /tmp/buddy-demo, then defines `claude`: the plugin under --plugin-dir, Terry
# as the character, Haiku for the main turn. The model's words differ on every
# run, so check the frames before committing the GIF.

Output docs/demo/buddy.gif

Set Shell bash
Set Width 1200
Set Height 760
Set FontSize 17
Set Padding 24
Set Theme "Catppuccin Mocha"
Set Framerate 12
Set TypingSpeed 45ms
Set WindowBar Colorful

# Setup, off camera: the demo project, the throwaway config dir, the session.
Hide
Type@1ms "source docs/demo/setup.sh && clear && claude"
Enter
Wait+Screen@60s /manual mode on/
# Let the start-up notices pass before the camera rolls.
Sleep 14s
Show

# Terry paces above the prompt.
Sleep 3s

# A real turn: Claude runs the failing test, fixes it, runs it again.
Type "the test fails, fix it"
Sleep 500ms
Enter
Sleep 9s

# Skip the rest of the wait; come back as the turn ends.
Hide
Wait+Screen@120s /ed for \d+s/
Show

# Terry's end-of-turn comment, and the suggested next prompt in the box.
Sleep 7s

# A question to Terry, answered in his voice.
Type "/buddy should we pull in a library for this?"
Sleep 500ms
Enter
Wait+Screen@60s /Asked Terry/
Sleep 7s

Hide
Ctrl+C
Ctrl+C
