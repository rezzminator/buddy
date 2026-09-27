#!/bin/sh
# SessionStart command hook. buddy draws and talks through function hooks,
# which Claude Code loads only when CLAUDE_CODE_ENABLE_FUNCTION_HOOKS is on;
# without it the plugin lists as enabled and does nothing. This hook loads
# without that flag: when the flag is off it shows one line saying how to turn
# it on, and when it is on it prints nothing. The line goes out as JSON
# systemMessage, the one SessionStart channel the user sees on screen.
raw=${CLAUDE_CODE_ENABLE_FUNCTION_HOOKS:-}
# Claude Code's truthy set: 1, true, yes, on; any case, spaces trimmed.
case "$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in 1|true|yes|on) exit 0 ;; esac
# Unset, the variable defers to the early-access rollout flag; stay quiet when
# Claude Code's cached feature flags turn it on for this account.
if [ -z "$raw" ]; then
  cfg=${CLAUDE_CONFIG_DIR:+$CLAUDE_CONFIG_DIR/.claude.json}
  grep -qE '"tengu_plugin_hooks_modules": *true' "${cfg:-$HOME/.claude.json}" 2>/dev/null && exit 0
fi
settings=$(printf '%s' "${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf '{"systemMessage":"buddy is off: Claude Code loads its function hooks only with CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1. Add \\"env\\": { \\"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS\\": \\"1\\" } to %s, then start a new session."}\n' "$settings"
