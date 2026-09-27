# Changelog

Every release of buddy. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `buddy--v<version>`, with a GitHub release carrying the section below.

## [Unreleased]

### Added
- The `suggestions` option (on by default): at the end of every answered turn the buddy proposes the next prompt in your words, the persona deciding what it nudges toward, as the prompt box's dim suggestion (Tab takes it). It comes from the same short `quipModel` call that writes the buddy's line (at most 120 output tokens, a 30-second deadline). Claude Code's own suggestion is held back meanwhile and shown only when the buddy has none (it answers `NONE`, nothing, or not within 30 seconds); a suggestion another plugin proposes still shows, and one overtaken by the next turn or by `/buddy off` is dropped. `suggestions: false` turns it off; with it on, turning off Claude Code's own prompt suggestions saves paying for both.
- `inherit` for `quipModel` and `effort`: `quipModel: inherit` follows the main chat's model, read at every call (`opus` when it cannot be read); `effort: inherit` uses the effort of the main chat's latest request, and sends none before its first (or when that request carries none, or a number), so the model's default applies. The defaults stay `opus` and `low`.
- The buddy remembers the prompts it suggested: a suggestion the prompt box showed joins its memory as its own kind of exchange, so it can say what it suggested last.
- The `contextTurns` option (default 3, 1 to 10): how many of the chat's latest answered turns each call reads, for questions and the end-of-turn call.
- The log records each call's token and prompt-cache usage: `ask.outcome` and `quip.outcome` (or `suggest.outcome`, when the end-of-turn call wrote no line) carry `inTok`, `outTok`, `cacheRead`, `cacheWrite` and `cachePct` (the share of the input read from the cache), shown by `/buddy log`.
- The end-of-turn call's `quip.outcome` and `suggest.outcome` log records carry `ms`, from the turn's end to the reply, as `ask.outcome` does.

### Changed
- A `/buddy` question is one direct call on `quipModel`, now `opus` by default, at the new `effort` option's level (default `low`; low, medium, high, xhigh or max), seeing the chat's last `contextTurns` turns (default 3) instead of only the last prompt and answer, and answered at once, even mid-turn. The end-of-turn line and suggestion use the same model, effort and `contextTurns` window.
- The buddy's lines and answers are told to become the character completely and say one useful thing that both the user and the chat missed (a risk, a gap, a wrong assumption, a better next step): the character decides how it is said, never what is true.
- Quips are on by default and come at the end of every answered turn, tool use or not, with `quipCooldownSec` defaulting to 0: one short `quipModel` call per turn reads its memory, the chat's last `contextTurns` turns and the turn's tally, and writes the buddy's line and the prompt suggestion together. An aborted turn, or a subagent's, makes no call. To keep the buddy quiet, set `quips: false`; to keep Claude Code's own suggestion, `suggestions: false`; to space the lines out, set `quipCooldownSec` (the old default was 45).

### Removed
- The `questionMode` option (`fork`, `complete`, `off`) is removed: every `/buddy` question is answered by `quipModel` on the chat's last `contextTurns` turns in about 3 seconds. Migration: delete `questionMode` from your plugin options; `questionMode: off` has no replacement (a question is only asked when you type one).

