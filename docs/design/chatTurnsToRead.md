# chatTurnsToRead

`chatTurnsToRead` is the buddy's short-term memory: the main chat's last N answered turns, a compaction counting as one, and under each what the buddy and you said after it.
Ask it to remember a word, and the next question gets the word back; ask about a turn older than its memory, and it says it doesn't remember that far back.
It is one timeline per session, and every question and end-of-turn call reads it, at no extra model call.

## What it remembers

The timeline is a list of blocks, oldest first, one per answered main-chat turn or compaction (`Block`): the turn's prompt, what Claude did, its numbers and Claude's answer, under its `turnId`, when it was filed (`at`), how long its prompt and answer were before the cut (`full`), and each character's exchanges after it.
Only the first block may have no turn: what was said before the first turn remembered, such as the greeting.

| Exchange | Holds |
| --- | --- |
| `question` | a `/buddy` question with its answer, or the question alone if it got none: its call failed, or another character was drawn by the time the answer came, so it was dropped |
| `line` | a canned line the bubble showed on its own |
| `endOfTurn` | what a turn's end showed: its `commentAfterEachTurn` (said, or outranked by a warning), the second brain's warning or scream the bubble said (`warned`), the prompt it sent Claude itself (`promptToMainChat`), and its `suggestNextPrompt`, if the prompt box showed it; at least one, kept together |

