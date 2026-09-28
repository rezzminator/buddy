# Security policy

## Supported versions

Only the latest release of buddy gets security fixes. The current version is
in [CHANGELOG.md](./CHANGELOG.md).

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it
privately through GitHub's
[private vulnerability reporting](https://github.com/rezzminator/buddy/security/advisories/new)
(the repository's **Security** tab, **Report a vulnerability**).

Include what you found, the steps to reproduce it, the Claude Code version
(`claude --version`) and the buddy version.

## What buddy touches

Useful when judging impact:

- It reads Claude Code's config, `~/.claude.json` (or
  `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR` is set), and its
  ten newest backups, beside it and in `~/.claude/backups/` (or
  `$CLAUDE_CONFIG_DIR/backups/`), to recompute your original companion. It
  skips unfinished `.tmp.*` writes, empty files and files over 5 MB, and
  never writes any of them. Your account id is never shown, saved or logged.
- Its one shell hook, `hooks/function-hooks-check.sh`, runs when a session
  starts or resumes: when `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is unset it
  searches the config for Claude Code's function-hooks rollout flag, and it
  prints one line saying buddy is off, or nothing. It writes nothing.
- It reads the character JSON files in the folder the `customCharactersDir` option
  names.
- It makes model calls only through Claude Code itself: a `/buddy` question,
  and one short call at the end of each answered turn for `commentAfterEachTurn`
  and `suggestNextPrompt`, on `model` (default `opus`) at `effort`
  (default `low`) and sent its `chatTurnsToRead` (the chat's last turns, default 4, with what it said after each) (`commentAfterEachTurn` and `suggestNextPrompt`, on by default; turn
  both off for none). There is no buddy server.

It writes four things, and nothing else:

- **Its memory of each chat, in the chat's own folder**, beside the chat's
  transcript, which already holds all of it:
  `{config}/projects/{project}/{session id}/buddy/memory.json`, for each chat
  with a person at the prompt: its `chatTurnsToRead` (the chat's last `chatTurnsToRead` answered turns, each prompt
  without its markup, what Claude did as one line per step (a shell command's
  description and the names of the files it read or edited, never a tool's
  output), and the start and end of each answer, and per character what it
  exchanged with you after each: a `/buddy` question with its answer, a line
  it said, the `commentAfterEachTurn` and `suggestNextPrompt` it showed).
  Deleting the chat's folder deletes it.
- **Its own Claude Code plugin store:** the picked character, the picked
  original companion's soul (its name and personality) and which install's
  roll you chose, the pet count, and whether it is hidden.
- **The log file**, unless `logFile` is empty: by default
  `~/.claude/buddy/buddy.log` (`$CLAUDE_CONFIG_DIR/buddy/buddy.log` when
  `CLAUDE_CONFIG_DIR` is set; a path you set is used with `~` and a leading `$CLAUDE_CONFIG_DIR` expanded), one JSON line
  per record, with one rotation, `buddy.log.1`, past 1 MB.
  One JSON line per record: every failure with its message and stack; at
  `info` (the default) also session starts, commands (their kind and length,
  never their text), each question's outcome, `commentAfterEachTurn` and menu picks; at
  `debug` also the question text, the first 80 characters of each model
  answer, and band decisions. It never holds your account identity or any
  content of `~/.claude.json`.
- **The round files**, unless `saveRounds` is off (on by default): one
  text file per main-chat turn in the same chat folder as its memory, at most 150 per chat, the least recently
  written overwritten once all are used, holding everything that went into buddy and came out of it, in the order it happened, from the turn's start to the next turn's start: the prompt the turn began with, each tool call buddy heard with its arguments and output (each value cut at 500 characters), every buddy log record at any level, each bubble line and prompt-box suggestion, the turn's end as buddy filed it into its memory, and every model call buddy made, its system prompt, prompt and reply verbatim. They are for debugging and hold your conversation's text and
  tool output; they never hold your account identity or any content of
  `~/.claude.json`.
