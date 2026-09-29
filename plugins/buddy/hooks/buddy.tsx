import { atom, read, update } from 'claude-code';
import type { RenderElement, EngineInterface, ModelCompleteResult, On, PluginOptions, PromptSubmitInput, PromptSubmitResult, Register, Timer, ToolCallInput, ToolCallResult, TurnCompleteInput, TurnStartInput, TurnStepInput, TurnStepResult } from 'claude-code';
import {
  COMPLETE_DEADLINE_MS, ERROR_MS, answer, beginQuestion, createBrain, deadlineReason, endQuestion, noAnswerReason, refuseQuestion, endTurn, failAnswer, farewell, greet, isMainLoop, observeBand, period, pet,
  currentPose, react, sceneOf, setCharacter, speak, tick, wake,
  type Brain,
} from '../src/brain.ts';
import { frameAt, type Character, type Pose } from '../src/character.ts';
import { DRAWER_KEYS, USAGE, parseCommand, type Action } from '../src/command.ts';
import { allItems, buildMenu, currentKeyOf, findItem, type Item, type Originals } from '../src/menu.ts';
import {
  CHAT_TURNS_TO_READ_RETRY_MS, CHAT_TURNS_TO_READ_WRITE_DEADLINE_MS, CHAT_TURNS_TO_READ_WRITE_TRIES, BUDDY_PROMPT, TAKEN_SUGGESTION, chatTurnsToReadOf, addCompaction, addExchange, addTurn, cleanPrompt, memoryStats, render, storeKey,
  type Block, type Exchange, type Notes, type Stored,
} from '../src/chatTurnsToRead.ts';
import { MEMORY_FILE, buddyFolder, isSessionId, projectSlug, projectsDir, transcriptPath } from '../src/chatFolder.ts';
import { actionOf, denialReason, didOf, failureReason, type Action as Step, type Failure } from '../src/did.ts';
import { answerSuggestions, feedOfMemory, isTaken, markNumbers, markRead, pruneToMemory, pushEntry, type FeedEntry, type NewEntry, type TurnEnding } from '../src/feed.ts';
import { drawDrawer, type DrawerView, type Elements, type MenuState } from './drawer.tsx';
import { callSection, capValue, eventLine, newRoundSlot, roundHead, toolLines, turnEndSection, type RoundCall } from '../src/rounds.ts';
import { Logger, notice, sumUsage, usageFields, type LogFields, type LogIO, type LogLevel } from '../src/log.ts';
import { within, type Sleep } from '../src/deadline.ts';
import { chained, latestWrites, newChain, type Chain, type LatestWrites } from '../src/chain.ts';
import { INHERIT, expandHome, logPath, observeEffort, resolveEffort, resolveModel, resolveOptions, type Effort, type ObservedEffort, type Options } from '../src/options.ts';
import {
  ASKED_PROMPT_MAX_CHARS, BUDDY_PROMPT_CONTEXT, isOwnPrompt, NO_PROMPTS, QUESTION_MAX_TOKENS, TAKEN_SUGGESTION_CONTEXT, TURN_DEADLINE_MS, TURN_MAX_TOKENS, deliverPrompts, endPromptTurn, lostTurnOf, startPromptTurn, endsConversation, isUserOrigin, oneLineSystem, originOf, parseAskReply, parseTurnReply, questionPrompt, requestTimeoutMs, retriesEmpty,
  skipReason, stillThinking, submitPrompt, turnMay, turnPrompt, turnSystem, type PromptLedger, type Turn, type TurnGate, type TurnReply, type TurnSummary, type TurnWants, type Verdict,
} from '../src/prompts.ts';
import { dropsHarnessSuggestion, heldSuggestionRelease, suggestNextPromptOutcome } from '../src/suggestNextPrompt.ts';
import { roll, type Roll, type Variant } from '../src/hatch.ts';
import {
  ORIGINAL_ID, VARIANTS, companionOf, identityOf, originalCharacter, savedOriginalOf,
  type SavedOriginal, type Soul,
} from '../src/original.ts';
import { BACKUP_LIMITS, backupCandidates, configSources, type ConfigSources, type Listed } from '../src/config-source.ts';
import { bashCommand, classifyToolCall, toolOutput } from '../src/reactions.ts';
import {
  SHELL_FILE_MAX_BYTES, SWEEP_DEPTH_MAX, SWEEP_FILES_MAX, SWEEP_READ_BYTES_MAX, SWEEP_SKIP_DIRS,
  closeTally, countAgentRun, countShellChanges, countStep, countToolCall, openTally, shellChanges, shellFolders, shellTargets, statsBrief, sweptChanges, sweptShellChange, usageReadingOf,
  type FileMark, type ShellChange, type Tally, type TurnStats, type UsageReading,
} from '../src/stats.ts';
import {
  choose, isCharacterFile, loadEntries, mergeRoster, startWarning, withEntry,
  type Entry, type LoadedFile, type Roster, type Source,
} from '../src/roster.ts';
import { BUBBLE_INK, TONE_COLOR, spriteColor, type Scene, type Tone } from '../src/scene.ts';
import { validateHats, validateSpecies, type HatArt, type SpeciesTemplate } from '../src/species.ts';

// The adapter: the only file touching `$`. Every decision lives in ../src/;
// this wires Claude Code's events to it, grouped by event, and draws the scene.

const COMMAND = 'buddy';
/** Every this many clock ticks a drawing session reads back `hidden`, which another session sharing the store may have set. */
const SHARED_TICKS = 15;
/** How often a hidden session, drawn, reads `hidden` back. */
const SHARED_MS = 3000;

/** How often the open drawer is drawn again: its sprite, its spinner, its rule of light. */
const DRAWER_MS = 500;
/** The feed the drawer draws (src/feed.ts): the host's for the session, so a reload keeps it. */
const FEED = atom({ plugin: 'buddy', key: 'feed' } as const, [] as FeedEntry[]);

/** One round file: when it opened, its turn's start (null before any turn this buddy saw), its timeline so far, its calls; its slot and session once first written; `dirty` when text is not on disk yet, `queued` while a write waits. */
type Round = { at: number; start: { turnId: string; prompt: string } | null; body: string; calls: number; path: string; session: string; dirty: boolean; queued: boolean };

/** The state whose round the log's tap writes into: set by register, so every record reaches the round timeline. */
let tapped: State | null = null;

type State = {
  options: Options;
  roster: Roster;
  b: Brain | null;
  storeChoice: string | undefined;
  /** The original companion's roster entry, once picked in the menu (or restored at a start). */
  original: Entry | null;
  /** The picked original's roll and soul, as saved: a restart draws it with no backup scan. */
  saved: SavedOriginal | undefined;
  /** Why characters/ or the customCharactersDir could not be listed: the menu says it in the group. */
  shippedError: string | undefined;
  customCharactersDirError: string | undefined;
  /** The drawer's personality tab, while it is built: the characters to pick from and the one the preview shows. */
  menu: MenuState | null;
  hidden: boolean;
  pets: number;
  timer: Timer | null;
  clockPeriod: number;
  lastKey: string;
  lastTickError: string;
  /** This session's chatTurnsToRead timeline as last loaded or written, and its file; loaded again when the session id changes (a start, a /clear, a resume, a reload). */
  chatTurnsToRead: { sessionId: string; path: string; blocks: Block[]; notes: Notes } | null;
  /** The buddy's folder in this session's chat folder, once its transcript was found there (chatFolderFor). */
  chatFolder: { sessionId: string; dir: string } | null;
  /** Every chatTurnsToRead read and write, one after another, in the order made. */
  chatTurnsToReadChain: Chain;
  /** The file writes of the chatTurnsToRead: one in flight per file, so a late one never lands over a newer one. */
  chatTurnsToReadWrites: LatestWrites<Stored>;
  /** The last chatTurnsToRead failure, said in the next /buddy question's reply; '' when none since. */
  chatTurnsToReadError: string;
  /** A chatTurnsToRead read or write was abandoned at its deadline and that was said: said again only after one lands. */
  chatTurnsToReadHangSaid: boolean;
  /** The /buddy question waiting for its answer, one at a time; null when none. */
  asking: { since: number } | null;
  /** A person is at the prompt (session.start's isInteractive): a -p run or the SDK makes no end-of-turn call, nobody sees it. */
  interactive: boolean;
  /** The band has drawn in this session: before that (a headless session, ever) no line was shown, so none is remembered. */
  bandSeen: boolean;
  /** Clock ticks since the start, and when `hidden` was last read back from the store. */
  ticks: number;
  sharedAt: number;
  /** Bumped by this session's /buddy off and on, before and after saving: a read of `hidden` begun before the latest is stale and dropped. */
  hiddenGen: number;
  /** Saves of `hidden` in flight: a read of it landing meanwhile may hold the value before the save, and is dropped. */
  hiddenSaves: number;
  /** Bumped at every main-loop turn's end, however it ended, and at /clear: a commentAfterEachTurn, verdict or suggestNextPrompt from an earlier turn's call is stale, never shown. */
  turnGen: number;
  /** The engine's own suggestion for this turn, held back while the buddy's end-of-turn call runs: shown if the buddy gives up. */
  harnessSuggestion: string | null;
  /** The buddy gave up on this turn's suggestNextPrompt: the engine's own suggestion passes. */
  suggestNextPromptGaveUp: boolean;
  /** A prompt of the user's entered since the buddy last prompted the main chat (promptToMainChat): at most one per prompt of the user's, never from the turn its own prompt began. */
  mainChatPromptArmed: boolean;
  /** The buddy's prompt to the main chat sent and not yet seen entering: how its own prompt.submit hook knows it when the engine gives no origin. */
  pendingMainChatPrompt: string | undefined;
  /** How many prompts of the user's have entered, and that count as each end-of-turn call began, by turn: a reply that comes back after the user prompted again never sends its prompt. */
  userPrompts: number;
  userPromptsAtCall: Map<string, number>;
  /** The buddy's own suggestion now dim in the prompt box; cleared by the user's next prompt, or by another suggestion shown. */
  shownSuggestion: string | null;
  /** The prompt of a suggestion taken unedited, as it entered: the turn it begins is filed as the buddy's words the user chose. */
  takenPrompt: string | null;
  /** What the user most deeply wants, as the last end-of-turn call named it: carried to the next one, forgotten at /clear. */
  desire: string | null;
  /** The turn (turnGen) whose verdict the bubble warned or screamed: its comment never covers it. */
  loudGen: number;
  /** The inherit read of the main chat's model failed once and was logged; a later failure falls back to opus in silence. */
  inheritFailed: Set<'model'>;
  /** The effort of the main chat's latest model request (turn.step), which effort inherit sends; undefined before its first. */
  mainEffort: ObservedEffort;
  /** The prompts given to the main chat (prompt.submit) and the main turns they started (turn.start), by id: an answered turn files its own into `turns`. */
  prompts: PromptLedger;
  /** The running main turn's id, from its turn.start to its turn.complete; undefined while none runs. */
  mainTurn: string | undefined;
  /** The running main turn's numbers as they come in (src/stats.ts), and the session's usage read as it began; null while none runs. */
  tally: { counts: Tally; before: Promise<UsageReading | null> } | null;
  /** When the last main turn of this conversation ended, for the next one's gap; undefined before the first, and after /clear or a resume. */
  lastMainEndAt: number | undefined;
  /** A read of the session's usage failed and that was said: later failures are logged, not said. */
  usageFailSaid: boolean;
  /** Bumped by every main turn's start: a memory write that failed is tried again only while it stays the same. */
  turnStarts: number;
  /** Bumped only by /clear or a resume: a /buddy question asked in an earlier conversation is dropped, never shown or remembered in this one. */
  conversation: number;
  /** The id of the latest answered main turn filed into the chatTurnsToRead: an exchange beginning now is filed under it. undefined before the first in this process, or after /clear or a resume: filed under the newest remembered. */
  lastTurnId: string | undefined;
  /** The options' warnings were said: once, in the first greeting's bubble. */
  warned: boolean;
  /** The round being written, from its turn's start to the next turn's start (Round); null before the first event, or after /clear or a resume. */
  round: Round | null;
  /** The bubble's text as the round timeline last said it: a new one is said once. */
  roundBubble: string | null;
  /** Every round write, in order: a call's section never lands before its round's head. */
  roundsChain: Promise<void>;
  /** A round file failed to write: said once, logged every time after. */
  roundsFailed: boolean;
  /** End-of-turn calls in flight: the drawer says the buddy is thinking. */
  calls: number;
  /** Every write of the drawer's feed, one after another, in the order made. */
  feedChain: Promise<void>;
  drawer: Drawer;
};

/** The drawer: open or not, its tab, its clock, the animation's tick, the ask box's unsent text, the band's id once drawn (to scroll it). */
type Drawer = { open: boolean; tab: 'talk' | 'personality'; timer: Timer | null; frame: number; draft: string; bandId: string };

type BandProps = { hasSurvey: boolean; isWorking: boolean; maxRows: number; bodyColumns: number };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The plugin's log (src/log.ts): records queue here; each `lg` writes them through that hook's `$`. */
const L = new Logger();

/** A notice in the transcript, naming the plugin (notice): Claude Code names it only in the debug log. */
function say($: EngineInterface, text: string): void {
  $.ui.log(notice(text));
}

/** The engine's clock's sleep, for a deadline (within). */
function sleeper($: EngineInterface): Sleep {
  return (ms, options) => $.clock.sleep(ms, options);
}

/** The log's file I/O through this hook's `$`. */
function logIO($: EngineInterface): LogIO {
  return {
    read: async (path) => {
      if (!(await $.fs.exists(path))) return undefined;
      const text = await $.fs.read(path);
      if (typeof text !== 'string') throw new Error(`${path} is not text`);
      return text;
    },
    exists: async (path) => $.fs.exists(path),
    write: async (path, text) => $.fs.write(path, text),
    fallback: (line) => say($, line),
  };
}

/** One record, written now through `$`; never throws. */
function lg($: EngineInterface, level: LogLevel, event: string, fields: LogFields = {}): void {
  L.log(level, event, fields);
  L.flush(logIO($)).catch(() => undefined);
  flushRound($);
}

/** A debug record at most once a second per event. */
function lgT($: EngineInterface, event: string, fields: LogFields = {}): void {
  L.throttled(event, fields);
  L.flush(logIO($)).catch(() => undefined);
  flushRound($);
}

/** Every failure: a transcript notice, and an error record with its context and stack. */
function log($: EngineInterface, what: string, error: unknown, fields: LogFields = {}): void {
  say($, `${what} failed: ${message(error)}`);
  L.error(what, error, fields);
  L.flush(logIO($)).catch(() => undefined);
  flushRound($);
}

/** A problem said in the transcript and the plugin log alike. */
function warn($: EngineInterface, event: string, text: string, fields: LogFields = {}): void {
  say($, text);
  lg($, 'info', event, { ...fields, text });
}

// ---- roster -------------------------------------------------------------

async function readDir($: EngineInterface, dir: string, source: Source): Promise<{ entries: Entry[]; error?: string }> {
  let listing;
  try {
    listing = await $.fs.list(dir);
  } catch (error) {
    return { entries: [], error: `couldn't read ${dir}: ${message(error)}` };
  }
  const files: LoadedFile[] = [];
  const names = listing.filter((f) => isCharacterFile(f.name, f.kind)).map((f) => f.name).sort();
  for (const name of names) {
    try {
      const text = await $.fs.read(`${dir}/${name}`);
      files.push(typeof text === 'string' ? { name, text } : { name, error: 'unreadable: not text' });
    } catch (error) {
      files.push({ name, error: `unreadable: ${message(error)}` });
    }
  }
  return { entries: loadEntries(files, source) };
}

