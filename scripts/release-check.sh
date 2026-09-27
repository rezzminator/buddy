#!/usr/bin/env bash
# Release integrity: the version agrees in every place that carries it, and
# CHANGELOG.md has a dated section for it. With a base version argument (the
# version on main), the version must also have moved past it.
# The engine: the README's "tested on Claude Code X.Y.Z" names the one version
# ci.yml pins in CLAUDE_CODE_VERSION, and every workflow install uses that pin.
# The install ref: marketplace.json points installs at main, which is
# release-only (ci.yml's release job gates every pull request into main and
# every push onto it). A tag ref cannot work here: the tag is created after the
# release merge, so main's marketplace.json would name a tag that does not
# exist yet.
# Prints one line per failure and exits 1; exits 2 when a file cannot be read.
set -uo pipefail
cd "$(dirname "$0")/.." || { echo "ERROR cannot enter the repository root"; exit 2; }
read_json() { node -e 'const [f, e] = process.argv.slice(1); const j = JSON.parse(require("fs").readFileSync(f, "utf8")); process.stdout.write(String(e.split(".").reduce((o, k) => o?.[k], j) ?? ""))' "$1" "$2"; }
v=$(read_json plugins/buddy/.claude-plugin/plugin.json version) || { echo "ERROR cannot read plugins/buddy/.claude-plugin/plugin.json"; exit 2; }
[ -n "$v" ] || { echo "ERROR plugin.json has no version"; exit 2; }
fail=0
m=$(node -e 'const j = require("./.claude-plugin/marketplace.json"); process.stdout.write(j.plugins.find((p) => p.name === "buddy")?.version ?? "")') || { echo "ERROR cannot read .claude-plugin/marketplace.json"; exit 2; }
p=$(read_json package.json version) || { echo "ERROR cannot read package.json"; exit 2; }
[ -r README.md ] || { echo "ERROR cannot read README.md"; exit 2; }
[ -r CHANGELOG.md ] || { echo "ERROR cannot read CHANGELOG.md"; exit 2; }
[ -r .github/workflows/ci.yml ] || { echo "ERROR cannot read .github/workflows/ci.yml"; exit 2; }
ref=$(node -e 'const j = require("./.claude-plugin/marketplace.json"); process.stdout.write(j.plugins.find((p) => p.name === "buddy")?.source?.ref ?? "")') || { echo "ERROR cannot read .claude-plugin/marketplace.json"; exit 2; }
tested=$(node -e 'const t = require("fs").readFileSync("README.md", "utf8").replace(/\n>?[ \t]*/g, " "); process.stdout.write([...new Set([...t.matchAll(/tested on Claude Code (\d+\.\d+\.\d+)/gi)].map((m) => m[1]))].join(" "))') || { echo "ERROR cannot read README.md"; exit 2; }
pin=$(sed -nE 's/^[[:space:]]*CLAUDE_CODE_VERSION:[[:space:]]*"?([0-9][0-9.]*)"?[[:space:]]*$/\1/p' .github/workflows/ci.yml | sort -u | tr '\n' ' ' | sed 's/ $//')
# shellcheck disable=SC2016 # the pin is matched literally, not expanded
unpinned=$(grep -nE '@anthropic-ai/claude-code' .github/workflows/*.yml | grep -vF '@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}')
b=$(grep -oE 'badge/version-[0-9.]+-' README.md | sed -E 's/badge\/version-|-$//g')
[ "$m" = "$v" ] || { echo "FAIL marketplace.json says ${m:-nothing}, plugin.json $v"; fail=1; }
[ "$p" = "$v" ] || { echo "FAIL package.json says ${p:-nothing}, plugin.json $v"; fail=1; }
[ "$b" = "$v" ] || { echo "FAIL README badge says ${b:-nothing}, plugin.json $v"; fail=1; }
grep -qE "^## \[$v\] — [0-9]{4}-[0-9]{2}-[0-9]{2}$" CHANGELOG.md || { echo "FAIL CHANGELOG.md has no dated section for $v"; fail=1; }
case "$tested" in *" "*) echo "FAIL README names several tested-on versions: $tested"; fail=1 ;; esac
case "$pin" in *" "*) echo "FAIL ci.yml sets CLAUDE_CODE_VERSION more than once: $pin"; fail=1 ;; esac
[ -n "$tested" ] || { echo "FAIL README names no \"tested on Claude Code X.Y.Z\" version"; fail=1; }
[ -n "$pin" ] || { echo "FAIL ci.yml pins no CLAUDE_CODE_VERSION"; fail=1; }
[ "$tested" = "$pin" ] || { echo "FAIL README is tested on Claude Code ${tested:-nothing}, ci.yml pins ${pin:-nothing}"; fail=1; }
[ -z "$unpinned" ] || { echo "FAIL a workflow installs Claude Code without the CLAUDE_CODE_VERSION pin: $unpinned"; fail=1; }
[ "$ref" = main ] || { echo "FAIL marketplace.json points installs at ${ref:-no ref}, not the release-only main"; fail=1; }
if [ -n "${1:-}" ]; then
  newest=$(printf '%s\n%s\n' "$1" "$v" | sort -V | tail -1)
  { [ "$v" != "$1" ] && [ "$newest" = "$v" ]; } || { echo "FAIL version $v has not moved past main's $1"; fail=1; }
fi
[ $fail -eq 0 ] && echo "PASS release $v: versions agree, CHANGELOG dated${1:+, past $1}, CI pins tested Claude Code $pin, installs track main"
exit $fail
