import type { EngineInterface, ModelForkResult, On, PluginOptions, Register, Timer, ToolCallInput, ToolCallResult, TurnCompleteInput } from 'claude-code';
import {
  COMPLETE_DEADLINE_MS, ERROR_MS, FORK_DEADLINE_MS, QUEUE_MAX_MS, answer, beginQuestion, createBrain, deadlineReason, endQuestion, noAnswerReason, refuseQuestion, endTurn, failAnswer, farewell, greet, holdsAnswer, isMainLoop, observeBand, period, pet,
  react, sceneOf, setCharacter, speak, tick, wake,
  type Brain,
} from '../src/brain.ts';
import type { Character } from '../src/character.ts';
import { USAGE, parseCommand } from '../src/command.ts';
import {
  MENU_COMMAND, MENU_PANE, MENU_TITLE, PREVIEW_MS, allItems, buildMenu, listWidth, currentKeyOf, findItem, menuRows, previewOf, rowLabel,
  type Item, type Menu, type Originals,
} from '../src/menu.ts';
import { MEMORY_KEY_PREFIX, MEMORY_SESSIONS, bookOf, recall, record, render, staleKeys, storeKey, type Book, type Exchange, type Stored } from '../src/memory.ts';
import { Logger, usageFields, type LogFields, type LogIO, type LogLevel } from '../src/log.ts';
import { INHERIT, expandHome, logPath, resolveEffort, resolveModel, resolveOptions, type Effort, type Options } from '../src/options.ts';
import {
  QUESTION_MAX_TOKENS, TURN_DEADLINE_MS, TURN_MAX_TOKENS, forkPrompt, oneLine, oneLineSystem, parseTurnReply, pushTurn, questionPrompt, recentTurns, stillThinking, turnForkPrompt, turnPrompt, turnSystem, type Turn, type TurnSummary, type TurnWants,
} from '../src/prompts.ts';
import { dropsHarnessSuggestion } from '../src/suggest.ts';
import { roll, type Roll, type Variant } from '../src/hatch.ts';
import {
  ORIGINAL_ID, VARIANTS, companionOf, identityOf, originalCharacter, savedOriginalOf,
  type SavedOriginal, type Soul,
} from '../src/original.ts';
import { BACKUP_LIMITS, backupCandidates, configSources, type ConfigSources, type Listed } from '../src/config-source.ts';
import { bashCommand, toolOutput } from '../src/reactions.ts';
import {
  choose, isCharacterFile, loadEntries, mergeRoster, startWarning, withEntry,
  type Entry, type LoadedFile, type Roster, type Source,
} from '../src/roster.ts';
import type { Scene } from '../src/scene.ts';
import { validateHats, validateSpecies, type HatArt, type SpeciesTemplate } from '../src/species.ts';

// The adapter: the only file touching `$`. Every decision lives in ../src/;
// this wires Claude Code's events to it, grouped by event, and draws the scene.

const COMMAND = 'buddy';
/** Every this many clock ticks a drawing session reads back `hidden`, which another session sharing the store may have set. */
const SHARED_TICKS = 15;
/** How often a hidden session, drawn, reads `hidden` back. */
const SHARED_MS = 3000;
/** Preview frames the menu pane may go undrawn before its clock stops: the pane is gone. */
const MENU_UNDRAWN_TICKS = 10;

type State = {
  options: Options;
  roster: Roster;
  b: Brain | null;
  storeChoice: string | undefined;
  /** The original companion's roster entry, once picked in the menu (or restored at a start). */
  original: Entry | null;
  /** The picked original's roll and soul, as saved: a restart draws it with no backup scan. */
  saved: SavedOriginal | undefined;
  /** Why characters/ or the characterDir could not be listed: the menu says it in the group. */
  shippedError: string | undefined;
  folderError: string | undefined;
  menu: MenuState | null;
  hidden: boolean;
  pets: number;
  timer: Timer | null;
  clockPeriod: number;
  lastKey: string;
  lastTickError: string;
  /** This session's memory as last loaded or written; loaded again when the session id changes (a start, a /clear, a reload). */
  memory: { sessionId: string; book: Book } | null;
  /** Every memory read and write, one after another, in the order made. */
  memoryChain: Promise<void>;
  /** The last memory failure, said in the next /buddy question's reply; '' when none since. */
  memoryError: string;
  /** The /buddy question waiting for its answer, one at a time; null when none. */
  asking: { since: number } | null;
  /** A tool ran since the last turn.complete, or the band reports work: the main turn is running. */
  turnBusy: boolean;
  /** The band has drawn in this session: before that (a headless session, ever) no line was shown, so none is remembered. */
  bandSeen: boolean;
  /** Clock ticks since the start, and when `hidden` was last read back from the store. */
  ticks: number;
  sharedAt: number;
  /** Bumped by this session's /buddy off and on, before and after saving: a read of `hidden` begun before the latest is stale and dropped. */
  hiddenGen: number;
  /** Saves of `hidden` in flight: a read of it landing meanwhile may hold the value before the save, and is dropped. */
  hiddenSaves: number;
  /** Bumped at each turn's prompt suggestion: a suggestion from an earlier turn is stale and never proposed. */
  suggestGen: number;
  /** The engine's own suggestion for this turn, held back while the buddy's end-of-turn call runs: shown if the buddy gives up. */
  harnessSuggestion: string | null;
  /** The buddy gave up on this turn's suggestion: the engine's own passes. */
  suggestGaveUp: boolean;
  /** The inherit reads (the main chat's model, its effort) that failed once and were logged; a later failure falls back in silence. */
  inheritFailed: Set<'model' | 'effort'>;
  /** The user's prompt of the running main turn, from prompt.submit: an answered turn files it into `turns`. */
  pendingPrompt: string;
  /** Questions asked while the main turn ran, each waiting to fork: the main thread's next turn.complete, of any reason, lets them go. */
  turnWaiters: (() => void)[];
  /** The main chat's last contextTurns answered turns, oldest first, read by the end-of-turn call and a question's completion. */
  turns: Turn[];
  /** The options' warnings were said: once, in the first greeting's bubble. */
  warned: boolean;
};

