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
- Around each shell command of the main chat it reads, to count the lines
  the command changed: the files the command names, up to 256 KB each, and
  in the folders it works in, the size and time of at most 400 files 4
  folders deep (dot-folders and folders such as `node_modules` left out),
  the smallest of them read up to 512 KB in all. Paths under the system's
  temp folders are left out. The text is held only to compare, never logged
  or saved.
- It makes model calls only through Claude Code itself, on `model` (default
  `opus`) at `effort` (default `low`): a `/buddy` question, and one short
  call at the end of each answered turn for `commentAfterEachTurn` and
  `suggestNextPrompt` (both on by default; turn both off for none), each
  sent the chat's memory items and its `chatTurnsToRead` (the chat's last
  turns, default 4, with what the buddy said after each). With
  `promptWhenIdle` on (off by default), a chat idle 30 minutes after an
  answered turn makes one more call, on opus at low effort, sent only
  Claude's last answer. There is no buddy server.

It can prompt Claude, and Claude acts on what it reads:

- **`promptToMainChat`, on by default.** The end-of-turn call may send
  Claude one prompt of its own, at most one per prompt of yours, under the
  plugin's origin with a note that it is the buddy's, never yours, to check
  before acting on. While it is on, your live rules from the buddy's memory,
  quoted in the words you typed, ride every prompt Claude gets as context.
  Set it to `false` to stop both.
- **`promptWhenIdle`, off by default.** An idle chat's call may send Claude
  one line to resume owed work, at most 3 in a row before you prompt again.
  A line naming a git push or force, a branch deletion, a hard reset, a tag,
  a merge or a rebase, a `gh pr`, `gh release` or `gh repo` step, a
  deletion, a publication or deploy, or a login, account, credential or
  token step is refused in code and never sent.

It writes these, and nothing else:

- **Its memory of each chat, in the chat's own folder**, beside the chat's
  transcript, which already holds all of it:
  `{config}/projects/{project}/{session id}/buddy/`, for each chat with a
  person at the prompt. `memory.json` holds the chat's memory items (your
  rules, quoted in words you typed, open items, facts, lessons and doubts),
  the count of each rule's strikes, and per character its `chatTurnsToRead`
  (the chat's last answered turns, each prompt without its markup, what
  Claude did as one line per step (a shell command's description and the
  names of the files it read or edited, never a tool's output), and the
  start and end of each answer, with what the buddy said after each and
  your `/buddy` questions with its answers). Beside it, `memory.md`: the same
  memory as the character drawn now reads it, written for you to read;
  `calls.json`: the buddy's model calls in flight, so one a reload cut off
  is logged as abandoned; and, with `promptWhenIdle` on, `away.json`: the
  pending idle wait. Deleting the chat's folder deletes them all.
- **Its own Claude Code plugin state:** the picked character, the picked
  original companion's soul (its name and personality) and which install's
  roll you chose, whether it is hidden, and the drawer's conversation.
- **The log file**, unless `logFile` is empty: by default
  `~/.claude/buddy/buddy.log` (`$CLAUDE_CONFIG_DIR/buddy/buddy.log` when
  `CLAUDE_CONFIG_DIR` is set; a path you set is used with `~` and a leading
  `$CLAUDE_CONFIG_DIR` expanded). Past 1 MB it is archived whole to the next
  free `buddy.log.N` (`.1`, `.2`, …), none ever overwritten or deleted.
  One JSON line per record: every failure with its message and stack; at
  `info` (the default) also session starts, commands (their kind and length,
  never their text), each question's outcome, `commentAfterEachTurn` and menu picks; at
  `debug` also the question text, the first 80 characters of each model
  answer, and band decisions. It never holds your account identity or any
  content of `~/.claude.json`.
- **The round files**, unless `saveRounds` is off (on by default): one
  text file per main-chat turn in the same chat folder as its memory,
  `round-001.txt` on, every turn kept and none ever overwritten, holding
  everything that went into buddy and came out of it, in the order it
  happened, from the turn's start to the next turn's start: the prompt the
  turn began with, each tool call buddy heard with its arguments and output
  (each value cut at 500 characters), every buddy log record at any level,
  each bubble line and prompt-box suggestion, the turn's end as buddy filed
  it into its memory, and every model call buddy made, its system prompt,
  prompt and reply verbatim. They are for debugging and hold your
  conversation's text and tool output; they never hold your account
  identity or any content of `~/.claude.json`.