### Fixed
- A subagent's tool calls and turn end no longer count as the main turn's: its end wiped the turn's tally of tools and failures before the end-of-turn call read it, and its tool calls drew reactions. Only the main loop's events do now.
- A headless session (`claude -p`, the SDK) no longer makes an end-of-turn call: it paid for a line nobody saw and a suggestion with no prompt box. The log records `turn.skipped` with `why: headless`; a `/buddy` question still answers.
- A log fallback that threw (the debug log refusing a record) left the log's write chain rejected, and every later record was silently never written. A throwing fallback is now swallowed, the chain never stays rejected, and a flush never throws into a hook.
- A quip, or a quip's failure, replaced a `/buddy` answer still holding the bubble, cutting its 15 seconds short. A quip arriving while an answer, a failure or the `thinking` line holds the bubble is now not said, nor remembered, and the log records it as `held`.
- A turn's line held the bubble against the next turn's line for 15 seconds: a turn ending within 15 seconds of the last paid for a line that was logged `held`, never drawn nor remembered. Only a `/buddy` answer, its failure or the thinking line holds against a turn's line now; the next turn's line replaces the last, and lines nobody asked for still wait behind it.
- A line or suggestion from an end-of-turn call was said, and remembered, by a character picked while the call ran. The call speaks as the character drawn when the turn ended: a line arriving after a switch is dropped (`quip.outcome` `dropped`), and the suggestion is filed under its own character.
- `/clear` and a resume left the buddy reading the cleared conversation: its window of turns, the running prompt and a call in flight carried over. They are forgotten at `session.end` now.
- A prompt typed while a turn ran was filed with the running turn, and the next turn with none (`(not seen)`). Each prompt is filed with the turn it starts now.
- An end-of-turn call still running when a later turn ended interrupted, failed or refused showed its line and suggestion anyway. Any main turn's end makes it stale now (`stale` on `quip.outcome` and `suggest.outcome`).
- After a turn that made no end-of-turn call (an error, a refusal), Claude Code's own suggestion stayed held back if the buddy's last one had shown. It passes now.
- In a session whose band never drew, every answered turn paid for a line nobody saw, and remembered it. The line is asked for only once the band has drawn; the suggestion still comes.
- An end-of-turn call that wrote no line logged no usage: its `suggest.outcome` carries the call's tokens now.
- Two timers raced for each call's deadline, so a question past 90 seconds ended as `aborted` or `no answer in 90 s` at random. The buddy's deadline decides; the request's own `timeoutMs`, 5 seconds later, abandons it, and the deadline's timer stops once the call settles.
- A `/buddy` question's 90 seconds covered only the completion: a hung memory or settings read left the thinking line up and every later question refused. One deadline from the question's start covers the memory read, the settings and the completion now, and the thinking line shows at once; a memory failure met by a question is said in the next question's reply.
- The first call of a session waited on pruning old sessions' memory, and every call read its memory and then its settings: pruning runs beside the read now, and the two reads together.
- The plugin's messages in the debug log read `buddy: buddy: …`: Claude Code already prefixes the plugin's name, so the plugin no longer adds its own.
- `/buddy off` or `/buddy on` could be undone at once by this session's own read of the shared `hidden`, begun while the new value was being saved and answering the old one. The clock stops before `/buddy off` saves, and a read begun before or during the save is dropped.

## [0.3.0] — 2026-09-27

### Fixed
- Only a test runner's output reacts as a test: the output of a Bash command running npm/pnpm/yarn/bun test, vitest, jest, mocha, ava, tap, pytest, unittest, go test, cargo test or nextest, rspec, rake or rails test, mix test, dotnet test, mvn or gradle test, deno test, phpunit or ctest, read from its summary lines. `git log` or `grep` output holding FAILED, or `ls` lines starting with ok, no longer set off a reaction; neither do lines such as `Attempt 1 failed` or `PASS=1`, and failing TAP (`not ok N`) is a fail, never a pass. Not recognised yet: a gradle pass (gradle prints no count), `make test`, a runner inside docker or `bash -c`, and `node --test`.
- A `/buddy` question asked while the main chat was busy mid-turn answered with the main chat's own words. A fork replays the main thread's last request, so mid-turn it continues that turn; now, while the main turn runs, the question goes to `quipModel` (persona, memory and question), and a fork that gives no answer falls back to it too.
- Questions asked while another was waiting, or while the main turn was busy, could end in nothing: no answer, no error, no memory. Every question now ends visibly: its answer, or `{name} couldn't answer: {reason}` in the bubble, `no answer in 90 s` when the question takes longer than that, fork and fallback together: one 90-second deadline per question, the fallback getting only the time left, and the `thinking` line stays up until the answer, the failure or the deadline arrives; the deadline ends the question, not a fork already sent, which runs to its end (Claude Code offers no cancel) and may still bill; a question asked while one is still waiting is refused out loud ("still thinking about your last question"). An answer holds the bubble for its 15 seconds: tool-call reactions and other lines nobody asked for wait.
- Below 40 columns the bubble was left out, so an answer never showed in a narrow window. It is now drawn above the character, across the whole width, and a bubble too long for the rows it has is cut with `…`.
- Text is measured in terminal cells, not characters, so CJK text and emoji in a bubble or the hover card keep their layout.
- With `CLAUDE_CONFIG_DIR` set, "Yours" read `~/.claude.json` and its backups under HOME, another account's files. It now reads `$CLAUDE_CONFIG_DIR/.claude.json` and `$CLAUDE_CONFIG_DIR/backups/`, and the ones under HOME only when the variable is unset.
- A session whose band never draws (a headless `claude -p` or SDK session) remembered canned lines nobody saw. A line joins the memory only once the band has drawn in the session; before that only the newest line is held, for the first draw.
- An answer, or a failure, arriving after a switch to another character was said by the new one. It is now dropped, the log says `{name}'s answer was dropped: {drawn} is drawn now`, and the character asked remembers the question alone.
- Two sessions sharing the plugin store lost each other's pets, and `/buddy off` or `/buddy on` in one never reached the other. `/buddy` now counts on from the stored count, and each session reads `hidden` back from the store, since Claude Code raises no event when the store changes.
- The menu's preview clock kept ticking after its pane was gone without a close event. It stops when the menu closes, and after 10 beats without a draw of the pane.
- The Professor's description no longer calls it the default companion; the duck has been the default since 0.2.0.