async function loadRoster(st: State, $: EngineInterface): Promise<void> {
  const errors: string[] = [];
  const builtin = await readDir($, `${$.plugin.root}/characters`, 'builtin');
  if (builtin.error) errors.push(builtin.error);
  st.shippedError = builtin.error;
  st.customCharactersDirError = undefined;
  let user: Entry[] = [];
  if (st.options.customCharactersDir) {
    let dir = st.options.customCharactersDir;
    if (dir.startsWith('~')) dir = expandHome(dir, await $.env.get('HOME'));
    const mine = await readDir($, dir.replace(/\/+$/, ''), 'user');
    if (mine.error) errors.push(mine.error);
    st.customCharactersDirError = mine.error;
    user = mine.entries;
  }
  st.roster = mergeRoster(builtin.entries, user, errors);
  if (st.original) st.roster = withEntry(st.roster, st.original);
  // The merged roster's errors: the listing failures, and a file taking a reserved id.
  for (const e of st.roster.errors) warn($, 'roster.error', e);
  for (const e of st.roster.entries) if (e.error) warn($, 'roster.invalid', `character ${e.id} (${e.source}) is invalid: ${e.error}`, { id: e.id, source: e.source });
  lg($, 'info', 'roster.load', { characters: st.roster.entries.length, invalid: st.roster.entries.filter((e) => !e.character).length });
}

/** Draws the stored/option/default choice; a bad one draws the default (the duck) and says why. */
function applyChoice(st: State, $: EngineInterface): void {
  const choice = choose(st.roster, st.storeChoice, st.options.character);
  if (choice.error) warn($, 'character.choice', choice.error);
  // An ignored option is said once, in the first greeting's bubble, as a character or roster error is: never a silent revert.
  const warning = startWarning(choice.error, st.roster.errors, st.warned ? [] : st.options.errors);
  st.warned = true;
  if (!st.b) st.b = createBrain(choice.character, st.options.walkOverPromptBar, st.options.ambiguousCharacterWidth);
  st.b.pets = st.pets;
  setCharacter(st.b, choice.character, warning, Math.random);
  L.context.character = choice.character.id;
  lg($, 'info', 'character.switch', { id: choice.character.id, via: 'start' });
}

// ---- chatTurnsToRead ------------------------------------------------------

function chatTurnsToReadFailed(st: State, $: EngineInterface, what: string, error: unknown): void {
  log($, what, error, { area: 'chatTurnsToRead' });
  st.chatTurnsToReadError = `${what} failed: ${message(error)}`;
}

/**
 * The buddy's folder in session `sessionId`'s own chat folder, beside its
 * transcript (src/chatFolder.ts): the project folder named from the session's
 * root, then its working directory, then any holding the transcript. Before
 * the transcript is written (a new chat's start) it is the root's, and is
 * looked for again next time.
 */
