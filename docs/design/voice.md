# Voice

buddy talks through a model in exactly two ways: it answers a question you ask with `/buddy`; and at the end of every answered turn one call writes its reaction to the turn (quips) and your next prompt (suggestions), both on by default.
Everything else it says is a canned line ([Characters](./characters.md)), and every model reply is held to one bubble line and a few tokens.

## Questions

`/buddy` followed by anything that is not a command is a question.
A command word counts only when it stands alone, so `/buddy reload the page` is a question, not `/buddy reload` (`parseCommand`).
`/buddy list` alone, or `/buddy use` with one word after it, is no question either: switching moved to the menu, and the reply is `Switching characters moved to /buddy-personality.`, with no model call.

```mermaid
flowchart TD
  Q["/buddy question"] --> Off{"hidden, or a question still waiting?"}
  Off -->|yes| Say["the reply says why, a refusal in the bubble too; no model call"]
  Off -->|no| T["thinking pose and line; reply: Asked name."]
  T --> C["$.model.complete on quipModel"]
  C --> L["oneLine of the reply"]
  L --> A{"a line?"}
  A -->|yes| Ans["the answer, 15 s"]
  A -->|"no: an error, or none in 90 s"| Lost["name couldn't answer: reason, 15 s"]
```

`$.model.complete` runs on `quipModel` at `effort`, with the persona, the character rule and the one-line rule as the system prompt (`oneLineSystem`) and the buddy's recent exchanges ([Memory](./memory.md)), the chat's last `contextTurns` turns (`recentTurns`) and the question as the prompt (`questionPrompt`), capped at 100 output tokens (`QUESTION_MAX_TOKENS`).
It does not see the rest of the chat, and it answers at once, even while the main turn runs.

The command replies `Asked {name}.` at once, and the model call runs after the handler returns; the `thinking` line holds the bubble meanwhile, until the answer, the failure or the deadline arrives.
A question has 90 seconds (`COMPLETE_DEADLINE_MS`).
The answer replaces the `thinking` line for 15 seconds.
A call that fails or answers nothing, or a question past its deadline (`no answer in 90 s`), shows `{name} couldn't answer: {reason}` with the `oops` pose, and the log names the reason (`noAnswerReason`): `api-error` carries its status (`api-error 529`), `empty-reply` and `aborted` read as themselves.
The deadline ends the question in the bubble, not the call: the engine offers no way to cancel one already sent, so it runs to its end and may still bill.
The answer belongs to the character asked: when another is drawn by the time it arrives, the answer or the failure is dropped, never said by the new one, and the log says `{name}'s answer was dropped: {drawn} is drawn now`.
One question waits at a time: one asked meanwhile is refused out loud, in the reply and the bubble (`{name} is still thinking about your last question`).
An answer, a failure or a refusal holds the bubble for its time; tool-call reactions and other unasked lines wait.

## The end-of-turn call

Quips and suggestions are on by default (`quips: true`, `suggestions: true`); each turns off alone.
At the end of every turn (`turn.complete`), the brain resets the turn's tally and returns it with whether the line is due (`endTurn`): quips on, and at least `quipCooldownSec` seconds (0 by default: every turn) of brain time since the last line.
The call is made only for an answered turn of the main loop (`reason: 'answer'`, not aborted, no `agentId`), tool use or not, while the buddy is shown, when the line is due or suggestions are on.
It is one `$.model.complete` on `quipModel` at `effort`, at most 120 output tokens (`TURN_MAX_TOKENS`), within 30 seconds (`TURN_DEADLINE_MS`): about 3 seconds.
A call that cannot answer (an API error, an empty reply, the deadline) fails the line and gives the suggestion up to the engine's own; a suggestion arriving after the next turn asked for its own is stale (`suggestGen`) and never shown.
`parseTurnReply` reads the reply, and `quip.outcome` carries the call's usage (`usageFields`: `inTok`, `cacheRead`, `cacheWrite`, `outTok`, `cachePct`) and `ms`, from the turn's end to the reply, as `suggest.outcome` does.
The system prompt is the persona, the character rule when a `LINE:` is wanted, then the tagged lines wanted (`turnSystem`): `LINE:` the buddy's own reaction in character, at most 20 words; `NEXT:` the prompt the user is most likely to send Claude next, in the user's own words, at most 15 words, `NEXT: NONE` only when the work is plainly finished.
The prompt is the memory, the chat's recent turns (`recentTurns`: the last `contextTurns` answered main-thread turns, `TURN_WINDOW` = 3 by default, 1 to `TURN_WINDOW_MAX` = 10, oldest first, each the end of the user's prompt from `prompt.submit`, capped at 1500 characters, and the end of Claude's answer, capped at 3000), then the turn's tally (`turnPrompt`):