- **As far back of itself as of the chat.** When a turn ends past the option's count, the oldest block goes, and every exchange filed under it goes with it (`addTurn`). The buddy never holds a comment about a turn it can no longer see.
- **Filed where it happened.** An exchange is filed under the turn that was the newest when it began (`addExchange`, `lastTurnId`): a question asked while a turn runs is filed under the turn before it, however late its answer lands; an end-of-turn exchange under its own turn. One whose turn is no longer remembered is dropped.
- **Only what was shown.** The `thinking` filler is not an exchange; a line said while the buddy is hidden was never shown, so it is dropped; a comment held back behind a `/buddy` answer is not filed. A line joins only once the band has drawn in the session: a headless `claude -p` or SDK session never draws it; before the first draw only the newest line is held, for when the band first shows it (`heard`).
- **A compaction is a turn.** When the main chat compacts (`session.compact`, the main loop's, never a `precompute`), the summary Claude now holds is filed as a block of its own (`addCompaction`, `from: compaction`), its summary the answer, cut like an answer, and counts toward N. The model reads `Turn k. The main chat was compacted: Claude now holds only this summary of everything before it:`, so the buddy knows what the chat still holds of what it no longer remembers.
- **Answered and interrupted turns.** A turn the user interrupted is filed with `interrupted: true`, what Claude said before it its answer, which the model reads under `Claude answered, before the user interrupted the turn:`; it still makes no end-of-turn call. A subagent's turn is not filed. A headless session files no turn at all, so it never pushes an interactive session's memory out of the store.

## Its own notes

Beside the timeline, each character keeps its own notes on the chat (`Notes`), written and rewritten by itself: at every turn's end the end-of-turn call asks for its whole memory as `MEMORY:` lines, one note of one sentence each, each on a line of its own shaped `MEMORY: kind: note`, at most 8 (`MEMORY_LINE`, `NOTES_MAX`). The kinds: `rule:` an instruction or decision of the user's that still binds, in their words, kept until they lift it or it is met; `open:` what the user asked for that is unfinished or unproven; `fact:` what the chat showed; `doubt:` the buddy's own unchecked suspicion, dropped once a turn checks it and never stated as fact. A note is copied word for word unless a turn in view changes it, and a user's rule beats any doubt. Typed notes keep the buddy's guesses from hardening into facts across rewrites, and a user's standing order from falling out of the four-turn window.

- **Rewritten whole.** The reply's notes replace the ones it had (`rememberNotes`); a reply with no `MEMORY:` line, or only a bare one, keeps them, so a model that forgot to write them never erases them; notes listed under a bare `MEMORY:` line are read as notes; and `MEMORY: NONE` alone forgets them all.
- **Cleaned.** Each note trimmed, a leading bullet or number stripped, empty, repeated and too long ones (past 300 characters, `NOTE_MAX_CHARS`) dropped; past 8 the latest note of the kind that goes first is dropped until they fit: a doubt, then a fact or an untyped note, then an open item, a rule last (`cleanNotes`); a stored file is cleaned the same way when read.
- **Leading what it remembers.** `render` puts them first, before the timeline, so every question and end-of-turn call reads them: `Your own notes on this chat, which you keep and rewrite yourself:` (`renderNotes`).
- **Per chat and per character,** kept in the same `memory.json` as the timeline (`Stored.notes`), so a `/clear` starts with none and a reopened chat finds them again.
- **Said when they change.** The drawer's thread shows each rewrite as `✎ {name}'s notes`, one bullet per note; `notes.outcome` logs `rewritten`, `cleared` or `unchanged`, with the count.

## The numbers

Each turn is filed with its numbers (`TurnStats`, [`src/stats.ts`](../../plugins/buddy/src/stats.ts)), counted in code as the turn runs, never by a model: the adapter opens a tally at `turn.start` (`openTally`), counts each of the main loop's model requests with why it stopped at `turn.step` (`countStep`), each tool call at `tool.call` (`countToolCall`), each subagent run that ends inside the turn with the tokens it spent (`countAgentRun`), and closes it at `turn.complete` with the turn's time, the main loop's tokens and model, the effort of its latest request, and the session's usage read at its start and its end (`closeTally`, `$.session.usage()`, at most 2 s each, checked at entry by `usageReadingOf`). The model reads them as one line under what Claude did (`renderStats`), a few dozen tokens:

| Part | Counted from | Said |
| --- | --- | --- |
| time, gap | `turn.complete`'s `durationMs`; the previous main turn's end to this start | `4m12s, after a 14m00s pause` |
| model requests | the main loop's `turn.step`s | `31 model requests` |
| tool calls | the main loop's `tool.call`s, by tool (an MCP tool by its own name, its server dropped); errored, refused, and shell commands run again unchanged | `47 tool calls (Bash 20, Edit 12, Read 10, Grep 3, 2 more kinds), 3 failed, 1 denied, 2 shell commands run again unchanged` |
| subagents | subagent runs ended, their calls and every token they spent | `2 subagent runs: 57 tool calls, 340k tokens` |
| files, hot file | distinct paths read, edited, written, a main-loop shell command's included (below), and deleted by one; the file edited 3 times or more (`HOT_EDITS`) | `files 8 read, 5 edited, 1 written, 2 deleted; buddy.tsx edited 9×` |
| lines | an edit's old and new text, their shared first and last lines left out; a write's every line | `lines +212 −47` |
| test runs | a test runner's summary (`classifyToolCall`) | `test runs 2 passed, 1 failed` |
| git | `git commit` and `git push` where a command starts, past git's options | `1 commit, 1 push` |
| web | `WebFetch`, `WebSearch`, a harvester, fetch, web or browser MCP tool | `3 web reads` |
| stops | responses cut at max tokens; requests the context window could not hold | `cut at max tokens 1×` |
| tokens | the main loop's, as `turn.complete` sums them | `tokens 1.2M in (95% cached), 18k out` |
| cost | the session's cost at the end less at the start, as `/cost` counts it | `$0.42` |
| context | the window after the turn | `context 62% full of 200k` |
| limits | the 5-hour and weekly windows, said from 50% used (`LIMIT_SAID_PERCENT`) | `5-hour limit 71% used` |
| model, effort | the model that answered; the effort of the last request; said for a turn that asked a model anything, again only when it changed from the turn before | `on opus-5 at xhigh effort` |

- **Only what happened.** A group that stayed zero is left out, stored and said; a call that failed touches no file, line, commit or web read, only its failure count, a shell command's measured edits aside.
- **A shell command's edits, measured.** The words of a main-loop shell command that look like paths (`shellTargets`: from the session's folder and each folder it `cd`s into or points `-C` at, `~` as home, at most 24) are read before it runs and after (at most 300 ms each way, a file past 256 KB left unread, the text held only to compare, never logged); only a file that really changed counts, whatever the command's exit: one made is written, one changed edited, one deleted deleted (never an edit of it), its lines counted as git counts them (`fileLineDelta`). A path built while the command runs goes unmeasured, and a subagent's command is never measured. Before and after each main-loop shell call the folders it works in are also swept (`sweepFolders`, `shellFolders`: dot-folders and `node_modules`, `dist`, `build`, `coverage`, `vendor`, `target`, `venv`, `__pycache__`, `out` skipped; at most 400 files, 4 deep; up to 512 KB of the smallest text files read ahead), so a file a script or formatter changes without the command naming it counts (`sweptChanges`); its lines are exact when its text was read ahead, else the numbers line says `unmeasured in N files`. Paths are keyed by their real path.
- **The whole turn's work.** The main loop's own calls are counted by name, its subagents' in one number; what a call did (files, lines, tests, git, web) counts whoever made it. A subagent still running after the turn ended counts toward none.
- **A read that fails is said.** A usage that fails or comes back malformed is said once in the transcript and logged every time; one that takes past 2 s logs `usage.read` `timeout`. Either way the turn is filed with its other numbers, without the cost, context and limits.
- **The end-of-turn call points, never repeats.** Its memory holds the turn just ended, what Claude did and its numbers with it, so the prompt ends `The turn that just ended is the last one above.` (`JUST_ENDED`); only a memory missing that turn gets the tally counted here (`Tools used: …`).
- **In the drawer too.** The turn's row in the talk tab carries them in brief once it ends: `4m12s · 104 tools · $0.42` (`statsBrief`, `markNumbers`). Each turn logs `turn.numbers`: its time, requests, tool calls, subagent runs, cost and context.

## How a turn is filtered

A turn is kept as what carries meaning, never what only fills (`cappedTurn`):

| Part | Kept | Dropped |
| --- | --- | --- |
| the prompt (`cleanPrompt`) | its text, one line; a task notification's `<summary>`, its `<status>` when not `completed`, and its `<result>` as `Its report:`, cut to its first 1,200 and last 400 characters (`NOTIFICATION_RESULT_HEAD`, `NOTIFICATION_RESULT_TAIL`); its first 4,800 and last 2,400 characters (`TURN_PROMPT_HEAD`, `TURN_PROMPT_TAIL`) | every tag, a `<system-reminder>` with its text, a notification's ids, paths and usage |
| what Claude did (`actionOf`, `didOf`) | one line per step: a shell command's `description` (else the command, its `cd`s dropped and each path cut to its last part, a URL whole, at most 72); a file tool's verb and file name, the turn's files gathered under one `read`, `edited`, `wrote` or `searched`; an agent's description; a skill, a web search, a fetched host, an MCP tool's name; a background shell command or agent marked as reporting back later; a failed step's `(failed: …)` with one line of why (`failureReason`: the first error line, else the last, after the exit code), a denied one's `(denied: …)` with the denial's words, both redacted of keys and tokens, at most 90 characters (`FAIL_REASON_CAP`); a failed or denied file tool a step of its own in the infinitive (`edit a.ts (failed: …)`), never gathered under the verb | a tool's output past that one line, and a diff; bookkeeping tools (`ToolSearch`, the task tools, `Monitor`, `ScheduleWakeup` …); a step said twice in a row; a subagent's steps; past 12 steps (`DID_MAX`), all but the first 4 and last 7, counted |
| the answer (`cleanAnswer`) | its words, code and line breaks; its first 8,000 and last 3,200 characters (`TURN_ANSWER_HEAD`, `TURN_ANSWER_TAIL`): the start says what came of the turn, the end what is next | bold, heading marks, table rules, blank lines |

Each step is at most 80 characters (`DID_TEXT_CAP`), its failure marker after the cut, whole (a stored step at most `DID_LINE_CAP`), a verb names at most 6 files and counts the rest (`DID_FILES_MAX`). Filtering is idempotent: a stored turn read back is filtered again and stays as it was.
A text cut keeps its head and tail around ` … ` (`ends`).

What the buddy and you say to each other is never cut: a question, an answer, a `commentAfterEachTurn`, a warning and a `suggestNextPrompt` are kept whole, blank space around them aside (`keepText`), line breaks and all, and no count drops them. Only canned lines are bounded: one character keeps at most 3 under one turn, the oldest going first (`LINES_PER_TURN_MAX`).

## How much of a turn is kept

The cut was chosen from 60 days of real transcripts, 12,492 turns, priced on Sonnet 5 at $2 in and $10 out per million tokens, with a 4-turn memory, about 1,800 fixed tokens per call (the system prompt and the exchanges) and 2.64 characters per token, both measured from the round files:

| Tier | Prompt head / tail | Answer head / tail | Text lost | Turns cut | Cost per 100 turns | vs 300/150 | Largest call |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1x | 300 / 150 | 500 / 200 | 70.8% | 60.1% | $0.65 | | about 3.6k tokens, $0.008 |
| 2x | 600 / 300 | 1,000 / 400 | 53.0% | 44.9% | $0.77 | +18% | about 5.3k tokens |
| 4x | 1,200 / 600 | 2,000 / 800 | 33.1% | 23.3% | $0.91 | +38% | about 8.9k tokens |
| 8x | 2,400 / 1,200 | 4,000 / 1,600 | 18.6% | 10.3% | $1.00 | +53% | about 16k tokens, $0.033 |
| **16x, chosen** | 4,800 / 2,400 | 8,000 / 3,200 | 7.7% | 3.6% | $1.07 | +64% | about 29k tokens, $0.06 |
| whole | | | 0% | 0% | $1.13 | +72% | unbounded |

A real prompt's median is 112 characters (p90 3,563), an answer's 596 (p90 2,621), so most turns are whole at any tier; the tiers differ in the long ones. At 16x an average call reads about 4,900 input tokens instead of 2,800, and a turn is still bounded, so one pasted log cannot make a call unbounded.

The cost and the cut are measured in use, not only here: every model call logs one `call.cost` record (`completeRecorded`) with its kind, model, outcome, `ms`, tokens (`inTok`, `outTok`, `cacheRead`, `cacheWrite`), the turns its memory held (`memTurns`), their prompt and answer characters kept (`memKept`) and before the cut (`memFull`, `memoryStats`), and the prompt's size (`promptChars`). `npm run audit` (`scripts/audit.mjs`, `-- --since 24h|7d`, or log files named) totals them per day, per kind and overall: calls, failures, tokens, an estimated cost at list prices, the turns remembered and the share of their text cut. With no log it exits 1 naming where it looked; a bad `--since` exits 2; an unpriced model and a line that does not parse are named.

## The story form

The memory is all the buddy reads of the chat: it stands in for the whole conversation. The last turn it renders, the one a call is about, stays as filtered above; every turn before it is told as a story, cut to what steers the buddy (`render`, `turnLines`):

| Part of an older turn | Kept |
| --- | --- |
| the prompt | its first 600 and last 200 characters (`STORY_PROMPT_HEAD`, `STORY_PROMPT_TAIL`) |
| a prompt added while Claude worked | its line, label included, to the first 400 and last 100 characters (`STORY_ADDED_HEAD`, `STORY_ADDED_TAIL`) |
| what Claude did | its line whole (`STORY_DID_STEPS` null); a number there names only that many steps and counts them all, `Claude did 10 steps: a; b; …` (`didLine`) |
| the numbers | only its failed tool calls, when any: `2 tool calls failed.` |
| the answer | its first 500 and last 300 characters (`STORY_ANSWER_HEAD`, `STORY_ANSWER_TAIL`) |
| the buddy's exchanges | whole and in order, canned lines included |

A compaction before the last turn keeps its head line, then its summary and the exchanges after it, canned lines left out, cut to the first 1,500 and last 500 characters (`STORY_COMPACTION_HEAD`, `STORY_COMPACTION_TAIL`). A compaction that is the last turn, and what was said before any turn, stay as they are.

Replayed on 189 real end-of-turn calls, the story form read 27.8% fewer input tokens and the reactions held; dropping the canned lines as well lost a catch that spanned turns, so they stay. The cut is made when the prompt is rendered, never in what is stored: `memory.json` keeps each turn as filtered above, so a turn read whole as the last is cut only once a newer one follows it. `call.cost`'s `memKept` and `memFull` count the stored turns; `promptChars` is what was sent.

## Where it is kept

Each chat has one file in its own folder, beside its transcript: `{config}/projects/{project}/{session id}/buddy/memory.json` (`chatFolderFor`, `src/chatFolder.ts`), holding when it was last written, the blocks and each character's notes (`Stored`). `{config}` is `CLAUDE_CONFIG_DIR`, else `~/.claude`; `{project}` is the folder holding the transcript `{session id}.jsonl`: the one named from the session's root (every character but a letter or digit made `-`), else from its working directory, else any project folder holding it (a path too long to name so). Before the transcript exists (a new chat's start) it is the root's, and the adapter looks again at the next read. The chat's round files (`saveRounds`) go into the same folder.

- **Per session.** The adapter asks `$.session.id()` before every read and loads the record again when the id changes. A `/clear` moves the process to a new session id, so it starts with no memory; a resume moves it to the resumed session's id, so that chat's memory comes back with it.
- **Per character.** A character reads only its own exchanges (`render`), so a switched character never claims another's words, and switching back finds them again; the turns are the same for every character.
- **In the chat's folder.** It survives `/reload`, restarts and a reopened chat: the session start loads it (`loadMemory`, for a hidden buddy too), and opening the drawer loads it, so the talk tab shows it at once. It lasts as long as the chat, and deleting the chat's folder deletes it.
- **Moved from the store.** Before 1.0.0 it was kept in `$.store` under `chatTurnsToRead:{session id}` (`storeKey`), 20 sessions at most. A chat's first read with no `memory.json` reads that key, writes the file, and deletes the key (`chatTurnsToRead.moved`); other chats' keys wait until those chats are opened.

Every read and write goes through one chain, in the order made, so a turn is filed before its end-of-turn call reads the memory, and an answer is saved before the next question reads it (`chainChatTurnsToRead`, on `chained`).
A link's deadline counts only its own run: a write gets 60 seconds (`CHAT_TURNS_TO_READ_WRITE_DEADLINE_MS`), a read what is left of its caller's deadline. A link still running at its deadline is abandoned, said once, and the chain goes on; a read whose caller gives up while it still waits is dropped unrun (`chatTurnsToRead.dropped`), never said failed.
A write that failed or was abandoned is made again 5 seconds later (`CHAT_TURNS_TO_READ_RETRY_MS`), so the reads queued meanwhile go first, 3 tries in all (`CHAT_TURNS_TO_READ_WRITE_TRIES`), and only while the next main turn has not started and the conversation is the same (`changeChatTurnsToRead`); the change is applied to the timeline once, never twice. `chatTurnsToRead.retry` logs each try as `trying`, `landed` or `skipped`, and a retry that lands clears the failure the next reply would have said.
An abandoned link writes nothing once it lands: a late store read never replaces the timeline a later link loaded, and at most one store write per session is in flight (`latestWrites`), so a late write never lands over a newer one.

## How it reaches the model

`render` turns the timeline into one block, addressed to the character as "you", the way the system prompt addresses it; the user is always "the user", Claude always "Claude":

```text
What you remember, oldest first:

Before those turns:
- You said: Quack!

Turn 1. The user asked Claude:
fix the login bug
Claude did: read auth.ts, session.ts; Run the auth tests (failed: exit 1: FAIL tests/auth.test.ts > login keeps the session); edited session.ts; Run the auth tests
1 tool call failed.
Claude answered:
Fixed it: the session cookie was never refreshed.
- After this turn, you commented: Tests pass, but the lockfile moved.
  With it, you suggested the user's next prompt: commit the lockfile
- The user asked you: remember pineapple
  You answered: Pineapple, noted.

Turn 2. The user asked Claude:
commit the lockfile
Claude did: Commit the lockfile
Numbers: 11s, after a 1m05s pause · 2 model requests · 1 tool call (Bash 1) · 1 commit · tokens 250k in (99% cached), 90 out · $0.03 · context 39% full of 200k
Claude answered:
Committed.
```

A question that got no answer reads `You gave no answer.` under it; a turn the user began by sending the buddy's own suggestion unedited reads `The user sent Claude your own suggested prompt, unedited:` (`TAKEN_SUGGESTION`), so its claims are never taken for the user's; a turn whose prompt was not the user's reads `Claude was sent, not by the user ({origin}):`, or `Claude was sent, from an unknown origin:` when its origin was never seen. A plugin hot reload (a `settings.json` edit, `/reload-plugins`) empties the prompt ledger, so the turn running then ends with no prompt on file: its prompt is read back from the transcript, the last user message that is neither a tool result nor a local command's output (`lostPromptOf`, `$.session.messages()`), its origin still unknown; each read logs `prompt.backfill` (`found` or `none`), and a failed read is said and logged as a failure, the turn then reading `(not seen)`.

| Call | What it gets |
| --- | --- |
| a question | the block, then the question (`questionPrompt`); its system prompt carries the memory rule (`oneLineSystem`, `memoryRule`) |
| the end-of-turn call | the block, the turn just ended its last, then a pointer to it (`turnPrompt`, `JUST_ENDED`); the tally counted here only when the block misses that turn |

The memory rule tells the character how far its memory reaches, in turns, and to say in character that its short-term memory doesn't reach that far when asked about anything older, never guessing or making it up.
The block is read once, when the question is asked, so it holds what came before the question; the question joins the timeline with its answer.

## The option

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `chatTurnsToRead` | number | `4` | how many of the main chat's latest answered turns the buddy remembers, with what it and the user said after each; 1 to 10 |

A value that is not a whole number from 1 to 10 is ignored by name and remembers 4: `option chatTurnsToRead ignored: {value} is not a whole number from 1 to 10; reading 4`.
The line reaches the log at session start, the first greeting's bubble once, and `/buddy help`, as every option's error does.
Lowering it mid-session reads only the newest turns at once; the file drops the rest at the next turn.

## Errors

A `chatTurnsToRead` that cannot be read, saved or pruned never disappears in silence.
The failure is logged, and the next question's reply carries it: `Asked {name}. (Its chatTurnsToRead: {what} failed: {why})`.
A stored record that is malformed keeps what still reads and says how many entries it dropped (`chatTurnsToReadOf`); a record of another shape is said not to be a `chatTurnsToRead` record; nothing stored is an empty memory, not an error.

## Decisions

- **One timeline, one window.** Rejected: the chat's turns and the buddy's own exchanges as two lists with two sizes. The buddy then remembered comments about turns it could no longer see, and could not tell which turn a comment was about or whether its suggestion was taken; in one timeline each comment sits under its turn, and the prompt that follows a suggestion is the next turn.
- **What Claude did, as its descriptions.** Rejected: a tool's output or a diff, which costs thousands of tokens and is noise to a one-line comment; and only the tool counts, which say how much was done, never what. A shell command's description is Claude's own one-line account of it.
- **The start and end of the answer.** Rejected: its end alone. Claude says what came of a turn first; a long answer lost its conclusion and kept its closing lines.
- **A wide cut, 16x.** Rejected: 300/150 and 500/200, which cut 60% of real turns and lost 71% of their text, and no cut at all, which lets one pasted log make a call unbounded. 16x keeps 96% of turns whole for 64% more per call ([the tiers](#how-much-of-a-turn-is-kept)); `npm run audit` measures what it costs and cuts in use.
- **Your words and its words whole.** Rejected: folding each exchange to 160 characters and keeping 10 per turn. What you told the buddy, and what it told you, is the thread you hold it to; a cut answer quoted back is a wrong answer.
- **Older turns as a story, the last whole.** Rejected: every remembered turn at the wide cut, which spent most of a call's tokens on turns the call is not about; and a story without the canned lines, which lost a catch that spanned turns. The last turn is what the call reacts to, so it keeps its numbers and its full text; an older one keeps what steers: the user's words, the start and end of Claude's answer, its failed calls, and everything the buddy and the user said.
- **A compaction as a turn.** Rejected: ignoring it. After a compaction Claude holds only its summary; a buddy that never saw it comments on a chat that no longer exists.
- **Retry the write while the next turn has not started.** Rejected: one try in 30 seconds. A write lost to a slow store left a hole in the memory; retried later than the next turn's start it would file a turn out of order.
- **Measured in turns.** Rejected: counting exchanges. A turn is what the user thinks in, and the buddy can say how far back it remembers in the same words.
- **It knows its reach.** Rejected: a memory the model is not told the size of. Asked about an older turn, it guessed; told its reach, it says it doesn't remember.
- **Recent turns in the prompt.** Rejected: a model-written summary of the conversation. A summary costs one more call per turn; the timeline costs nothing to keep and a few thousand tokens at most to send.
- **Every call carries it.** Rejected: relying on the chat's own record. A `/buddy` answer is drawn only in the bubble and never lands in the main transcript, where the chat holds only the command and its `Asked {name}.` reply; so without the timeline no call could see what the buddy said.
- **A turn's `commentAfterEachTurn`, warning and `suggestNextPrompt` in one exchange.** Rejected: one exchange each, or the suggestion kept as a line. A `suggestNextPrompt` was put in the prompt box, never said in the bubble, and in the user's words, not the character's; apart, the model had to guess which suggestion came with which comment.
- **The character is "you", the user is "the user".** Rejected: `You:` for the user and the character's name for its lines. The prompt calls the character "you" everywhere else, so `You:` for the user's lines invited the model to take them as its own.
- **Kept in the chat's own folder.** Rejected: plugin memory only, since a `/reload` would forget the thread mid-conversation and a resume could not bring its chat back; and `$.store`, which 0.3 used, since one store shared by every chat had to be capped at 20 chats, so a reopened older chat had lost its memory, and a chat's memory outlived the chat. The chat's folder already holds the transcript the memory is read from.
- **Per session and per character.** Rejected: one global timeline. A new session's buddy would recall another chat, and a switched character would quote another's words as its own.
- **A small default and a hard cap.** Rejected: unbounded memory. Every remembered turn is sent with every call.

## Where it lives

| File | Symbols |
| --- | --- |
| [`src/chatTurnsToRead.ts`](../../plugins/buddy/src/chatTurnsToRead.ts) | `CHAT_TURNS_TO_READ_DEFAULT`, `CHAT_TURNS_TO_READ_MAX`, `Notes`, `NOTES_MAX`, `NOTE_MAX_CHARS`, `cleanNotes`, `renderNotes`, `TURN_PROMPT_HEAD`, `TURN_PROMPT_TAIL`, `TURN_ANSWER_HEAD`, `TURN_ANSWER_TAIL`, `STORY_PROMPT_HEAD`, `STORY_PROMPT_TAIL`, `STORY_ADDED_HEAD`, `STORY_ADDED_TAIL`, `STORY_ANSWER_HEAD`, `STORY_ANSWER_TAIL`, `STORY_COMPACTION_HEAD`, `STORY_COMPACTION_TAIL`, `STORY_DID_STEPS`, `didLine`, `LINES_PER_TURN_MAX`, `COMPACTION`, `CHAT_TURNS_TO_READ_KEY_PREFIX`, `CHAT_TURNS_TO_READ_WRITE_DEADLINE_MS`, `CHAT_TURNS_TO_READ_WRITE_TRIES`, `CHAT_TURNS_TO_READ_RETRY_MS`, `Exchange`, `Block`, `Stored`, `storeKey`, `keepText`, `ends`, `cleanPrompt`, `cleanAnswer`, `addTurn`, `addCompaction`, `memoryStats`, `addExchange`, `render`, `chatTurnsToReadOf` |
| [`src/chatFolder.ts`](../../plugins/buddy/src/chatFolder.ts) | `BUDDY_FOLDER`, `MEMORY_FILE`, `projectsDir`, `projectSlug`, `isSessionId`, `transcriptPath`, `buddyFolder` |
| [`src/did.ts`](../../plugins/buddy/src/did.ts) | `DID_MAX`, `DID_HEAD`, `DID_TEXT_CAP`, `DID_FILES_MAX`, `FAIL_REASON_CAP`, `DID_LINE_CAP`, `SHORT_COMMAND_CAP`, `Action`, `FileVerb`, `Failure`, `redact`, `denialReason`, `failureReason`, `actionOf`, `didOf` |
| [`src/stats.ts`](../../plugins/buddy/src/stats.ts) | `TOOL_NAMES_MAX`, `HOT_EDITS`, `LIMIT_SAID_PERCENT`, `Tokens`, `TurnStats`, `Tally`, `UsageReading`, `usageReadingOf`, `CountedCall`, `openTally`, `countStep`, `countAgentRun`, `countToolCall`, `changedLines`, `SHELL_CANDIDATES_MAX`, `SHELL_FILE_MAX_BYTES`, `ShellChange`, `shellTargets`, `fileLineDelta`, `shellChanges`, `countShellChanges`, `closeTally`, `count`, `span`, `dollars`, `renderStats`, `statsBrief`, `turnStatsOf` |
| [`src/chain.ts`](../../plugins/buddy/src/chain.ts) | `chained`, `newChain`, `latestWrites`, `LinkOutcome` |
| [`src/prompts.ts`](../../plugins/buddy/src/prompts.ts) | `MEMORY_LINE`, `parseTurnReply`, `memoryRule`, `oneLineSystem`, `questionPrompt`, `JUST_ENDED`, `turnPrompt`, `Turn` |
| [`src/options.ts`](../../plugins/buddy/src/options.ts) | `resolveOptions`, `DEFAULTS` |
| [`hooks/buddy.tsx`](../../plugins/buddy/hooks/buddy.tsx) | `chatFolderFor`, `chatTurnsToReadFor`, `loadMemory`, `chainChatTurnsToRead`, `changeChatTurnsToRead`, `onToolCall`, `rememberTurn`, `rememberCompaction`, `rememberExchange`, `rememberNotes`, `completeRecorded`, `readChatTurnsToRead`, `heard`, `chatTurnsToReadFailed`, `ask`, `turnCall`, `onTurnComplete`, `onTurnStart`, `onTurnStepped`, `onTurnEnd`, `readUsage`, `turnStats` |
| [`scripts/audit.mjs`](../../scripts/audit.mjs) | `npm run audit`: the `call.cost` records totalled |
| [`plugin.json`](../../plugins/buddy/.claude-plugin/plugin.json) | `userConfig`: `chatTurnsToRead` |

## How it's tested

- Unit: [`tests/chatTurnsToRead.test.ts`](../../tests/chatTurnsToRead.test.ts): the window of turns and every exchange leaving with its turn, the turnless first block, filing under a turn and dropping one whose turn is gone, per-character exchanges kept whole and canned lines capped, the cut on turns, a compaction filed and rendered, the memory's stats, a prompt's markup and an answer's markdown dropped, what a turn did kept, the render, a malformed record said. [`tests/chatFolder.test.ts`](../../tests/chatFolder.test.ts): the projects folder, a project's folder name, the buddy folder beside the transcript, a session id that cannot name a folder. [`tests/prompts.test.ts`](../../tests/prompts.test.ts) covers the memory rule and where the block goes; [`tests/options.test.ts`](../../tests/options.test.ts) the option.
- Unit, the notes: stored notes cleaned and read back, a malformed one dropped and counted, at most 8, overflow by kind, leading what the character remembers; hooks: a reply's `MEMORY:` lines kept in `memory.json`, said in the drawer when they change, leading the next call and every question, kept by a reply without them, forgotten by `MEMORY: NONE`.
- Unit, the story form: [`tests/chatTurnsToRead.test.ts`](../../tests/chatTurnsToRead.test.ts): a timeline rendered equal to the benched reference's story form of the same timeline ([`tests/fixtures/story-form.txt`](../../tests/fixtures/story-form.txt)), the last turn as before, an older turn's prompt, added line and answer cut, its numbers only as failed calls (none for a failed test run), its exchanges and canned lines whole, a compaction cut when not last and whole when last, `didLine` with null and with a number. Hooks: a turn whose prompt the ledger lost filed with the transcript's last prompt, none there left `(not seen)` and logged, a failed read logged as a failure.
- Unit: [`tests/did.test.ts`](../../tests/did.test.ts): a step per tool, bookkeeping dropped, files gathered under their verb, the caps.
- Unit, the numbers: [`tests/stats.test.ts`](../../tests/stats.test.ts): every counter (calls by tool, failed, denied, reruns, files once each, the hot file, the changed lines, tests, commits and pushes past git's options and never in a quoted string, web reads, requests and stops, subagent runs and tokens), the cost, context and limits from the usage readings, the line with every group and the model said only on change, the drawer's brief, the short formats, a stored one read back and a malformed one refused; [`tests/chatTurnsToRead.test.ts`](../../tests/chatTurnsToRead.test.ts): kept with the turn, read back, said under what Claude did, a malformed one dropping its turn; [`tests/feed.test.ts`](../../tests/feed.test.ts): on the turn's row, and drawn back from the memory. Hooks: a turn's requests, calls, subagent run, tokens and the session's usage filed in `memory.json`, read under what Claude did by the end-of-turn call that points to it, shown on the drawer's row, and a subagent running after the turn counted toward none; a malformed usage said once, a hung one holding the turn 2 s at most, each filing the turn without the cost.
- Hooks: a turn is remembered with what it did and never a tool's output, a subagent's steps left out; a question sees the last 4 turns and is told its reach; the fifth turn pushes out the first together with what was said after it; a question asked during a turn is filed under the turn before it; a headless session files no turn; a resumed session's question carries its stored turns; `/clear` and a resume start from another session's memory; a memory that cannot be saved is said in the next reply; a refused write is made again and lands, and is not once the next turn started; a compaction's summary reaches the next call, a precomputed or subagent one never; every call logs `call.cost`; the memory and the round files land in the chat's folder, also when its project folder is named otherwise; a memory kept in the store moves into the file and leaves the store; a reopened chat draws its memory into the drawer at once, the buddy hidden or not.
- Live: the (j) rows ask `/buddy remember the word pineapple`, then `/buddy what word did I ask you to remember?`, expect `pineapple` in the answer, and read this chat's `memory.json`, with no `thinking` filler in it. The configuration proof's S3 runs `chatTurnsToRead: 1`: the file holds only the last turn, and a question about the turn before it is answered as out of memory.