### Added
- When function hooks are off, a session's start or resume prints one line, `buddy is off: …`, naming the `env` entry to add to `settings.json`; before, the plugin listed as enabled and did nothing. The line goes away once `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is set.
- The `ambiguousWidth` option (`narrow` or `wide`, default `narrow`), for a terminal that draws East Asian ambiguous-width characters two columns wide, as a CJK locale often does.
- A plugin log: one JSON line per record in `logFile`, each write re-read and retried so sessions sharing one log rarely lose a line, and a loss the retry sees is reported (default `$CLAUDE_CONFIG_DIR/buddy/buddy.log` when `CLAUDE_CONFIG_DIR` is set, else `~/.claude/buddy/buddy.log`; a path you set is used as given; empty = no file), capped at 1 MB with one rotation, at `logLevel` `error`, `info` (default) or `debug`. Every failure is logged with its context and stack; `info` adds sessions, commands, asks and their outcomes, quips, menu picks; `debug` adds question text, model result shapes and band decisions. It never holds your identity or anything from `~/.claude.json`.
- `/buddy log`: the log file's path and its last 20 lines, to paste into an issue.
- Test summaries of mocha, ava, tap, bun, minitest (`rake test`), deno, phpunit, ctest, dotnet test and Maven, of RSpec (`12 examples, 0 failures` passes; a non-zero failure count fails) and of Python unittest (`Ran N tests in Xs` then a line `OK`, `OK (skipped=1)` too, passes; a stray `OK` alone never counts) set off `testPass` and `testFail`.
- Quack has its own `petted` pose, eyes closed happy and a heart, and a `rest` pose: it floats on the water.

### Changed
- `/buddy list` and `/buddy use {id}` no longer ask the model: they reply with one line pointing to `/buddy-personality` (`Switching characters moved to /buddy-personality.`).
- The backup scan keeps real backup names only, skipping unfinished `.tmp.*` writes, empty files and files over 5 MB, and reads the newest 10.
- The id `original` is reserved for your original companion: a character file that takes it is refused with an error naming the file, never drawn; the error shows in the Your folder group of `/buddy-personality` and in the bubble at each session start and `/buddy reload`.
- An option that is ignored or capped is said once, in the first greeting's bubble, besides the log and `/buddy help`: never a silent revert. A characters folder that cannot be listed, or a file taking the reserved id, is said in the bubble at each session start and `/buddy reload`, pointing at `/buddy-personality`.
- The quick start leads with the `env` block of `settings.json`, which every new terminal keeps, with the shell export as the alternative, and says the `userConfig options not yet set` notice after install can be ignored: every option has a default.

## [0.2.1] — 2026-09-27