```text
The main chat's last turn, oldest first:

The user asked Claude:
run the tests

Claude answered:
All 42 pass.

Tools used: Read x3, Bash. Failures: 1. Last shell command: npm test.
```

`parseTurnReply` reads the `LINE:` and `NEXT:` lines in any case, bullets tolerated; an untagged reply is the line alone.

### The line

The line goes through `oneLine` and shows with `yay` when the turn had no failures, `oops` when it had some.
A line, or its failure, that arrives while a `/buddy` answer, a failure or the `thinking` line still holds the bubble (`holdsAnswer`) is not said and not remembered; the log records it as `held` (`quip.outcome`).
A call that fails, times out or has no line fails the line as a question fails, in the bubble.

### The suggestion

The persona decides what to nudge toward; the words are never in character.
`NEXT:` goes through `suggestionText`, which strips wrapping quotes and collapses whitespace; `NONE`, an empty value or one past 160 characters (`SUGGESTION_MAX_CHARS`) proposes nothing.
The suggestion becomes the prompt box's dim suggestion through `$.prompt.suggest`; a late one is safe, since Claude Code refuses it once the box holds text or a turn runs.
A suggestion overtaken by the next turn's, or by `/buddy off`, is stale and never proposed.
While suggestions are on and the buddy is shown, the `prompt.suggest` hook holds back Claude Code's own guess (origin `suggestion`, `dropsHarnessSuggestion`), so it never covers the buddy's; a plugin's proposal, the buddy's or another's, always passes.
When the buddy gives up on a turn (timeout, no answer, `NONE`, an error), the held guess is proposed after all, and one arriving later passes: the box is never emptier than without the plugin.
Claude Code's own suggestions still cost their own call: turning them off saves paying for both.
The log records each outcome at info (`suggest.outcome`: shown, not-shown, none, failed, stale, harness-shown, harness-not-shown), and at debug only lengths, never the prompt or the suggestion.

## One line, few tokens

Every model reply must fit one bubble.
Three layers hold it there:

| Layer | What it does | Where |
| --- | --- | --- |
| The one-line rule | `Answer in ONE line, at most 25 words, in character. Do not use tools. Do not think out loud.`, in every question's system prompt | `ONE_LINE_RULE` |
| A token cap | 100 output tokens for a question, 120 for the end-of-turn call's two lines | `QUESTION_MAX_TOKENS`, `TURN_MAX_TOKENS` |
| The trim | the first non-empty line, quotes and backticks stripped, cut to 240 characters with `...` | `oneLine` |

The rule exists because a model's reply, without it, spent 813 output tokens on what should have been one line.
Each clause closes one way a working chat's model spends tokens: length, tools, thinking out loud.
The rule makes the model aim for one line; the cap and the trim catch the rest.

## The quip model

`quipModel` (default `opus`) is an alias such as `opus`, `sonnet` or `haiku`, or a full model id; `effort` (default `low`; low, medium, high, xhigh or max) is how hard it thinks on each call, passed to every `$.model.complete` the buddy makes.
Either can be `inherit`, resolved before every call by `callSettings`: `quipModel: inherit` is the main chat's model (`$.session.model()`, `resolveModel`), `opus` when it cannot be read; `effort: inherit` is the main chat's level where Claude Code exposes it, the `CLAUDE_EFFORT` variable (`resolveEffort`), and otherwise no effort is sent, so the model's default applies. A failed read is logged once and falls back; each call's resolved model and effort are logged at debug (`turn.settings`, `ask.settings`), and `session.start` logs the options as set, `inherit` included.
It serves both calls: the end-of-turn call and every question.
A question it answers carries the chat's last `contextTurns` turns (`recentTurns`) before the question, since a completion cannot see the chat.
Like every option, it is resolved once at load by `resolveOptions`: a value of the wrong type is ignored by name (`option quipModel ignored: not a string`), logged at session start, said once in the first greeting's bubble, and listed under `/buddy help`.

## Decisions

