# buddy

A tiny companion that walks on your Claude Code prompt line and talks back: Quack the duck by default, six more characters built in (`professor`, `robot`, `ghost`, `dragon`, `yellow-duck`, `terry`), or your own.

```text
/buddy                  open or fold the drawer: the buddy, its thread with you, its personalities
/buddy off | on         hide or show it, remembered and shared by your sessions
/buddy reload           rescan the characters after you edit one
/buddy help             usage, and any option ignored or capped
/buddy log              the log file's path and its last 20 lines, for an issue
/buddy list | use {id}  moved: replies pointing to the personality picker, no model call
/buddy {question}       a one-line answer, in character
```

It reacts to the work: a failed tool call, a test runner's run passing or failing. After each answered turn, one short call on `model` (default `opus`) at `effort` (default `low`) judges Claude's last move `RIGHT`, `SHORTCUT` (warned in yellow) or `WRONG` (screamed in red), says one line in character (`commentAfterEachTurn`) and writes your next prompt into the prompt box (`suggestNextPrompt`). When the turn leaves your ask unmet or unproven, it prompts Claude itself (`promptToMainChat`, on by default), at most once per prompt of yours, and Claude is told the words are the buddy's. It keeps a memory per chat in `memory.json` (`memory.md` beside it, for you to read): your standing rules in your own words, which ride every prompt to Claude, plus what is open, facts, lessons and doubts. `promptWhenIdle` (off by default) lets it nudge a chat left idle. `/buddy {question}` answers in one line. Walking, reactions and every other command stay local; only these calls spend tokens, and the log (`logFile`, shown by `/buddy log`) records each call's tokens and cost.

## Pick a personality

`/buddy` opens the drawer: the buddy beside your conversation with it, filling every row Claude Code gives the band (in fullscreen what the bottom of the screen has left above the prompt, at most half the terminal; otherwise the terminal's height. Claude Code sets that ceiling, and no plugin can draw taller), its last row `memory  {path}`, the absolute path of the chat's `memory.md`. Every act in it is a ctrl+x chord, their guide at its bottom-left: `ctrl+x tab` ask · `ctrl+x t` personality · `ctrl+x u` use suggested prompt · `ctrl+x q` close. ctrl+x tab works as it is; the other three need this in `~/.claude/keybindings.json` (`$CLAUDE_CONFIG_DIR/keybindings.json` when that is set), merged into the file if you have one: `{"bindings":[{"context":"Global","bindings":{"ctrl+x t":"pane:next","ctrl+x u":"pane:previous","ctrl+x q":"confirm:previousField"}}]}`. ctrl+x t opens the personality picker, a pane holding your keys while your prompt is empty: a list with a live preview of the lit entry, in two groups: Shipped, the characters that come with it; Yours, first the companion Claude Code's removed `/buddy` hatched for your account (read from `~/.claude.json` or a backup of it, or with `CLAUDE_CONFIG_DIR` set from `$CLAUDE_CONFIG_DIR/.claude.json` and `$CLAUDE_CONFIG_DIR/backups/` instead; never written), listed as the native and the npm install rolled it, then your `customCharactersDir` files. ↑ and ↓ light the next or previous entry, Enter picks it, remembered across `/reload` and restarts, and Esc closes the picker; one that cannot be drawn is lit, its preview saying why, and never picked. Hovering the buddy shows the last thing it said to you.

It requires function hooks: add `"env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }` to `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when that is set); without them a new session says `buddy is off: …`. Every option has a default, so a `userConfig options not yet set` notice after install can be ignored. It draws in the terminal and the desktop app. The full documentation and the character guide live in the repository: https://github.com/rezzminator/buddy

Built and maintained with [Professor](https://github.com/rezzminator/professor).