async function chatFolderFor(st: State, $: EngineInterface, sessionId: string): Promise<string> {
  if (st.chatFolder?.sessionId === sessionId) return st.chatFolder.dir;
  if (!isSessionId(sessionId)) throw new Error(`the session id ${JSON.stringify(sessionId)} cannot name a folder`);
  const projects = projectsDir({ HOME: await $.env.get('HOME'), CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR') });
  if (projects === null) throw new Error('no chat folder: neither CLAUDE_CONFIG_DIR nor HOME is set');
  const named = [...new Set([projectSlug(await $.session.root()), projectSlug(await $.session.cwd())])];
  let slug: string | null = null;
  for (const n of named) if (slug === null && (await $.fs.exists(transcriptPath(projects, n, sessionId)))) slug = n;
  if (slug === null && (await $.fs.exists(projects))) {
    for (const e of await $.fs.list(projects)) {
      if (e.kind === 'file' || named.includes(e.name)) continue;
      if (await $.fs.exists(transcriptPath(projects, e.name, sessionId))) {
        slug = e.name;
        break;
      }
    }
  }
  const dir = buddyFolder(projects, slug ?? named[0]!, sessionId);
  if (slug !== null) st.chatFolder = { sessionId, dir };
  return dir;
}

/**
 * The session's chatTurnsToRead, by `$.session.id()` (the transcript's
 * name): a new id loads its own from memory.json in its chat folder; one
 * kept in the store before 1.0.0 is moved there. null when the link asking,
 * `live` false, was abandoned while the file answered: a later link may have
 * loaded and written since, and this stale read never replaces that.
 */
async function chatTurnsToReadFor(st: State, $: EngineInterface, live: () => boolean): Promise<{ sessionId: string; path: string; blocks: Block[]; notes: Notes } | null> {
  const sessionId = await $.session.id();
  if (st.chatTurnsToRead?.sessionId === sessionId) return st.chatTurnsToRead;
  const path = `${await chatFolderFor(st, $, sessionId)}/${MEMORY_FILE}`;
  let value: unknown;
  let legacy = false;
  let unreadable = '';
  if (await $.fs.exists(path)) {
    const text = (await $.fs.read(path)) as string;
    try {
      value = JSON.parse(text);
    } catch (error) {
      unreadable = `${path} is not JSON (${message(error)}); starting over`;
    }
  } else {
    value = await $.store.get(storeKey(sessionId));
    legacy = value !== undefined;
  }
  if (!live()) return null;
  const loaded = chatTurnsToReadOf(value);
  if (unreadable || loaded.error) chatTurnsToReadFailed(st, $, 'reading the chatTurnsToRead', new Error(unreadable || loaded.error));
  st.chatTurnsToRead = { sessionId, path, blocks: loaded.blocks, notes: loaded.notes };
  seedFeed(st, $, loaded.blocks);
  if (legacy) {
    // Moved into the chat's folder, then out of the store; a failed write leaves the store's copy for the next start.
    await st.chatTurnsToReadWrites(path, { at: Date.now(), blocks: loaded.blocks, notes: loaded.notes }, (p, v) => $.fs.write(p, JSON.stringify(v)));
    await $.store.delete(storeKey(sessionId));
    lg($, 'info', 'chatTurnsToRead.moved', { blocks: loaded.blocks.length });
  }
  return st.chatTurnsToRead;
}

/**
 * `link` run on the chatTurnsToRead chain (chained), abandoned `ms` after it
 * starts; `waitMs`, a reader's patience, drops it unrun if it is still queued
 * then. An abandonment is said once, the next only after a link lands; a link
 * dropped unrun is logged, never said failed. A link failing after it was
 * abandoned is logged, never said twice. Resolves true when the link landed.
 */
async function chainChatTurnsToRead(st: State, $: EngineInterface, what: string, ms: number, link: (live: () => boolean) => Promise<void>, waitMs?: number): Promise<boolean> {
  const o = await chained(
    sleeper($),
    st.chatTurnsToReadChain,
    async (live) => {
      try {
        await link(live);
      } catch (error) {
        if (live()) throw error;
        L.error(`${what} (abandoned)`, error, { area: 'chatTurnsToRead' });
        L.flush(logIO($)).catch(() => undefined);
      }
    },
    ms,
    waitMs,
  );
  switch (o.kind) {
    case 'landed':
      st.chatTurnsToReadHangSaid = false;
      return true;
    case 'failed':
      chatTurnsToReadFailed(st, $, what, o.error);
      return false;
    case 'abandoned':
      // In whole seconds: a question's deadline is what is left of its 90 s, a few ms short.
      if (!st.chatTurnsToReadHangSaid) chatTurnsToReadFailed(st, $, what, new Error(deadlineReason(Math.round(ms / 1000) * 1000)));
      st.chatTurnsToReadHangSaid = true;
      return false;
    case 'dropped':
      lg($, 'info', 'chatTurnsToRead.dropped', { what });
      return false;
  }
}

/**
 * `change` applied to the session's chatTurnsToRead, which is then saved;
 * `what` names it in a failure. One that failed or was abandoned is made
 * again CHAT_TURNS_TO_READ_RETRY_MS later, up to CHAT_TURNS_TO_READ_WRITE_TRIES
 * in all, while no main turn has started since and the conversation is the same; the change itself is
 * applied once, a later try only saving it.
 */
function changeChatTurnsToRead(st: State, $: EngineInterface, what: string, change: (m: { blocks: Block[]; notes: Notes }) => { blocks: Block[]; notes: Notes } | Promise<{ blocks: Block[]; notes: Notes }>): void {
  const turnStarts = st.turnStarts;
  const conversation = st.conversation;
  let applied = '';
  const attempt = (n: number): void => {
    chainChatTurnsToRead(st, $, what, CHAT_TURNS_TO_READ_WRITE_DEADLINE_MS, async (live) => {
      const m = await chatTurnsToReadFor(st, $, live);
      // Abandoned meanwhile: a later link may have written, and this one writes nothing.
      if (!m || !live()) return;
      if (applied !== m.sessionId) {
        const changed = await change({ blocks: m.blocks, notes: m.notes });
        // Abandoned while the change waited (a turn's numbers): a later try applies it again.
        if (!live()) return;
        m.blocks = changed.blocks;
        m.notes = changed.notes;
        applied = m.sessionId;
      }
      const stored: Stored = { at: Date.now(), blocks: m.blocks, notes: m.notes };
      await st.chatTurnsToReadWrites(m.path, stored, (p, v) => $.fs.write(p, JSON.stringify(v)));
    })
      .then((landed) => {
        if (landed) {
          if (n > 1) {
            lg($, 'info', 'chatTurnsToRead.retry', { what, try: n, outcome: 'landed' });
            // The failure said for an earlier try is healed: the next /buddy reply no longer says it.
            if (st.chatTurnsToReadError.startsWith(what)) st.chatTurnsToReadError = '';
          }
          return;
        }
        if (n >= CHAT_TURNS_TO_READ_WRITE_TRIES) return;
        $.clock.after(CHAT_TURNS_TO_READ_RETRY_MS, () => {
          if (st.turnStarts !== turnStarts || st.conversation !== conversation) {
            lg($, 'info', 'chatTurnsToRead.retry', { what, try: n + 1, outcome: 'skipped', reason: st.conversation !== conversation ? 'the conversation ended' : 'the next turn started' });
            return;
          }
          lg($, 'info', 'chatTurnsToRead.retry', { what, try: n + 1, outcome: 'trying' });
          attempt(n + 1);
        });
      })
      .catch((error) => log($, what, error));
  };
  attempt(1);
}

/**
 * The answered main turn `turnId` filed last into the chatTurnsToRead, with its
 * numbers once `stats` has them, the oldest dropped past the option's count of
 * turns. Reads made after it wait for it, the end-of-turn call's among them.
 */
function rememberTurn(st: State, $: EngineInterface, turnId: string, turn: Turn, stats: Promise<TurnStats | undefined>): void {
  const n = st.options.chatTurnsToRead;
  st.lastTurnId = turnId;
  changeChatTurnsToRead(st, $, 'remembering the turn', async (m) => {
    const s = await stats;
    return { ...m, blocks: addTurn(m.blocks, turnId, s ? { ...turn, stats: s } : turn, n, Date.now()) };
  });
}

/** How long one read of the session's usage may take: past it, the turn's numbers go without its cost, context and limits. */
const USAGE_DEADLINE_MS = 2_000;

/** How long a shell command's files may take to read, before it runs and after: past it the command goes unmeasured, never held up. */
const SHELL_MEASURE_MS = 300;

/** A tree sweep of the folders a shell command works in: each file's mark, the texts read ahead (before the command only), and whether no cap cut it short. */
type Sweep = { marks: Map<string, FileMark>; texts: Map<string, string>; whole: boolean };

/** A main-loop shell command's files as they were before it ran (the ones it names read, the folders it works in swept), and the tally their changes count into. */
type ShellBefore = { tally: Tally; files: Map<string, string | null>; folders: string[]; sweep: Sweep | null };

/** Where a folder really is, links followed (`/tmp` is `/private/tmp` on macOS); undefined when it cannot be resolved. */
async function realFolder($: EngineInterface, dir: string): Promise<string | undefined> {
  try {
    return (await $.fs.stat(dir, { resolve: true })).realPath;
  } catch {
    return undefined;
  }
}

/**
 * Each path's text, `null` when it does not exist (a file the command may
 * make), keyed by where it really is, so two spellings of one file are one; a
 * folder, a file past SHELL_FILE_MAX_BYTES or one that cannot be read is left
 * out, unmeasured. The text is held only to compare, never logged.
 */
async function readShellFiles($: EngineInterface, paths: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  await Promise.all(
    paths.map(async (p) => {
      try {
        if (!(await $.fs.exists(p))) {
          const cut = p.lastIndexOf('/');
          const real = await realFolder($, p.slice(0, cut) || '/');
          out.set(real ? `${real}/${p.slice(cut + 1)}` : p, null);
          return;
        }
        const s = await $.fs.stat(p, { resolve: true });
        if (s.kind !== 'file' || s.size > SHELL_FILE_MAX_BYTES) return;
        out.set(s.realPath ?? p, await $.fs.read(p));
      } catch (error) {
        lgT($, 'shell.measure', { outcome: 'unreadable', reason: message(error) });
      }
    }),
  );
  return out;
}

/** A file's text for counting its lines; undefined when it is past SHELL_FILE_MAX_BYTES, holds a NUL (a binary), or cannot be read. */
async function readText($: EngineInterface, path: string, size?: number): Promise<string | undefined> {
  try {
    if ((size ?? (await $.fs.stat(path)).size) > SHELL_FILE_MAX_BYTES) return undefined;
    const text = await $.fs.read(path);
    return text.includes('\u0000') ? undefined : text;
  } catch (error) {
    lgT($, 'shell.sweep', { outcome: 'unreadable', reason: message(error) });
    return undefined;
  }
}

/**
 * The files under `folders`, nearest first: dot-folders and SWEEP_SKIP_DIRS
 * left out, at most SWEEP_FILES_MAX files SWEEP_DEPTH_MAX folders deep, each
 * marked by its size and modification time; with `readAhead`, the smallest
 * text files read as well, SWEEP_READ_BYTES_MAX in all. A folder not there
 * yet holds nothing; one that cannot be listed is logged and makes the sweep
 * not whole.
 */
async function sweepFolders($: EngineInterface, folders: readonly string[], readAhead: boolean): Promise<Sweep> {
  const marks = new Map<string, FileMark>();
  const texts = new Map<string, string>();
  const files: { path: string; size: number }[] = [];
  let whole = true;
  const seen = new Set(folders);
  let level = folders.map((dir) => ({ dir, depth: 0 }));
  while (level.length > 0) {
    const listed = await Promise.all(
      level.map(async ({ dir, depth }) => {
        try {
          return { dir, depth, entries: depth === 0 && !(await $.fs.exists(dir)) ? [] : await $.fs.list(dir) };
        } catch (error) {
          lgT($, 'shell.sweep', { outcome: 'unlisted', reason: message(error) });
          whole = false;
          return { dir, depth, entries: [] };
        }
      }),
    );
    level = [];
    for (const { dir, depth, entries } of listed) {
      for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const path = `${dir}/${entry.name}`;
        if (entry.kind === 'dir') {
          if (entry.name.startsWith('.') || SWEEP_SKIP_DIRS.has(entry.name) || seen.has(path)) continue;
          if (depth >= SWEEP_DEPTH_MAX) whole = false;
          else {
            seen.add(path);
            level.push({ dir: path, depth: depth + 1 });
          }
        } else if (entry.kind === 'file') {
          if (files.length >= SWEEP_FILES_MAX) whole = false;
          else files.push({ path, size: entry.size });
        }
      }
    }
  }
  await Promise.all(
    files.map(async ({ path }) => {
      try {
        const s = await $.fs.stat(path);
        marks.set(path, { size: s.size, mtimeMs: s.mtimeMs });
      } catch (error) {
        lgT($, 'shell.sweep', { outcome: 'unmarked', reason: message(error) });
      }
    }),
  );
  if (readAhead) {
    let budget = SWEEP_READ_BYTES_MAX;
    const ahead: { path: string; size: number }[] = [];
    for (const f of files.filter((x) => x.size <= SHELL_FILE_MAX_BYTES).sort((a, b) => a.size - b.size)) {
      if (f.size > budget) break;
      budget -= f.size;
      ahead.push(f);
    }
    await Promise.all(
      ahead.map(async ({ path, size }) => {
        const text = await readText($, path, size);
        if (text !== undefined) texts.set(path, text);
      }),
    );
  }
  return { marks, texts, whole };
}

/** A main-loop shell command about to run while a turn is tallied: the files it names (shellTargets) read, the folders it works in (shellFolders) swept; null when there is nothing to measure or no time to. */
async function shellBefore(st: State, $: EngineInterface, e: ToolCallInput): Promise<ShellBefore | null> {
  try {
    const tally = st.tally?.counts;
    const call = e as unknown as { tool: string; command?: unknown; input?: unknown; [argument: string]: unknown };
    if (!tally || call.tool !== 'Bash' || !isMainLoop(e.agentId)) return null;
    const command = bashCommand(call);
    if (!command) return null;
    const cwd = await $.session.cwd();
    const home = (await $.env.get('HOME')) ?? '';
    const spelled = shellFolders(command, cwd, home);
    const folders = [...new Set(await Promise.all(spelled.map(async (dir) => (await realFolder($, dir)) ?? dir)))];
    const started = Date.now();
    const [files, sweep] = await Promise.all([
      within(sleeper($), readShellFiles($, shellTargets(command, cwd, home)), SHELL_MEASURE_MS),
      within(sleeper($), sweepFolders($, folders, true), SHELL_MEASURE_MS),
    ]);
    if (files === 'timeout') lgT($, 'shell.measure', { outcome: 'timeout', when: 'before' });
    if (sweep === 'timeout') lgT($, 'shell.sweep', { outcome: 'timeout', when: 'before' });
    else lgT($, 'shell.sweep', { outcome: 'swept', files: sweep.marks.size, read: sweep.texts.size, whole: sweep.whole, ms: Date.now() - started });
    const named = files === 'timeout' ? new Map<string, string | null>() : files;
    const swept = sweep === 'timeout' ? null : sweep;
    return named.size > 0 || swept ? { tally, files: named, folders, sweep: swept } : null;
  } catch (error) {
    log($, "reading a shell command's files before it runs", error);
    return null;
  }
}

/**
 * The command ran, however it ended: the files it names read again, each one
 * it really changed counted (shellChanges); then its folders swept again, and
 * each other file that changed counted (sweptChanges), its lines where its
 * text was read before, else as unmeasured (sweptShellChange).
 */
async function shellAfter($: EngineInterface, before: ShellBefore): Promise<void> {
  try {
    const [now, sweep] = await Promise.all([
      within(sleeper($), readShellFiles($, [...before.files.keys()]), SHELL_MEASURE_MS),
      before.sweep ? within(sleeper($), sweepFolders($, before.folders, false), SHELL_MEASURE_MS) : Promise.resolve(null),
    ]);
    const changes: ShellChange[] = [];
    const measured = new Set<string>();
    if (now === 'timeout') lgT($, 'shell.measure', { outcome: 'timeout', when: 'after' });
    else {
      changes.push(...shellChanges(before.files, now));
      for (const file of before.files.keys()) if (now.has(file)) measured.add(file);
    }
    const was = before.sweep;
    if (sweep === 'timeout') lgT($, 'shell.sweep', { outcome: 'timeout', when: 'after' });
    else if (sweep && was) {
      const moved = sweptChanges(was.marks, sweep.marks, was.whole && sweep.whole).filter((c) => !measured.has(c.file));
      const read = await within(
        sleeper($),
        Promise.all(
          moved.map(async (c) => {
            const before = c.kind === 'made' ? null : was.texts.get(c.file);
            const after = c.kind === 'gone' ? null : c.kind === 'made' || before !== undefined ? await readText($, c.file) : undefined;
            return sweptShellChange(c.file, c.kind, before, after);
          }),
        ),
        SHELL_MEASURE_MS,
      );
      if (read === 'timeout') lgT($, 'shell.sweep', { outcome: 'timeout', when: 'reading' });
      else for (const c of read) if (c) changes.push(c);
    }
    countShellChanges(before.tally, changes);
  } catch (error) {
    log($, 'measuring what a shell command changed', error);
  }
}

/** The session's usage now ($.session.usage()), checked; null when it failed, came back malformed, or took past USAGE_DEADLINE_MS; `when` names the read in a failure. */
async function readUsage(st: State, $: EngineInterface, when: string): Promise<UsageReading | null> {
  try {
    const r: unknown = await within(sleeper($), $.session.usage(), USAGE_DEADLINE_MS);
    if (r !== 'timeout') {
      const reading = usageReadingOf(r);
      if (!reading) throw new Error(`it came back as ${r === null ? 'null' : typeof r}, not the usage`);
      return reading;
    }
    lg($, 'info', 'usage.read', { when, outcome: 'timeout', ms: USAGE_DEADLINE_MS });
    return null;
  } catch (error) {
    // Said once: a usage that never reads would otherwise say so at every turn.
    if (st.usageFailSaid) L.error(`reading the session's usage at ${when}`, error);
    else log($, `reading the session's usage at ${when}`, error);
    st.usageFailSaid = true;
    return null;
  }
}

/** The ended main turn's numbers: its tally closed with its end (`e`) and the session's usage at its start and now; undefined, logged, when that failed. */
async function turnStats(st: State, $: EngineInterface, tally: { counts: Tally; before: Promise<UsageReading | null> }, e: TurnCompleteInput): Promise<TurnStats | undefined> {
  try {
    const ms = typeof e.durationMs === 'number' ? e.durationMs : Date.now() - tally.counts.startedAt;
    const effort = st.mainEffort;
    const [before, after] = await Promise.all([tally.before, readUsage(st, $, "the turn's end")]);
    const stats = closeTally(tally.counts, { ms, ...(e.usage ? { usage: e.usage } : {}), ...(effort === undefined ? {} : { effort }) }, before, after);
    lg($, 'info', 'turn.numbers', { ms: stats.ms, requests: stats.requests ?? 0, tools: Object.values(stats.tools ?? {}).reduce((n, k) => n + k, 0), agentRuns: stats.agents?.runs ?? 0, usd: stats.usd ?? -1, context: stats.context?.percent ?? -1 });
    return stats;
  } catch (error) {
    log($, "counting the turn's numbers", error);
    return undefined;
  }
}

/** The main chat compacted: its summary filed as a turn of its own, and into the drawer; the drawer's older turns go with the memory's. */
function rememberCompaction(st: State, $: EngineInterface, summary: string): void {
  const n = st.options.chatTurnsToRead;
  const id = `compaction:${Date.now()}`;
  st.lastTurnId = id;
  lg($, 'info', 'compaction.remembered', { length: summary.length });
  changeChatTurnsToRead(st, $, 'remembering the compaction', (m) => ({ ...m, blocks: addCompaction(m.blocks, id, summary, n, Date.now()) }));
  feedAdd(st, $, { at: Date.now(), kind: 'compact', text: summary, turnId: id, read: true });
}

/** The exchange `x` of `characterId` filed under the turn `after` (default: the latest answered one), and saved; one whose turn is no longer remembered is dropped. */
function rememberExchange(st: State, $: EngineInterface, characterId: string, x: Exchange, after = st.lastTurnId): void {
  changeChatTurnsToRead(st, $, `remembering the ${x.kind}`, (m) => ({ ...m, blocks: addExchange(m.blocks, characterId, x, after) }));
}

/**
 * `characterId`'s own notes on this chat, as it rewrote them at a turn's end,
 * replacing the ones it had; said in the drawer when they changed. Logs
 * `notes.outcome`: rewritten, cleared or unchanged, with the count.
 */
function rememberNotes(st: State, $: EngineInterface, characterId: string, voiced: { who?: string; color?: string }, notes: string[]): void {
  const had = st.chatTurnsToRead?.notes[characterId] ?? [];
  const same = had.length === notes.length && had.every((n, i) => n === notes[i]);
  lg($, 'info', 'notes.outcome', { outcome: same ? 'unchanged' : notes.length === 0 ? 'cleared' : 'rewritten', count: notes.length });
  if (same) return;
  changeChatTurnsToRead(st, $, 'remembering the notes', (m) => ({ ...m, notes: { ...m.notes, [characterId]: notes } }));
  feedAdd(st, $, { at: Date.now(), kind: 'memory', text: notes.length > 0 ? notes.join('\n') : 'forgot every note', ...voiced });
}

// ---- the feed: what the drawer draws -------------------------------------

/** `change` applied to the feed, after every change made before, so two never race and land in the order made; a failure is logged, never thrown. */
function changeFeed(st: State, $: EngineInterface, what: string, change: (feed: FeedEntry[]) => FeedEntry[]): void {
  st.feedChain = st.feedChain
    .then(async () => {
      // The drawer spans what the buddy remembers: turns it has forgotten leave the feed with it.
      await update($, FEED, (feed) => pruneToMemory(change([...(feed ?? [])]), st.options.chatTurnsToRead));
      if (st.drawer.open) scrollDrawerToEnd(st, $);
    })
    .catch((error: unknown) => log($, `the drawer's feed: ${what}`, error));
}

/**
 * The feed drawn back from the memory just loaded, where it holds no turn of
 * it yet (a resume, a restart): what the buddy remembers is what the drawer shows.
 */
function seedFeed(st: State, $: EngineInterface, blocks: readonly Block[]): void {
  const c = st.b?.character;
  if (!c || blocks.length === 0) return;
  changeFeed(st, $, 'drawing the memory back', (f) => {
    const since = f.slice(f.findLastIndex((e) => e.kind === 'clear') + 1);
    if (since.some((e) => e.kind !== 'line')) return f;
    const seeded = feedOfMemory(blocks, c.id, voice(c), Date.now());
    lg($, 'info', 'feed.seeded', { entries: seeded.length });
    return seeded.reduce((acc, e) => pushEntry(acc, e), f);
  });
}

/** One entry joins the feed. */
function feedAdd(st: State, $: EngineInterface, entry: NewEntry): void {
  changeFeed(st, $, entry.kind, (f) => pushEntry(f, entry));
}

/** A model call's tokens, all four counts together (usageFields); undefined when it reported none. */
function tokensOf(usage: Record<string, number>): number | undefined {
  const n = (usage.inTok ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.outTok ?? 0);
  return n > 0 ? n : undefined;
}

/** `c`'s name and ink on a feed entry. */
function voice(c: Character): { who: string; color: string } {
  return { who: c.name, color: c.color };
}

/** What `c` remembers of this session, rendered for a prompt, after every write made before; '' when nothing, or not read within the caller's `ms`. */
async function readChatTurnsToRead(st: State, $: EngineInterface, c: Character, ms: number): Promise<{ text: string; memory: MemoryStats; last?: string }> {
  let text = '';
  let memory: MemoryStats = { turns: 0, kept: 0, full: 0 };
  let last: string | undefined;
  const landed = await chainChatTurnsToRead(
    st,
    $,
    'reading the chatTurnsToRead',
    ms,
    async (live) => {
      const m = await chatTurnsToReadFor(st, $, live);
      if (m && live()) {
        text = render(m.blocks, c.id, st.options.chatTurnsToRead, m.notes[c.id] ?? []);
        memory = memoryStats(m.blocks, st.options.chatTurnsToRead);
        last = m.blocks.at(-1)?.turnId;
      }
    },
    ms,
  );
  return landed ? { text, memory, ...(last === undefined ? {} : { last }) } : { text: '', memory: { turns: 0, kept: 0, full: 0 } };
}

/**
 * The session's memory loaded now, and the drawer drawn back from it: at a
 * session's start and when the drawer opens, so a reopened chat shows what the
 * buddy remembers before any turn, question or greeting touches it.
 */
function loadMemory(st: State, $: EngineInterface): void {
  chainChatTurnsToRead(st, $, 'loading the chatTurnsToRead', CHAT_TURNS_TO_READ_WRITE_DEADLINE_MS, async (live) => {
    await chatTurnsToReadFor(st, $, live);
  }).catch((error: unknown) => log($, 'loading the chatTurnsToRead', error));
}

/** What a call's memory handed the model of the main chat's turns (memoryStats), for the audit. */
type MemoryStats = { turns: number; kept: number; full: number };

/** The canned lines the brain said since last taken: kept when the band shows them, dropped while hidden. */
function heard(st: State, $: EngineInterface): void {
  const b = st.b;
  if (!b || b.said.length === 0) return;
  // Before the band first draws (a headless `claude -p` or SDK session never does) only the newest line can still be shown.
  if (!st.bandSeen) {
    b.said.splice(0, b.said.length - 1);
    return;
  }
  const said = b.said.splice(0);
  if (st.hidden) return;
  for (const s of said) {
    rememberExchange(st, $, s.id, { kind: 'line', text: s.text });
    const c = st.roster.entries.find((e) => e.id === s.id)?.character ?? (b.character.id === s.id ? b.character : null);
    // Heard while the band draws, where state is never written: joined to the feed once the drawing is done.
    const entry: NewEntry = { at: Date.now(), kind: 'line', text: s.text, ...(c ? voice(c) : { who: s.id }) };
    $.clock.after(0, () => feedAdd(st, $, entry));
  }
}

// ---- clock and redraw ---------------------------------------------------

function refresh(st: State, $: EngineInterface): void {
  heard(st, $);
  // Each new bubble text joins the round once, marked when /buddy off keeps it from being drawn.
  const bubble = st.b?.talk?.text ?? null;
  if (bubble !== st.roundBubble) {
    st.roundBubble = bubble;
    if (bubble !== null) roundEvent(st, $, eventLine(Date.now(), `OUT · bubble${st.hidden ? ' (hidden, not drawn)' : ''}: ${JSON.stringify(bubble)}`));
  }
  if (!st.b || st.hidden) return;
  const key = JSON.stringify(sceneOf(st.b));
  if (key === st.lastKey) return;
  st.lastKey = key;
  $.ui.invalidate('ui.render');
}

function stopClock(st: State): void {
  st.timer?.cancel();
  st.timer = null;
}

function startClock(st: State, $: EngineInterface): void {
  stopClock(st);
  if (!st.b || st.hidden) return;
  st.clockPeriod = period(st.b);
  st.timer = $.clock.every(st.clockPeriod, () => onTick(st, $));
}

function onTick(st: State, $: EngineInterface): void {
  try {
    if (!st.b) return;
    tick(st.b, new Date().getHours(), Math.random);
    if (++st.ticks % SHARED_TICKS === 0) syncHidden(st, $);
    lgT($, 'clock.tick', { period: st.clockPeriod, talking: st.b.talk !== null, working: st.b.working });
    refresh(st, $);
    if (period(st.b) !== st.clockPeriod) startClock(st, $);
  } catch (error) {
    if (message(error) === st.lastTickError) return;
    st.lastTickError = message(error);
    log($, 'a clock tick', error);
  }
}

/** `hidden` read back from the store: `/buddy off` or `on` in another session sharing it reaches this one. */
function syncHidden(st: State, $: EngineInterface): void {
  st.sharedAt = Date.now();
  const gen = st.hiddenGen;
  $.store
    .get('hidden')
    .then((v) => {
      const hidden = v === true;
      // Asked before this session's own /buddy off or on, or answered while it saves: what it read is older than that.
      if (gen !== st.hiddenGen || st.hiddenSaves > 0) return;
      if (!st.b || hidden === st.hidden) return;
      st.hidden = hidden;
      lg($, 'info', 'hidden.shared', { hidden });
      if (hidden) stopClock(st);
      else startClock(st, $);
      st.lastKey = '';
      $.ui.invalidate('ui.render');
    })
    .catch((error) => log($, 'reading /buddy off back from the store', error));
}

// ---- session.start ------------------------------------------------------

async function readStore(st: State, $: EngineInterface): Promise<void> {
  try {
    const pets = await $.store.get('pets');
    st.pets = typeof pets === 'number' && Number.isFinite(pets) ? pets : 0;
  } catch (error) {
    log($, 'reading the pet count', error);
  }
  try {
    st.hidden = (await $.store.get('hidden')) === true;
  } catch (error) {
    log($, 'reading /buddy off', error);
  }
  try {
    const choice = await $.store.get('character');
    st.storeChoice = typeof choice === 'string' && choice !== '' ? choice : undefined;
  } catch (error) {
    log($, 'reading the stored character choice', error);
  }
  try {
    st.saved = savedOriginalOf(await $.store.get('original'));
  } catch (error) {
    log($, 'reading the saved original companion', error);
  }
}

async function startSession(st: State, $: EngineInterface): Promise<void> {
  await startLog(st, $);
  for (const e of st.options.errors) warn($, 'option.warning', e);
  await readStore(st, $);
  await loadRoster(st, $);
  if ((st.storeChoice ?? st.options.character) === ORIGINAL_ID) await restoreOriginal(st, $);
  applyChoice(st, $);
  try {
    await $.command.register({ name: COMMAND, description: 'Open or fold the drawer: your buddy, its thread with you and its personalities; with words, ask it; or: off, on, reload, log, help', argumentHint: '[question] | off | on | reload | log | help', immediate: true });
  } catch (error) {
    log($, `registering /${COMMAND}`, error);
  }

  startClock(st, $);
  st.lastKey = '';
  $.ui.invalidate('ui.render');
  if (st.interactive) loadMemory(st, $);
}

/** The log's level, file (logPath: the config folder's by default) and session; a failure here leaves file logging off, said. */
async function startLog(st: State, $: EngineInterface): Promise<void> {
  L.level = st.options.logLevel;
  try {
    const where = logPath(st.options.logFile, { HOME: await $.env.get('HOME'), CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR') });
    if ('error' in where) throw new Error(where.error);
    L.file = where.path;
  } catch (error) {
    L.file = '';
    log($, 'opening the log file', error, { logFile: st.options.logFile });
  }
  try {
    L.context.session = await $.session.id();
  } catch (error) {
    log($, 'reading the session id for the log', error);
  }
  // The version as loaded, from the plugin's own manifest: a stale load after an update shows here.
  let build = 'unread';
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown };
    build = typeof manifest.version === 'string' ? manifest.version : 'no version';
  } catch (error) {
    lg($, 'debug', 'session.build-unread', { error: message(error) });
  }
  lg($, 'info', 'session.start', { build, rounds: st.options.saveRounds, model: st.options.model, effort: st.options.effort, level: L.level, commentAfterEachTurn: st.options.commentAfterEachTurn, suggestNextPrompt: st.options.suggestNextPrompt, chatTurnsToRead: st.options.chatTurnsToRead });
}

// ---- ui.render: AbovePrompt ---------------------------------------------

function bandScene(st: State, $: EngineInterface, p: BandProps): Scene | null {
  if (p.hasSurvey || !st.b || st.hidden) return null;
  st.bandSeen = true;
  observeBand(st.b, { cols: p.bodyColumns, maxRows: p.maxRows, isWorking: p.isWorking }, Math.random);
  heard(st, $);
  const scene = sceneOf(st.b);
  lgT($, 'band.scene', { pose: st.b.lastPose, bubble: st.b.talk?.text.length ?? 0, cols: p.bodyColumns, working: p.isWorking });
  st.lastKey = JSON.stringify(scene);
  return scene;
}

type Component = any;

function drawBand(Box: Component, Text: Component, s: Scene) {
  const bubble = s.bubble ? (
    <Box key="bubble" borderStyle="round" borderColor={s.bubble.tone ? TONE_COLOR[s.bubble.tone] : undefined} paddingX={1} width={s.bubble.width} alignSelf="flex-start">
      <Text italic={s.bubble.tone !== 'alarm'} bold={s.bubble.tone === 'alarm'} color={BUBBLE_INK[s.bubble.to ?? 'user']} wrap="wrap">{s.bubble.text}</Text>
    </Box>
  ) : null;
  const card = s.card ? (
    <Box position="absolute" top={0} left={s.card.left} width={s.card.width} display="none" hover={{ display: 'flex' }} borderStyle="round" flexDirection="column" paddingX={1}>
      {s.card.lines.map((line, i) => <Text bold={i === 0} dimColor={i === 2} wrap="truncate-end">{line}</Text>)}
    </Box>
  ) : null;
  const sprite = (
    <Box key="buddy" flexDirection="column">
      {s.rows.map((row) => <Text color={s.color}>{row}</Text>)}
      {card}
    </Box>
  );
  const left = s.bubble?.side === 'left';
  return (
    <Box flexDirection="column">
      {s.effects.map((segs) => (
        <Box flexDirection="row">
          {segs.length === 0 ? <Text> </Text> : segs.map((g) => <Box marginLeft={g.pad}><Text color={g.color}>{g.text}</Text></Box>)}
        </Box>
      ))}
      <Box flexDirection="row" marginLeft={s.rowX} gap={1}>
        {left ? bubble : sprite}
        {left ? sprite : bubble}
      </Box>
    </Box>
  );
}

// ---- tool.call, turn.step and turn.complete ----------------------------

function onToolCall(st: State, $: EngineInterface, e: ToolCallInput, r: ToolCallResult): void {
  try {
    const call = e as unknown as { tool: string; command?: unknown; input?: unknown; [argument: string]: unknown };
    const res = r as unknown as { deny?: unknown; isError?: unknown; text?: unknown; result?: unknown };
    const isError = res.isError === true;
    const denied = typeof res.deny === 'string';
    const output = toolOutput(res);
    const command = call.tool === 'Bash' ? bashCommand(call) : '';
    // The running main turn counts every call, its subagents' too: they are that turn's work.
    if (st.tally) countToolCall(st.tally.counts, { tool: call.tool, args: call, failed: isError, denied, outcome: classifyToolCall({ tool: call.tool, isError, denied, output, command }), main: isMainLoop(e.agentId) });
    // A subagent's call is not the main loop's own work: the round says it was heard, nothing more.
    if (!isMainLoop(e.agentId)) {
      roundEvent(st, $, toolLines(Date.now(), { tool: call.tool, args: call, output, failed: isError || denied, step: null, reaction: null, agentId: e.agentId }));
      return;
    }
    if (!st.b) return;
    const failure: Failure | null = denied ? { kind: 'denied', reason: denialReason(res.deny as string) } : isError ? { kind: 'failed', reason: failureReason(output) } : null;
    const action = actionOf(call, failure);
    const reaction = react(st.b, { tool: call.tool, isError, denied, output, command, action }, Math.random);
    roundEvent(st, $, toolLines(Date.now(), { tool: call.tool, args: call, output, failed: isError || denied, step: action ? (didOf([action])[0] ?? null) : null, reaction }));
    refresh(st, $);
  } catch (error) {
    log($, 'reacting to a tool call', error);
  }
}

/** Records the effort of a request of the running main turn, which effort inherit sends; a subagent's or a side request's leaves it. A main request carries the prompts the user typed over its turn, which Claude Code delivers into it: they join that turn (deliverPrompts); a subagent's request never delivers the main queue. */
function onTurnStep(st: State, $: EngineInterface, e: TurnStepInput): void {
  try {
    st.mainEffort = observeEffort(st.mainEffort, e, st.mainTurn);
  } catch (error) {
    log($, "recording the main chat's effort", error);
  }
  try {
    if (isMainLoop(e.agentId)) st.prompts = deliverPrompts(st.prompts, e.turnId);
  } catch (error) {
    log($, 'delivering the prompts typed over the turn', error);
  }
}

/** A model request of the running main turn ended (`r`, the step's result): counted, with why it stopped; a subagent's or a side request's is not. */
function onTurnStepped(st: State, $: EngineInterface, e: TurnStepInput, r: TurnStepResult | undefined): void {
  try {
    if (st.tally && isMainLoop(e.agentId) && e.turnId === st.tally.counts.turnId) countStep(st.tally.counts, r?.stopReason ?? null);
  } catch (error) {
    log($, 'counting a model request', error);
  }
}

/**
 * A prompt of the user's answers the buddy's suggestion in the box: taken
 * when it is that suggestion, unedited (isTaken). Another's prompt (a peer, a
 * notification) leaves the box as it is.
 */
function takeSuggestion(st: State, $: EngineInterface, e: PromptSubmitInput): boolean {
  try {
    const shown = st.shownSuggestion;
    // Validated here: an origin the engine left out is not presumed the user's.
    if (shown === null || !isUserOrigin(e.origin?.kind ?? 'unclassified')) return false;
    st.shownSuggestion = null;
    return isTaken(shown, e.text);
  } catch (error) {
    log($, 'matching the prompt to the suggestion', error);
    return false;
  }
}

/** Whether a submitted prompt is this plugin's own (promptToMainChat's): by its origin, or as the text it just sent (isOwnPrompt). */
function ownPrompt(st: State, $: EngineInterface, e: PromptSubmitInput): boolean {
  try {
    return isOwnPrompt(e.origin, $.plugin.name, e.text, st.pendingMainChatPrompt);
  } catch (error) {
    log($, "telling the buddy's own prompt", error);
    return false;
  }
}

/** A prompt that entered the session (`r`, next(e)'s result) joins the ledger, with its origin, the buddy's own as BUDDY_PROMPT; a dropped one never does. One of the user's arms promptToMainChat. `taken`: it is the buddy's suggestion, unedited (takeSuggestion). */
function onPromptSubmit(st: State, $: EngineInterface, e: PromptSubmitInput, r: PromptSubmitResult, taken: boolean, own: boolean): void {
  try {
    if (typeof r.drop === 'string') return;
    // Validated here: an origin the engine left out is not presumed the user's.
    st.prompts = submitPrompt(st.prompts, r.text, own ? BUDDY_PROMPT : originOf(e.origin, $.plugin.name), e.turnId);
    if (isUserOrigin(e.origin?.kind ?? 'unclassified')) {
      st.mainChatPromptArmed = true;
      st.userPrompts++;
    }
    if (taken) {
      st.takenPrompt = r.text;
      lg($, 'info', 'suggestNextPrompt.taken', { length: r.text.length });
    }
  } catch (error) {
    log($, 'remembering the prompt', error);
  }
}

/** A main turn began (only the main loop raises turn.start): it is the running one, and takes its prompt; an engine suggestion still held is for an ended turn, released. */
function onTurnStart(st: State, $: EngineInterface, e: TurnStartInput): void {
  try {
    st.mainTurn = e.turnId;
    st.turnStarts++;
    st.tally = { counts: openTally(e.turnId, Date.now(), st.lastMainEndAt), before: readUsage(st, $, "the turn's start") };
    st.prompts = startPromptTurn(st.prompts, e.turnId, e.text);
    openRound(st, $, e.turnId, e.text);
    const prompt = cleanPrompt(e.text);
    changeFeed(st, $, 'the prompt', (f) => (prompt ? pushEntry(answerSuggestions(f, prompt), { at: Date.now(), kind: 'you', text: prompt, turnId: e.turnId }) : f));
    if (st.harnessSuggestion !== null) {
      st.harnessSuggestion = null;
      lg($, 'info', 'suggestNextPrompt.outcome', { outcome: 'harness-stale' });
    }
  } catch (error) {
    log($, 'the start of a turn', error);
  }
}

/** An ended main turn as onTurnEnd hands it on: the prompt that started it, its origin when not the user's, the prompts delivered into it, its tally (null when its start was not seen); `lost` when the ledger held no entry for it, its prompt to be read back from the transcript (lostPrompt). */
type Ended = { prompt: string; from?: string; added?: string[]; lost?: true; lostSteps?: Step[]; tally: { counts: Tally; before: Promise<UsageReading | null> } | null };

/**
 * A main turn ended, however, before any hook beneath runs (turn.complete):
 * it is no longer the running one, and it uses up the prompt that started it,
 * returned for onTurnComplete to file; null for a subagent's end. Runs with no
 * character loaded too, and whatever the hooks beneath do.
 */
function onTurnEnd(st: State, $: EngineInterface, e: TurnCompleteInput): Ended | null {
  try {
    if (!isMainLoop(e.agentId)) {
      // A subagent's run ended inside the running main turn: counted there, with what it spent.
      if (st.tally) countAgentRun(st.tally.counts, e.usage);
      return null;
    }
    if (st.mainTurn === e.turnId) st.mainTurn = undefined;
    const tally = st.tally?.counts.turnId === e.turnId ? st.tally : null;
    st.tally = null;
    st.lastMainEndAt = Date.now();
    // A plugin hot reload empties the ledger: the turn running then has no entry.
    const lost = !st.prompts.started.some((s) => s.turnId === e.turnId);
    const ended = endPromptTurn(st.prompts, e.turnId);
    st.prompts = ended.ledger;
    // The turn a taken suggestion began: the user's choice, the buddy's words.
    const taken = ended.from === undefined && st.takenPrompt !== null && ended.prompt === st.takenPrompt;
    if (taken) st.takenPrompt = null;
    const from = taken ? TAKEN_SUGGESTION : ended.from;
    return { prompt: ended.prompt, ...(from === undefined ? {} : { from }), ...(ended.added ? { added: ended.added } : {}), ...(lost ? { lost: true as const } : {}), tally };
  } catch (error) {
    log($, 'the end of a turn', error);
    return null;
  }
}

/**
 * The main turn `turnId` the ledger lost, its prompt and steps read back from
 * the transcript (lostTurnOf): logged either way, found or none there; a
 * failed read is said and logged as a failure, and gives no prompt.
 */
async function lostTurn($: EngineInterface, turnId: string): Promise<{ prompt: string; steps: Step[] }> {
  try {
    const rows = await $.session.messages();
    const lost = lostTurnOf(rows);
    lg($, 'info', 'prompt.backfill', { turnId, outcome: lost.prompt ? 'found' : 'none', rows: rows.length, steps: lost.steps.length });
    return lost;
  } catch (error) {
    log($, 'reading the transcript for a lost prompt', error, { turnId });
    return { prompt: '', steps: [] };
  }
}

/** A main turn's end, `ended` its prompt (onTurnEnd): the tally, the chatTurnsToRead turns, and the end-of-turn call. */
function onTurnComplete(st: State, $: EngineInterface, e: TurnCompleteInput, ended: Ended | null): void {
  try {
    // Only the main loop's end is the turn's end: a subagent's leaves the main turn's tally whole.
    if (!ended || !st.b) return;
    wake(st.b, Math.random);
    // A turn ended, however: an earlier turn's call still running is stale, its commentAfterEachTurn and suggestNextPrompt never shown.
    const gen = ++st.turnGen;
    // Every turn is filed into the chatTurnsToRead with its steps: an answered one as it is, one interrupted, or ended by an API error or a refusal, marked so (what Claude said before it its answer; it makes no call), a prompt not the user's under its origin; a headless session (nobody at the prompt) files none, never pushing an interactive session's memory out of the store.
    const answered = e.reason === 'answer' && !e.isAborted;
    // A turn read back after a hot reload takes its steps from the transcript: the buddy heard only the calls after the reload.
    const did = didOf(ended.lostSteps?.length ? ended.lostSteps : st.b.turn.actions);
    const from = ended.from === undefined ? {} : { from: ended.from };
    // The prompts the user typed while it ran, delivered into it: read with it, never as a turn of their own.
    const added = ended.added ? { added: ended.added } : {};
    // Its numbers, counted as it ran, once the session's usage is read: filed with the turn, and on its row in the drawer.
    const stats = ended.tally ? turnStats(st, $, ended.tally, e) : Promise.resolve(undefined);
    const how: TurnEnding | undefined = answered ? undefined : e.isAborted || e.reason === 'aborted' ? 'interrupted' : e.reason === 'error' || e.reason === 'refusal' ? e.reason : undefined;
    const cut = how === 'interrupted' ? { interrupted: true as const } : how ? { ended: how } : {};
    if (st.interactive) rememberTurn(st, $, e.turnId, { prompt: ended.prompt, answer: e.answer, did, ...from, ...added, ...cut }, stats);
    // The drawer says whether the buddy read the turn: one interrupted is remembered, but never read by a call.
    changeFeed(st, $, 'the turn read', (f) => markRead(f, e.turnId, answered && st.interactive, how));
    stats.then((s) => {
      if (s) changeFeed(st, $, 'the turn numbers', (f) => markNumbers(f, e.turnId, statsBrief(s)));
    }).catch((error) => log($, "showing the turn's numbers", error));
    roundEvent(st, $, turnEndSection(Date.now(), { turnId: e.turnId, reason: e.isAborted ? 'aborted' : e.reason, prompt: ended.prompt, answer: typeof e.answer === 'string' ? e.answer : '', did, ...from, ...added }));
    const gate: TurnGate = {
      answered,
      hidden: st.hidden,
      interactive: st.interactive,
      bandSeen: st.bandSeen,
      commentAfterEachTurn: st.options.commentAfterEachTurn,
      suggestNextPrompt: st.options.suggestNextPrompt,
      promptToMainChat: st.options.promptToMainChat,
      mainChatPromptArmed: st.mainChatPromptArmed,
    };
    const may = turnMay(gate);
    const { turn, commentAfterEachTurnDue } = endTurn(st.b, may.commentAfterEachTurn, st.options.secondsBetweenComments);
    const wants: TurnWants = { commentAfterEachTurn: commentAfterEachTurnDue, suggestNextPrompt: may.suggestNextPrompt, promptToMainChat: may.promptToMainChat };
    // The engine's own suggestion is held back only while this turn's call may still propose one; one already held (the engine may suggest before this code runs) is shown or released, never erased.
    st.suggestNextPromptGaveUp = !wants.suggestNextPrompt;
    if (!wants.suggestNextPrompt) giveUpSuggestNextPrompt(st, $, gen, 0).catch((error) => log($, "showing the engine's own suggestion", error));
    if (wants.commentAfterEachTurn || wants.suggestNextPrompt || wants.promptToMainChat) {
      lg($, 'info', 'turn.call', { commentAfterEachTurn: wants.commentAfterEachTurn, suggestNextPrompt: wants.suggestNextPrompt, promptToMainChat: wants.promptToMainChat, tools: turn.tools.length });
      // The character drawn as the turn ended: what arrives after a switch is never said by another.
      st.calls++;
      st.userPromptsAtCall.set(e.turnId, st.userPrompts);
      turnCall(st, $, st.b.character, turn, e.turnId, gen, wants, Date.now())
        .catch((error) => log($, 'the end-of-turn call', error))
        .finally(() => {
          st.calls--;
          st.userPromptsAtCall.delete(e.turnId);
        });
    } else {
      lg($, 'info', 'turn.skipped', { why: skipReason(gate) });
    }
    refresh(st, $);
  } catch (error) {
    log($, 'the end of a turn', error);
  }
}

/** A /clear or a resume: the chat the buddy read is gone (the session id moves, and with it the chatTurnsToRead read), so its prompts, the turn's tally and any call in flight are dropped. */
function forgetConversation(st: State, $: EngineInterface, reason: string): void {
  st.lastTurnId = undefined;
  // A new conversation's events never land in the ended one's round file.
  writeRound(st, $, st.round);
  st.round = null;
  st.roundBubble = null;
  st.prompts = NO_PROMPTS;
  st.mainTurn = undefined;
  st.tally = null;
  st.lastMainEndAt = undefined;
  st.conversation++;
  st.turnGen++;
  if (st.harnessSuggestion !== null) lg($, 'info', 'suggestNextPrompt.outcome', { outcome: 'harness-stale' });
  st.harnessSuggestion = null;
  st.suggestNextPromptGaveUp = true;
  st.shownSuggestion = null;
  st.takenPrompt = null;
  st.desire = null;
  if (st.b) endTurn(st.b, false, 0);
  feedAdd(st, $, { at: Date.now(), kind: 'clear', text: reason });
  lg($, 'info', 'session.forget', { reason });
}

/** One change to the round files, after every change made before; a failure is said once, then logged. Never throws. */
function changeRounds(st: State, $: EngineInterface, what: string, change: () => Promise<void>): void {
  if (!st.options.saveRounds) return;
  st.roundsChain = st.roundsChain.then(change).catch((error) => {
    if (st.roundsFailed) L.error(what, error);
    else log($, what, error);
    st.roundsFailed = true;
  });
}

/** A round opening now, with its turn's start, or none. */
function newRound(start: Round['start']): Round {
  return { at: Date.now(), start, body: '', calls: 0, path: '', session: '', dirty: true, queued: false };
}

/** `text` added to the round being written (one opened, before any turn, when none is); null with saveRounds off. Writes nothing: writeRound does. */
function roundAppend(st: State, text: string): Round | null {
  if (!st.options.saveRounds) return null;
  st.round ??= newRound(null);
  st.round.body += text;
  st.round.dirty = true;
  return st.round;
}

/** `round` on disk, whole, after every write before; its slot and session taken at its first write. At most one write waits per round: it writes the text as it stands when it runs. */
function writeRound(st: State, $: EngineInterface, round: Round | null): void {
  if (!round || !st.options.saveRounds || round.queued || !round.dirty) return;
  round.queued = true;
  changeRounds(st, $, 'writing a round file', async () => {
    round.queued = false;
    if (!round.path) {
      round.session = await $.session.id();
      const dir = await chatFolderFor(st, $, round.session);
      round.path = `${dir}/${await nextRoundSlot($, dir)}`;
    }
    round.dirty = false;
    await $.fs.write(round.path, roundHead(round.at, round.session, round.start) + round.body);
  });
}

/** The records the log's tap added to the round, written: every lg, lgT and log call ends here. */
function flushRound($: EngineInterface): void {
  if (tapped) writeRound(tapped, $, tapped.round);
}

/** The file name a new round takes in the chat's folder `dir`: the number after the highest round there. */
async function nextRoundSlot($: EngineInterface, dir: string): Promise<string> {
  const names = (await $.fs.exists(dir)) ? (await $.fs.list(dir)).filter((f) => f.kind === 'file').map((f) => f.name) : [];
  return newRoundSlot(names);
}

/** A main turn began: the round before it is written as it stands, and this turn's opens with the prompt it began with. */
function openRound(st: State, $: EngineInterface, turnId: string, prompt: string): void {
  if (!st.options.saveRounds) return;
  writeRound(st, $, st.round);
  st.round = newRound({ turnId, prompt });
  st.roundBubble = null;
  writeRound(st, $, st.round);
}

/** A moment of the round's timeline, written. */
function roundEvent(st: State, $: EngineInterface, text: string): void {
  writeRound(st, $, roundAppend(st, text));
}

/** `$.model.complete(request)`, its request and reply recorded verbatim into the round being written when it was sent, whatever it returns or throws. */
async function completeRecorded(st: State, $: EngineInterface, kind: RoundCall['kind'], request: { model: string; effort?: Effort; system: string; prompt: string; maxTokens: number; timeoutMs: number }, memory: MemoryStats): Promise<ModelCompleteResult> {
  const at = Date.now();
  // The round it was sent in: a reply landing after the next turn began still goes with its request.
  const round = st.options.saveRounds ? (st.round ??= newRound(null)) : null;
  const { system, prompt, ...settings } = request;
  const record = (call: Omit<RoundCall, 'kind' | 'at' | 'settings' | 'system' | 'prompt'>) => {
    if (!round) return;
    round.calls++;
    round.body += callSection(round.calls, { kind, at, settings, system, prompt, ...call });
    round.dirty = true;
    writeRound(st, $, round);
  };
  // One line per call for the audit (scripts/audit.mjs): what it cost, and how much of the chat's turns its memory cut.
  const cost = (outcome: string, usage: Record<string, number>) =>
    lg($, 'info', 'call.cost', { kind, model: settings.model, outcome, ms: Date.now() - at, ...usage, memTurns: memory.turns, memKept: memory.kept, memFull: memory.full, promptChars: system.length + prompt.length });
  try {
    const r = await $.model.complete(request);
    const usage = 'usage' in r ? usageFields(r.usage) : {};
    record({ outcome: r.isAnswered ? 'answered' : `not answered: ${noAnswerReason(r)}`, reply: r.isAnswered ? r.text : '', ms: Date.now() - at, usage });
    cost(r.isAnswered ? 'answered' : 'not answered', usage);
    return r;
  } catch (error) {
    record({ outcome: `threw: ${message(error)}`, reply: '', ms: Date.now() - at, usage: {} });
    cost('threw', {});
    throw error;
  }
}

/**
 * The model and effort of one `$.model.complete`, resolved now: an 'inherit'
 * option takes the main chat's: its model, read now (a failed read is logged
 * once and falls back to opus), and the effort of its latest request, recorded
 * by turn.step (none before its first). Logged at debug as `event`.
 * Never throws.
 */
async function callSettings(st: State, $: EngineInterface, event: string): Promise<{ model: string; effort?: Effort }> {
  let sessionModel: string | undefined;
  if (st.options.model === INHERIT) {
    try {
      sessionModel = await $.session.model();
    } catch (error) {
      if (!st.inheritFailed.has('model')) log($, "reading the main chat's model for model inherit", error);
      st.inheritFailed.add('model');
    }
  }
  const model = resolveModel(st.options.model, sessionModel);
  const effort = resolveEffort(st.options.effort, st.mainEffort);
  lg($, 'debug', event, { model, effort: effort ?? 'none' });
  return effort ? { model, effort } : { model };
}

/**
 * One call at a turn's end writes, those wanted, the buddy's
 * commentAfterEachTurn and its second brain: what the user most deeply wants
 * (carried to the next turn's call), a verdict on Claude's last move, and the
 * suggestNextPrompt that follows, and its own notes on the chat, rewritten
 * (rememberNotes). A model completion on the main chat's last
 * chatTurnsToRead turns, in the voice of `c`, the character drawn as the turn
 * ended; one deadline covers the chatTurnsToRead read, the settings and the
 * completion. A SHORTCUT or WRONG verdict takes the bubble before the comment,
 * which it outranks. A timeout, a refusal, an empty reply or a throw fails
 * commentAfterEachTurn as it fails and gives suggestNextPrompt up; a reply
 * after a later turn ended (or /clear) is stale by `gen`, dropped whole. Every
 * outcome logs `ms`, from `started` (the turn's end) to the reply; the call's
 * usage goes on commentAfterEachTurn's outcome, else on the verdict's. Never
 * throws.
 */
async function turnCall(st: State, $: EngineInterface, c: Character, t: TurnSummary, turnId: string, gen: number, wants: TurnWants, started: number): Promise<void> {
  let reply: TurnReply | null = null;
  let reason = '';
  let usage: Record<string, number> = {};
  let late = false;
  try {
    const r = await within(
      sleeper($),
      (async (): Promise<ModelCompleteResult | 'timeout'> => {
        const t0 = await $.clock.now();
        // The chatTurnsToRead, read after this turn was filed into it, and the settings do not wait on each other.
        const [remembered, settings] = await Promise.all([readChatTurnsToRead(st, $, c, TURN_DEADLINE_MS), callSettings(st, $, 'turn.settings')]);
        // Past the deadline already: no completion is sent that nobody waits for.
        if (late) return 'timeout' as const;
        // The memory holds the turn just ended, what Claude did and its numbers with it: the prompt points there.
        const prompt = turnPrompt(t, remembered.text, remembered.last === turnId);
        lg($, 'debug', 'turn.prompt', { length: prompt.length });
        // Abandoned the margin past the deadline, however late it is sent.
        const timeoutMs = requestTimeoutMs(TURN_DEADLINE_MS, (await $.clock.now()) - t0);
        return completeRecorded(st, $, 'endOfTurn', { ...settings, system: turnSystem(c.persona, wants, st.desire), prompt, maxTokens: TURN_MAX_TOKENS, timeoutMs }, remembered.memory);
      })(),
      TURN_DEADLINE_MS,
    );
    late = r === 'timeout';
    // What the call cost and how much it read from the prompt cache.
    usage = r !== 'timeout' && 'usage' in r ? usageFields(r.usage) : {};
    if (r === 'timeout') reason = 'timeout';
    else if (!r.isAnswered) reason = r.reason;
    else {
      reply = parseTurnReply(r.text);
      lg($, 'debug', 'turn.reply', { length: r.text.length, commentAfterEachTurn: reply.commentAfterEachTurn?.length ?? 0, verdict: reply.verdict ?? 'none', suggestNextPrompt: reply.suggestNextPrompt?.length ?? 0, promptToMainChat: reply.promptToMainChat?.length ?? 0 });
    }
  } catch (error) {
    log($, 'the end-of-turn call', error);
    reason = message(error);
  }
  const ms = Date.now() - started;
  const commentAfterEachTurnFields = { ms, ...usage };
  const verdictFields = wants.commentAfterEachTurn ? { ms } : { ms, ...usage };
  if (gen !== st.turnGen) {
    if (wants.commentAfterEachTurn) lg($, 'info', 'commentAfterEachTurn.outcome', { outcome: 'stale', ...commentAfterEachTurnFields });
    if (wants.suggestNextPrompt) {
      lg($, 'info', 'verdict.outcome', { outcome: 'stale', ...verdictFields });
      lg($, 'info', 'suggestNextPrompt.outcome', { outcome: 'stale', ms });
    }
    return;
  }
  // The second brain first: a warning or a scream takes the bubble, and the comment never covers it.
  let warned: string | null = null;
  let verdict: { verdict: Verdict; why: string } | null = null;
  if (wants.suggestNextPrompt || wants.promptToMainChat) {
    if (reply?.desire) st.desire = reply.desire;
    verdict = reply?.verdict && reply.why ? { verdict: reply.verdict, why: reply.why } : null;
    warned = sayVerdict(st, $, c, gen, verdict, reason, verdictFields);
  }
  const commentAfterEachTurn = wants.commentAfterEachTurn ? sayCommentAfterEachTurn(st, $, c, t, gen, reply?.commentAfterEachTurn ?? null, reason || 'no commentAfterEachTurn in the reply', commentAfterEachTurnFields) : null;
  let suggestNextPrompt: string | null = null;
  if (wants.suggestNextPrompt) {
    try {
      suggestNextPrompt = await showSuggestNextPrompt(st, $, gen, reply?.suggestNextPrompt ?? null, reason, { ms });
    } catch (error) {
      log($, 'a suggestNextPrompt', error);
      await giveUpSuggestNextPrompt(st, $, gen, ms).catch((e) => log($, "showing the engine's own suggestion", e));
    }
  }
  // The drawer: what the bubble and the prompt box showed, the verdict with what it judged against, or why the comment never came.
  const tokens = tokensOf(usage);
  const cost = tokens ? { ms, tokens } : {};
  if (commentAfterEachTurn !== null) feedAdd(st, $, { at: Date.now(), kind: 'comment', text: commentAfterEachTurn, ...voice(c), ...cost });
  else if (wants.commentAfterEachTurn && reason) feedAdd(st, $, { at: Date.now(), kind: 'failed', text: reason, ...voice(c), ms });
  if (verdict) feedAdd(st, $, { at: Date.now(), kind: 'verdict', text: verdict.why, verdict: verdict.verdict, ...(st.desire ? { desire: st.desire } : {}), ...voice(c), ...(commentAfterEachTurn === null ? cost : {}) });
  if (suggestNextPrompt !== null) feedAdd(st, $, { at: Date.now(), kind: 'suggest', text: suggestNextPrompt, ...voice(c) });
  let promptToMainChat = wants.promptToMainChat ? (reply?.promptToMainChat ?? null) : null;
  // The user prompted again while this call ran: the buddy's prompt would land after the user's own, answering a turn that moved on.
  if (promptToMainChat !== null && st.userPrompts !== st.userPromptsAtCall.get(turnId)) {
    lg($, 'info', 'promptToMainChat.stale', { character: c.id, length: promptToMainChat.length });
    promptToMainChat = null;
  }
  // What this turn showed, as one exchange: the comment, the warning, the prompt it sent Claude, the suggestion.
  if (commentAfterEachTurn !== null || warned !== null || promptToMainChat !== null || suggestNextPrompt !== null) {
    rememberExchange(
      st,
      $,
      c.id,
      {
        kind: 'endOfTurn',
        ...(commentAfterEachTurn !== null ? { commentAfterEachTurn } : {}),
        ...(warned !== null ? { warned } : {}),
        ...(promptToMainChat !== null ? { promptToMainChat } : {}),
        ...(suggestNextPrompt !== null ? { suggestNextPrompt } : {}),
      },
      turnId,
    );
  }
  // The buddy's own notes, rewritten; a reply with no MEMORY line keeps the ones it had.
  if (reply?.memory) rememberNotes(st, $, c.id, voice(c), reply.memory);
  if (promptToMainChat !== null) sendPromptToMainChat(st, $, c, promptToMainChat);
}

/**
 * The buddy's own prompt to the main chat (promptToMainChat), `text`, once its
 * turn's exchange is filed: disarmed first, so the turn it starts never sends
 * another until a prompt of the user's re-arms it; submitted as this plugin's,
 * never awaited, a refusal logged; once it entered, shown (showSentPrompt).
 */
function sendPromptToMainChat(st: State, $: EngineInterface, c: Character, text: string): void {
  st.mainChatPromptArmed = false;
  st.pendingMainChatPrompt = text;
  try {
    $.prompt
      .submit({ text })
      .then((r) => {
        if (r.drop === undefined) showSentPrompt(st, $, c, text);
        else lg($, 'info', 'promptToMainChat.dropped', { character: c.id, reason: r.drop });
      })
      .catch((error: unknown) => log($, "sending the buddy's prompt to the main chat", error));
    lg($, 'info', 'promptToMainChat.sent', { character: c.id, length: text.length });
  } catch (error) {
    log($, "sending the buddy's prompt to the main chat", error);
  }
}

/** The prompt the buddy sent Claude, in the bubble addressed to Claude (its yellow words), waiting its turn behind the turn's own bubble; never while hidden. */
function showSentPrompt(st: State, $: EngineInterface, c: Character, text: string): void {
  const b = st.b;
  if (!b || st.hidden) return;
  try {
    answer(b, text, null, c.id, true, undefined, 'claude');
  } catch (error) {
    log($, "showing the buddy's prompt to the main chat", error);
  }
  refresh(st, $);
}

/** How the bubble says a verdict: a shortcut warned of, a wrong move screamed; a right one says nothing over the comment. */
const VERDICT_BUBBLE: Record<Verdict, { tone: Tone; pose: Pose | null } | null> = { RIGHT: null, SHORTCUT: { tone: 'warn', pose: null }, WRONG: { tone: 'alarm', pose: 'oops' } };

/**
 * A SHORTCUT or WRONG verdict of `c` in the bubble, its tone's frame, marking
 * turn `gen` loud so its comment never covers it; a model bubble already
 * there keeps the bubble its 10 s first (answer). `reason`: why the call gave none. Returns the words when the
 * bubble said them, else null.
 */
function sayVerdict(st: State, $: EngineInterface, c: Character, gen: number, v: { verdict: Verdict; why: string } | null, reason: string, fields: Record<string, number>): string | null {
  const b = st.b;
  if (!b) return null;
  let said: string | null = null;
  try {
    if (!v) {
      lg($, 'info', 'verdict.outcome', reason ? { outcome: 'failed', reason, ...fields } : { outcome: 'none', ...fields });
      return null;
    }
    const loud = VERDICT_BUBBLE[v.verdict];
    if (!loud) {
      lg($, 'info', 'verdict.outcome', { outcome: 'quiet', verdict: v.verdict, ...fields });
      return null;
    }
    const shown = !st.hidden && answer(b, v.why, loud.pose, c.id, true, loud.tone);
    if (shown) {
      said = v.why;
      st.loudGen = gen;
    }
    const outcome = shown ? 'said' : st.hidden ? 'hidden' : 'dropped';
    lg($, 'info', 'verdict.outcome', { outcome, verdict: v.verdict, ...fields });
  } catch (error) {
    log($, 'a verdict', error);
  }
  refresh(st, $);
  return said;
}

/**
 * The commentAfterEachTurn of `c` in the bubble, or the failure why there is none;
 * a model bubble already there keeps the bubble its 10 s first (answer).
 * Never said by another character drawn meanwhile, nor over this turn's
 * verdict (`outranked`: the drawer and the memory still keep it). `fields`: ms
 * and usage, logged on the outcome. Returns the text when the bubble showed
 * it or a verdict outranked it, else null.
 */
function sayCommentAfterEachTurn(st: State, $: EngineInterface, c: Character, t: TurnSummary, gen: number, text: string | null, reason: string, fields: Record<string, number>): string | null {
  const b = st.b;
  if (!b) return null;
  let said: string | null = null;
  try {
    if (text) {
      // Hidden by /buddy off while the model wrote it: never shown, so never remembered.
      // This turn's verdict, a warning or a scream, keeps the bubble: the comment goes to the drawer and the memory only.
      const outranked = !st.hidden && st.loudGen === gen;
      const shown = !st.hidden && !outranked && answer(b, text, t.failures > 0 ? 'oops' : 'yay', c.id, true);
      if (shown || outranked) said = text;
      const outcome = shown ? 'answered' : outranked ? 'outranked' : st.hidden ? 'hidden' : 'dropped';
      lg($, 'info', 'commentAfterEachTurn.outcome', { outcome, ...(outcome === 'dropped' ? { asker: c.id, drawn: b.character.id } : {}), ...fields });
    } else {
      say($, `a commentAfterEachTurn got no answer: ${reason}`);
      const shown = failAnswer(b, reason, c.id, true);
      lg($, 'info', 'commentAfterEachTurn.outcome', { outcome: shown ? 'failed' : 'dropped', reason, ...fields });
    }
  } catch (error) {
    log($, 'a commentAfterEachTurn', error);
  }
  refresh(st, $);
  return said;
}

/** The suggestNextPrompt into the prompt box; none, or a failed call, gives this turn's up. `fields`: the turn's end to the reply (`ms`), logged on the outcome. Returns the text when the box showed it, else null. */
async function showSuggestNextPrompt(st: State, $: EngineInterface, gen: number, text: string | null, reason: string, fields: Record<string, number>): Promise<string | null> {
  if (text === null) {
    lg($, 'info', 'suggestNextPrompt.outcome', reason ? { outcome: 'failed', reason, ...fields } : { outcome: 'none', ...fields });
    await giveUpSuggestNextPrompt(st, $, gen, fields.ms ?? 0);
    return null;
  }
  // A later turn ended or started, /clear, or /buddy off came meanwhile: this one is never proposed.
  if (gen !== st.turnGen || st.hidden || st.mainTurn !== undefined) {
    lg($, 'info', 'suggestNextPrompt.outcome', { outcome: 'stale', ...fields });
    return null;
  }
  const { isShown } = await $.prompt.suggest({ text });
  if (isShown) st.shownSuggestion = text;
  roundEvent(st, $, eventLine(Date.now(), `OUT · prompt-box suggestion (the buddy's)${isShown ? '' : ' (not shown)'}: ${JSON.stringify(text)}`));
  // Not shown because a turn started while it was proposed: stale, not the engine's refusal.
  lg($, 'info', 'suggestNextPrompt.outcome', { outcome: suggestNextPromptOutcome(isShown, st.mainTurn !== undefined), length: text.length, ...fields });
  if (!isShown) return null;
  // The engine's own suggestion, held for this turn, lost to the buddy's: released now, as what happened.
  if (st.harnessSuggestion !== null) {
    st.harnessSuggestion = null;
    lg($, 'info', 'suggestNextPrompt.outcome', { outcome: 'harness-replaced' });
  }
  return text;
}

/** The buddy has no suggestNextPrompt for turn `gen`: the engine's own, held back meanwhile, is shown, and a later one passes. `ms`: the turn's end to the reply, logged on the outcome. */
async function giveUpSuggestNextPrompt(st: State, $: EngineInterface, gen: number, ms: number): Promise<void> {
  if (gen !== st.turnGen) return;
  st.suggestNextPromptGaveUp = true;
  const text = st.harnessSuggestion;
  st.harnessSuggestion = null;
  if (text === null) return;
  // Hidden, or a turn started meanwhile (the engine's suggestion was for the ended turn): released unshown, said as which.
  const released = heldSuggestionRelease(st.hidden, st.mainTurn !== undefined);
  if (released) {
    lg($, 'info', 'suggestNextPrompt.outcome', { outcome: released, ms });
    return;
  }
  const { isShown } = await $.prompt.suggest({ text });
  roundEvent(st, $, eventLine(Date.now(), `OUT · prompt-box suggestion (Claude Code's own)${isShown ? '' : ' (not shown)'}: ${JSON.stringify(text)}`));
  lg($, 'info', 'suggestNextPrompt.outcome', { outcome: isShown ? 'harness-shown' : 'harness-not-shown', ms });
}

// ---- the original companion ---------------------------------------------

/** A JSON file, parsed: an error names the file and why, never its contents. */
async function readJson($: EngineInterface, path: string, shown: string): Promise<{ value?: unknown; error?: string }> {
  let text: unknown;
  try {
    text = await $.fs.read(path);
  } catch (error) {
    return { error: `couldn't read ${shown}: ${message(error)}` };
  }
  if (typeof text !== 'string') return { error: `couldn't read ${shown}: not text` };
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    // The parser's message may quote the file: only its kind is said.
    return { error: `couldn't parse ${shown}: not valid JSON (${error instanceof Error ? error.name : typeof error})` };
  }
}