/** The open menu: its rows, the one drawn now, where the focus started and is, the preview's frame. */
type MenuState = { model: Menu; current: string; start: string; focused: string; frame: number; timer: Timer | null; soul: Soul | null; undrawn: number };

type BandProps = { hasSurvey: boolean; isWorking: boolean; maxRows: number; bodyColumns: number };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The plugin's log (src/log.ts): records queue here; each `lg` writes them through that hook's `$`. */
const L = new Logger();

/** The log's file I/O through this hook's `$`. */
function logIO($: EngineInterface): LogIO {
  return {
    read: async (path) => {
      if (!(await $.fs.exists(path))) return undefined;
      const text = await $.fs.read(path);
      if (typeof text !== 'string') throw new Error(`${path} is not text`);
      return text;
    },
    write: async (path, text) => $.fs.write(path, text),
    fallback: (line) => $.ui.log(line),
  };
}

/** One record, written now through `$`; never throws. */
function lg($: EngineInterface, level: LogLevel, event: string, fields: LogFields = {}): void {
  L.log(level, event, fields);
  L.flush(logIO($)).catch(() => undefined);
}

/** A debug record at most once a second per event. */
function lgT($: EngineInterface, event: string, fields: LogFields = {}): void {
  L.throttled(event, fields);
  L.flush(logIO($)).catch(() => undefined);
}

/** Every failure: the debug log line as before, and an error record with its context and stack. */
function log($: EngineInterface, what: string, error: unknown, fields: LogFields = {}): void {
  $.ui.log(`buddy: ${what} failed: ${message(error)}`);
  L.error(what, error, fields);
  L.flush(logIO($)).catch(() => undefined);
}

/** A problem said in the debug log and the plugin log alike. */
function warn($: EngineInterface, event: string, text: string, fields: LogFields = {}): void {
  $.ui.log(`buddy: ${text}`);
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
  st.folderError = undefined;
  let user: Entry[] = [];
  if (st.options.characterDir) {
    let dir = st.options.characterDir;
    if (dir.startsWith('~')) dir = expandHome(dir, await $.env.get('HOME'));
    const mine = await readDir($, dir.replace(/\/+$/, ''), 'user');
    if (mine.error) errors.push(mine.error);
    st.folderError = mine.error;
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
  if (!st.b) st.b = createBrain(choice.character, st.options.motion, st.options.ambiguousWidth === 'wide');
  st.b.pets = st.pets;
  setCharacter(st.b, choice.character, warning, Math.random);
  L.context.character = choice.character.id;
  lg($, 'info', 'character.switch', { id: choice.character.id, via: 'start' });
}

// ---- memory ---------------------------------------------------------------

function memoryFailed(st: State, $: EngineInterface, what: string, error: unknown): void {
  log($, what, error, { area: 'memory' });
  st.memoryError = `${what} failed: ${message(error)}`;
}

/** The newest MEMORY_SESSIONS sessions' memory stays in the store, `current` among them; the rest is deleted. */
async function pruneMemory($: EngineInterface, current: string): Promise<void> {
  const sessions: { key: string; at: number }[] = [];
  for (const key of await $.store.keys()) {
    if (!key.startsWith(MEMORY_KEY_PREFIX) || key === storeKey(current)) continue;
    const v = await $.store.get(key);
    sessions.push({ key, at: typeof v === 'object' && v !== null && typeof (v as Stored).at === 'number' ? (v as Stored).at : 0 });
  }
  for (const key of staleKeys(sessions, MEMORY_SESSIONS - 1)) await $.store.delete(key);
}

/** The session's book, by `$.session.id()` (the transcript's name): a new id loads its own from the store. */
async function bookFor(st: State, $: EngineInterface): Promise<{ sessionId: string; book: Book }> {
  const sessionId = await $.session.id();
  if (st.memory?.sessionId === sessionId) return st.memory;
  const loaded = bookOf(await $.store.get(storeKey(sessionId)));
  if (loaded.error) memoryFailed(st, $, 'reading the memory', new Error(loaded.error));
  st.memory = { sessionId, book: loaded.book };
  try {
    await pruneMemory($, sessionId);
  } catch (error) {
    memoryFailed(st, $, "deleting old sessions' memory", error);
  }
  return st.memory;
}

/** Appends the exchange `x` to the ring of `characterId` and saves the session's book; the memory option 0 keeps nothing. */
function keep(st: State, $: EngineInterface, characterId: string, x: Exchange): void {
  const n = st.options.memory;
  if (n === 0) return;
  st.memoryChain = st.memoryChain.then(async () => {
    try {
      const m = await bookFor(st, $);
      m.book = record(m.book, characterId, x, n);
      const stored: Stored = { at: Date.now(), characters: m.book };
      await $.store.set(storeKey(m.sessionId), stored);
    } catch (error) {
      memoryFailed(st, $, `remembering the ${x.kind}`, error);
    }
  });
}

/** What `c` remembers of this session, rendered for a prompt, after every write made before; '' when nothing or off. */
async function recollect(st: State, $: EngineInterface, c: Character): Promise<string> {
  const n = st.options.memory;
  if (n === 0) return '';
  let text = '';
  st.memoryChain = st.memoryChain.then(async () => {
    try {
      text = render(recall((await bookFor(st, $)).book, c.id, n), c.name);
    } catch (error) {
      memoryFailed(st, $, 'reading the memory', error);
    }
  });
  await st.memoryChain;
  return text;
}

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
  for (const s of said) keep(st, $, s.id, { kind: 'line', text: s.text });
}

