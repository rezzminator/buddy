# buddy

A tiny companion that walks on your Claude Code prompt line and talks back: Quack the duck by default, six more characters built in (`professor`, `cat`, `robot`, `ghost`, `dragon`, `yellow-duck`), or your own.

```text
/buddy                  pet it
/buddy off | on         hide or show it, remembered and shared by your sessions
/buddy reload           rescan the characters after you edit one
/buddy help             usage, and any option ignored or capped
/buddy log              the log file's path and its last 20 lines, for an issue
/buddy list | use {id}  moved: replies pointing to /buddy-personality, no model call
/buddy {question}       a one-line answer, in character
/buddy-personality      see every character and switch, remembered, with a live preview
```

It reacts to the work: a failed tool call, a test runner's run passing or failing. A question is by default one fast call on `quipModel` (default `opus`) at the `effort` option's level (default `low`), seeing the chat's last 3 turns and told to become the character completely and say one useful thing that both you and Claude missed; `questionMode: fork` forks this chat instead, so the answer sees the whole conversation and reads its prompt cache, and only the fork answers (in a long chat that can take a minute); the options `questionMode`, `quips`, `quipModel`, `effort`, `quipCooldownSec` and `suggestions` decide what spends tokens; `quips` and `suggestions` (both on by default) let one short `quipModel` call at the end of every answered turn write the buddy's line and the prompt box's suggestion, Claude Code's own suggestion held back and shown only when the buddy has none (`quips: false` or `suggestions: false` turns either off, and `quipCooldownSec`, default 0, spaces the lines out), and `memory` (default 6, 0 = off, at most 30) how many recent exchanges it remembers, per session and per character: an exchange is a /buddy question with its answer (or the question alone if it got none), or one line it said. In `fork` mode a question asked while the main chat is busy mid-turn waits for the turn to end, then forks, and before the chat's first reply the bubble says there is nothing to fork yet; in `complete` mode it answers at once. One question is answered at a time (asking again meanwhile gets `still thinking about your last question`), and every question ends in the bubble: an answer, which holds it for 15 seconds, or `{name} couldn't answer: {reason}`, such as `no answer in 180 s`, a fork's deadline from when it starts (90 s in `complete` mode), though a fork already sent runs on to its end (the engine offers no cancel) and may still bill; an answer that arrives after a switch to another character is dropped. `logLevel` (error, info, debug; default info) and `logFile` (default `~/.claude/buddy/buddy.log`, or `$CLAUDE_CONFIG_DIR/buddy/buddy.log` when that is set; a path you set is used with `~` and a leading `$CLAUDE_CONFIG_DIR` expanded; empty = none; one JSON line per record, retried when another session writes at the same moment, 1 MB with one rotation) set the plugin log, which `/buddy log` shows. Below 40 columns the bubble is drawn above the character, and a long one is cut with `…`; `ambiguousWidth` (narrow or wide, default narrow) is for a terminal that draws East Asian ambiguous-width characters two columns wide. Your own characters are JSON files in the folder the `characterDir` option names; the id `original` is reserved, and a file taking it is refused with an error naming it, in the Your folder group of `/buddy-personality` and in the bubble at each session start and `/buddy reload`.

## Pick a personality

`/buddy-personality` opens a menu with a live preview of the highlighted entry, in three groups: the shipped characters; yours, the companion Claude Code's removed `/buddy` hatched for your account (read from `~/.claude.json` or a backup of it, or with `CLAUDE_CONFIG_DIR` set from `$CLAUDE_CONFIG_DIR/.claude.json` and `$CLAUDE_CONFIG_DIR/backups/` instead; never written), listed as the native and the npm install rolled it; and your `characterDir` folder. ↑/↓ move, Enter switches and remembers it across `/reload` and restarts, Esc closes and changes nothing.

It requires function hooks: add `"env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }` to `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when that is set); without them a new session says `buddy is off: …`. Every option has a default, so a `userConfig options not yet set` notice after install can be ignored. It draws in the terminal and the desktop app. The full documentation and the character guide live in the repository: https://github.com/rezzminator/buddy

Built and maintained with [Professor](https://github.com/rezzminator/professor).
