# buddy — a Claude Code function-hooks plugin: an ASCII companion above the prompt that reacts to the work and answers `/buddy` questions

Professor's marketplace installs `main` of this repo, and `main` reaches every user at their next `plugin update`: a hook that throws or blocks breaks the prompt line of everyone who installed it.

## Vocabulary

- behavioural spec: what buddy does, its commands, options and character fields · `README.md`
- plugin directory: everything that installs and nothing else · `plugins/buddy/`
- adapter: the only file that touches `$`, its wiring grouped by event · `plugins/buddy/hooks/buddy.tsx`
- engine: every decision, as pure modules · `plugins/buddy/src/`
- character: one JSON file per id · `plugins/buddy/characters/{id}.json` · contract `plugins/buddy/schema/character.schema.json`, guide `CONTRIBUTING.md`
- manifest: `plugin.json`, which declares no `userConfig`, and `icon.svg` · `plugins/buddy/.claude-plugin/`
- config file: every option, one flat JSON object · `${XDG_CONFIG_HOME:-$HOME/.config}/buddy/config.json` · parsed by `configFilePath`, `parseConfigFile` and `resolveOptions` in `plugins/buddy/src/options.ts`, example `config.example.json`
- unit tests: one vitest file per engine concern · `tests/`
- hook tests: function-hook tests on the testing kit of the `claude-code` module; `claude plugin test` requires them inside the plugin directory · `plugins/buddy/tests/`
- plugin API: every hook's shape; grep it before using an event · `types/claude-code.d.ts`, untracked, written by `npm run types` (run by `npm run typecheck`)
- live proof: a real Haiku session driven in tmux · `scripts/live-proof.sh`
- live configuration proof: five sessions over option sets, buddy on opus low, each turn's time and tokens in a report · `scripts/live-configs.sh`, helpers shared in `scripts/live-lib.sh`
- release check: the version agrees everywhere and the CHANGELOG section is dated · `scripts/release-check.sh`
- CI: the gates on a pull request into `main`, and the GitHub release when it merges · `.github/workflows/release.yml`
- repo agents: `gitter`, the only git writer · `.claude/agents/`

## Runtime

### Claude Code

