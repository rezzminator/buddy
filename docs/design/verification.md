# Verification

buddy runs inside the prompt line of everyone who installs it, so a change lands only after it is proven at three depths: pure unit tests, hook tests of the real adapter, and a live session.
Each gate below says what it proves and what it prints when it fails; a gate that cannot run says so and never passes.

## The gates

| Gate | Command | Proves | Broken, it reports |
| --- | --- | --- | --- |
| Unit tests | `npm run test:unit` (vitest over `tests/`) | every decision in `plugins/buddy/src/` | the failing test by name; a hatch mismatch lists each vector as `#i (id length n): got …, want …` |
| Hook tests | `npm run test:hooks` (`claude plugin test plugins/buddy`) | the adapter wired to Claude Code's own testing kit, over an in-memory world | the failing test by name |
| Typecheck | `npm run typecheck` (`npm run types`, then `tsc`, then `tsc -p tsconfig.hooks.json`) | the engine, the tests and the adapter against `types/claude-code.d.ts`, which `npm run types` writes from the installed Claude Code (`/plugin-types`, no login needed) and git ignores | each type error by file and line |
| Validate | `npm run validate:plugin` (`claude plugin validate --strict`, the repo and the plugin) | both manifests, and the rule on `$` | the violation; a broken `$` rule would otherwise load the module with zero hooks |
| Release check | `scripts/release-check.sh [main's version]` | the version agrees in `plugin.json`, `marketplace.json`, `package.json` and the README badge; `CHANGELOG.md` has a dated section; the version moved past `main`'s | one `FAIL` line per disagreement and exit 1; `ERROR` and exit 2 when a file cannot be read |
| Live proof | `npm run live` (`scripts/live-proof.sh`) | a real session draws, walks, answers, switches through the drawer's personality tab, hides and remembers | a table with a `FAIL` row per failed check and its evidence, exit 1; `ERROR` and exit 2 when the session cannot be driven |
| Live configurations | `npm run live:configs` (`scripts/live-configs.sh`) | five real sessions, one per configuration, two turns each, every turn measured | `report.md` with a `FAIL` row per failed check and its evidence, and `unread` for a metric no record carried, exit 1; a session that could not be driven is `NOT DRIVEN` with its error, exit 2 |
| Live drawer | `npm run live:drawer` (`scripts/live-drawer.sh`) | one real session, two turns and a `/buddy` question, then `/buddy` opens the drawer, captured, its talk tab checked to name the memory and hold both turns, its shortcuts' guide drawn, its personality tab opened and left with ctrl+x t, the ask box reached with ctrl+x tab, and folded back with ctrl+x q from the prompt | a `FAIL` line per failed check (the drawer not drawn, missing the question or a turn, the personality tab not listing the characters, the ask box not reached, or not folded back), exit the count of FAILs; the screen in `drawer.txt` and `.ansi` |
| CI | `.github/workflows/ci.yml` | `npm test`, the typecheck and the validation on every push to `develop` or `main` and every pull request; the release check on a pull request into `main` and on every push that lands on `main` | the failed step |
| No leaks | a rule in `CLAUDE.md`, checked with a grep before a commit | no machine-absolute path and no personal data in a tracked file | the matching line |

The hook tests and the validation need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, as a real session does.
`npm test` runs the unit tests, then the hook tests.

## The live proof

The script drives a real, interactive Claude Code session and reads the screen.