/** Where Claude Code keeps its config: CLAUDE_CONFIG_DIR, else HOME. */
async function sourcesOf($: EngineInterface): Promise<ConfigSources | { error: string }> {
  try {
    return configSources({ HOME: await $.env.get('HOME'), CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR') });
  } catch (error) {
    log($, 'reading CLAUDE_CONFIG_DIR and HOME', error);
    return { error: `couldn't read CLAUDE_CONFIG_DIR or HOME: ${message(error)}` };
  }
}

/** The species template, and the hat art when the companion wears a hat. */
async function loadArt($: EngineInterface, r: Roll): Promise<{ template?: SpeciesTemplate; hats: HatArt; error?: string }> {
  const dir = `${$.plugin.root}/species`;
  const species = r.bones.species;
  const file = await readJson($, `${dir}/${species}.json`, `species/${species}.json`);
  if (file.error) return { hats: {}, error: file.error };
  const v = validateSpecies(file.value, species);
  if (!v.ok) return { hats: {}, error: `species/${species}.json is invalid: ${v.error}` };
  if (r.bones.hat === 'none') return { template: v.template, hats: {} };
  const hats = await readJson($, `${dir}/hats.json`, 'species/hats.json');
  if (hats.error) return { hats: {}, error: hats.error };
  const h = validateHats(hats.value);
  if (!h.ok) return { hats: {}, error: `species/hats.json is invalid: ${h.error}` };
  return { template: v.template, hats: h.hats };
}

/** The newest backup of the config that parses and holds a companion; `notes` says what could not be looked at. */
async function backupSoul($: EngineInterface, src: ConfigSources, notes: string[]): Promise<{ soul: Soul; label: string } | null> {
  const listed: (Listed & { path: string; label: string })[] = [];
  for (const d of src.backupDirs) {
    try {
      // No backups folder is no backups; a folder that cannot be listed is said.
      if (d.where === 'folder' && !(await $.fs.exists(d.dir))) continue;
      for (const f of await $.fs.list(d.dir)) listed.push({ name: f.name, where: d.where, kind: f.kind, size: f.size, path: `${d.dir}/${f.name}`, label: `${d.shown}/${f.name}` });
    } catch (error) {
      log($, `listing ${d.shown} for backups`, error);
      notes.push(`Couldn't list ${d.shown} to look for backups: ${message(error)}`);
    }
  }
  // Names and listed sizes first, so only real backups are dated; then the newest few by date.
  const named = backupCandidates(listed, { ...BACKUP_LIMITS, maxCount: Number.POSITIVE_INFINITY });
  const dated = await Promise.all(
    named.keep.map(async (c) => {
      try {
        const s = await $.fs.stat(c.path);
        return { ...c, kind: s.kind, size: s.size, mtimeMs: s.mtimeMs };
      } catch (error) {
        log($, `reading the date of ${c.label}`, error);
        return c;
      }
    }),
  );
  const picked = backupCandidates(dated);
  for (const d of [...named.dropped, ...picked.dropped]) lg($, 'debug', 'backup.dropped', { where: d.where, name: d.name, reason: d.reason });
  let skipped = 0;
  for (const c of picked.keep) {
    const j = await readJson($, c.path, c.label);
    if (j.error) {
      skipped++;
      say($, `skipping a backup: ${j.error}`);
      continue;
    }
    const s = companionOf(j.value);
    if (s.soul) return { soul: s.soul, label: c.label };
  }
  if (skipped > 0) notes.push(`Skipped ${skipped} backup${skipped === 1 ? '' : 's'} that did not read or parse.`);
  return null;
}

/** Claude Code's config, read and never written: the identity it rolls from, and its companion when it has one. */
async function readConfig($: EngineInterface): Promise<{ identity: string; sources: ConfigSources; soul?: Soul } | { error: string }> {
  const sources = await sourcesOf($);
  if ('error' in sources) return { error: sources.error };
  const shown = sources.shownConfig;
  const config = await readJson($, sources.configFile, shown);
  if (config.error !== undefined) return { error: config.error };
  const companion = companionOf(config.value);
  if (companion.error) return { error: `${shown} has a companion, but ${companion.error}` };
  const identity = identityOf(config.value);
  return companion.soul ? { identity, sources, soul: companion.soul } : { identity, sources };
}

/** One roll of the original, drawn: the Character, or why its art will not draw. */
async function rollOriginal($: EngineInterface, identity: string, soul: Soul, variant: Variant): Promise<{ character?: Character; error?: string }> {
  const r = roll(identity, variant);
  const art = await loadArt($, r);
  if (!art.template) return { error: art.error ?? `no species art for the ${r.bones.species}` };
  const v = originalCharacter({ soul, bones: r.bones, variant, template: art.template, hats: art.hats });
  return v.ok ? { character: v.character } : { error: v.error };
}

/** The "Yours" group: the companion in ~/.claude.json, else the newest backup holding one, rolled both ways. */
async function findOriginals($: EngineInterface): Promise<Originals> {
  const config = await readConfig($);
  if ('error' in config) {
    say($, `Personalities: ${config.error}`);
    return { kind: 'error', error: config.error };
  }
  const notes: string[] = [];
  let soul = config.soul;
  let from: string | undefined;
  if (!soul) {
    const backup = await backupSoul($, config.sources, notes);
    if (backup) ({ soul, label: from } = backup);
  }
  if (!soul) return { kind: 'none', notes };
  const rolls: { variant: Variant; character?: Character; error?: string }[] = [];
  for (const variant of VARIANTS) {
    const r = await rollOriginal($, config.identity, soul, variant);
    if (r.error) say($, `the ${variant} roll of your original companion will not draw: ${r.error}`);
    rolls.push({ variant, ...r });
  }
  return from === undefined ? { kind: 'found', soul, notes, rolls } : { kind: 'found', soul, from, notes, rolls };
}

/** At start, with the original chosen: its saved soul and roll, the identity read again, no backup scan. */
async function restoreOriginal(st: State, $: EngineInterface): Promise<void> {
  let error = '';
  try {
    const saved = st.saved;
    if (!saved) error = `no original companion saved; the drawer's personality tab (/${COMMAND}) picks one`;
    else {
      const config = await readConfig($);
      if ('error' in config) error = config.error;
      else {
        const r = await rollOriginal($, config.identity, saved.soul, saved.variant);
        if (r.character) st.original = { id: ORIGINAL_ID, source: 'original', character: r.character };
        else error = r.error ?? 'its art will not draw';
      }
    }
  } catch (err) {
    log($, 'restoring the original companion', err);
    error = message(err);
  }
  if (error) st.original = { id: ORIGINAL_ID, source: 'original', error };
  if (st.original) st.roster = withEntry(st.roster, st.original);
}

// ---- the drawer's personality tab -----------------------------------------

/** The personality tab: every character to pick from, the focus and the preview on the one drawn now. */
async function openPersonality(st: State, $: EngineInterface): Promise<void> {
  const b = st.b;
  if (!b) return;
  st.drawer.tab = 'personality';
  lg($, 'info', 'personality.open', { current: b.character.id });
  $.ui.invalidate('ui.render');
  const originals = await findOriginals($);
  const model = buildMenu({ roster: st.roster, shippedError: st.shippedError, customCharactersDir: { isSet: Boolean(st.options.customCharactersDir), error: st.customCharactersDirError }, originals });
  const current = currentKeyOf(b.character.id, st.saved?.variant);
  const focused = findItem(model, current) ? current : (allItems(model)[0]?.key ?? '');
  // Left for the talk tab while it was built: never drawn over it.
  if (st.drawer.tab !== 'personality') return;
  st.menu = { model, current, focused, soul: originals.kind === 'found' ? originals.soul : null };
  $.ui.invalidate('ui.render');
}

/** Back to the talk tab. */
function showTalk(st: State, $: EngineInterface): void {
  st.drawer.tab = 'talk';
  st.menu = null;
  $.ui.invalidate('ui.render');
  scrollDrawerToEnd(st, $);
}

/**
 * ctrl+x n (`by` 1) or b (-1): the personality tab, opened if it is not,
 * lights the next or previous character, round the list, and switches to it
 * at once; one that cannot be drawn is lit, its preview saying why, and not picked.
 */
async function stepCharacter(st: State, $: EngineInterface, by: 1 | -1): Promise<void> {
  if (st.drawer.tab !== 'personality' || !st.menu) await openPersonality(st, $);
  const m = st.menu;
  if (!m) return;
  const items = allItems(m.model);
  if (items.length === 0) return;
  const at = items.findIndex((i) => i.key === m.focused);
  const item = items[(Math.max(0, at) + by + items.length) % items.length]!;
  m.focused = item.key;
  $.ui.invalidate('ui.render');
  if (item.character) await pickItem(st, $, item);
}

/** A character picked: switches and remembers the choice (the store's `character`); the new one greets, the tab stays open on it. */
async function pickItem(st: State, $: EngineInterface, item: Item): Promise<void> {
  const b = st.b;
  const menu = st.menu;
  if (!b || !menu) return;
  const c = item.character;
  if (!c) {
    say($, `Can't pick ${item.label}: ${item.error}`);
    return;
  }
  let note = '';
  if (item.pick.kind === 'original') {
    if (!menu.soul) {
      say($, `Can't pick ${item.label}: its soul was not found`);
      return;
    }
    st.original = { id: ORIGINAL_ID, source: 'original', character: c };
    st.roster = withEntry(st.roster, st.original);
    st.saved = { variant: item.pick.variant, soul: menu.soul };
    st.storeChoice = ORIGINAL_ID;
    note += await save($, 'character', ORIGINAL_ID);
    note += await save($, 'original', st.saved);
  } else {
    st.storeChoice = item.pick.id;
    note += await save($, 'character', item.pick.id);
  }
  setCharacter(b, c, undefined, Math.random);
  L.context.character = c.id;
  lg($, 'info', 'personality.pick', { id: c.id, kind: item.pick.kind, saved: !note });
  if (note) speak(b, `${c.name} is here${note}`, 'oops', ERROR_MS);
  menu.current = item.key;
  startClock(st, $);
  st.lastKey = '';
  $.ui.invalidate('ui.render');
}

// ---- the drawer: /buddy, the band above the prompt opened ------------------

/** What the drawer draws from, now; null before the buddy is loaded. */
function drawerView(st: State, feed: readonly FeedEntry[], cols: number, rows: number): DrawerView | null {
  const b = st.b;
  if (!b) return null;
  const now = Date.now();
  const status = st.hidden ? 'hidden' : st.asking || st.calls > 0 ? 'thinking' : currentPose(b) === 'sleep' ? 'asleep' : 'idle';
  const pose = status === 'thinking' ? 'thinking' : status === 'asleep' ? 'sleep' : 'idle';
  return {
    feed,
    now,
    frame: st.drawer.frame,
    name: b.character.name,
    color: spriteColor(b.character, now),
    sprite: frameAt(b.character, pose, st.drawer.frame),
    status,
    engine: `${st.options.model} · ${st.options.effort}`,
    pets: b.pets,
    turnsRemembered: st.options.chatTurnsToRead,
    tab: st.drawer.tab,
    menu: st.drawer.tab === 'personality' ? st.menu : null,
    cols,
    rows,
  };
}

/** A suggestion into the prompt box, said when the box refuses it. */
function useSuggestion($: EngineInterface, text: string): void {
  $.prompt
    .fill({ text })
    .then((r) => {
      lg($, 'info', 'drawer.use', { filled: r.isFilled });
      if (!r.isFilled) $.ui.toast(`Couldn't put it in the prompt box${'reason' in r && r.reason ? `: ${String(r.reason)}` : ''}`);
    })
    .catch((error: unknown) => log($, 'putting a suggestion in the prompt box', error));
}

/** The drawer's ask box: its unsent text, and Enter asking the buddy whatever it says. */
function askBox(st: State, $: EngineInterface): { draft: string; setDraft: (text: string) => void; ask: (text: string) => void } {
  return {
    draft: st.drawer.draft,
    setDraft: (t) => {
      st.drawer.draft = t;
    },
    ask: (t) => {
      if (!t.trim()) return;
      st.drawer.draft = '';
      $.ui.invalidate('ui.render');
      runCommand(st, $, t, true)
        .then((r) => {
          if (!r.text.startsWith('Asked ')) $.ui.toast(r.text);
        })
        .catch((error: unknown) => log($, 'asking from the drawer', error));
    },
  };
}

/** The drawer's window over its thread moved to the newest, once it is drawn. */
function scrollDrawerToEnd(st: State, $: EngineInterface): void {
  const id = st.drawer.bandId;
  if (!id || st.drawer.tab !== 'talk') return;
  $.clock.after(0, () => {
    $.ui.scroll({ to: 'end', in: id }).catch((error: unknown) => log($, 'scrolling the drawer to its newest', error));
  });
}

/** /buddy: the band above the prompt opens into the drawer, or folds back into the buddy; its clock runs while it is open. */
function toggleDrawer(st: State, $: EngineInterface): { text: string } {
  if (!st.b) return { text: 'buddy is still starting; try again in a moment' };
  const d = st.drawer;
  d.open = !d.open;
  if (d.open) {
    loadMemory(st, $);
    d.timer ??= $.clock.every(DRAWER_MS, () => {
      d.frame++;
      $.ui.invalidate('ui.render');
    });
    scrollDrawerToEnd(st, $);
  } else {
    d.timer?.cancel();
    d.timer = null;
    d.tab = 'talk';
    st.menu = null;
  }
  lg($, 'info', d.open ? 'drawer.open' : 'drawer.close', {});
  $.ui.invalidate('ui.render');
  return { text: d.open ? `The drawer is open above your prompt: ${DRAWER_KEYS}.` : 'The drawer folded back.' };
}

/** The drawer in the band above the prompt; a thread taller than the band scrolls in it. */
async function drawDrawerBand(st: State, $: EngineInterface, e: { surface: string; requestId: string; props: BandProps }): Promise<RenderElement | null> {
  const E = $.ui.resolve(e as never) as unknown as Elements;
  const first = st.drawer.bandId === '';
  st.drawer.bandId = e.requestId;
  if (first) scrollDrawerToEnd(st, $);
  const feed = await read($, FEED);
  const v = drawerView(st, feed, e.props.bodyColumns, e.props.maxRows);
  if (!v) return null;
  return drawDrawer(E, v, {
    use: (text) => useSuggestion($, text),
    ...askBox(st, $),
    close: () => toggleDrawer(st, $),
    pet: () => {
      runCommand(st, $, '', false, true).catch((error: unknown) => log($, 'petting from the drawer', error));
    },
    tab: () => {
      if (st.drawer.tab === 'talk') openPersonality(st, $).catch((error: unknown) => log($, 'opening the personality tab', error));
      else showTalk(st, $);
    },
    step: (by) => {
      stepCharacter(st, $, by).catch((error: unknown) => log($, 'switching the character', error));
    },
  });
}

// ---- command.run: /buddy ------------------------------------------------

async function save($: EngineInterface, key: string, value: unknown): Promise<string> {
  try {
    if (value === undefined) await $.store.delete(key);
    else await $.store.set(key, value);
    return '';
  } catch (error) {
    log($, `saving ${key}`, error);
    return ` (not saved: ${message(error)})`;
  }
}

/** `hidden` saved: a read of it begun before or during the save holds an older value, and is dropped. */
async function saveHidden(st: State, $: EngineInterface, hidden: boolean): Promise<string> {
  st.hiddenGen++;
  st.hiddenSaves++;
  try {
    return await save($, 'hidden', hidden);
  } finally {
    st.hiddenSaves--;
    st.hiddenGen++;
  }
}

/** A model result as log fields: never the whole text. */
function shape(r: ModelCompleteResult | 'timeout'): LogFields {
  if (r === 'timeout') return { timeout: true };
  return r.isAnswered ? { isAnswered: true, length: r.text.length, head: r.text.slice(0, 80) } : { isAnswered: false, reason: r.reason };
}

/**
 * One /buddy question of `c` to its outcome, always visible: an answer, or
 * "{name} couldn't answer: {reason}" in the bubble. `model` answers
 * from persona, chatTurnsToRead (what `c` remembers of the main chat's last turns and
 * of what it and the user said around them, before this question) and question, whether or not
 * the main turn is running. One deadline, from the question's start, covers
 * the chatTurnsToRead read, the settings and the completion.
 */
async function ask(st: State, $: EngineInterface, question: string, c: Character): Promise<void> {
  const b = st.b;
  if (!b) {
    st.asking = null;
    return;
  }
  const started = st.asking?.since ?? Date.now();
  // The conversation it is asked in: a /clear or resume before the answer drops it.
  const conversation = st.conversation;
  // The turn it is asked after: its exchange is filed there, however many turns end before the answer.
  const after = st.lastTurnId;
  const ms = Math.max(0, COMPLETE_DEADLINE_MS - (Date.now() - started));
  let cleared = false;
  let said = '';
  let reason = '';
  // The prompt the question asked for, put in the prompt box after the answer.
  let asked: { prompt: string | null; tooLong: boolean } = { prompt: null, tooLong: false };
  // What the calls sent so far cost, the first's kept whatever the retry does: a timeout or a throw still logs it.
  let paid: unknown;
  // The answer belongs to the one asked: a character switched in meanwhile never says it.
  let shown = true;
  let late = false;
  try {
    const r: ModelCompleteResult | 'timeout' = await within(
      sleeper($),
      (async (): Promise<ModelCompleteResult | 'timeout'> => {
        const t0 = await $.clock.now();
        // The chatTurnsToRead and the settings do not wait on each other.
        const [remembered, settings] = await Promise.all([readChatTurnsToRead(st, $, c, ms), callSettings(st, $, 'ask.settings')]);
        // Past the deadline already: no completion is sent that nobody waits for.
        if (late) return 'timeout' as const;
        // A completion does not see the chat: the chatTurnsToRead tells it where the chat stands.
        const prompt = questionPrompt(question, remembered.text);
        lg($, 'debug', 'ask.prompt', { length: prompt.length });
        // Abandoned the margin past the deadline, however late it is sent.
        const send = async (): Promise<ModelCompleteResult> =>
          completeRecorded(st, $, 'question', { ...settings, system: oneLineSystem(c.persona, st.options.chatTurnsToRead), prompt, maxTokens: QUESTION_MAX_TOKENS, timeoutMs: requestTimeoutMs(ms, (await $.clock.now()) - t0) }, remembered.memory);
        const first = await send();
        paid = first.usage;
        const leftMs = ms - ((await $.clock.now()) - t0);
        if (late || !retriesEmpty(first, leftMs)) return first;
        // The model returned no words and the question is still open: asked once more, its outcome counting both calls.
        lg($, 'debug', 'ask.retry', { reason: 'empty reply', leftMs });
        const again = await send();
        paid = sumUsage(first.usage, again.usage);
        return { ...again, usage: paid } as ModelCompleteResult;
      })(),
      ms,
    );
    late = r === 'timeout';
    lg($, 'debug', 'ask.result', shape(r));
    const reply = r !== 'timeout' && r.isAnswered ? parseAskReply(r.text) : null;
    if (reply) asked = { prompt: reply.prompt, tooLong: reply.tooLong };
    // A reply that is the prompt alone still answers.
    const text = reply ? reply.answer || (reply.prompt ? 'In your prompt box.' : '') : '';
    if (conversation !== st.conversation) {
      // Asked about a conversation /clear or a resume ended: never shown as an answer about this one, never remembered in it.
      cleared = true;
      reason = 'the conversation it was asked in ended';
      shown = failAnswer(b, reason, c.id);
    } else if (text) {
      said = text;
      // Hidden by /buddy off while it thought: the answer is never drawn, so never remembered as said.
      shown = !st.hidden && answer(b, text, null, c.id);
    } else {
      reason = r === 'timeout' ? deadlineReason(COMPLETE_DEADLINE_MS) : r.isAnswered ? 'empty reply' : noAnswerReason(r);
      say($, `a /buddy question got no answer: ${reason}`);
      shown = failAnswer(b, reason, c.id);
    }
  } catch (error) {
    if (conversation !== st.conversation) {
      // Failed after /clear or a resume: dropped as an answer is, never a failure about the old chat shown in this one.
      cleared = true;
      reason = 'the conversation it was asked in ended';
      L.error('a /buddy question', error, { dropped: true });
      shown = failAnswer(b, reason, c.id);
    } else {
      reason = message(error);
      log($, 'a /buddy question', error);
      shown = failAnswer(b, reason, c.id);
    }
  } finally {
    st.asking = null;
    endQuestion(b);
  }
  // What the calls cost and how much they read from the prompt cache.
  const usage = usageFields(paid);
  if (cleared) {
    warn($, 'ask.dropped', `${c.name}'s answer was dropped: the conversation it was asked in ended`, { asker: c.id });
    lg($, 'info', 'ask.outcome', { outcome: 'dropped', reason, ms: Date.now() - started, ...usage });
    refresh(st, $);
    return;
  }
  const hidden = !shown && st.hidden;
  if (!shown && !hidden) warn($, 'ask.dropped', `${c.name}'s answer was dropped: ${b.character.name} is drawn now`, { asker: c.id, drawn: b.character.id });
  lg($, 'info', 'ask.outcome', { outcome: hidden ? 'hidden' : !shown ? 'dropped' : said ? 'answered' : 'failed', ...(reason ? { reason } : {}), ms: Date.now() - started, ...usage });
  // The drawer: the answer, or why there is none.
  const tokens = tokensOf(usage);
  if (said && shown) feedAdd(st, $, { at: Date.now(), kind: 'answer', text: said, ...voice(c), ms: Date.now() - started, ...(tokens ? { tokens } : {}) });
  else if (reason) feedAdd(st, $, { at: Date.now(), kind: 'failed', text: reason, ...voice(c), ms: Date.now() - started });
  if (said && shown) await putAskedPrompt(st, $, c, asked);
  // One exchange: the question with its answer as shown, or the question alone.
  rememberExchange(st, $, c.id, said && shown ? { kind: 'question', question, answer: said } : { kind: 'question', question }, after);
  refresh(st, $);
}

/** The prompt a /buddy question asked for, into the prompt box and the drawer as an idea ctrl+x u uses; one too long to take is said, never dropped quietly. Never throws. */
async function putAskedPrompt(st: State, $: EngineInterface, c: Character, asked: { prompt: string | null; tooLong: boolean }): Promise<void> {
  try {
    if (asked.tooLong) {
      say($, `${c.name}'s prompt was longer than ${ASKED_PROMPT_MAX_CHARS} characters, so it was not put in your prompt box`);
      feedAdd(st, $, { at: Date.now(), kind: 'failed', text: `its prompt passed ${ASKED_PROMPT_MAX_CHARS} characters`, ...voice(c) });
      lg($, 'info', 'ask.prompt.outcome', { outcome: 'too-long' });
      return;
    }
    if (asked.prompt === null) return;
    feedAdd(st, $, { at: Date.now(), kind: 'suggest', text: asked.prompt, ...voice(c) });
    // A turn running now owns the prompt box: the idea waits in the drawer for ctrl+x u.
    if (st.mainTurn !== undefined) {
      lg($, 'info', 'ask.prompt.outcome', { outcome: 'turn-running', length: asked.prompt.length });
      return;
    }
    const { isShown } = await $.prompt.suggest({ text: asked.prompt });
    if (isShown) st.shownSuggestion = asked.prompt;
    roundEvent(st, $, eventLine(Date.now(), `OUT · prompt-box suggestion (asked of the buddy)${isShown ? '' : ' (not shown)'}: ${JSON.stringify(asked.prompt)}`));
    lg($, 'info', 'ask.prompt.outcome', { outcome: isShown ? 'shown' : 'not-shown', length: asked.prompt.length });
  } catch (error) {
    log($, "putting a /buddy answer's prompt in the prompt box", error);
  }
}

/** /buddy with `args`; `asQuestion` (the drawer's ask box) takes them as a question whatever they say, `off` or `help` too. */
async function runCommand(st: State, $: EngineInterface, args: string, asQuestion = false, petting = false): Promise<{ text: string }> {
  const b = st.b;
  if (!b) return { text: 'buddy is still starting; try again in a moment' };
  const action: Action = asQuestion ? { kind: 'question', text: args.trim() } : petting ? { kind: 'pet' } : parseCommand(args);
  lg($, 'info', 'command', { name: COMMAND, kind: action.kind, argsLength: args.trim().length });
  // This call took the one question slot: a failure before its ask ends frees it and ends the thinking line.
  let began = false;
  try {
    switch (action.kind) {
      case 'drawer':
        return toggleDrawer(st, $);
      case 'pet': {
        // Another session sharing the store may have petted it since: its count is the floor.
        try {
          const stored = await $.store.get('pets');
          if (typeof stored === 'number' && Number.isFinite(stored) && stored > b.pets) b.pets = stored;
        } catch (error) {
          log($, 'reading the pet count back', error);
        }
        pet(b, Math.random);
        st.pets = b.pets;
        const note = await save($, 'pets', b.pets);
        refresh(st, $);
        return { text: `${b.character.name}: ${b.pets} pets${note}` };
      }
      case 'off': {
        const line = farewell(b, Math.random);
        heard(st, $);
        st.hidden = true;
        // Stopped before the save: no clock tick reads the store back while it is written.
        stopClock(st);
        const note = await saveHidden(st, $, true);
        $.ui.invalidate('ui.render');
        return { text: `${b.character.name}: "${line}" (hidden; /buddy on brings ${b.character.name} back)${note}` };
      }
      case 'on': {
        // Lines said while hidden were never shown: dropped, not remembered.
        heard(st, $);
        st.hidden = false;
        const note = await saveHidden(st, $, false);
        // The greeting is the line shown: a wake line under it would be remembered unseen.
        wake(b, Math.random, { silent: true });
        greet(b, Math.random);
        startClock(st, $);
        st.lastKey = '';
        $.ui.invalidate('ui.render');
        return { text: `${b.character.name} is back${note}` };
      }
      case 'reload': {
        await loadRoster(st, $);
        applyChoice(st, $);
        startClock(st, $);
        refresh(st, $);
        const bad = st.roster.entries.filter((e) => !e.character).length;
        return { text: `Reloaded ${st.roster.entries.length} characters (${bad} invalid); drawing ${b.character.name}` };
      }
      case 'help':
        return { text: [USAGE, ...st.options.errors].join('\n') };
      case 'moved':
        return { text: `Switching characters moved to the drawer's personality tab: /${COMMAND} opens it.` };
      case 'log': {
        if (!L.file) return { text: 'No log file: the option logFile is empty (failures still go to the debug log).' };
        try {
          const lines = await L.tail(logIO($));
          return { text: [`Log: ${L.file}`, ...(lines.length > 0 ? lines : ['(empty)'])].join('\n') };
        } catch (error) {
          log($, 'reading the log', error, { file: L.file });
          return { text: `Log: ${L.file}\n(couldn't read it: ${message(error)})` };
        }
      }
      case 'question': {
        if (st.hidden) return { text: `${b.character.name} is hidden; /buddy on first` };
        const c = b.character;
        // One question at a time, and a refused one says so: never silence.
        if (st.asking) {
          refuseQuestion(b);
          refresh(st, $);
          lg($, 'info', 'ask.outcome', { outcome: 'refused', reason: 'still thinking', ms: 0, pendingMs: Date.now() - st.asking.since });
          return { text: stillThinking(c.name) };
        }
        st.asking = { since: Date.now() };
        began = true;
        lg($, 'info', 'ask.start', { length: action.text.length });
        lg($, 'debug', 'ask.question', { question: action.text });
        feedAdd(st, $, { at: Date.now(), kind: 'ask', text: action.text });
        // The thinking line at once; ask reads the chatTurnsToRead, the question joining it with its answer.
        beginQuestion(b, Math.random);
        refresh(st, $);
        ask(st, $, action.text, c).catch((error) => {
          st.asking = null;
          log($, 'a /buddy question', error);
          endQuestion(b);
          failAnswer(b, message(error), c.id);
          refresh(st, $);
        });
        const trouble = st.chatTurnsToReadError;
        st.chatTurnsToReadError = '';
        return { text: `Asked ${c.name}.${trouble ? ` (Its chatTurnsToRead: ${trouble})` : ''}` };
      }
    }
  } catch (error) {
    if (began) {
      st.asking = null;
      endQuestion(b);
    }
    log($, `/buddy ${action.kind}`, error);
    return { text: `/buddy ${args.trim()} failed: ${message(error)}` };
  }
}

// ---- wiring, grouped by event -------------------------------------------

export const register: Register = (on: On, options: PluginOptions) => {
  const st: State = {
    options: resolveOptions(options as Record<string, unknown>),
    roster: mergeRoster([], []),
    b: null,
    storeChoice: undefined,
    original: null,
    saved: undefined,
    shippedError: undefined,
    customCharactersDirError: undefined,
    menu: null,
    hidden: false,
    pets: 0,
    timer: null,
    clockPeriod: 0,
    lastKey: '',
    lastTickError: '',
    chatTurnsToRead: null,
    chatFolder: null,
    chatTurnsToReadChain: newChain(),
    chatTurnsToReadWrites: latestWrites<Stored>(),
    chatTurnsToReadError: '',
    chatTurnsToReadHangSaid: false,
    asking: null,
    interactive: true,
    bandSeen: false,
    ticks: 0,
    sharedAt: 0,
    hiddenGen: 0,
    hiddenSaves: 0,
    turnGen: 0,
    harnessSuggestion: null,
    suggestNextPromptGaveUp: false,
    mainChatPromptArmed: false,
    pendingMainChatPrompt: undefined,
    userPrompts: 0,
    userPromptsAtCall: new Map(),
    shownSuggestion: null,
    takenPrompt: null,
    desire: null,
    loudGen: -1,
    inheritFailed: new Set(),
    mainEffort: undefined,
    prompts: NO_PROMPTS,
    mainTurn: undefined,
    tally: null,
    lastMainEndAt: undefined,
    usageFailSaid: false,
    conversation: 0,
    turnStarts: 0,
    lastTurnId: undefined,
    warned: false,
    round: null,
    roundBubble: null,
    roundsChain: Promise.resolve(),
    roundsFailed: false,
    calls: 0,
    feedChain: Promise.resolve(),
    drawer: { open: false, tab: 'talk', timer: null, frame: 0, draft: '', bandId: '' },
  };
  // Every log record, at any level, joins the round being written; the drawing's per-second records and a round write's own failure do not.
  tapped = st;
  L.tap = (r) => {
    if (r.event === 'band.scene' || r.event === 'clock.tick' || r.event === 'writing a round file') return;
    roundAppend(st, eventLine(r.at, `LOG ${r.level} ${r.event} ${capValue(r.fields)}`));
  };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    try {
      st.interactive = e.isInteractive !== false;
      await startSession(st, $);
    } catch (error) {
      log($, 'starting', error);
    }
    return result;
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (st.hidden && Date.now() - st.sharedAt >= SHARED_MS) syncHidden(st, $);
      const scene = bandScene(st, $, e.props);
      // The drawer takes the band's place, hidden buddy or not; a survey still wins.
      if (st.drawer.open && !e.props.hasSurvey) {
        const tree = await drawDrawerBand(st, $, e);
        if (tree) return tree;
      }
      if (!scene) return next(e);
      const { Box, Text } = $.ui.resolve(e);
      return drawBand(Box, Text, scene);
    } catch (error) {
      log($, 'drawing the band', error);
      return next(e);
    }
  });

  // A main-loop shell command's own edits are measured: the files it names, read before it runs and after.
  on('tool.call', async ($, e, next) => {
    const shell = await shellBefore(st, $, e);
    const r = await next(e);
    onToolCall(st, $, e, r);
    if (shell) await shellAfter($, shell);
    return r;
  });

  // What entered, once it did: a prompt a lower hook dropped starts no turn and is never filed. The buddy's suggestion sent unedited, and the buddy's own prompt to the main chat, carry, for Claude alone, whose words they hold.
  on('prompt.submit', async ($, e, next) => {
    const taken = takeSuggestion(st, $, e);
    const own = !taken && ownPrompt(st, $, e);
    if (own) st.pendingMainChatPrompt = undefined;
    const context = taken ? TAKEN_SUGGESTION_CONTEXT : own ? BUDDY_PROMPT_CONTEXT : null;
    const r = await next(context !== null ? { ...e, context: [...(e.context ?? []), context] } : e);
    onPromptSubmit(st, $, e, r, taken, own);
    return r;
  });

  // Each main turn's own prompt and id, before its first request: turn.step and turn.complete carry the id.
  on('turn.start', async ($, e, next) => {
    onTurnStart(st, $, e);
    return next(e);
  });

  // A /clear or a resume leaves the process on a fresh conversation, with no session.start: the old chat is forgotten.
  on('session.end', async ($, e, next) => {
    try {
      if (endsConversation(e.reason)) forgetConversation(st, $, e.reason);
    } catch (error) {
      log($, 'forgetting the cleared conversation', error);
    }
    return next(e);
  });

  // The running-turn marker and the prompt clear first: a hook beneath that throws never leaves the turn running.
  on('turn.complete', async ($, e, next) => {
    const ended = onTurnEnd(st, $, e);
    // A turn whose prompt the ledger lost reads it and its steps back from the transcript while the hooks beneath run; its origin stays unknown.
    const found = ended?.lost ? lostTurn($, e.turnId) : null;
    const r = await next(e);
    const lost = found ? await found : null;
    onTurnComplete(st, $, e, ended && lost?.prompt ? { ...ended, prompt: lost.prompt, lostSteps: lost.steps } : ended);
    return r;
  });

  // The main chat's effort reaches the plugin only on its requests: recorded, then the stream passes through untouched, and the request is counted with why it stopped.
  on('turn.step', async function* ($, e, next) {
    onTurnStep(st, $, e);
    const r = yield* next(e);
    onTurnStepped(st, $, e, r);
    return r;
  });

  // With suggestNextPrompt on, the engine's own guess is held back: the buddy's end-of-turn call writes suggestNextPrompt instead.
  on('prompt.suggest', async ($, e, next) => {
    try {
      if (dropsHarnessSuggestion(e.origin, st.options.suggestNextPrompt, st.hidden || st.b === null, st.suggestNextPromptGaveUp)) {
        st.harnessSuggestion = e.text;
        lg($, 'debug', 'suggestNextPrompt.harness-held');
        return { isShown: false };
      }
    } catch (error) {
      log($, 'a prompt.suggest hook', error);
    }
    const r = await next(e);
    // Whatever shows replaces the buddy's own in the box; the buddy's own call marks it again once shown.
    if (r.isShown) st.shownSuggestion = null;
    return r;
  });

  on('command.run', { command: COMMAND }, async ($, e) => {
    try {
      return await runCommand(st, $, e.args);
    } catch (error) {
      log($, `/${COMMAND}`, error);
      return { text: `/${COMMAND} failed: ${message(error)}` };
    }
  });

  // The main chat compacted: the buddy files the summary Claude now holds, as it files a turn.
  on('session.compact', async ($, e, next) => {
    const r = await next(e);
    try {
      if (r.messages && e.trigger !== 'precompute' && isMainLoop(e.agentId) && st.interactive) {
        const before = new Set(e.messages.map((m) => m.handle).filter((h): h is string => h !== undefined));
        // The summary is the message the compaction wrote: one the transcript did not hold before.
        const summary = r.messages.filter((m) => m.handle === undefined || !before.has(m.handle)).map((m) => m.text).filter((t) => t.trim()).join('\n\n');
        if (summary) rememberCompaction(st, $, summary);
        else lg($, 'info', 'compaction.remembered', { length: 0, reason: 'no summary message' });
      }
    } catch (error) {
      log($, 'remembering the compaction', error);
    }
    return r;
  });
};