- Function hooks run only with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`: the hook tests, `npm run validate:plugin` and a real session all need it.
- The `AbovePrompt` site is raised in the terminal and the desktop app only; VS Code and mobile never raise it, which the README states and the adapter does not work around.
- Options come from the config file alone: `XDG_CONFIG_HOME` when set and absolute, else `$HOME/.config` when `HOME` is absolute, then `buddy/config.json`; read once at session start by the adapter's `readConfigFile`, never again. A missing file gives the defaults silently; an unreadable or invalid file, an unknown key or a wrong-typed or out-of-range value is one named warning each, that key's default applies and the valid keys still apply. No environment variable and no `pluginConfigs` entry sets an option: an old `pluginConfigs["buddy@..."]` entry is found through `$.settings.read` per source (Claude Code hands `register` only declared options, and the manifest declares none) and is one warning naming its keys and the file, its values never applied. Live scripts write `$RUN/xdg/buddy/config.json` and launch with that `XDG_CONFIG_HOME` (`live_buddy_config` in `scripts/live-lib.sh`).
- Migrating from `pluginConfigs["buddy@..."]` (before 3.0.0): remove the entry from `settings.json` and put the same keys, flat, in the config file.

### Local

- `npm test` (vitest, then `claude plugin test plugins/buddy`), `npm run typecheck` and `npm run validate:plugin` (root and plugin, `--strict`) pass before a commit.
- Targeted runs: `npx vitest run tests/{concern}.test.ts` runs one unit file; the hook tests have no targeted runner (`claude plugin test` takes only a folder and runs every file in it, and `plugins/buddy/tests/` holds one file of two to four minutes), so `npm run test:hooks` runs once, at the end of a change, never per edit.
- `npm run live` runs the live proof and `npm run live:configs` the configuration proof, both with `--plugin-dir plugins/buddy`; run both after any change to the adapter.
- `npm run release:check` proves a release's versions and CHANGELOG section.
- `make release-check` runs exactly the checks CI runs on a pull request into `main` (`make check`, then `make release` against the local `origin/main`, so `git fetch origin main` first); Node 22 through mise.

### CI

- `.github/workflows/release.yml` is the only workflow; no CI runs on a push to any branch. On a pull request into `main`, its `check` job runs `make check` (the three gates) and its `release` job runs `make release`: the release check with the version moved past `main`'s, and non-empty CHANGELOG notes.
- When that pull request merges, its `publish` job tags the merge commit `buddy--v{X.Y.Z}` and publishes the GitHub release from the CHANGELOG section; it fails when the tag already exists.

## Rules

### Publication

- **NEVER a machine-absolute path** (under `/Users`, `/home` or `/private`), personal data or a private project name in a tracked file.
- **NEVER push code or cut a release without the owner's ask**; a README or marketing commit on `develop` is pushed as soon as it is committed.
- **`main` MUST move only by merging the `develop → main` pull request**, with a merge commit and never a squash, so both branches share one history.

### Engine

- A new behaviour lands in the engine as a pure function with a test watched failing first; the adapter only wires it.
- `$` is passed only to functions declared at the top level of the adapter and always spelled `$.noun.event(...)`, and `$.env` names are string literals (the adapter reads only `HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, `PLUGIN_LOG_DIR` and `TMPDIR`): otherwise Claude Code loads the module with zero hooks, and `npm run validate:plugin` reports it.
- Every hook catches, logs `{what} failed: {err}` through `say` (Claude Code names the plugin on a command's reply, never on a `$.ui.log` transcript line, so `notice()` adds `buddy:`; the debug log's copy then reads `buddy: buddy:`, accepted, as `$.ui.log` has no transcript-only sink), and returns `next(e)` or the original result.
- A failure shows on screen: a missing or invalid character draws the duck with a bubble naming the error and pointing at the personality picker (ctrl+x t in `/buddy`), which lists it as `(invalid)`.
- Only a `/buddy` question, or `commentAfterEachTurn`, `suggestNextPrompt` or `promptWhenIdle` when on, calls a model; walking, reactions and every other command stay local.
- Dev files live outside the plugin directory, which installs whole.

### Characters

- A built-in character carries `"$schema": "../schema/character.schema.json"`, validates against it, and its art and persona are original.
- A missing line pool falls back to the engine's neutral pool, in no character's voice.
- A change to a command, an option or a character field moves `README.md`, `CONTRIBUTING.md` and the schema in the same commit; an option's also moves `config.example.json`, its `DEFAULTS` row and its README option row.

### Branches and releases

- `develop` is the default branch: every change lands there, by a commit or a pull request. It is protected by the ruleset `develop keeps its history`: never force-push or delete it.
- `main` is protected by the ruleset `main is release-only`: it merges only after `check` and `release` pass, never by a direct push and never by an admin override.
- Every merge into `main` publishes: the version moves past `main`'s, and a pre-release version (`-alpha`) is bumped to the real release version in that pull request.
- A version bump moves `plugins/buddy/.claude-plugin/plugin.json`, `package.json` and the README badge together, and turns `## [Unreleased]` in `CHANGELOG.md` into `## [X.Y.Z] — {date}`; installed copies update only on a new version.
- Semantic versioning: a fix is a patch; a new option, behaviour or built-in character is a minor; a renamed or removed option, command or character field, or a moved option home, is a major, and its CHANGELOG entry says how to migrate.
- A release is `gitter`'s RELEASE phase: bump the version and the dated CHANGELOG section on `develop`, `git fetch origin main` then `make release-check`, open the `develop → main` pull request, merge it once `check` and `release` are green; the merge is the release, `release.yml` tags and publishes it, and no tag is ever pushed by hand.
- Git writes go through `gitter`, `.claude/agents/gitter.md`.
