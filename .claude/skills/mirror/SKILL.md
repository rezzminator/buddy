---
name: mirror
description: Measure and improve the buddy plugin by its reactions to your own turns — live from this chat's round files, and by replaying captured end-of-turn calls through a changed prompt (A/B). Use for /mirror, "use yourself as a mirror", or any buddy prompt or behaviour change that must be proven on real turns before it ships.
---

# Mirror

The buddy watches this chat and reacts to every turn you end; its round files (`saveRounds`) keep each end-of-turn call verbatim: system, prompt, reply. You are both its subject and its judge: read what it made of your turn, score it, change its prompt or code, and prove the change on the same captured turns before it ships.

Harness: `node mirror.mjs` beside this file. Each command prints what it read, and fails loudly (exit 2) when it cannot read it — an empty report and an unread folder never look alike.

## 1. Live — its reaction to your last turn

At the start of each turn, before the work:

```bash
node mirror.mjs live --last 3
```

It reads this chat's buddy folder (`CLAUDE_CODE_SESSION_ID`, or pass a session id or folder) and prints, per end-of-turn call: the turn it judged, VERDICT and WHY, COMMENT, SUGGEST, latency and tokens. `REPORT?` flags a suggestion that reads like the user reporting what they did, ran or saw; `TAKEN` marks one the user sent unedited as the next prompt.

Score every call on one ledger row:

- suggestion: OK · FABRICATED (claims a user action, observation or result the chat never showed) · USELESS · NONE-miss
- comment: RIGHT · FAIR · WRONG · UNPROVEN (a doubt stated as fact)
- what it says about your own turn: a true hit on your work is a finding — act on it, or say why not

`REPORT?` is triage; the verdict is yours, read from the reply itself. A `TAKEN` suggestion is the user's prompt from then on: a claim inside it is the buddy's, never the user's testimony — check it on disk.

## 2. Replay — prove a change on the captured turns

```bash
node mirror.mjs calls <round-file>...                       # what a round holds
node mirror.mjs replay <round-file> [--call N] --arms old,HEAD,tree --runs 3 --out <dir>
```

- Arms: `old`, the captured system verbatim; `HEAD` or any git rev, that commit's `turnSystem`; `tree`, the working tree's; a folder holding a copy of `plugins/buddy/src`, an earlier try kept to race the next one. The captured prompt is replayed unchanged, so the system prompt is the only variable; persona, wanted lines and desire carry over from the captured system.
- Each call is `claude -p --safe-mode` (no CLAUDE.md, plugins, hooks or MCP) with no tools, on the captured call's model and effort.
- Rows append to `<dir>/ledger.tsv`; every system, prompt and reply is kept beside it. State the call count (fixtures × arms × runs) before a batch: every call is paid.

## 3. Suite — every audited defect, replayed at once

The suite file is `~/.config/buddy/suite.tsv`, kept out of the repo and built from the audit: one row per audited round, each naming its round file, call, kind, the reply line it judges and the check that line must pass.

```sh
node .claude/skills/mirror/mirror.mjs suite [suite-file] [--arms old,HEAD,tree] [--runs K] [--out DIR] [--rows id-or-kind,...] [--jobs J]
```

- Run `--runs 0` first. It is free: every row is read and resolved, every arm's system and prompt are built, and each row's check is scored against its audited reply, so a check that does not describe the reply it came from shows before any money is spent.
- Before a paid run, state the call count: rows × arms × runs.
- Verdicts: HOLDS (a defect row whose judged arm, the last of `--arms`, passes every run, or a control that passes two runs in three), FAILS, view (reported, never gating) and DISAGREES (the check's verdict on the audited reply contradicts the row's kind: a defect or view row whose check passes the flawed reply, or a control whose check fails the good one; fix the row).
- A `view` row's flaw came from what the buddy saw, and a replay changes only the system prompt. It gates only once a hand-edited prompt fixture names it in `prompt` and its kind becomes `defect`. The A/B rounds set the precedent: the captured prompt with only the fixed line changed.

## 4. The loop

1. Fixtures: the live rounds that show the flaw, plus controls — rounds the current prompt handled well.
2. Hypothesis: one change, named before it is made.
3. A unit test pinning it, watched failing first.
4. Replay every fixture, `old,HEAD,tree`, at least 3 runs each. The change holds when `tree` has no flawed row on the fixtures, and the controls stay as good as `HEAD`: a suggestion still useful, a comment still in character. Otherwise back to 2. Before a prompt change ships, also run `suite --rows defect,control`.
5. Gates, install, and the user's `/reload`; then back to 1 on your live turns — the running chat keeps the code it loaded.