- **The session.** tmux on a private socket (`-L buddy-proof`), a 160 × 50 window, never your own tmux server. The real Claude binary (`CLAUDE_BIN`, else `claude` resolved past a text wrapper), with `--model haiku --setting-sources project --allowedTools Bash --plugin-dir plugins/buddy`, a fresh `--session-id`, and function hooks on.
- **The options.** A settings file pins them under `buddy@inline`, the id a `--plugin-dir` copy reads: `commentAfterEachTurn: false`, `suggestNextPrompt: false`, `walkOverPromptBar: true`, `logLevel: debug`, and `logFile` in the run folder.
- **The boot.** The trust dialog defaults to "No, exit", so the script presses Down, then Enter; the session is up once the prompt glyph shows, followed by a space or the no-break space Claude Code draws.
- **The helpers.** `scripts/live-lib.sh` holds what both live scripts use: the binary, the run's own config dir (`live_isolate`), the boot, the pane, the bubble, the transcript's replies, and sending a prompt or a command.
- **What it reads.** What is drawn, from the pane (`tmux capture-pane`). The art to look for, from the characters' own JSON: rows of four or more visible characters, and for a second character only rows the duck lacks. The bubble, as the text between the round border's bars. Each command's reply, from the session transcript's `<local-command-stdout>`, so a reply is read as data, not scraped.
- **The evidence.** A timestamped run directory keeps every pane capture, the drive log and a copy of the transcript; each row of the table prints the evidence it saw.

It spends a few cents of Haiku, and touches nothing of yours: every session runs in a config dir of the run's own (`$RUN/config`: transcripts, the plugin store, sessions), from a clean environment (`env -i`) and the native binary, never a `claude` wrapper, so no transcript, store entry or fleet row is left behind. It signs in with a long-lived token from `claude setup-token`, read at launch from `$BUDDY_LIVE_TOKEN_FILE` (default `~/.config/buddy/live-token`); without one it stops with exit 2 and says how to make it. `--setting-sources project` keeps the user's own settings, and so their `character` option, out of the run.

