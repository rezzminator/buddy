# buddy — a Claude Code function-hooks plugin: an ASCII companion above the prompt that reacts to the work and answers `/buddy` questions

The repo is its own marketplace, and `main` reaches every user at their next `plugin update`: a hook that throws or blocks breaks the prompt line of everyone who installed it.

## Vocabulary

- behavioural spec: what buddy does, its commands, options and character fields · `README.md`
- plugin directory: everything that installs and nothing else · `plugins/buddy/`
- adapter: the only file that touches `$`, its wiring grouped by event · `plugins/buddy/hooks/buddy.tsx`
- engine: every decision, as pure modules · `plugins/buddy/src/`
- character: one JSON file per id · `plugins/buddy/characters/{id}.json` · contract `plugins/buddy/schema/character.schema.json`, guide `CONTRIBUTING.md`
- manifest: `plugin.json` with the `userConfig` options, and `icon.svg` · `plugins/buddy/.claude-plugin/`
- marketplace: installs the plugin directory from `main` (`git-subdir`) · `.claude-plugin/marketplace.json`
- unit tests: one vitest file per engine concern · `tests/`
- hook tests: function-hook tests on the testing kit of the `claude-code` module; `claude plugin test` requires them inside the plugin directory · `plugins/buddy/tests/`
- plugin API: every hook's shape; grep it before using an event · `types/claude-code.d.ts`, untracked, written by `npm run types` (run by `npm run typecheck`)
- live proof: a real Haiku session driven in tmux · `scripts/live-proof.sh`
- live configuration proof: five sessions over option sets, buddy on opus low, each turn's time and tokens in a report · `scripts/live-configs.sh`, helpers shared in `scripts/live-lib.sh`
- release check: the version agrees everywhere and the CHANGELOG section is dated · `scripts/release-check.sh`
- CI: the gates on push and pull request, and the GitHub release on a tag · `.github/workflows/`
- repo agents: `gitter`, the only git writer · `.claude/agents/`

## Runtime

### Claude Code

- Function hooks run only with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`: the hook tests, `npm run validate:plugin` and a real session all need it.
- The `AbovePrompt` site is raised in the terminal and the desktop app only; VS Code and mobile never raise it, which the README states and the adapter does not work around.
- Loaded with `--plugin-dir plugins/buddy`, the plugin reads its options under `pluginConfigs["buddy@inline"]`; installed, under `buddy@buddy`.

### Local

- `npm test` (vitest, then `claude plugin test plugins/buddy`), `npm run typecheck` and `npm run validate:plugin` (root and plugin, `--strict`) pass before a commit.
- Targeted runs: `npx vitest run tests/{concern}.test.ts` runs one unit file; the hook tests have no targeted runner (`claude plugin test` takes only a folder and runs every file in it, and `plugins/buddy/tests/` holds one file of two to four minutes), so `npm run test:hooks` runs once, at the end of a change, never per edit.
- `npm run live` runs the live proof and `npm run live:configs` the configuration proof, both with `--plugin-dir plugins/buddy`; run both after any change to the adapter.
- `npm run release:check` proves a release's versions and CHANGELOG section.

### CI

- `.github/workflows/ci.yml` runs the three gates on every push to `{develop|main}` and every pull request; on a pull request into `main`, its `release` job requires the version to move past `main`'s.
- `.github/workflows/release.yml` publishes the GitHub release from the CHANGELOG section when a `buddy--v*` tag on `main` is pushed.

## Rules

### Publication

- **NEVER a machine-absolute path** (under `/Users`, `/home` or `/private`), personal data or a private project name in a tracked file.
- **NEVER push code or cut a release without the owner's ask**; a README or marketing commit on `develop` is pushed as soon as it is committed.
- **`main` MUST move only by merging the `develop → main` pull request**, with a merge commit and never a squash, so both branches share one history.

### Engine

- A new behaviour lands in the engine as a pure function with a test watched failing first; the adapter only wires it.
- `$` is passed only to functions declared at the top level of the adapter and always spelled `$.noun.event(...)`, and `$.env` names are string literals: otherwise Claude Code loads the module with zero hooks, and `npm run validate:plugin` reports it.
- Every hook catches, logs `{what} failed: {err}` through `say` (Claude Code names the plugin on a command's reply, never on a `$.ui.log` transcript line, so `notice()` adds `buddy:`; the debug log's copy then reads `buddy: buddy:`, accepted, as `$.ui.log` has no transcript-only sink), and returns `next(e)` or the original result.
- A failure shows on screen: a missing or invalid character draws the duck with a bubble naming the error and pointing at the personality picker (ctrl+x t in `/buddy`), which lists it as `(invalid)`.
- Only a `/buddy` question, or `commentAfterEachTurn`, `suggestNextPrompt` or `promptWhenIdle` when on, calls a model; walking, reactions and every other command stay local.
- Dev files live outside the plugin directory, which installs whole.

### Characters

- A built-in character carries `"$schema": "../schema/character.schema.json"`, validates against it, and its art and persona are original.
- A missing line pool falls back to the engine's neutral pool, in no character's voice.
- A change to a command, an option or a character field moves `README.md`, `CONTRIBUTING.md` and the schema in the same commit; an option's also moves `config.example.json`.

### Branches and releases

- `develop` is the default branch: every change lands there, by a commit or a pull request.
- A version bump moves `plugins/buddy/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json` and the README badge together, and turns `## [Unreleased]` in `CHANGELOG.md` into `## [X.Y.Z] — {date}`; installed copies update only on a new version.
- Semantic versioning: a fix is a patch; a new option, behaviour or built-in character is a minor; a renamed or removed option, command or character field is a major, and its CHANGELOG entry says how to migrate.
- A release is `gitter`'s RELEASE phase: the `develop → main` pull request, merged once CI is green, then `claude plugin tag --push plugins/buddy` on `main` creates `buddy--v{X.Y.Z}`.
- Git writes go through `gitter`, `.claude/agents/gitter.md`.