// ---- clock and redraw ---------------------------------------------------

function refresh(st: State, $: EngineInterface): void {
  heard(st, $);
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

/** A question queued behind the main turn goes now: a new session or /buddy reload ends the wait. */
function releaseQueued(st: State): void {
  for (const go of st.turnWaiters.splice(0)) go();
}

async function startSession(st: State, $: EngineInterface): Promise<void> {
  releaseQueued(st);
  await startLog(st, $);
  for (const e of st.options.errors) warn($, 'option.warning', e);
  await readStore(st, $);
  await loadRoster(st, $);
  if ((st.storeChoice ?? st.options.character) === ORIGINAL_ID) await restoreOriginal(st, $);
  applyChoice(st, $);
  try {
    await $.command.register({ name: COMMAND, description: 'Pet your buddy, ask it something, or: off, on, reload, log, help; /buddy-personality switches character', argumentHint: '[question] | off | on | reload | log | help', immediate: true });
  } catch (error) {
    log($, `registering /${COMMAND}`, error);
  }
  try {
    await $.command.register({ name: MENU_COMMAND, description: 'Pick your buddy from a menu with a live preview: the shipped characters, your original companion, your folder', immediate: true });
  } catch (error) {
    log($, `registering /${MENU_COMMAND}`, error);
  }
  startClock(st, $);
  st.lastKey = '';
  $.ui.invalidate('ui.render');
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
  lg($, 'info', 'session.start', { build, model: st.options.quipModel, effort: st.options.effort, level: L.level, questionMode: st.options.questionMode, quips: st.options.quips, suggestions: st.options.suggestions, memory: st.options.memory });
}

// ---- ui.render: AbovePrompt ---------------------------------------------

function bandScene(st: State, $: EngineInterface, p: BandProps): Scene | null {
  if (p.hasSurvey || !st.b || st.hidden) return null;
  st.bandSeen = true;
  observeBand(st.b, { cols: p.bodyColumns, maxRows: p.maxRows, isWorking: p.isWorking }, Math.random);
  // The band's spinner is the say on whether the main turn runs; a tool call alone can set it.
  if (!p.isWorking) st.turnBusy = false;
  heard(st, $);
  const scene = sceneOf(st.b);
  lgT($, 'band.scene', { pose: st.b.lastPose, bubble: st.b.talk?.text.length ?? 0, cols: p.bodyColumns, working: p.isWorking });
  st.lastKey = JSON.stringify(scene);
  return scene;
}

type Component = any;

function drawBand(Box: Component, Text: Component, s: Scene) {
  const bubble = s.bubble ? (
    <Box borderStyle="round" paddingX={1} width={s.bubble.width} alignSelf="flex-start">
      <Text italic wrap="wrap">{s.bubble.text}</Text>
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

// ---- tool.call and turn.complete ----------------------------------------

function onToolCall(st: State, $: EngineInterface, e: ToolCallInput, r: ToolCallResult): void {
  try {
    // A subagent's or a fork's call (the buddy's own fork's denied attempts included) is not the main turn's work.
    if (!st.b || !isMainLoop(e.agentId)) return;
    st.turnBusy = true;
    const call = e as unknown as { tool: string; command?: unknown; input?: unknown };
    const res = r as unknown as { deny?: unknown; isError?: unknown; text?: unknown; result?: unknown };
    react(st.b, { tool: call.tool, isError: res.isError === true, denied: typeof res.deny === 'string', output: toolOutput(res), command: call.tool === 'Bash' ? bashCommand(call) : '' }, Math.random);
    refresh(st, $);
  } catch (error) {
    log($, 'reacting to a tool call', error);
  }
}

function onTurnComplete(st: State, $: EngineInterface, e: TurnCompleteInput): void {
  try {
    // Only the main loop's end is the turn's end: a subagent's or a fork's leaves the main turn busy, its tally whole.
    if (!isMainLoop(e.agentId)) return;
    // The main turn ended, however it ended (answered, aborted, an error): a question waiting on it forks now.
    for (const go of st.turnWaiters.splice(0)) go();
    if (!st.b) return;
    wake(st.b, Math.random);
    st.turnBusy = false;
    // Every answered turn of the main loop, tools or none; never an aborted one.
    const answered = e.reason === 'answer' && !e.isAborted;
    if (answered) {
      st.turns = pushTurn(st.turns, { prompt: st.pendingPrompt, answer: e.answer }, st.options.contextTurns);
      st.pendingPrompt = '';
    }
    const { turn, lineDue } = endTurn(st.b, st.options.quips && !st.hidden && answered, st.options.quipCooldownSec);
    const wants: TurnWants = { line: lineDue, next: st.options.suggestions && !st.hidden && answered };
    if (wants.line || wants.next) {
      const gen = wants.next ? ++st.suggestGen : st.suggestGen;
      if (wants.next) {
        st.harnessSuggestion = null;
        st.suggestGaveUp = false;
      }
      lg($, 'info', 'turn.call', { mode: st.options.turnMode, line: wants.line, next: wants.next, tools: turn.tools.length });
      turnCall(st, $, turn, gen, wants).catch((error) => log($, 'the end-of-turn call', error));
    } else {
      const why = !answered ? 'not an answered turn' : st.hidden ? 'hidden' : !st.options.quips && !st.options.suggestions ? 'quips and suggestions off' : 'cooldown';
      lg($, 'info', 'turn.skipped', { why });
    }
    refresh(st, $);
  } catch (error) {
    log($, 'the end of a turn', error);
  }
}

/**
 * The model and effort of one `$.model.complete`, resolved now: an 'inherit'
 * option reads the main chat's (its model, the CLAUDE_EFFORT level); a failed
 * read is logged once and falls back (opus; no effort). Logged at debug as `event`.
 * Never throws.
 */
async function callSettings(st: State, $: EngineInterface, event: string): Promise<{ model: string; effort?: Effort }> {
  let sessionModel: string | undefined;
  if (st.options.quipModel === INHERIT) {
    try {
      sessionModel = await $.session.model();
    } catch (error) {
      if (!st.inheritFailed.has('model')) log($, "reading the main chat's model for quipModel inherit", error);
      st.inheritFailed.add('model');
    }
  }
  let envEffort: string | undefined;
  if (st.options.effort === INHERIT) {
    try {
      envEffort = await $.env.get('CLAUDE_EFFORT');
    } catch (error) {
      if (!st.inheritFailed.has('effort')) log($, "reading the main chat's effort (CLAUDE_EFFORT) for effort inherit", error);
      st.inheritFailed.add('effort');
    }
  }
  const model = resolveModel(st.options.quipModel, sessionModel);
  const effort = resolveEffort(st.options.effort, envEffort);
  lg($, 'debug', event, { model, effort: effort ?? 'none' });
  return effort ? { model, effort } : { model };
}

/**
 * One call at a turn's end writes the buddy's line and the next-prompt
 * suggestion, those wanted: in turnMode `complete` a quipModel completion on
 * the main chat's recent turns; in `fork` a fork of the main chat (its model,
 * effort and prompt cache), which the turn that just ended leaves free to fork.
 * A timeout, a refusal, an empty reply or a throw fails the line as a quip
 * fails and gives the suggestion up; a late suggestion is stale by `gen`.
 * Never throws.
 */
async function turnCall(st: State, $: EngineInterface, t: TurnSummary, gen: number, wants: TurnWants): Promise<void> {
  const b = st.b;
  if (!b) return;
  // The window as this turn ended, before a later turn can move it.
  const turns = st.turns;
  let reply: { line: string | null; next: string | null } | null = null;
  let reason = '';
  let usage: Record<string, number> = {};
  try {
    const memory = await recollect(st, $, b.character);
    const mode = st.options.turnMode;
    let r: ModelForkResult | 'timeout';
    if (mode === 'fork') {
      const prompt = turnForkPrompt(b.character.persona, wants, memory);
      lg($, 'debug', 'turn.prompt', { mode, length: prompt.length });
      r = await within($, $.model.fork({ prompt }), FORK_DEADLINE_MS);
    } else {
      const prompt = turnPrompt(t, turns, memory);
      lg($, 'debug', 'turn.prompt', { mode, length: prompt.length });
      const settings = await callSettings(st, $, 'turn.settings');
      r = await within(
        $,
        $.model.complete({ ...settings, system: turnSystem(b.character.persona, wants), prompt, maxTokens: TURN_MAX_TOKENS, timeoutMs: TURN_DEADLINE_MS }),
        TURN_DEADLINE_MS,
      );
    }
    // What the call cost and how much it read from the prompt cache, logged on the line's outcome.
    usage = r !== 'timeout' && 'usage' in r ? usageFields(r.usage) : {};
    if (r === 'timeout') reason = 'timeout';
    else if (!r.isAnswered) reason = r.reason;
    else {
      reply = parseTurnReply(r.text);
      lg($, 'debug', 'turn.reply', { length: r.text.length, line: reply.line?.length ?? 0, next: reply.next?.length ?? 0 });
    }
  } catch (error) {
    log($, 'the end-of-turn call', error);
    reason = message(error);
  }
  if (wants.line) sayTurnLine(st, $, t, reply?.line ?? null, reason || 'no line in the reply', usage);
  if (wants.next) {
    try {
      await proposeTurnNext(st, $, gen, reply?.next ?? null, reason, b.character.id);
    } catch (error) {
      log($, 'a prompt suggestion', error);
      await giveUpSuggestion(st, $, gen).catch((e) => log($, 'showing the engine\'s own suggestion', e));
    }
  }
}

/** The end-of-turn line in the bubble, or the failure why there is none; a held /buddy answer keeps the bubble. `usage`: the call's usageFields, logged on the outcome. */
function sayTurnLine(st: State, $: EngineInterface, t: TurnSummary, text: string | null, reason: string, usage: Record<string, number>): void {
  const b = st.b;
  if (!b) return;
  const c = b.character;
  try {
    if (text) {
      // Hidden by /buddy off while the model wrote it: never shown, so never remembered.
      // A held /buddy answer keeps the bubble until it ends: the line is never said over it, nor remembered.
      const held = !st.hidden && holdsAnswer(b);
      const shown = !st.hidden && !held && answer(b, text, t.failures > 0 ? 'oops' : 'yay', c.id);
      if (shown) keep(st, $, c.id, { kind: 'quip', text });
      lg($, 'info', 'quip.outcome', { outcome: shown ? 'answered' : st.hidden ? 'hidden' : held ? 'held' : 'dropped', ...usage });
    } else {
      $.ui.log(`buddy: a quip got no answer: ${reason}`);
      if (holdsAnswer(b)) lg($, 'info', 'quip.outcome', { outcome: 'held', reason, ...usage });
      else {
        lg($, 'info', 'quip.outcome', { outcome: 'failed', reason, ...usage });
        failAnswer(b, reason, c.id);
      }
    }
  } catch (error) {
    log($, 'a quip', error);
  }
  refresh(st, $);
}

/** The end-of-turn suggestion of character `characterId` into the prompt box, remembered once shown; none, or a failed call, gives this turn's up. */
async function proposeTurnNext(st: State, $: EngineInterface, gen: number, text: string | null, reason: string, characterId: string): Promise<void> {
  if (text === null) {
    lg($, 'info', 'suggest.outcome', reason ? { outcome: 'failed', reason } : { outcome: 'none' });
    return giveUpSuggestion(st, $, gen);
  }
  // A later turn asked for its own, or /buddy off came meanwhile: this one is never proposed.
  if (gen !== st.suggestGen || st.hidden) {
    lg($, 'info', 'suggest.outcome', { outcome: 'stale' });
    return;
  }
  const { isShown } = await $.prompt.suggest({ text });
  lg($, 'info', 'suggest.outcome', { outcome: isShown ? 'shown' : 'not-shown', length: text.length });
  // Shown: the buddy remembers it suggested this, so it can say what it suggested last.
  if (isShown) keep(st, $, characterId, { kind: 'suggestion', text });
}

/** The buddy has no suggestion for turn `gen`: the engine's own, held back meanwhile, is shown, and a later one passes. */
async function giveUpSuggestion(st: State, $: EngineInterface, gen: number): Promise<void> {
  if (gen !== st.suggestGen) return;
  st.suggestGaveUp = true;
  const text = st.harnessSuggestion;
  st.harnessSuggestion = null;
  if (text === null || st.hidden) return;
  const { isShown } = await $.prompt.suggest({ text });
  lg($, 'info', 'suggest.outcome', { outcome: isShown ? 'harness-shown' : 'harness-not-shown' });
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
      $.ui.log(`buddy: skipping a backup: ${j.error}`);
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
    $.ui.log(`buddy: /${MENU_COMMAND}: ${config.error}`);
    return { kind: 'error', error: config.error };
  }
  const notes: string[] = [];
  let soul = config.soul;
  let from: string | undefined;
  if (!soul) {
    const backup = await backupSoul($, config.sources, notes);
    if (backup) ({ soul, label: from } = backup);
  }
  if (!soul) return { kind: 'none', notes, shownConfig: config.sources.shownConfig };
  const rolls: { variant: Variant; character?: Character; error?: string }[] = [];
  for (const variant of VARIANTS) {
    const r = await rollOriginal($, config.identity, soul, variant);
    if (r.error) $.ui.log(`buddy: the ${variant} roll of your original companion will not draw: ${r.error}`);
    rolls.push({ variant, ...r });
  }
  return from === undefined ? { kind: 'found', soul, notes, rolls } : { kind: 'found', soul, from, notes, rolls };
}

/** At start, with the original chosen: its saved soul and roll, the identity read again, no backup scan. */
async function restoreOriginal(st: State, $: EngineInterface): Promise<void> {
  let error = '';
  try {
    const saved = st.saved;
    if (!saved) error = `no original companion saved; /${MENU_COMMAND} picks one`;
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

// ---- /buddy-personality: the menu pane ------------------------------------

function stopMenu(st: State): void {
  if (st.menu) L.log('info', 'menu.close'); // written by the next record's flush
  st.menu?.timer?.cancel();
  st.menu = null;
}

async function openMenu(st: State, $: EngineInterface): Promise<{ text: string }> {
  const b = st.b;
  if (!b) return { text: 'buddy is still starting; try again in a moment' };
  lg($, 'info', 'menu.open', { current: b.character.id });
  const originals = await findOriginals($);
  const model = buildMenu({ roster: st.roster, shippedError: st.shippedError, folder: { isSet: Boolean(st.options.characterDir), error: st.folderError }, originals });
  const current = currentKeyOf(b.character.id, st.saved?.variant);
  const start = findItem(model, current) ? current : (allItems(model)[0]?.key ?? '');
  stopMenu(st);
  const menu: MenuState = { model, current, start, focused: start, frame: 0, timer: null, soul: originals.kind === 'found' ? originals.soul : null, undrawn: 0 };
  st.menu = menu;
  menu.timer = $.clock.every(PREVIEW_MS, () => {
    // A pane gone without ui.close is never drawn again: its preview clock stops with it.
    if (++menu.undrawn > MENU_UNDRAWN_TICKS) {
      lg($, 'info', 'menu.gone', { undrawnTicks: menu.undrawn });
      if (st.menu === menu) stopMenu(st);
      else menu.timer?.cancel();
      return;
    }
    menu.frame++;
    $.ui.invalidate('ui.render');
  });
  let opened;
  try {
    opened = await $.ui.open({ id: MENU_PANE, title: MENU_TITLE, focus: true, closeOnEscape: true, rows: menuRows(model) });
  } catch (error) {
    stopMenu(st);
    log($, `opening /${MENU_COMMAND}`, error);
    return { text: `/${MENU_COMMAND} couldn't open its pane: ${message(error)}` };
  }
  if (!opened.isPlaced) return { text: `The menu is open but not drawn yet: ${opened.reason}` };
  return { text: `${MENU_TITLE}: ↑/↓ move, Enter picks, Esc closes.` };
}

/** Enter on a row: switches and remembers the choice (the store's `character`), then the pane closes and the new one greets. */
async function pickItem(st: State, $: EngineInterface, item: Item): Promise<void> {
  const b = st.b;
  const menu = st.menu;
  if (!b || !menu) return;
  const c = item.character;
  if (!c) {
    $.ui.log(`buddy: /${MENU_COMMAND}: can't pick ${item.label}: ${item.error}`);
    return;
  }
  let note = '';
  if (item.pick.kind === 'original') {
    if (!menu.soul) {
      $.ui.log(`buddy: /${MENU_COMMAND}: can't pick ${item.label}: its soul was not found`);
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
  lg($, 'info', 'menu.pick', { id: c.id, kind: item.pick.kind, saved: !note });
  if (note) speak(b, `${c.name} is here${note}`, 'oops', ERROR_MS);
  startClock(st, $);
  st.lastKey = '';
  $.ui.invalidate('ui.render');
  stopMenu(st);
  try {
    await $.ui.close({ id: MENU_PANE });
  } catch (error) {
    log($, `closing /${MENU_COMMAND}`, error);
  }
}

function drawMenu(Box: Component, Text: Component, Button: Component, m: MenuState, onPick: (item: Item) => void) {
  const p = previewOf(findItem(m.model, m.focused), m.frame, Date.now());
  const groups = m.model.sections.map((s, n) => (
    <Box key={`group:${n}`} flexDirection="column" marginTop={n === 0 ? 0 : 1}>
      <Text bold>{s.title}</Text>
      {s.lines.map((line) => <Text wrap="wrap">{line}</Text>)}
      {s.items.map((item) => <Button key={item.key} label={rowLabel(item, m.current)} plain autoFocus={item.key === m.start ? true : undefined} onPress={() => onPick(item)} />)}
    </Box>
  ));
  const preview =
    p.kind === 'error' ? (
      <Box key="preview" flexDirection="column">
        <Text bold>{p.label}</Text>
        <Text wrap="wrap">{`Can't draw it: ${p.error}`}</Text>
      </Box>
    ) : (
      <Box key="preview" flexDirection="column">
        {p.rows.map((row) => <Text color={p.color}>{row}</Text>)}
        <Text bold>{p.name}</Text>
        <Text dimColor wrap="truncate-end">{p.about}</Text>
        <Text italic wrap="truncate-end">{`“${p.sample}”`}</Text>
        {p.card.map((row) => <Text wrap="truncate-end">{row}</Text>)}
      </Box>
    );
  return (
    <Box flexDirection="row" gap={3}>
      <Box flexDirection="column" flexShrink={0} width={listWidth(m.model)}>{groups}</Box>
      <Box flexDirection="column" flexGrow={1}>{preview}</Box>
    </Box>
  );
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

/** `p`, or 'timeout' once `ms` passed on the engine's clock first. */
async function within<T>($: EngineInterface, p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, $.clock.sleep(ms).then(() => 'timeout' as const)]);
}

/** A model result as log fields: never the whole text. */
function shape(r: ModelForkResult | 'timeout'): LogFields {
  if (r === 'timeout') return { timeout: true };
  return r.isAnswered ? { isAnswered: true, length: r.text.length, head: r.text.slice(0, 80) } : { isAnswered: false, reason: r.reason };
}

/**
 * One /buddy question to its outcome, always visible: an answer, or
 * "{name} couldn't answer: {reason}" in the bubble. In `fork` mode the fork of
 * the main chat (its model, context and prompt cache) answers, and nothing
 * else: a fork replays the main thread's last request, so one asked while the
 * main turn runs would continue that turn, and the question waits for the
 * turn to end first. In `complete` mode the quip model answers from persona,
 * memory, the main chat's last contextTurns turns (`recentTurns`) and question.
 * `memory`: what the buddy remembered before this question; it goes before the question.
 * `busy`: whether the main turn ran when the question was asked, decided once at ask.start.
 */
async function ask(st: State, $: EngineInterface, question: string, memory: string, busy: boolean): Promise<void> {
  const b = st.b;
  if (!b) {
    st.asking = null;
    return;
  }
  const c = b.character;
  const started = Date.now();
  let said = '';
  const via = st.options.questionMode === 'fork' ? 'fork' : 'complete';
  let reason = '';
  let usage: Record<string, number> = {};
  // The answer belongs to the one asked: a character switched in meanwhile never says it.
  let shown = true;
  try {
    let r: ModelForkResult | 'timeout';
    let deadline: number;
    if (via === 'fork') {
      let queuedOut = false;
      if (busy) {
        lg($, 'info', 'ask.queued', { why: 'the main turn is running' });
        queuedOut = (await within($, new Promise<void>((go) => st.turnWaiters.push(go)), QUEUE_MAX_MS)) === 'timeout';
      }
      if (queuedOut) {
        deadline = QUEUE_MAX_MS;
        r = 'timeout';
      } else {
        const prompt = forkPrompt(c.persona, question, memory);
        lg($, 'debug', 'ask.prompt', { via, length: prompt.length });
        // Counted from here, never while it waited: the safety net that ends the bubble, not a cancel.
        deadline = FORK_DEADLINE_MS;
        r = await within($, $.model.fork({ prompt }), deadline);
      }
    } else {
      // A completion does not see the chat: the recent turns tell it where the chat stands.
      const prompt = questionPrompt(question, memory, recentTurns(st.turns));
      lg($, 'debug', 'ask.prompt', { via, length: prompt.length });
      deadline = COMPLETE_DEADLINE_MS;
      const settings = await callSettings(st, $, 'ask.settings');
      r = await within($, $.model.complete({ ...settings, system: oneLineSystem(c.persona), prompt, maxTokens: QUESTION_MAX_TOKENS, timeoutMs: deadline }), deadline);
    }
    lg($, 'debug', 'ask.result', { via, ...shape(r) });
    // What the call cost and how much it read from the prompt cache: a fork's reuse of the chat's cache shows here.
    usage = r !== 'timeout' && 'usage' in r ? usageFields(r.usage) : {};
    const text = r !== 'timeout' && r.isAnswered ? oneLine(r.text) : '';
    if (text) {
      said = text;
      // Hidden by /buddy off while it thought: the answer is never drawn, so never remembered as said.
      shown = !st.hidden && answer(b, text, null, c.id);
    } else {
      reason = r === 'timeout' ? deadlineReason(deadline) : r.isAnswered ? 'empty reply' : noAnswerReason(r);
      $.ui.log(`buddy: a /buddy question got no answer: ${reason}`);
      shown = failAnswer(b, reason, c.id);
    }
  } catch (error) {
    reason = message(error);
    log($, 'a /buddy question', error, { via });
    shown = failAnswer(b, reason, c.id);
  } finally {
    st.asking = null;
    endQuestion(b);
  }
  const hidden = !shown && st.hidden;
  if (!shown && !hidden) warn($, 'ask.dropped', `${c.name}'s answer was dropped: ${b.character.name} is drawn now`, { asker: c.id, drawn: b.character.id });
  lg($, 'info', 'ask.outcome', { outcome: hidden ? 'hidden' : !shown ? 'dropped' : said ? 'answered' : 'failed', via, ...(reason ? { reason } : {}), ms: Date.now() - started, ...usage });
  // One exchange: the question with its answer as shown, or the question alone.
  keep(st, $, c.id, said && shown ? { kind: 'question', question, answer: said } : { kind: 'question', question });
  refresh(st, $);
}

async function runCommand(st: State, $: EngineInterface, args: string): Promise<{ text: string }> {
  const b = st.b;
  if (!b) return { text: 'buddy is still starting; try again in a moment' };
  const action = parseCommand(args);
  lg($, 'info', 'command', { name: COMMAND, kind: action.kind, argsLength: args.trim().length });
  // This call took the one question slot: a failure before its ask ends frees it and ends the thinking line.
  let began = false;
  try {
    switch (action.kind) {
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
        releaseQueued(st);
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
        return { text: `Switching characters moved to /${MENU_COMMAND}.` };
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
        if (st.options.questionMode === 'off') return { text: 'questions are off (questionMode)' };
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
        // Decided once, here: the band draws as working while this very command runs, so a later read is always busy.
        const busy = b.working || st.turnBusy;
        lg($, 'info', 'ask.start', { mode: st.options.questionMode, busy, length: action.text.length });
        lg($, 'debug', 'ask.question', { question: action.text });
        // What it remembers from before this question; the question joins it with its answer, in ask.
        const memory = await recollect(st, $, c);
        beginQuestion(b, Math.random);
        refresh(st, $);
        ask(st, $, action.text, memory, busy).catch((error) => {
          st.asking = null;
          log($, 'a /buddy question', error);
          endQuestion(b);
          failAnswer(b, message(error), c.id);
          refresh(st, $);
        });
        const trouble = st.memoryError;
        st.memoryError = '';
        return { text: `Asked ${c.name}.${trouble ? ` (Its memory: ${trouble})` : ''}` };
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
    folderError: undefined,
    menu: null,
    hidden: false,
    pets: 0,
    timer: null,
    clockPeriod: 0,
    lastKey: '',
    lastTickError: '',
    memory: null,
    memoryChain: Promise.resolve(),
    memoryError: '',
    asking: null,
    turnBusy: false,
    bandSeen: false,
    ticks: 0,
    sharedAt: 0,
    hiddenGen: 0,
    hiddenSaves: 0,
    suggestGen: 0,
    harnessSuggestion: null,
    suggestGaveUp: false,
    inheritFailed: new Set(),
    pendingPrompt: '',
    turnWaiters: [],
    turns: [],
    warned: false,
  };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    try {
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
      if (!scene) return next(e);
      const { Box, Text } = $.ui.resolve(e);
      return drawBand(Box, Text, scene);
    } catch (error) {
      log($, 'drawing the band', error);
      return next(e);
    }
  });

  on('tool.call', async ($, e, next) => {
    const r = await next(e);
    onToolCall(st, $, e, r);
    return r;
  });

  on('prompt.submit', async ($, e, next) => {
    try {
      st.pendingPrompt = e.text;
    } catch (error) {
      log($, 'remembering the prompt', error);
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const r = await next(e);
    onTurnComplete(st, $, e);
    return r;
  });

  // With suggestions on, the engine's own guess is held back: the buddy's end-of-turn call proposes the next prompt instead.
  on('prompt.suggest', async ($, e, next) => {
    try {
      if (dropsHarnessSuggestion(e.origin, st.options.suggestions, st.hidden || st.b === null, st.suggestGaveUp)) {
        st.harnessSuggestion = e.text;
        lg($, 'debug', 'suggest.harness-held');
        return { isShown: false };
      }
    } catch (error) {
      log($, 'a prompt suggestion hook', error);
    }
    return next(e);
  });

  on('command.run', { command: COMMAND }, async ($, e) => {
    try {
      return await runCommand(st, $, e.args);
    } catch (error) {
      log($, `/${COMMAND}`, error);
      return { text: `/${COMMAND} failed: ${message(error)}` };
    }
  });

  on('command.run', { command: MENU_COMMAND }, async ($) => {
    try {
      return await openMenu(st, $);
    } catch (error) {
      stopMenu(st);
      log($, `/${MENU_COMMAND}`, error);
      return { text: `/${MENU_COMMAND} failed: ${message(error)}` };
    }
  });

  on('ui.render', { component: 'Pane', requestId: MENU_PANE }, async ($, e, next) => {
    try {
      const { Box, Text, Button } = $.ui.resolve(e);
      // A pane kept open across a reload has no menu behind it: said, never blank.
      if (!st.menu) return <Text>{`The menu closed; /${MENU_COMMAND} opens it again.`}</Text>;
      st.menu.undrawn = 0;
      return drawMenu(Box, Text, Button, st.menu, (item) => {
        pickItem(st, $, item).catch((error) => log($, `picking ${item.label}`, error));
      });
    } catch (error) {
      log($, 'drawing the menu', error);
      return next(e);
    }
  });

  // The preview follows the focus: arrows, Tab or a click move the ring onto a row.
  on('ui.focus', { requestId: MENU_PANE }, async ($, e, next) => {
    try {
      lg($, 'debug', 'menu.focus', { element: e.element ?? null, origin: (e as { origin?: { kind?: string } }).origin?.kind ?? null, menu: st.menu !== null });
      if (st.menu && e.element !== undefined && findItem(st.menu.model, e.element)) {
        st.menu.focused = e.element;
        st.menu.frame = 0;
        $.ui.invalidate('ui.render');
      }
    } catch (error) {
      log($, 'following the menu focus', error);
    }
    return next(e);
  });

  // Esc (or the close mark) closes the menu and changes nothing.
  on('ui.close', async ($, e, next) => {
    try {
      if (e.id === MENU_PANE) stopMenu(st);
    } catch (error) {
      log($, `closing /${MENU_COMMAND}`, error);
    }
    return next(e);
  });
};
