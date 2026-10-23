# The checks release.yml runs on a pull request into main, run the same way here.
RUN := $(if $(CI),,mise exec node@22 --)# CI=true on runners: setup-node gives 22
MANIFEST := plugins/buddy/.claude-plugin/plugin.json

.PHONY: release-check deps check release

release-check: check release

deps:
	$(RUN) npm ci

check: export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS := 1
check: deps
	$(RUN) npm test
	$(RUN) npm run typecheck
	$(RUN) npm run validate:plugin

# Base is the local origin/main: fetch it first. A main without the manifest is 0.0.0, as before.
release:
	$(RUN) scripts/release-check.sh "$$(git show origin/main:$(MANIFEST) 2>/dev/null | $(RUN) node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version' 2>/dev/null || echo 0.0.0)"
	v=$$($(RUN) node -p 'require("./$(MANIFEST)").version'); \
	awk -v v="$$v" '$$0 ~ "^## \\[" v "\\]" {f=1; next} /^## \[/ || /^\[/ {f=0} f' CHANGELOG.md | grep -q '' || { echo "FAIL CHANGELOG.md section for $$v yields no release notes"; exit 1; }