- **A question answered by `quipModel` on the last turns.** Rejected: a completion blind to the chat, which answers nothing useful about the work. The chat's last `contextTurns` turns tell it where the chat stands, and it answers in about 3 seconds, even mid-turn.
- **A 90-second safety net.** Rejected: no deadline. The call cannot be cancelled once sent; the deadline only guarantees the bubble ends.
- **The rule in the prompt, and a cap, and a trim.** Rejected: a token cap alone, which cuts a rambling answer mid-sentence. The rule shapes the answer; the cap bounds the cost; the trim guarantees one line.
- **Reply at once, answer later.** Rejected: holding the command until the model answers. The prompt stays free, and the bubble shows the buddy thinking.
- **One call per turn for the line and the suggestion, on by default.** Rejected: a separate call for the suggestion beside the line's. One call reads the turn once and bounds its cost with one token cap; and a buddy that spoke only after tool use, past a cooldown, spoke too little.
- **Every call sees the ends of the last `contextTurns` turns, not the whole chat.** Rejected: a summary alone, which cannot tell what the user will ask next; and replaying the main chat's whole request, which sees everything but in a long session answers after about a minute, cannot be cancelled, takes no token cap, and mid-turn would only continue the main turn. A companion's aside has to be fast, so both calls run on `quipModel`, with no option to choose another path.
- **Suggestions in the user's words.** Rejected: a suggestion in character, which would have to be rewritten before sending, which defeats Tab.
- **A failure shows in the bubble.** Rejected: staying silent. An empty bubble would read as "it did not hear me".
- **Command words only when alone.** Rejected: matching the first word. `/buddy reload the page` is a question.

## Where it lives

| File | Symbols |
| --- | --- |
| [`src/prompts.ts`](../../plugins/buddy/src/prompts.ts) | `ONE_LINE_RULE`, `QUESTION_MAX_TOKENS`, `TURN_MAX_TOKENS`, `TURN_DEADLINE_MS`, `oneLineSystem`, `questionPrompt`, `recentTurns`, `pushTurn`, `TURN_WINDOW`, `TURN_WINDOW_MAX`, `CHARACTER_RULE`, `turnSystem`, `turnPrompt`, `parseTurnReply`, `oneLine`, `lostThread`, `stillThinking`, `TurnSummary`, `suggestionText`, `SUGGESTION_MAX_CHARS` |
| [`src/suggest.ts`](../../plugins/buddy/src/suggest.ts) | `dropsHarnessSuggestion` |
| [`src/brain.ts`](../../plugins/buddy/src/brain.ts) | `beginQuestion`, `endQuestion`, `answer`, `failAnswer`, `refuseQuestion`, `holdsAnswer`, `endTurn`, `react`, `COMPLETE_DEADLINE_MS`, `deadlineReason`, `noAnswerReason` |
| [`src/command.ts`](../../plugins/buddy/src/command.ts) | `parseCommand`, `USAGE` |
| [`src/options.ts`](../../plugins/buddy/src/options.ts) | `resolveOptions`, `DEFAULTS`, `resolveModel`, `resolveEffort`, `INHERIT` |
| [`hooks/buddy.tsx`](../../plugins/buddy/hooks/buddy.tsx) | `ask`, `callSettings`, `onTurnComplete`, `turnCall`, `sayTurnLine`, `proposeTurnNext`, `giveUpSuggestion`, `runCommand`, the `prompt.submit` and `prompt.suggest` hooks |
| [`plugin.json`](../../plugins/buddy/.claude-plugin/plugin.json) | `userConfig`: `contextTurns`, `quips`, `quipModel`, `effort`, `quipCooldownSec`, `suggestions` |

## How it's tested

- Unit: [`tests/prompts.test.ts`](../../tests/prompts.test.ts) (the completion and the chat's recent turns, the character rule, the end-of-turn system, prompt and reply, the trim), [`tests/command.test.ts`](../../tests/command.test.ts), [`tests/options.test.ts`](../../tests/options.test.ts), the end-of-turn and question cases of [`tests/brain.test.ts`](../../tests/brain.test.ts) (the summary at every end, the line due with quips on and past the cooldown, the question deadline and failure reasons), [`tests/suggest.test.ts`](../../tests/suggest.test.ts) (which suggestion is dropped).
- Hooks, the end-of-turn call (on by default): one answered turn makes one completion, its line in the band and its suggestion proposed as a plugin's; Claude Code's own is held during the call and shown on `NEXT: NONE`; an aborted or subagent turn makes no call; a held `/buddy` answer keeps the bubble while the suggestion still goes out.
- Hooks, questions: a question is one completion on `quipModel` at `effort` with the persona, the rule and the last `contextTurns` turns, whether the main turn is idle or running (the band working, or a tool ran); an `api-error` says its status, an `empty-reply` itself; past 90 s the bubble says `no answer in 90 s` and the next question is taken.
- Live: row (d) asks before the first reply, row (f) after one, row (k) mid-turn (answered before the turn ends); row (l) finds the answered outcome in the log.
- The end-of-turn call is not checked by the live proof; the unit and hook tests are its proof.