Every switch goes through the drawer's personality tab (`menu_pick`), each act a ctrl+x chord pressed from the prompt (`tmux send-keys C-x {key}`): `/buddy`, ctrl+x t (`tab_open`); read which shipped entry holds the `*`; press ctrl+x n (or ctrl+x b, whichever way the wanted entry lies among the shipped ids) once per entry between them, each step switching at once, until the `*` marks the wanted entry (`step_to`); ctrl+x q folds the drawer (`tab_close`). A tab marking no shipped entry, or steps that never reach the entry, stop the run with exit 2. `menu_mark` reopens the tab, reads the `*`, and folds it. `live_isolate` writes the four chords the engine does not bind itself into the run's `keybindings.json` ([README: Shortcuts](../../README.md#shortcuts)).

| Row | Drives | Passes when |
| --- | --- | --- |
| (a) the default (duck) is drawn | `/buddy on`, a menu pick of the duck | a row of `duck.json`'s art is in the pane |
| (b) it walks | nothing; three samples 2 s apart, after the greeting | the duck's rows change between samples |
| (c) ctrl+x p pets | `/buddy`, ctrl+x p | the left card's `♥ N` rose by one |
| (c) the personality tab marks the current one | the tab, then folded | `* Quack (duck)` in the pane |
| (d) question before a reply | `/buddy what is your favourite tool`, before the chat's first reply | the reply says `Asked`, and the bubble holds an answer |
| (e) a test pass shows a `testPass` line | a prompt asking Claude to run `npm test` in the run's work folder, whose `package.json` test script prints `Tests: 3 passed` | a line of the duck's `testPass` pool shows in the bubble |
| (f) question after a reply | `/buddy what did we just run` | the bubble holds an answer |
| (g) a personality tab pick of `{other}` draws it | the tab, stepped to the first non-duck character by id (`cat`) | a row unique to its art is in the pane |
| (g) reopened, the tab marks `{other}` | the tab, then folded | `* {name} ({other})` in the pane |
| (g) picking the default returns | the tab, stepped back to the duck | the duck's rows are back |
| (h) `/buddy off` hides | `/buddy off` | no duck row in the pane |
| (h) `/buddy on` shows | `/buddy on` | the duck's rows are back |
| (i) `/buddy` opens the personality tab | `tab_open` | `* Quack (duck)`, `Shipped`, `Yours` and the duck's description in the pane, never its persona prompt |
| (i) ctrl+x n lights the next entry and switches to it | ctrl+x n once | the next entry, `ghost`, is lit and marked `*`, and the preview shows it |
| (i) ctrl+x b steps back | ctrl+x b once | the duck is marked `*` again, its preview back |
| (i) ctrl+x q folds it, the duck drawn | ctrl+x q | the shortcuts' row is gone; the duck is still drawn |
| (i) stepping onto `cat` draws it, the tab marks it | the tab again, stepped to `cat`, then folded | `cat`'s preview showed; the tab, still open, marks `* {name} (cat)`; its art is in the band |
| (i) reopened, the tab marks `cat` | the tab, then folded | `* {name} (cat)` in the pane |
| (i) picking the default returns | the tab, stepped back to the duck | the duck's rows are back |
| (j) `/buddy remember the word pineapple` | that question | the reply says `Asked`, and the bubble holds an answer |
| (j) the next answer remembers `pineapple` | `/buddy what word did I ask you to remember?` | the answer holds `pineapple` |
| (j) the chat's memory.json holds this session's chatTurnsToRead | nothing; `projects/*/{session}/buddy/memory.json` in the run's config dir is read | it holds both questions among its blocks' `characters.duck` exchanges, no `thinking` filler |
| (k) a question during a busy main turn | a prompt that runs `sleep 8` via Bash, then replies `K1`; `/buddy do you like yourself?` during it | the reply says `Asked`; the answer arrives before the main turn's `K1` reply, and the last outcome in the log is `answered` |
| (k) a second immediate ask | `/buddy say ack` right after | its reply refuses out loud (`still thinking about your last question`) or says `Asked` |
| (l) the log holds the ask | nothing; the run's `buddy.log` (the proof sets `logFile` into its run folder, `logLevel` debug) is read | an `ask.start` and an `ask.outcome` answered |
| (l) `/buddy log` | `/buddy log` | the reply names the run's log path and holds JSON lines |

### Why there is no fake HOME

A fake HOME would let the proof plant an invented `~/.claude.json` and check the "Yours" group live.
But a session started with a fake HOME is logged out, and a logged-out session answers no question.
So the proof keeps the real HOME and never reads or prints the "Yours" group, which would show a real account's companion.
The hook tests prove that path instead, with an invented `~/.claude.json` and backups served from memory.

## The live configuration proof

`scripts/live-configs.sh` proves the buddy per configuration and measures every turn.
Each session is the live proof's (the helpers in `scripts/live-lib.sh`, the main chat on Haiku, `--plugin-dir plugins/buddy`), on its own tmux socket (`-L buddy-cfg-{S}`) and folder, three at once at most; the options always pin `model: opus`, `effort: low`, `logLevel: debug` and `logFile` in the session's folder.
Each session sends two prompts (one running `ls` via Bash, one plain reply), waits for the reply in the transcript, then for the end-of-turn records (`turn.call` and its outcomes, or `turn.skipped`), 45 seconds at most.

| Session | Options | Passes when |
| --- | --- | --- |
| S1 | the defaults | after each turn `commentAfterEachTurn` shows in the bubble (`commentAfterEachTurn.outcome` answered, its stored text in the pane) and `suggestNextPrompt` in the prompt box (`suggestNextPrompt.outcome` shown, its stored text in the pane); `/buddy remember the word tangerine` is answered, and `/buddy what word did I ask you to remember?` answers `tangerine` from `chatTurnsToRead` |
| S2 | `commentAfterEachTurn: false` | no `commentAfterEachTurn.outcome` after a turn; a `suggestNextPrompt` is shown |
| S3 | `suggestNextPrompt: false`, `chatTurnsToRead: 1` | `commentAfterEachTurn` shows after each turn; no `suggestNextPrompt.outcome`; the chat's `memory.json` holds only the second turn; its buddy folder, pre-filled with 150 round files, still holds 150, the oldest two overwritten by this session's rounds; `/buddy what Bash command did Claude run in the turn before my last one?` is answered as out of memory (it names its memory, and not `ls`) |
| S4 | the defaults, headless | `claude -p`, then `claude -p --resume`: two `turn.skipped` with `why: headless`, and no `turn.call`, `turn.settings`, `turn.prompt`, `ask.settings` or `ask.start` |
| S5 | `customCharactersDir` holding one invalid `broken.json`, `character: broken` | the duck is drawn with a bubble naming the error (`Couldn't load broken: …; the personality tab in /buddy picks another`); the error holds the bubble 10 s from the session's start, part of it behind the trust dialog, so when it is gone by the prompt `/buddy reload` says it again, and the row names which |

A `suggestNextPrompt` check also passes on `suggestNextPrompt.outcome` none: the model answered `SUGGEST_NEXT_PROMPT: NONE`, which by design hands the prompt box back to Claude Code's own suggestion, and the row says so.
Per turn the report reads, from the log: `commentAfterEachTurn.outcome` and `suggestNextPrompt.outcome` with their `ms` (the turn's end to the reply, as the plugin measures it) and the call's `inTok`, `outTok`, `cacheRead` and `cacheWrite` (the watch call's, from `verdict.outcome`, when `commentAfterEachTurn` is off); from the transcript, the reply's timestamp, so `end→commentAfterEachTurn ms` is the `commentAfterEachTurn.outcome` record's time minus the main turn's end; the number of model calls (`turn.settings`, `ask.settings`); and every error record.
One pane sample a second after the outcome confirms the bubble: an answered `commentAfterEachTurn`'s stored text is in it, a failure reads `couldn't answer`.
A metric no record carried is `unread`, never a zero. The run folder `/tmp/buddy/configs-{timestamp}/` keeps `report.md`, `report.json`, and per session the log, the drive log, every pane capture and a copy of the transcript.

## Logging

The plugin log is for debugging a live session: `src/log.ts` queues one JSON line per record, `{ts, level, event, session?, character?, ...fields}`, and the adapter writes the queue through the calling hook's `$.fs` (a hook's `$` is never kept).
`logLevel` (`error`, `info` or `debug`; default `info`) sets what is written, and `logFile` where: by default `$CLAUDE_CONFIG_DIR/buddy/buddy.log` when `CLAUDE_CONFIG_DIR` is set, else `~/.claude/buddy/buddy.log`; a path set in the option is used as written, `~` expanded to HOME and a leading `$CLAUDE_CONFIG_DIR` to the config folder; empty for no file.
`$.fs` has no append, so each flush writes the whole file, reads it back and puts back records another session wrote over, up to `WRITE_ATTEMPTS` (3) tries; a loss the re-read sees is reported on the fallback (`the log {file} lost N records to another writer at the same time`), never dropped silently; past 1 MB the file moves to `{logFile}.1`, one rotation.
A failed write goes to the transcript (`$.ui.log`, its default target) with every error record in it, and never throws into a hook; an empty `logFile` writes no file and errors still reach the transcript.

| Level | Adds |
| --- | --- |
| `error` | every failure: what failed, its ids, the message and stack |
| `info` | session start, roster loads and invalid characters, option warnings, commands (kind and argument length, never the text), menu open, pick and close, character switches, each ask's start and outcome (`answered`, `refused`, `failed`, `dropped`, `hidden`, with reason and ms), another session's `/buddy off` or `/buddy on` read back, a menu pane found gone, each end-of-turn call made or skipped and why (`turn.call`, `turn.skipped`), its `commentAfterEachTurn` (`commentAfterEachTurn.outcome`, with usage and ms) and its `suggestNextPrompt` (`suggestNextPrompt.outcome`, with ms, and usage too on a call without `commentAfterEachTurn`); an end-of-turn outcome's ms counts from the turn's end to the reply |
| `debug` | the question text, prompt lengths, each model result's shape (`isAnswered`, reason, length, first 80 characters), band scenes and clock ticks, at most one per second per event |

The identity and `~/.claude.json` never reach the log at any level; the hook test for the original companion checks the log file for the account id.
`/buddy log` replies with the path and the last 20 lines.

## Bugs the gates caught

- **A flaky random rest.** The hook test "walks once the greeting ends" waits out the greeting, then expects the band to change within one second. Its fixture character had the default `restChance` of 0.02, so some runs rolled a rest that covered that second and saw no step. The adapter passes `Math.random`, which a hook test cannot seed, so the fixture now sets `restChance: 0` ("a test that waits for a step must see one"), and the test passes every run.
- **"3 passed; 0 failed" read as a failure.** The fail pattern matched any count, so a clean `cargo test` summary set off `oops` and a `testFail` line. Their counted forms now need a non-zero count (`[1-9]\d*`). The regression tests (a zero count is not a fail, a zero count is not a pass, a cargo run with 0 failed is a pass) were watched failing against the old patterns before the fix.

## Known gaps

Named here, so none reads as a pass:

- The live proof runs with `commentAfterEachTurn: false`; `commentAfterEachTurn` and `suggestNextPrompt` are proven live by the live configuration proof.
- Sleep is proven in unit tests only; the live proof would have to run after midnight.
- The hover card needs a terminal that reports the mouse; it is unit-tested, not tried live.
- "Yours" is proven by hook tests only (no fake HOME, above).

## Decisions

- **A real session, on Haiku.** Rejected: mocks alone. The testing kit cannot press a person's Esc or show that Claude Code really draws the band, and a question mid-turn needs a real running turn. Haiku keeps a run to cents.
- **Exit 2 apart from exit 1.** Rejected: one failure code. "Could not drive the session" and "a check failed" are different news.
- **Replies from the transcript, drawing from the pane.** Rejected: scraping replies off the screen, where they wrap and scroll.
- **The real HOME.** Rejected: a fake one, which logs the session out.
- **A private tmux socket and `--plugin-dir`.** Rejected: your own tmux and the installed copy. The proof tests this checkout and touches nothing else.
- **Inline fixture characters in unit and hook tests.** Rejected: the shipped files. A change to the art never breaks an engine test.
- **Randomness removed from the fixture.** Rejected: retrying a flaky test. A test that passes on a second try proves nothing.

## Where it lives

| File | What |
| --- | --- |
| [`package.json`](../../package.json) | the `test`, `test:unit`, `test:hooks`, `types`, `typecheck`, `validate:plugin`, `release:check`, `live`, `live:configs` and `live:drawer` scripts |
| [`tests/`](../../tests/) | one vitest file per engine concern, [`fixtures.ts`](../../tests/fixtures.ts), the hatch fixtures |
| [`plugins/buddy/tests/buddy.test.tsx`](../../plugins/buddy/tests/buddy.test.tsx) | the hook tests; `world` answers `$.fs`, `$.store`, `$.clock`, `$.model` and the rest from memory |
| [`scripts/live-proof.sh`](../../scripts/live-proof.sh) | the live proof |
| [`scripts/live-configs.sh`](../../scripts/live-configs.sh) | the live configuration proof |
| [`scripts/live-lib.sh`](../../scripts/live-lib.sh) | the helpers both live scripts source |
| [`scripts/release-check.sh`](../../scripts/release-check.sh) | the release check |
| [`scripts/gen-wyhash-fixture.mjs`](../../scripts/gen-wyhash-fixture.mjs) | regenerates the Bun cross-check fixture |
| [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), [`release.yml`](../../.github/workflows/release.yml) | CI, and the GitHub release on a `buddy--v*` tag |

## How it's tested

The gates are held to their own standard: a regression test counts only once it was watched failing against the unfixed code, and whoever lands a change re-reads a live verdict from the saved evidence, not from the table alone.