### Added
- Yellow Duck (`yellow-duck`): the bright yellow duck of 0.1.0, kept as a character of its own now that Quack is the default duck.
- Community files: CODE_OF_CONDUCT, SECURITY, SUPPORT, issue and pull request templates, and a social preview.

### Changed
- The README leads with Quack the duck: a demo of its real frames and lines, why buddy, help and contributing.

## [0.2.0] — 2026-09-27

### Added
- `/buddy-personality`: a menu in a focused pane. The entries sit on the left in three titled groups, Shipped, Yours and Your folder, with `*` on the one drawn now; the right shows a live preview of the highlighted one: its sprite in its idle animation, its name, its description (for an original, its personality) and its greeting. ↑/↓ move the highlight and the preview follows; Enter switches to it and remembers it, across `/reload` and restarts; Esc closes the menu and changes nothing.
- Yours: the companion Claude Code's own `/buddy` hatched for your account before version 2.1.97 removed it. The menu reads `~/.claude.json` (never writes it), or the newest `~/.claude.json` backup that holds a companion, and lists it twice, as the native and the npm install rolled it: the same species, rarity, eyes, hat, shiny and stats, drawn with buddy's own art for all 18 species. A file that cannot be read or parsed is said in one line in the group, never shown as an empty one.
- An original companion wears its rarity's color; a shiny one cycles through the rainbow with a sparkle. Its preview and hover card show the stars, five stat bars and the day it hatched. Once picked, its name, personality and roll are saved, so a restart draws it without looking through backups; the menu marks it with `*` when it is drawn. The account id is never saved or logged.
- `schema/species.schema.json`, the contract of a species template and its hat art.
- A short memory: the last `memory` exchanges (option, default 6, 0 = off, at most 30), each a `/buddy` question with its answer or a line its bubble showed on its own (a canned line or a quip, never the thinking filler), kept per session and per character across `/reload`, go before the question in its next answer or quip, so it can refer back to them; no extra model call.

### Changed
- `/buddy list` and `/buddy use {id}` (with `/buddy use default`) are folded into `/buddy-personality`, now the one way to see the characters and switch; to go back to the `character` option's character, pick it there. A character that fails to load says `/buddy-personality picks another`.
- The default character, and the fallback when a chosen one fails to load, is now the duck, Quack; the Professor stays a shipped character, no longer the default.

## [0.1.0] — 2026-09-27

### Added
- A companion on the line above the Claude Code prompt: an ASCII character that walks, pauses to rest, stands still while Claude works, sleeps after midnight, and speaks in a one-line speech bubble. It draws in the terminal and the desktop app.
- Reactions: a failed or denied tool call, and test results in Bash output (pass or fail), change its pose and bring a line; a test pass sets off a short burst of confetti. Hovering the sprite shows a card with its name, description, pets, mood and the questions asked this session.
- `/buddy`: pet it (`/buddy`), list the characters (`/buddy list`), switch (`/buddy use {id}`, `/buddy use default`), hide and show (`/buddy off`, `/buddy on`), rescan the characters (`/buddy reload`), usage (`/buddy help`), and ask it anything else (`/buddy {question}`) for a one-line answer in character.
- Six built-in characters: `professor` (the default), `duck`, `cat`, `robot`, `ghost` and `dragon`.
- Your own characters: JSON files in the folder the `characterDir` option names, checked against `plugins/buddy/schema/character.schema.json`; an invalid one is listed with its first error, and choosing it draws the Professor with a bubble naming the error.
- Options `character`, `characterDir`, `motion`, `questionMode` (`fork`, `complete` or `off`), `quips` (off by default), `quipModel` and `quipCooldownSec`.

[Unreleased]: https://github.com/rezzminator/buddy/compare/buddy--v0.3.0...HEAD
[0.3.0]: https://github.com/rezzminator/buddy/compare/buddy--v0.2.1...buddy--v0.3.0
[0.2.1]: https://github.com/rezzminator/buddy/compare/buddy--v0.2.0...buddy--v0.2.1
[0.2.0]: https://github.com/rezzminator/buddy/compare/c6aa41e...buddy--v0.2.0
[0.1.0]: https://github.com/rezzminator/buddy/tree/c6aa41e
