# Memory

The short memory lets the buddy remember what was just said: ask it to remember a word, and the next question gets the word back.
It keeps the last few exchanges with each character in each session and puts them in front of every question and quip, at no extra model call.

## What it remembers

The memory is a ring of the last N exchanges, oldest first, N being the `memory` option, which counts exchanges, not lines or tokens: an exchange is a `/buddy` question with its answer (or the question alone if it got none), or one line the buddy said.

| Exchange | Holds |
| --- | --- |
| `question` | a `/buddy` question with its answer, or the question alone if it got none: its call failed, or another character was drawn by the time the answer came, so it was dropped |
| `line` | a canned line the bubble showed on its own |
| `quip` | a quip the bubble showed |

A question and its answer fill one slot, not two.
The `thinking` filler is not an exchange, and a line said while the buddy is hidden was never shown, so it is dropped.
A line joins only once the band has drawn in the session: a headless `claude -p` or SDK session never draws it, so none of its lines was shown; before the first draw only the newest line is held, for when the band first shows it (`heard`).
Each text is folded to one line of at most 160 characters (`capText`).
When the ring is full, a new exchange pushes the oldest out (`remember`).

## Where it is kept

Each session has one record in `$.store`, under `memory:{session id}` (`storeKey`): when it was last written, and one ring per character id (`Book`).

- **Per session.** The adapter asks `$.session.id()` before every read and loads the record again when the id changes: a new session, a `/clear`, a reload. A new session starts with an empty memory.
- **Per character.** A character recalls only its own ring (`recall`), so a switched character never claims another's words, and switching back finds its ring again.
- **In the store.** `$.store` survives `/reload`, so a plugin reload mid-session keeps the thread.
- **Bounded.** The store keeps the 20 most recently written sessions (`MEMORY_SESSIONS`); older records are deleted (`staleKeys`).

Every read and write goes through one chain, in the order made, so an answer is saved before the next question reads the ring.

## How it reaches the model

`render` turns the ring into a short block, and the prompt says what it is:

```text
Recently (oldest first):
You: remember the word pineapple
{name}: Pineapple, noted.
That is what you and the user said to each other lately; you may refer back to it.
```

| Call | Where the block goes |
| --- | --- |
| a question, forked | the fork's one user message, between the persona and the question (`forkPrompt`) |
| a question, completed (the default) | the prompt, before the chat's last 3 turns and the question (`questionPrompt`) |
| the end-of-turn call | the prompt, before the chat's last 3 turns and the turn's summary (`turnPrompt`) |

The block is read once, when the question is asked, so it holds what came before the question; the question joins the ring with its answer.
No call is added: the memory rides on calls buddy makes anyway, and the one-line rule and token caps of [Voice](./voice.md) apply unchanged.

## The option

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `memory` | number | `6` | how many recent exchanges the buddy remembers, counting exchanges, not lines or tokens; `0` is off; at most `30` |

`0` records nothing and adds nothing to any prompt.
A value above 30 remembers 30 and says so: `option memory capped: {n} is above 30; remembering 30`.
A value that is not a whole number of zero or more is ignored by name and remembers 6.
Both lines reach the log at session start, the first greeting's bubble once, and `/buddy help`, as every option's error does.

## Errors

A memory that cannot be read, saved or pruned never disappears in silence.
The failure is logged, and the next question's reply carries it: `Asked {name}. (Its memory: {what} failed: {why})`.
A stored record that is malformed keeps what still reads and says how many exchanges it dropped (`bookOf`); nothing stored is an empty memory, not an error.

## Decisions

- **Recent exchanges in the prompt.** Rejected: a model-written summary of the conversation. A summary costs one more call per exchange; a ring costs nothing to keep and a few hundred tokens to send.
- **Every call carries it, the fork too.** Rejected: relying on the fork's view of the chat. A `/buddy` answer is drawn only in the bubble and never lands in the main transcript, where the chat holds only the command and its `Asked {name}.` reply; so without the memory even a fork cannot see what the buddy said. `complete` mode and the end-of-turn call see only the last prompt and answer (`lastExchange`), never the chat.
- **A question and its answer in one slot.** Rejected: one slot per message. N then means N exchanges, and an answer never outlives its question.
- **Kept in `$.store`.** Rejected: plugin memory only. A `/reload` would forget the thread mid-conversation.
- **Per session and per character.** Rejected: one global ring. A new session's buddy would recall another chat, and a switched character would quote another's words as its own.
- **Its own lines count.** Rejected: remembering questions and answers only. "What did you just say?" deserves an answer, and a quip is part of the thread.
- **A small default, a hard cap, and pruning.** Rejected: unbounded memory. Every exchange is sent with every call, and the store should not grow with every session ever held.

## Where it lives

| File | Symbols |
| --- | --- |
| [`src/memory.ts`](../../plugins/buddy/src/memory.ts) | `MEMORY_DEFAULT`, `MEMORY_MAX`, `MEMORY_TEXT_CAP`, `MEMORY_SESSIONS`, `MEMORY_KEY_PREFIX`, `Exchange`, `Book`, `Stored`, `storeKey`, `capText`, `remember`, `record`, `recall`, `render`, `bookOf`, `staleKeys` |
| [`src/prompts.ts`](../../plugins/buddy/src/prompts.ts) | `forkPrompt`, `questionPrompt`, `recentTurns`, `turnPrompt` |
| [`src/options.ts`](../../plugins/buddy/src/options.ts) | `resolveOptions`, `DEFAULTS` |
| [`hooks/buddy.tsx`](../../plugins/buddy/hooks/buddy.tsx) | `bookFor`, `pruneMemory`, `keep`, `recollect`, `heard`, `memoryFailed`, `ask`, `quip` |
| [`plugin.json`](../../plugins/buddy/.claude-plugin/plugin.json) | `userConfig`: `memory` |

## How it's tested

- Unit: [`tests/memory.test.ts`](../../tests/memory.test.ts): the ring and its cap, a question with its answer as one slot, `0` keeping nothing, the 160-character fold, the render, one ring per character, a key per session, a malformed record said, old sessions pruned. [`tests/options.test.ts`](../../tests/options.test.ts) covers the option.
- Hooks: the fresh-session completion carries the memory, and a memory that cannot be saved is said in the next reply.
- Live: the (j) rows ask `/buddy remember the word pineapple`, then `/buddy what word did I ask you to remember?`, expect `pineapple` in the answer, and read the plugin's store for this session's record, with no `thinking` filler in it.
