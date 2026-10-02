<div align="center">

# buddy

**Claude Code buddy plugin: Quack the ASCII duck waddles above your prompt and talks back — or bring back your /buddy**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-1.1.0-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![CI](https://github.com/rezzminator/buddy/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/rezzminator/buddy/actions/workflows/ci.yml)
[![Built with Professor](https://img.shields.io/badge/built%20with-Professor-8A2BE2)](https://github.com/rezzminator/professor)

[Quick start](#-quick-start) · [Characters](#-characters) · [Docs](docs/design/_index.md) · [Changelog](./CHANGELOG.md) · [Help](#-help)

</div>

Meet **Quack**, a sarcastic little duck with a sharp tongue, waddling through
your code with smug confidence. It lives on the line right above your Claude
Code prompt:

```text
    .-.            *  .-.           ╭───────────────────────────────────╮
\__( x)=          \__( x)=          │ QUACK! All green, like pond weed. │
 \____)            \_\/_)           ╰───────────────────────────────────╯
 L   L              L  L
walking           tests pass

    .-.  Z            .-. !         ╭─────────────────────────────────────────────╮
\__( -)=          \__( x)<          │ That one splashed. Let's dry off and retry. │
 \____)            \____)           ╰─────────────────────────────────────────────╯
~~~~~~~~            L  L
after midnight    a tool fails
```

Every line in those bubbles is one of Quack's own; its art and its lines live
in [`plugins/buddy/characters/duck.json`](./plugins/buddy/characters/duck.json).

---

## 🦆 Why buddy

Claude Code once shipped `/buddy`, a companion that sat beside the prompt
and commented on your work in a speech bubble. It worked up to version
2.1.96; version 2.1.97 removed it.

**buddy** brings a companion back as a plugin. It lives inside Claude Code's
own interface, on the line right above the prompt, sees every tool call as it
happens, and answers you through Claude Code's own model calls: it needs no
server of its own.

- 🚶 **A duck on your prompt line.** Quack walks back and forth above the
  prompt, stops now and then to rest, stands still while Claude works, and
  falls asleep after midnight.
- 🎉 **Reacts to the work.** A test run passing in a Bash command gets a
  cheer and a burst of confetti; a failing one, or a failed or denied tool
  call, gets an "oops".
- 💬 **Talks back, and remembers.** `/buddy why is this slow?` gets a
  one-line answer, in character, that says what you and Claude both
  missed. Its short-term memory is the chat's last `chatTurnsToRead` turns
  (default 4), a compaction of the chat counting as one, each with what it
  said after it and what you asked it, word for word; ask about anything
  older and it says it doesn't remember that far back.
- 🗂️ **One command.** `/buddy` alone opens its drawer: the buddy and your
  conversation with it; ctrl+x t there opens a personality picker with a live preview.
- 🐣 **Your own buddy, back.** The personality picker: its "Yours" group recomputes the companion Claude Code
  hatched for your account (species, rarity, eyes, hat, stats) with the name
  and personality it saved.
- 🧠 **A second brain.** After each answered turn the buddy names what you
  most deeply want from the chat, judges Claude's last move against it, and
  suggests your next prompt to match: a right call gets a "yes, go on", a
  shortcut a yellow warning, a wrong move a red scream in the bubble.
- 📝 **Its memory of the chat.** The same call edits the buddy's memory
  items for the chat, each of a kind with its cap: `rule` your standing
  orders (10), kept only in words you typed yourself (at least 3 whole
  words and 12 characters of one prompt), never Claude's, a compaction
  summary's or another chat's; `open` what you asked for that is
  unfinished (6); `fact` what the chat showed (6); `lesson` what it learned
  the hard way (4); `doubt` its own unchecked suspicion, never stated as fact
  (3), ended once 3 turns pass untouched. Edits are checked in code, item by
  item, and kept across a character switch. Read first by every later call,
  and kept for you to read in the chat's `memory.md`, its path at the
  drawer's foot: the items by kind with their keys, the newest ended ones,
  then the turns.
- 📊 **The numbers of every turn.** Each turn it remembers comes with one
  line counted in code, never by a model: time and the pause before it,
  model requests, the main loop's own tool calls by tool with failures and
  refusals, files and lines changed, the file edited over and over, test runs
  in the order they passed and failed,
  commits and pushes, web reads, tokens and cache, cost, how full the
  context is, and a rate limit past half used. The drawer shows each turn's
  time, tools and cost on its row.
- 🤫 **Free unless you ask.** Walking, switching and reactions never
  call a model. Only a question you ask, and one short call at the end of
  each answered turn for `commentAfterEachTurn` and `suggestNextPrompt` (on by
  default; `commentAfterEachTurn: false` and `suggestNextPrompt: false` turn them off),
  and, with `promptWhenIdle` on, one call once the chat sits idle 30 minutes, spend tokens;
  a headless `claude -p` run makes no end-of-turn call.
- 🛡️ **Never in the way.** A character that fails to load is replaced by the
  duck, who says why; a hook that fails logs the error and steps aside.
  `/buddy off` hides it, and it stays hidden across restarts.

Quack is the default. buddy also ships the Professor, a robot, a
ghost, a dragon and a yellow duck, and draws your own characters from a folder of JSON
files (see [Characters](#-characters)).

## 🚀 Quick start

1. Turn on function hooks: add this `env` block to `~/.claude/settings.json`
   (merged into the object already there), so every new terminal has them.

   ```json
   { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
   ```

   Or export it in your shell, `export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`;
   an export vanishes in the next terminal.

2. Install:

   ```sh
   claude plugin marketplace add rezzminator/buddy
   claude plugin install buddy@buddy
   ```

Start a new session and Quack walks in above your prompt; type `/buddy` to
open its drawer.

After installing, Claude Code may print `N userConfig options not yet set —
run /plugin configure`. You can ignore it: every buddy option has a default,
so nothing needs setting and buddy works as installed. Use
`/plugin configure` only to change a default.

If function hooks are off, buddy says so when a session starts or resumes:
`buddy is off: … Add "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } to
~/.claude/settings.json, then start a new session.` (with `CLAUDE_CONFIG_DIR`
set it names `$CLAUDE_CONFIG_DIR/settings.json`). The line goes away once
the variable is set.

> **Early access.** buddy is built on Claude Code's function hooks, an
> early-access surface that may change between releases. A plugin built on
> function hooks cannot enter the official plugin directory, so buddy
> installs from this repository's own marketplace, as above. It is tested on
> Claude Code 2.1.284.

> **Where it shows.** The line above the prompt exists in Claude Code in the
> terminal and in the desktop app. The VS Code extension and mobile do not
> draw it, so there the character never appears.

## 🧭 Commands

| Command | What it does |
| --- | --- |
| `/buddy` | Open or fold the drawer: the band above your prompt opens full width into the buddy (sprite, name, status) beside your conversation with it, filling every row Claude Code gives the band (in fullscreen what the bottom of the screen has left above the prompt, at most half the terminal; otherwise the terminal's height. Claude Code sets that ceiling, and no plugin can draw taller); under them one bar: its numbers and the [shortcuts](#shortcuts) at the left, a box to ask it at the right; and last, `memory  {path}`, the absolute path of the chat's `memory.md`. The conversation is your last `chatTurnsToRead` turns with Claude, its newest messages that fit, the older ones counted above them: each prompt you sent opening a section (marked when the turn was interrupted and the buddy never read it), each compaction of the chat with the summary it read, each line naming who said it and how, each suggested prompt marked at its right `✓ you sent it` or `not sent`, and the newest open one `ctrl+x u uses it`. The drawer has no buttons: every act is a ctrl+x chord. ctrl+x q closes it from the prompt (while no pane is open), and so does `/buddy` again; either closes the personality picker with it. |
| `/buddy {question}` | Ask it: it thinks, then answers in one line, in character; asked for a prompt ("put it in a prompt for me"), it also puts one in your prompt box. While hidden it replies `{name} is hidden; /buddy on first`. |
| `/buddy off` / `/buddy on` | Hide or show it, remembered across restarts and shared with your other sessions. |
| `/buddy reload` | Rescan the characters, after you edit one. |
| `/buddy help` | Usage, then every option that was ignored or capped, and why. |
| `/buddy log` | The log file's path and its last 20 lines, to paste into an issue. |
| `/buddy list` / `/buddy use {id}` | `Switching characters moved to the personality picker: ctrl+x t in /buddy.` — no model call. |

### Shortcuts

The drawer's bottom-left, beside the ask box, is its guide, each chord spelled whole and bright:
`ctrl+x tab` ask · `ctrl+x t` personality · `ctrl+x u` use suggested prompt · `ctrl+x q` close.

| Chord | Does |
| --- | --- |
| ctrl+x tab | steps into the ask box |
| ctrl+x t | opens the [personality picker](#-pick-a-personality): ↑ ↓ choose, Enter picks, Esc closes it |
| ctrl+x u | puts the newest open suggested prompt in your prompt box |
| ctrl+x q | closes the drawer |

A plugin hears a chord only through a Claude Code keybinding action that
nothing else holds at the prompt, so buddy borrows three that Claude Code
handles only inside a panel or dialog; ctrl+x tab is Claude Code's own step-in. It
never takes a chord Claude Code uses at the prompt: while one of those panels
or dialogs is open, Claude Code's handler wins, and the drawer's chords are
off while it is folded. The three need these lines
in your `~/.claude/keybindings.json` (or `$CLAUDE_CONFIG_DIR/keybindings.json`
when that is set); merge them into the file if you have one:

```json
{"bindings":[{"context":"Global","bindings":{"ctrl+x t":"pane:next","ctrl+x u":"pane:previous","ctrl+x q":"confirm:previousField"}}]}
```

Without them only ctrl+x tab works.

## 🎭 Characters

| id | |
| --- | --- |
| `duck` | Quack: a sarcastic little duck with a sharp tongue, waddling through your code with smug confidence. The default. |
| `professor` | A warm, precise professor with a cup of tea. |
| `robot` | A literal little robot on one wheel that reports exactly what happened. |
| `ghost` | A gentle ghost that drifts along your prompt line, softly spooky. |
| `dragon` | A very small dragon with very large pride, guarding your code. |
| `yellow-duck` | A listening duck: explain your bug out loud, get a quack back. |
| `terry` | A lone-wolf systems programmer in a 640x480, 16-color world. Simplicity above all. |

The choice is, in order: your last pick in the personality picker, then the
`character` option, then `duck`. Your own characters sit beside these, and one with
a built-in's id replaces it. The id `original` is reserved for your original
companion: a file that takes it is refused, never drawn, with an error
naming the file in the picker's "Yours" group, and in
the bubble when a session starts and after `/buddy reload`.

## 🐣 Pick a personality

`/buddy` opens the drawer; ctrl+x t there opens the personality picker, a
pane that takes your keys while your prompt is empty. The entries sit on the
left, a live preview of the lit one on the right, in two groups.

- **Shipped**: the characters that come with the plugin.
- **Yours**: first the companion Claude Code's own `/buddy` hatched for your
  account, when Claude Code's config still holds its name and personality,
  or one of its ten newest backups does. The config is `~/.claude.json`, its
  backups beside it and in `~/.claude/backups/`; with `CLAUDE_CONFIG_DIR`
  set, `$CLAUDE_CONFIG_DIR/.claude.json` and `$CLAUDE_CONFIG_DIR/backups/`
  instead. Only real backups count: an unfinished `.tmp.*` write, an empty
  file or one over 5 MB is skipped. It is listed
  twice, as the native install and as the npm install rolled it: the two
  turned your account id into a different species, eyes, hat and stats, and
  the preview lets you recognise yours. No companion found takes no line.
  Then your own characters, from the `customCharactersDir` option. With none,
  it says `None yet: set customCharactersDir to a folder of your own character files.`
  (or `No character files in customCharactersDir.` when it is set).

↑ and ↓ light the next or previous entry, the preview following; Enter picks
the lit one, and Esc closes the picker, your keys back in the prompt. With text
in your prompt the picker opens without your keys and says
`clear your prompt, then ctrl+x t to choose with ↑ ↓ and Enter`. The preview shows the lit one: the sprite in its idle
animation, the name, its description (for your original, its saved personality) and a greeting in its voice;
for your original companion also its rarity stars, shiny, the five stats as
bars (`SNARK     ████████░░ 81`) and the day it hatched. `*` marks the one
drawn now. A pick is remembered: it is still there after `/reload` and a
restart; the picker stays open, its `*` moved, and the new character greets you. An entry that cannot be drawn is
lit, its preview saying why, and never picked. Folding the drawer closes the picker.

The picker only reads the config and its backups; it never writes them. A file it cannot
read shows as one line in the "Yours" group, saying why. Your account id is
never shown, saved or logged. To go back to your usual character, pick it
in the picker: the `character` option's one is listed under Shipped, or under
Yours when it is your own.

## 🧠 How it works

The full design, decision by decision, lives in [docs/design](docs/design/_index.md).

- **Walking.** The character steps one column every `stepMs` (200 ms unless
  the character says otherwise), turns at the edge, and rests now and then.
  It stops walking while a bubble is up. With the `walkOverPromptBar` option off, or a
  character that does not walk, it stands still and its frames still
  animate.
- **While Claude works** it draws its `working` pose and stands still. From
  midnight to 6 am, after a minute with nothing happening, it falls asleep
  with a `z Z` drifting above it; anything that happens wakes it up.
- **Reactions.** A tool call that fails or is denied: the `oops` pose and a
  line. The output of a Bash command that runs a test runner (npm/pnpm/yarn/bun
  test, vitest, jest, mocha, ava, tap, pytest, unittest, go test, cargo test
  or nextest, rspec, rake or rails test, mix test, dotnet test, mvn/gradle
  test, deno test, phpunit, ctest, claude plugin test), also quoted after a
  shell's `-c` or a wrapper's `run` or `exec` (`bash -c 'go test ./...'`), is read from its summary lines: a pass (a count of zero
  never passes) gives the `yay` pose, a line and two seconds of confetti; a
  failure gives the `oops` pose and a line. The pose and confetti come every
  time, the line one time in three. A failure always wins, and any
  other command's output never counts as a test. Not recognised yet: a
  gradle pass (gradle prints no count), `make test`, an unquoted runner
  after `docker exec`, and `node --test`.
- **The bubble** holds one line, wrapped to fit a rounded box beside the
  character, opening toward the free side. A canned line stays 10 seconds,
  a model's words 15. No canned line (it is dropped, never said later), turn
  start or end, working state or tool call replaces a model's words before
  their time; a newer model bubble waits until the one showing has had 10
  seconds, at most two waiting (past that the oldest is dropped). Its words
  are blue when the buddy talks to you, yellow when they show the prompt it
  sent Claude (`promptToMainChat`, `promptWhenIdle`); a `SHORTCUT` warning's yellow is its
  frame around blue words, so a prompt to Claude is told apart by its yellow
  words. Below 40 columns the bubble is drawn above the sprite, across
  the whole width, and the confetti is left out; a window too narrow for the
  sprite shows the bubble alone. A long bubble is cut with `…` to fit the
  rows it has. Text is measured in terminal cells, so CJK text and emoji
  line up; if your terminal draws East Asian ambiguous-width characters two
  columns wide, as a CJK locale often does, set `ambiguousCharacterWidth` to `wide`.
- **Hover card.** Hover over the character to see its name and the last
  thing it said to you (an answer, a comment, a warning or a failure), or
  `Nothing said to you yet.`; after a reload it is read back from the drawer's
  conversation. It needs a terminal that reports the mouse; elsewhere the card
  never shows.
- **Questions.** `/buddy {question}` is
  one fast call on `model` (default `opus`) at the `effort` option's
  level (default `low`), with the character's persona, the character rule,
  and its `chatTurnsToRead`: the chat's last turns (default 4), each filtered
  to what you saw of it, every view cut to its start and end, never
  summarised by a model:

  - your prompt without the markup around it, whole up to 20,000
    characters, past that its first 15,000 and last 5,000; a prompt of
    another origin (a slash command's, the buddy's own) its first 4,800 and
    last 2,400. A background task's notification is its summary, its status
    when not `completed`, its agent's tokens, tool uses and time, and its
    report with its size, cut to its first 600 and last 200 characters, or
    2,400 and 800 for a report over 10,000. A signed message from another
    chat (one ending `— sid … · to reply: chat_inject …`), as the prompt or
    added while Claude worked, is labelled as another chat's, never yours,
    its body cut to its first 600 and last 200;
  - what you added while Claude worked, cut like your prompt, and what
    Claude wrote mid-turn, each with its position (`after 3 tool calls`), in
    order: each of Claude's texts its first 2,000 and last 800, and past 9 of
    them the first 2 and the last 6 around a count of the rest;
  - what Claude did as one short line per step, at most 120 characters (an
    undescribed shell command at most 110): a shell command's description,
    the files it read or edited, work left running in the background; each
    step's call and output size (`[call 1.2k · output 34k chars]`); a failed
    or denied step with one redacted line of why, never a tool's whole
    output or a diff;
  - each agent Claude ran: its brief's first line and last 3 lines, and what
    it returned with its tokens, tool uses, time and report size, the report
    cut as a notification's is;
  - Claude's answer, past 11,200 characters its first 8,000 and last 3,200
    (see [docs/design/chatTurnsToRead.md](docs/design/chatTurnsToRead.md#how-a-turn-is-filtered)).

  Every cut is marked `[cut]` where text was taken out, and the buddy is
  told that what a cut hides is no evidence it is missing.
  Every turn but the last is told shorter, as a story: your prompt and each
  line you added their first 3,000 and last 1,000 characters, another
  origin's prompt and the suggestion its first 600 and last 200, each
  mid-turn text of Claude's, signed message, brief and report its first 400
  and last 100, what Claude did, its failed tool calls, its answer's first
  500 and last 300, and the buddy's own lines whole; the last turn, the one
  a call is about, stays whole. On 189 real calls, measured when an older
  turn's prompt kept 600 and 200, that read 27.8% fewer input tokens with
  the reactions held
  (see [the story form](docs/design/chatTurnsToRead.md#the-story-form)).
  A compaction of the chat is a turn of its own, its summary the answer,
  labelled Claude's own paraphrase, never your words; told as an older turn,
  it keeps its first 4,000 and last 1,000 characters. Each
  is followed by what the buddy commented and suggested after it and your
  `/buddy` questions with its answers, kept whole. It is told its memory reaches that far and no further, so a
  question about anything older is answered as out of memory, never guessed.
  It is answered at once,
  even while Claude is busy mid-turn. The character rule tells it to become
  the character completely and say one useful thing that both you and
  Claude missed in those turns: a risk, a gap, a wrong assumption, a better
  next step; the character decides how it is said, never what is true.
  Every question ends in the bubble: its
  answer, or `{name} couldn't answer: {reason}`, such as `api-error 529` or
  `no answer in 90 s`: a question has 90 seconds, and the
  thinking line stays up until the answer, the failure or the deadline. An
  answer holds the bubble for its 15 seconds; a reaction or any other
  canned line that comes meanwhile is dropped, never said later. An answer
  that arrives after you switched characters is dropped, never said by the
  new one. One
  question at a time: asking again before the answer gets `{name} is still
  thinking about your last question; ask again once it answers.`
- **The log.** buddy keeps its own log in `logFile` (default
  `~/.claude/buddy/buddy.log`, or `$CLAUDE_CONFIG_DIR/buddy/buddy.log` when
  `CLAUDE_CONFIG_DIR` is set; a path you set is used with `~` and a leading `$CLAUDE_CONFIG_DIR` expanded), one JSON
  line per record; a write another session overwrote is retried, and a record
  lost after the retries is reported, though two writes landing at the same instant can still drop one unseen; past 1 MB archived whole to the next free `buddy.log.N` (`.1`, `.2`, …), none ever overwritten, so no record is dropped. `logLevel` `error` writes failures
  only; `info`, the default, adds sessions, commands, questions and their
  outcomes, `commentAfterEachTurn` and menu picks; `debug` adds the question text and the
  model's result shapes. It never holds your account id or anything from
  `~/.claude.json`. `/buddy log` shows the path and the last 20 lines, to
  paste into an issue; an empty `logFile` writes no file.
- **`commentAfterEachTurn`** (on by default). At the end of every answered turn, tool use or
  not, one short call on `model` at the `effort` level (at most 2048
  output tokens, its thinking included, a 30-second deadline) reads its `chatTurnsToRead` (the chat's
  last turns, each filtered to your prompt, any prompt you typed while Claude
  worked on it, what Claude did and its answer, with
  what it said after each) and the turn's
  tally (the tools it used, how many failed, the last Bash command) and
  writes `commentAfterEachTurn`, the buddy's one-line reaction for the bubble, told the same
  character rule as a question. `secondsBetweenComments`
  (default 0) spaces `commentAfterEachTurn` out; `commentAfterEachTurn: false` keeps the buddy quiet. An
  aborted turn, or a subagent's, makes no call.
- **`suggestNextPrompt`** (on by default): the buddy's second brain. The
  same call, its prompt combining the character's with the suggestion's,
  names what you
  most deeply want from the chat (carried from turn to turn, forgotten at
  `/clear`), judges Claude's last move against it, and writes the prompt you
  should send next, as you would type it: an ask, an instruction or a
  decision, never a report of what you did, and never speaks for you: no
  approval, ruling or observation put in your mouth ("approved", "as I
  said", "I checked"); it asks for the step instead. It shows as the prompt box's
  dim suggestion, Tab to take it; sent unedited, Claude is told it is the
  buddy's suggestion, so a claim in it is checked, not trusted; extended,
  your own words typed after it, Claude is told the suggested part is the
  buddy's and only the words you added are yours. Either way Claude is told
  never to record the suggestion as your ruling, order or approval, and the
  buddy remembers each of your turns as what it suggested and what you sent,
  apart, so a rule it keeps comes only from words you typed beyond its
  suggestion. The drawer counts an extended suggestion as used. The verdict is `RIGHT` (the proper way: the
  suggestion says yes and moves on, the bubble keeps the comment),
  `SHORTCUT` (the fast or easy way that costs later, such as "done" claimed
  without evidence: a yellow warning in the bubble, the suggestion asks for
  the proper way) or `WRONG` (against what you want, such as a destructive
  step or a false claim: the buddy screams it in bold in a red frame, the suggestion stops
  Claude and names what to do instead). A warning or a scream outranks that
  turn's comment in the bubble; the drawer and the buddy's memory keep
  both. Claude Code's own suggestion is held back meanwhile and shown only
  when the buddy has none (it answers `NONE`, nothing, or not within 30
  seconds); a later turn's end (answered, interrupted or failed), `/clear`
  or `/buddy off` drops a late one. Where the band never draws (VS Code,
  mobile) the call writes the second brain alone, and no `commentAfterEachTurn` is paid for.
  Each turn's `commentAfterEachTurn` or verdict waits until the model bubble
  showing, a `/buddy` answer or the last turn's, has had its 10 seconds, and
  behind the thinking line of a question still pending. `suggestNextPrompt: false`
  leaves Claude Code's own alone; with it on, turning off Claude Code's own
  prompt suggestions saves paying for both.
- **`promptToMainChat`** (off by default): the buddy may prompt Claude itself; what it sent shows in the bubble, its words yellow.
  The same end-of-turn call may write one more line, a prompt of at most 40
  words the buddy sends Claude right away, only on evidence inside the turn
  that your own ask is unmet or unproven: a failed step or test run the
  answer passes over, a "done" that rests on less than it names, an
  instruction in your ask Claude did not follow, a part of the ask it never
  addressed. The buddy's own doubts (a better method, a risk, a tidy-up)
  stay a suggestion. Claude
  reads it under the plugin's origin with a note that it is the buddy's,
  never yours, to check before acting on. At most one per prompt of yours:
  the turn it starts never sends another. The buddy remembers what it sent
  and files that turn as its own. While it is on, your live rules from the
  buddy's memory ride every prompt Claude gets, whoever sent it, as context
  for Claude alone, each quoted in the words you typed, with what it covers
  labelled as the buddy's own reading, never yours. When the buddy's
  prompt is about one of those rules not followed, it names the rule, and
  the rule climbs a ladder: the first time, the prompt goes to Claude (the
  rule's own reminder when the buddy wrote none); the second, it goes again
  starting `Again:`; from the third, nothing goes to Claude and the bubble
  warns you in yellow, `Claude broke your rule again: "{your words}"`.
  Each rule's count is kept per chat in `memory.json`, logged as
  `rule.strike`; a rule that ends takes its count with it, so one set again
  starts over. A rule named in a reply that came too late to send still
  counts. A prompt the chat moved past while the call ran (you
  prompted again, a turn is running, or a newer turn ended) is never sent:
  the buddy remembers it as written and unsent.
- **`promptWhenIdle`** (off by default): the buddy may wake an idle chat.
  Once the chat sits 30 minutes after an answered turn, no turn running and
  no prompt sent, while the buddy is shown, it makes one call of its own, on
  opus at low effort whatever `model` and `effort` say, sent only Claude's
  last answer, asking whether Claude left work it owes and can do now. The
  reply is `PAUSE`, or one line `PUSH: {step}` the buddy sends Claude as its
  own prompt, its words yellow in the bubble. A push naming, in any
  phrasing, a git push or force, `branch -D`, `reset --hard`, a tag, a
  merge or a rebase, a `gh pr`, `gh release` or `gh repo` step, a deletion
  (`rm`, delete, drop, remove), a publication (publish, release, deploy), or
  an account step (login, logout, account, credential, token) is refused in
  code and sends nothing, as does a reply outside that shape, or one that
  comes back after you prompted or turned the buddy off. At most 3 pushes in a row before you prompt again; an
  interrupted, failed or refused turn arms no call, and any prompt, a turn's
  start or `/clear` cancels the wait. Each decision logs `away.decision`.
- **Errors are never silent.** A chosen character that is missing or invalid
  draws the duck with a bubble
  `Couldn't load {id}: {error}; ctrl+x t in /buddy picks another`
  for 10 seconds, and the personality picker marks it `(invalid)` with the error
  in its preview.

## ⚙️ Configuration

Set these through `/plugin configure`, or under `pluginConfigs["buddy@buddy"].options`
in `settings.json`. The key must be the full plugin id: Claude Code silently
ignores options under any other key. A value buddy cannot use is ignored by
name and its default kept: the first
greeting's bubble says so once, and `/buddy help` and the log list it.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `character` | string | `"duck"` | Character id (see the personality picker, ctrl+x t in /buddy) |
| `customCharactersDir` | directory | `""` | `customCharactersDir`: the folder of your own character JSON files |
| `walkOverPromptBar` | boolean | `true` | Walk back and forth over the prompt bar |
| `commentAfterEachTurn` | boolean | `true` | The buddy says `commentAfterEachTurn` at the end of every answered turn, from one short `model` call that also writes `suggestNextPrompt` (spends tokens); `false` keeps it quiet |
| `model` | string | `"opus"` | Model for `commentAfterEachTurn`, `suggestNextPrompt` and every /buddy question: the end-of-turn call and every /buddy question. `inherit` follows the main chat's model, read at every call (`opus` when it cannot be read) |
| `effort` | string | `"low"` | How hard `model` thinks on each of those calls: low, medium, high, xhigh, max or `inherit`. `inherit` uses the effort of the main chat's latest request, and sends none before its first (or when that request carries none, or a number), so the model's default applies |
| `secondsBetweenComments` | number | `0` | Minimum seconds between two `commentAfterEachTurn`; 0 = every answered turn |
| `suggestNextPrompt` | boolean | `true` | The buddy's second brain, in the same end-of-turn call: it names what you most deeply want, judges Claude's last move `RIGHT`, `SHORTCUT` (warned in yellow) or `WRONG` (screamed in red), and writes your next prompt to match (spends tokens); Claude Code's own is held back and shown only when the buddy has none; `false` keeps Claude Code's own |
| `promptToMainChat` | boolean | `false` | The buddy may send Claude a prompt of its own after a turn, at most one per prompt of yours, from the same end-of-turn call: only on evidence inside the turn that your own ask is unmet or unproven (a failed step or test run the answer passes over, a conclusion that rests on less than it names, an instruction in your ask not followed, a part of the ask never addressed); the buddy's own doubts, and a gap Claude named, stay a suggestion. Claude reads it as the buddy's, never yours, with a note saying so; the turn it starts never sends another, and with `suggestNextPrompt` on the suggestion after one is none. While on, your live rules from the buddy's memory ride every prompt as context for Claude, and a rule not followed climbs a ladder: the prompt, then the prompt again starting `Again:`, then from the third time a warning to you in the bubble instead. A prompt the chat moved past is never sent, remembered unsent. Logs `promptToMainChat.sent` and `rule.strike`. |
| `promptWhenIdle` | boolean | `false` | After an answered turn, once the chat sits idle 30 minutes with no turn running, one call on opus at low effort reads Claude's last answer and replies `PAUSE` or a one-line push, sent to Claude as the buddy's prompt; never a git push, a deletion, a publication, a credential or an account step; at most 3 pushes before you prompt again. One model call per idle stretch (spends tokens); logs `away.decision` |
| `chatTurnsToRead` | number | `4` | The buddy's memory: how many of the chat's latest turns it remembers, 1 to 10, after the chat's memory items (at most 10 rules, 6 open items, 6 facts, 4 lessons and 3 doubts, edited by the buddy at every turn's end and checked in code). Each turn comes with what the buddy showed after it (`commentAfterEachTurn`, a warning or scream, and `suggestNextPrompt`) and your /buddy questions with its answers; a compaction of the chat counts as a turn, its summary the answer; the last turn with its numbers (time, requests, tool calls, files, lines, tests in their order, commits, tokens, cost, context), each older one told shorter, its numbers only its failed tool calls; anything older is forgotten, and the buddy knows it. Every call reads it; kept per chat, in the chat's own folder beside its transcript (`{config}/projects/{project}/{session id}/buddy/memory.json`, and beside it `memory.md`, for you to read: the memory items, the newest ended ones, and the turns as the character drawn now reads them), so reopening a chat brings it back; the exchanges are kept per character, the memory items per chat; a write that fails retried twice while your next turn has not started; more turns, more tokens per call |
| `logLevel` | string | `"info"` | Log level: error, info or debug |
| `logFile` | string | `"$CLAUDE_CONFIG_DIR/buddy/buddy.log"` | Log file, one JSON line appended per record, archived whole to the next free `{logFile}.N` past 1 MB and never deleted; a leading `$CLAUDE_CONFIG_DIR` is the config folder (`~/.claude` when the variable is unset), `~` is your home folder, any other path is used as given (empty = no log file) |
| `saveRounds` | boolean | `true` | One text file per main-chat turn in the chat's own folder, beside its transcript and next to `memory.json`, the buddy's memory of that chat (`{config}/projects/{project}/{session id}/buddy/`), every turn kept (`round-001.txt` on, each new round numbered after the highest, none ever overwritten; `ls -t` lists them newest first), holding everything that went into buddy and came out of it, in the order it happened, from the turn's start to the next turn's start: the prompt the turn began with, each tool call buddy heard with its arguments and output (each value cut at 500 characters), every buddy log record at any level, each bubble line and prompt-box suggestion, the turn's end as buddy filed it into its memory, and every model call buddy made, its system prompt, prompt and reply verbatim (they hold what the transcript beside them holds: your prompts, Claude's answers and tool output); `false` = no files |
| `ambiguousCharacterWidth` | string | `"narrow"` | Ambiguous-width characters: narrow or wide; `wide` for a terminal that draws them two columns wide, as a CJK locale often does |

```json
{
  "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" },
  "pluginConfigs": {
    "buddy@buddy": {
      "options": { "customCharactersDir": "/path/to/my-characters", "commentAfterEachTurn": true }
    }
  }
}
```

[`config.example.json`](config.example.json) lists every option at its default, ready to merge into your `settings.json`.

### Speed and context

- A question and the end-of-turn call each read the `chatTurnsToRead`
  and the buddy's own small prompt, on `model` at `effort`; about
  3 seconds, however long the chat.
- `/buddy log` shows what each question cost: its `ask.outcome` record
  carries its tokens, `cacheRead` (input read from the prompt cache) and
  `cachePct` (that share of all its input) and `ms`; the end-of-turn call's
  `commentAfterEachTurn.outcome` carries the same (its `verdict.outcome`,
  when the call wrote no `commentAfterEachTurn`; that record also says
  said, quiet, held, hidden, dropped, none, failed or stale, with the
  verdict), and its `suggestNextPrompt.outcome` its `ms`, all counted from
  the turn's end to the reply.
- `npm run audit` (from a clone of this repo; `-- --since 7d` for a span)
  reads every model call's `call.cost` record from `buddy.log` and its
  rotated archives and prints, per day, per kind of call and in total: the
  calls, tokens in and out, the cost in dollars, the turns each call
  remembered and how much of those turns' text the memory cut. The cost is
  the `usd` each record logged at buddy's list prices; an older record
  without one is priced from the same table, `plugins/buddy/src/prices.ts`
  (`priceCall`), which the audit imports. A model with no price is named and
  left out of the cost, never shown as $0, and a `*` marks a row that left
  such calls out. The audit imports the engine's TypeScript price table
  directly, so it needs Node 23.6 or later (type stripping on by default).

## 🎨 Your own character

A character is one JSON file, `{id}.json`, checked against
[`plugins/buddy/schema/character.schema.json`](./plugins/buddy/schema/character.schema.json).
Put yours in a folder, point `customCharactersDir` at it, and `/buddy reload`.

| Field | Type | Req | Meaning |
| --- | --- | --- | --- |
| `$schema` | string | no | `"../schema/character.schema.json"` in built-ins |
| `id` | string, `^[a-z0-9][a-z0-9-]{0,31}$` | yes | unique, and not `original` (reserved); the id the personality picker stores |
| `name` | string ≤ 40 | yes | display name |
| `description` | string ≤ 100 | yes | one line for the personality picker's preview |
| `author` | string ≤ 60 | no | credit |
| `persona` | string ≤ 1200 | yes | the character's voice prompt, 2nd person ("You are …") |
| `color` | Ink color name or `#rrggbb` | no | sprite color, default `"yellow"` |
| `poses` | object | yes | pose name → array of frames; frame = array of rows (strings) |
| `lines` | object | no | event name → array of canned one-liners (≤ 120 chars each) |
| `motion` | object | no | `walk` (bool, default true), `stepMs` (80–1000, default 200), `restChance` (0–0.2, default 0.02), `restTicks` (1–100, default 15) |

[CONTRIBUTING.md](./CONTRIBUTING.md) has the rest of the contract (the
poses and their fallbacks, the line events, the rules for the art), a
working example, how to test it, and how to send it in to ship with buddy.

## ❓ FAQ

<details>
<summary><b>Is this the <code>/buddy</code> that Claude Code removed?</b></summary>

No. buddy is an independent plugin, not a patch to Claude Code or a revival
of the removed code. You choose a character, and its reactions come from its
own lines and from your own model calls, not from a server. But the
"Yours" group of the personality picker does bring back the companion the
removed `/buddy` hatched for your account: the same species, rarity, eyes, hat and stats, recomputed
from your account id, with the name and personality Claude Code's config (`~/.claude.json`, or
`$CLAUDE_CONFIG_DIR/.claude.json`) kept.
</details>

<details>
<summary><b>Does it cost tokens?</b></summary>

Only when a model answers. Walking, reactions and every command
except a question are local. A question
sends `model`, at the `effort` level, the question, the character's
persona and its `chatTurnsToRead` (the chat's last turns, with what
the buddy and you said after each), never the rest
of the conversation. `commentAfterEachTurn` and `suggestNextPrompt` are on by default: one short
`model` call per answered turn, sent its `chatTurnsToRead` (default 4 turns) and the turn's tally; `commentAfterEachTurn: false` and `suggestNextPrompt: false`
turn them off, and with `suggestNextPrompt` on, turning off Claude Code's own prompt
suggestions saves paying for both. With `promptWhenIdle` on, a chat left idle
30 minutes after an answered turn costs one more call, on opus at low effort,
sent only Claude's last answer.
</details>

<details>
<summary><b>I installed it and nothing shows.</b></summary>

Check that `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` was set before Claude Code
started: with it off, a new session prints `buddy is off: …` and names what
to add to `settings.json` (see [Quick start](#-quick-start)). Then check
that you are in the terminal or the desktop app (the VS Code
extension and mobile do not draw the line above the prompt), that the
window is wide enough for the character, and that `/buddy on` is in effect.
</details>

<details>
<summary><b>Why is my buddy asleep?</b></summary>

From midnight to 6 am, local time, it falls asleep after a minute with
nothing happening. Anything that happens wakes it.
</details>

<details>
<summary><b>My character shows as invalid.</b></summary>

The personality picker (ctrl+x t in `/buddy`) lists it as `{id} (invalid)`, and its preview names the
first error in the file. Fix it, save, and run `/buddy reload`.
</details>

## 🛠️ Development

```sh
npm install
npm test              # unit tests (vitest) and function-hook tests (claude plugin test)
npm run typecheck
npm run validate:plugin
claude setup-token    # once, for the live scripts: save the token to ~/.config/buddy/live-token (chmod 600)
                     # or set BUDDY_LIVE_CREDENTIALS_FROM to a logged-in Claude config dir (e.g. ~/.claude): its access token is read at each launch
npm run live          # live proof in tmux, spends a few cents of Haiku
npm run live:configs  # five sessions, one per configuration, every turn measured; report in /tmp/buddy/configs-*/
npm run live:drawer   # one session: two turns, a question, then /buddy opens the drawer, kept and closed with ctrl+x q; screen in /tmp/buddy/drawer-*/
```

Work lands on `develop`; `main` holds only releases, and each one is tagged
`buddy--vX.Y.Z` with its notes in [CHANGELOG.md](./CHANGELOG.md). Pull
requests go to `develop`; [CONTRIBUTING.md](./CONTRIBUTING.md) covers both
characters and code.

`plugins/buddy/hooks/buddy.tsx` is a thin adapter over `plugins/buddy/src/`,
where every decision is a pure, unit-tested module.

## 🎓 Built with Professor

buddy is built and maintained with [Professor](https://github.com/rezzminator/professor), a fleet controller and discipline layer for Claude Code, Codex and OpenCode: chats that message each other, agents held to the project's rules, and gated releases. The Professor character, shipped alongside Quack, carries its namesake.

## 🆘 Help

- A question, or buddy not showing up: see the [FAQ](#-faq), then
  [SUPPORT.md](./SUPPORT.md).
- A bug or an idea: [open an issue](https://github.com/rezzminator/buddy/issues/new/choose);
  there is a template for bugs, features and new characters.
- A security problem: [SECURITY.md](./SECURITY.md), never a public issue.

## 🤝 Contributing

The best thing to add is a character: one JSON file, a persona and a few
poses of ASCII art. [CONTRIBUTING.md](./CONTRIBUTING.md) walks through it;
issues labelled
[`good first issue`](https://github.com/rezzminator/buddy/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
are a place to start. Everyone taking part follows the
[Code of Conduct](./CODE_OF_CONDUCT.md).

<sub>Keywords: Claude Code buddy · /buddy · Claude Code companion · terminal pet · ASCII pet · tamagotchi · speech bubble · Claude Code plugin · function hooks · Claude Mods · custom characters</sub>

## License

[MIT](./LICENSE)
