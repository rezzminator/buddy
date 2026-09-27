import type { EngineInterface, ModelCompleteResult, On, PluginOptions, PromptSubmitInput, PromptSubmitResult, Register, Timer, ToolCallInput, ToolCallResult, TurnCompleteInput, TurnStartInput, TurnStepInput } from 'claude-code';
import {
  COMPLETE_DEADLINE_MS, ERROR_MS, answer, beginQuestion, createBrain, deadlineReason, endQuestion, noAnswerReason, refuseQuestion, endTurn, failAnswer, farewell, greet, holdsAnswer, isMainLoop, observeBand, period, pet,
  react, sceneOf, setCharacter, speak, tick, wake,
  type Brain,
} from '../src/brain.ts';
import type { Character } from '../src/character.ts';
import { USAGE, parseCommand } from '../src/command.ts';
import {
  MENU_COMMAND, MENU_PANE, MENU_TITLE, PREVIEW_MS, allItems, buildMenu, listWidth, currentKeyOf, findItem, menuRows, previewOf, rowLabel,
  type Item, type Menu, type Originals,
} from '../src/menu.ts';
import { REMEMBERED_EXCHANGES_KEY_PREFIX, REMEMBERED_EXCHANGES_SESSIONS, REMEMBERED_EXCHANGES_WRITE_DEADLINE_MS, rememberedExchangesOf, characterRememberedExchanges, addRememberedExchange, render, staleKeys, storeKey, type RememberedExchanges, type Exchange, type Stored } from '../src/rememberedExchanges.ts';
import { Logger, notice, sumUsage, usageFields, type LogFields, type LogIO, type LogLevel } from '../src/log.ts';
import { within, type Sleep } from '../src/deadline.ts';
import { INHERIT, expandHome, logPath, observeEffort, resolveEffort, resolveModel, resolveOptions, type Effort, type ObservedEffort, type Options } from '../src/options.ts';
import {
  NO_PROMPTS, QUESTION_MAX_TOKENS, TURN_DEADLINE_MS, TURN_MAX_TOKENS, endPromptTurn, startPromptTurn, endsConversation, oneLine, oneLineSystem, parseTurnReply, pushTurn, questionPrompt, chatTurnsToReadText, requestTimeoutMs, retriesEmpty,
  skipReason, stillThinking, submitPrompt, turnMay, turnPrompt, turnSystem, type PromptLedger, type Turn, type TurnGate, type TurnSummary, type TurnWants,
} from '../src/prompts.ts';
import { dropsHarnessSuggestion, suggestNextPromptOutcome } from '../src/suggestNextPrompt.ts';
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
  /** Why characters/ or the customCharactersDir could not be listed: the menu says it in the group. */
  shippedError: string | undefined;
  customCharactersDirError: string | undefined;
  menu: MenuState | null;
  hidden: boolean;
  pets: number;
  timer: Timer | null;
  clockPeriod: number;
  lastKey: string;
  lastTickError: string;
  /** This session's rememberedExchanges as last loaded or written; loaded again when the session id changes (a start, a /clear, a reload). */
  rememberedExchanges: { sessionId: string; rememberedExchanges: RememberedExchanges } | null;
  /** Every rememberedExchanges read and write, one after another, in the order made. */
  rememberedExchangesChain: Promise<void>;
  /** The last rememberedExchanges failure, said in the next /buddy question's reply; '' when none since. */
  rememberedExchangesError: string;
  /** A rememberedExchanges read or write was abandoned at its deadline and that was said: said again only after one lands. */
  rememberedExchangesHangSaid: boolean;
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
  /** Bumped at every main-loop turn's end, however it ended, and at /clear: a commentAfterEachTurn or suggestNextPrompt from an earlier turn's call is stale, never shown. */
  turnGen: number;
  /** The engine's own suggestion for this turn, held back while the buddy's end-of-turn call runs: shown if the buddy gives up. */
  harnessSuggestion: string | null;
  /** The buddy gave up on this turn's suggestNextPrompt: the engine's own suggestion passes. */
  suggestNextPromptGaveUp: boolean;
  /** The inherit read of the main chat's model failed once and was logged; a later failure falls back to opus in silence. */
  inheritFailed: Set<'model'>;
  /** The effort of the main chat's latest model request (turn.step), which effort inherit sends; undefined before its first. */
  mainEffort: ObservedEffort;
  /** The prompts given to the main chat (prompt.submit) and the main turns they started (turn.start), by id: an answered turn files its own into `turns`. */
  prompts: PromptLedger;
  /** The running main turn's id, from its turn.start to its turn.complete; undefined while none runs. */
  mainTurn: string | undefined;
  /** Bumped only by /clear or a resume: a /buddy question asked in an earlier conversation is dropped, never shown or remembered in this one. */
  conversation: number;
  /** The main chat's last chatTurnsToRead answered turns, oldest first, read by the end-of-turn call and a question's completion. */
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
    write: async (path, text) => $.fs.write(path, text),
    fallback: (line) => say($, line),
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

/** Every failure: a transcript notice, and an error record with its context and stack. */
function log($: EngineInterface, what: string, error: unknown, fields: LogFields = {}): void {
  say($, `${what} failed: ${message(error)}`);
  L.error(what, error, fields);
  L.flush(logIO($)).catch(() => undefined);
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

// ---- rememberedExchanges --------------------------------------------------

function rememberedExchangesFailed(st: State, $: EngineInterface, what: string, error: unknown): void {
  log($, what, error, { area: 'rememberedExchanges' });
  st.rememberedExchangesError = `${what} failed: ${message(error)}`;
}

/** The newest REMEMBERED_EXCHANGES_SESSIONS sessions' rememberedExchanges stay in the store, `current` among them; the rest is deleted. */
async function pruneRememberedExchanges($: EngineInterface, current: string): Promise<void> {
  const sessions: { key: string; at: number }[] = [];
  for (const key of await $.store.keys()) {
    if (!key.startsWith(REMEMBERED_EXCHANGES_KEY_PREFIX) || key === storeKey(current)) continue;
    const v = await $.store.get(key);
    sessions.push({ key, at: typeof v === 'object' && v !== null && typeof (v as Stored).at === 'number' ? (v as Stored).at : 0 });
  }
  for (const key of staleKeys(sessions, REMEMBERED_EXCHANGES_SESSIONS - 1)) await $.store.delete(key);
}

/** The session's rememberedExchanges, by `$.session.id()` (the transcript's name): a new id loads its own from the store. */
async function rememberedExchangesFor(st: State, $: EngineInterface): Promise<{ sessionId: string; rememberedExchanges: RememberedExchanges }> {
  const sessionId = await $.session.id();
  if (st.rememberedExchanges?.sessionId === sessionId) return st.rememberedExchanges;
  const loaded = rememberedExchangesOf(await $.store.get(storeKey(sessionId)));
  if (loaded.error) rememberedExchangesFailed(st, $, 'reading the rememberedExchanges', new Error(loaded.error));
  st.rememberedExchanges = { sessionId, rememberedExchanges: loaded.rememberedExchanges };
  // Old sessions' rememberedExchanges are pruned beside this read, never on its path: it touches only other sessions' keys.
  pruneRememberedExchanges($, sessionId).catch((error) => rememberedExchangesFailed(st, $, "deleting old sessions' rememberedExchanges", error));
  return st.rememberedExchanges;
}

/**
 * `link` added to the rememberedExchanges chain, abandoned `ms` after it is added: a link
 * that never settles leaves the chain once its deadline passes, so later reads
 * and writes go ahead; the first such abandonment is said, the next only after
 * a link lands. Resolves true when the link landed, false when abandoned.
 */
function chainRememberedExchanges(st: State, $: EngineInterface, what: string, ms: number, link: () => Promise<void>): Promise<boolean> {
  const bounded = within(sleeper($), st.rememberedExchangesChain.then(link), ms).then(
    (r) => {
      if (r !== 'timeout') {
        st.rememberedExchangesHangSaid = false;
        return true;
      }
      // In whole seconds: a question's deadline is what is left of its 90 s, a few ms short.
      if (!st.rememberedExchangesHangSaid) rememberedExchangesFailed(st, $, what, new Error(deadlineReason(Math.round(ms / 1000) * 1000)));
      st.rememberedExchangesHangSaid = true;
      return false;
    },
    (error: unknown) => {
      rememberedExchangesFailed(st, $, what, error);
      return false;
    },
  );
  st.rememberedExchangesChain = bounded.then(() => undefined);
  return bounded;
}

/** Appends the exchange `x` to the ring of `characterId` and saves the session's rememberedExchanges; the rememberedExchanges option 0 keeps nothing. */
function rememberExchange(st: State, $: EngineInterface, characterId: string, x: Exchange): void {
  const n = st.options.rememberedExchanges;
  if (n === 0) return;
  void chainRememberedExchanges(st, $, `remembering the ${x.kind}`, REMEMBERED_EXCHANGES_WRITE_DEADLINE_MS, async () => {
    try {
      const m = await rememberedExchangesFor(st, $);
      m.rememberedExchanges = addRememberedExchange(m.rememberedExchanges, characterId, x, n);
      const stored: Stored = { at: Date.now(), characters: m.rememberedExchanges };
      await $.store.set(storeKey(m.sessionId), stored);
    } catch (error) {
      rememberedExchangesFailed(st, $, `remembering the ${x.kind}`, error);
    }
  });
}

/** What `c` remembers of this session, rendered for a prompt, after every write made before; '' when nothing, off, or not read within the caller's `ms`. */
async function readRememberedExchanges(st: State, $: EngineInterface, c: Character, ms: number): Promise<string> {
  const n = st.options.rememberedExchanges;
  if (n === 0) return '';
  let text = '';
  const landed = await chainRememberedExchanges(st, $, 'reading the rememberedExchanges', ms, async () => {
    try {
      text = render(characterRememberedExchanges((await rememberedExchangesFor(st, $)).rememberedExchanges, c.id, n), c.name);
    } catch (error) {
      rememberedExchangesFailed(st, $, 'reading the rememberedExchanges', error);
    }
  });
  return landed ? text : '';
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
  for (const s of said) rememberExchange(st, $, s.id, { kind: 'line', text: s.text });
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

async function startSession(st: State, $: EngineInterface): Promise<void> {
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
    await $.command.register({ name: MENU_COMMAND, description: 'Pick your buddy from a menu with a live preview: the shipped characters, your original companion, your customCharactersDir', immediate: true });
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
  lg($, 'info', 'session.start', { build, model: st.options.model, effort: st.options.effort, level: L.level, commentAfterEachTurn: st.options.commentAfterEachTurn, suggestNextPrompt: st.options.suggestNextPrompt, rememberedExchanges: st.options.rememberedExchanges });
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

// ---- tool.call, turn.step and turn.complete ----------------------------

function onToolCall(st: State, $: EngineInterface, e: ToolCallInput, r: ToolCallResult): void {
  try {
    // A subagent's call is not the main turn's work.
    if (!st.b || !isMainLoop(e.agentId)) return;
    const call = e as unknown as { tool: string; command?: unknown; input?: unknown };
    const res = r as unknown as { deny?: unknown; isError?: unknown; text?: unknown; result?: unknown };
    react(st.b, { tool: call.tool, isError: res.isError === true, denied: typeof res.deny === 'string', output: toolOutput(res), command: call.tool === 'Bash' ? bashCommand(call) : '' }, Math.random);
    refresh(st, $);
  } catch (error) {
    log($, 'reacting to a tool call', error);
  }
}

/** Records the effort of a request of the running main turn, which effort inherit sends; a subagent's or a side request's leaves it. */
function onTurnStep(st: State, $: EngineInterface, e: TurnStepInput): void {
  try {
    st.mainEffort = observeEffort(st.mainEffort, e, st.mainTurn);
  } catch (error) {
    log($, "recording the main chat's effort", error);
  }
}

/** A prompt that entered the session (`r`, next(e)'s result) joins the ledger, with its origin; a dropped one never does. */
function onPromptSubmit(st: State, $: EngineInterface, e: PromptSubmitInput, r: PromptSubmitResult): void {
  try {
    if (typeof r.drop === 'string') return;
    // Validated here: an origin the engine left out is not presumed the user's.
    st.prompts = submitPrompt(st.prompts, r.text, e.origin?.kind ?? 'unclassified', e.turnId);
  } catch (error) {
    log($, 'remembering the prompt', error);
  }
}

/** A main turn began (only the main loop raises turn.start): it is the running one, and takes its prompt; an engine suggestion still held is for an ended turn, released. */
function onTurnStart(st: State, $: EngineInterface, e: TurnStartInput): void {
  try {
    st.mainTurn = e.turnId;
    st.prompts = startPromptTurn(st.prompts, e.turnId, e.text);
    if (st.harnessSuggestion !== null) {
      st.harnessSuggestion = null;
      lg($, 'info', 'suggestNextPrompt.outcome', { outcome: 'harness-stale' });
    }
  } catch (error) {
    log($, 'the start of a turn', error);
  }
}

function onTurnComplete(st: State, $: EngineInterface, e: TurnCompleteInput): void {
  try {
    // Only the main loop's end is the turn's end: a subagent's leaves the main turn's tally whole.
    if (!isMainLoop(e.agentId) || !st.b) return;
    wake(st.b, Math.random);
    // A turn ended, however: an earlier turn's call still running is stale, its commentAfterEachTurn and suggestNextPrompt never shown.
    const gen = ++st.turnGen;
    if (st.mainTurn === e.turnId) st.mainTurn = undefined;
    // Every main turn uses up the prompt that started it; only an answered one files it into the chatTurnsToRead turns, and a prompt not the user's under its origin.
    const ended = endPromptTurn(st.prompts, e.turnId);
    st.prompts = ended.ledger;
    const answered = e.reason === 'answer' && !e.isAborted;
    if (answered) st.turns = pushTurn(st.turns, { prompt: ended.prompt, answer: e.answer, ...(ended.from === undefined ? {} : { from: ended.from }) }, st.options.chatTurnsToRead);
    const gate: TurnGate = { answered, hidden: st.hidden, interactive: st.interactive, bandSeen: st.bandSeen, commentAfterEachTurn: st.options.commentAfterEachTurn, suggestNextPrompt: st.options.suggestNextPrompt };
    const may = turnMay(gate);
    const { turn, commentAfterEachTurnDue } = endTurn(st.b, may.commentAfterEachTurn, st.options.secondsBetweenComments);
    const wants: TurnWants = { commentAfterEachTurn: commentAfterEachTurnDue, suggestNextPrompt: may.suggestNextPrompt };
    // The engine's own suggestion is held back only while this turn's call may still propose one; one already held (the engine may suggest before this code runs) is shown or released, never erased.
    st.suggestNextPromptGaveUp = !wants.suggestNextPrompt;
    if (!wants.suggestNextPrompt) giveUpSuggestNextPrompt(st, $, gen, 0).catch((error) => log($, "showing the engine's own suggestion", error));
    if (wants.commentAfterEachTurn || wants.suggestNextPrompt) {
      lg($, 'info', 'turn.call', { commentAfterEachTurn: wants.commentAfterEachTurn, suggestNextPrompt: wants.suggestNextPrompt, tools: turn.tools.length });
      // The character drawn as the turn ended: a commentAfterEachTurn arriving after a switch is never said by another.
      turnCall(st, $, st.b.character, turn, gen, wants, Date.now()).catch((error) => log($, 'the end-of-turn call', error));
    } else {
      lg($, 'info', 'turn.skipped', { why: skipReason(gate) });
    }
    refresh(st, $);
  } catch (error) {
    log($, 'the end of a turn', error);
  }
}

/** A /clear or a resume: the chat the buddy read is gone, so its chatTurnsToRead turns, its prompts, the turn's tally and any call in flight are dropped. */
function forgetConversation(st: State, $: EngineInterface, reason: string): void {
  st.turns = [];
  st.prompts = NO_PROMPTS;
  st.mainTurn = undefined;
  st.conversation++;
  st.turnGen++;
  st.harnessSuggestion = null;
  st.suggestNextPromptGaveUp = true;
  if (st.b) endTurn(st.b, false, 0);
  lg($, 'info', 'session.forget', { reason });
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
 * One call at a turn's end writes the buddy's commentAfterEachTurn and
 * suggestNextPrompt, those wanted: a model completion on the main chat's last
 * chatTurnsToRead turns, in the voice of `c`, the character drawn as the turn ended.
 * One deadline covers the rememberedExchanges read, the settings and the completion.
 * A timeout, a refusal, an empty reply or a throw fails commentAfterEachTurn as
 * it fails and gives suggestNextPrompt up; a reply after a later turn ended (or
 * /clear) is stale by `gen`, its commentAfterEachTurn and suggestNextPrompt dropped.
 * Every outcome logs `ms`, from `started` (the turn's end) to the reply; the
 * call's usage goes on commentAfterEachTurn's outcome, else on suggestNextPrompt's.
 * Never throws.
 */
async function turnCall(st: State, $: EngineInterface, c: Character, t: TurnSummary, gen: number, wants: TurnWants, started: number): Promise<void> {
  // The chatTurnsToRead turns as this turn ended, before a later turn can move it.
  const turns = st.turns;
  let reply: { commentAfterEachTurn: string | null; suggestNextPrompt: string | null } | null = null;
  let reason = '';
  let usage: Record<string, number> = {};
  let late = false;
  try {
    const r = await within(
      sleeper($),
      (async (): Promise<ModelCompleteResult | 'timeout'> => {
        const t0 = await $.clock.now();
        // The rememberedExchanges and the settings do not wait on each other.
        const [rememberedExchanges, settings] = await Promise.all([readRememberedExchanges(st, $, c, TURN_DEADLINE_MS), callSettings(st, $, 'turn.settings')]);
        // Past the deadline already: no completion is sent that nobody waits for.
        if (late) return 'timeout' as const;
        const prompt = turnPrompt(t, turns, rememberedExchanges);
        lg($, 'debug', 'turn.prompt', { length: prompt.length });
        // Abandoned the margin past the deadline, however late it is sent.
        const timeoutMs = requestTimeoutMs(TURN_DEADLINE_MS, (await $.clock.now()) - t0);
        return $.model.complete({ ...settings, system: turnSystem(c.persona, wants), prompt, maxTokens: TURN_MAX_TOKENS, timeoutMs });
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
      lg($, 'debug', 'turn.reply', { length: r.text.length, commentAfterEachTurn: reply.commentAfterEachTurn?.length ?? 0, suggestNextPrompt: reply.suggestNextPrompt?.length ?? 0 });
    }
  } catch (error) {
    log($, 'the end-of-turn call', error);
    reason = message(error);
  }
  const ms = Date.now() - started;
  const commentAfterEachTurnFields = { ms, ...usage };
  const suggestNextPromptFields = wants.commentAfterEachTurn ? { ms } : { ms, ...usage };
  if (gen !== st.turnGen) {
    if (wants.commentAfterEachTurn) lg($, 'info', 'commentAfterEachTurn.outcome', { outcome: 'stale', ...commentAfterEachTurnFields });
    if (wants.suggestNextPrompt) lg($, 'info', 'suggestNextPrompt.outcome', { outcome: 'stale', ...suggestNextPromptFields });
    return;
  }
  if (wants.commentAfterEachTurn) sayCommentAfterEachTurn(st, $, c, t, reply?.commentAfterEachTurn ?? null, reason || 'no commentAfterEachTurn in the reply', commentAfterEachTurnFields);
  if (wants.suggestNextPrompt) {
    try {
      await showSuggestNextPrompt(st, $, gen, reply?.suggestNextPrompt ?? null, reason, c.id, suggestNextPromptFields);
    } catch (error) {
      log($, 'a suggestNextPrompt', error);
      await giveUpSuggestNextPrompt(st, $, gen, ms).catch((e) => log($, 'showing the engine\'s own suggestion', e));
    }
  }
}

/**
 * The commentAfterEachTurn of `c` in the bubble, or the failure why there is none;
 * a held /buddy answer keeps the bubble, a previous turn's commentAfterEachTurn does not.
 * Never said by another character drawn meanwhile. `fields`: ms and usage, logged on the outcome.
 */
function sayCommentAfterEachTurn(st: State, $: EngineInterface, c: Character, t: TurnSummary, text: string | null, reason: string, fields: Record<string, number>): void {
  const b = st.b;
  if (!b) return;
  try {
    if (text) {
      // Hidden by /buddy off while the model wrote it: never shown, so never remembered.
      // A held /buddy answer keeps the bubble until it ends: the commentAfterEachTurn is never said over it, nor remembered.
      const held = !st.hidden && holdsAnswer(b);
      const shown = !st.hidden && !held && answer(b, text, t.failures > 0 ? 'oops' : 'yay', c.id, true);
      if (shown) rememberExchange(st, $, c.id, { kind: 'commentAfterEachTurn', text });
      const outcome = shown ? 'answered' : st.hidden ? 'hidden' : held ? 'held' : 'dropped';
      lg($, 'info', 'commentAfterEachTurn.outcome', { outcome, ...(outcome === 'dropped' ? { asker: c.id, drawn: b.character.id } : {}), ...fields });
    } else {
      say($, `a commentAfterEachTurn got no answer: ${reason}`);
      if (holdsAnswer(b)) lg($, 'info', 'commentAfterEachTurn.outcome', { outcome: 'held', reason, ...fields });
      else {
        const shown = failAnswer(b, reason, c.id, true);
        lg($, 'info', 'commentAfterEachTurn.outcome', { outcome: shown ? 'failed' : 'dropped', reason, ...fields });
      }
    }
  } catch (error) {
    log($, 'a commentAfterEachTurn', error);
  }
  refresh(st, $);
}

/** The suggestNextPrompt of character `characterId` into the prompt box, remembered once shown; none, or a failed call, gives this turn's up. `fields`: the turn's end to the reply (`ms`), and the usage when no commentAfterEachTurn was wanted, logged on the outcome. */
async function showSuggestNextPrompt(st: State, $: EngineInterface, gen: number, text: string | null, reason: string, characterId: string, fields: Record<string, number>): Promise<void> {
  if (text === null) {
    lg($, 'info', 'suggestNextPrompt.outcome', reason ? { outcome: 'failed', reason, ...fields } : { outcome: 'none', ...fields });
    return giveUpSuggestNextPrompt(st, $, gen, fields.ms ?? 0);
  }
  // A later turn ended or started, /clear, or /buddy off came meanwhile: this one is never proposed.
  if (gen !== st.turnGen || st.hidden || st.mainTurn !== undefined) {
    lg($, 'info', 'suggestNextPrompt.outcome', { outcome: 'stale', ...fields });
    return;
  }
  const { isShown } = await $.prompt.suggest({ text });
  // Not shown because a turn started while it was proposed: stale, not the engine's refusal.
  lg($, 'info', 'suggestNextPrompt.outcome', { outcome: suggestNextPromptOutcome(isShown, st.mainTurn !== undefined), length: text.length, ...fields });
  // Shown: the buddy remembers this suggestNextPrompt, so it can say what it suggested last.
  if (isShown) rememberExchange(st, $, characterId, { kind: 'suggestNextPrompt', text });
}

/** The buddy has no suggestNextPrompt for turn `gen`: the engine's own, held back meanwhile, is shown, and a later one passes. `ms`: the turn's end to the reply, logged on the outcome. */
async function giveUpSuggestNextPrompt(st: State, $: EngineInterface, gen: number, ms: number): Promise<void> {
  if (gen !== st.turnGen) return;
  st.suggestNextPromptGaveUp = true;
  const text = st.harnessSuggestion;
  st.harnessSuggestion = null;
  if (text === null || st.hidden) return;
  // A turn started meanwhile: the engine's suggestion was for the ended turn, released unshown.
  if (st.mainTurn !== undefined) {
    lg($, 'info', 'suggestNextPrompt.outcome', { outcome: 'harness-stale', ms });
    return;
  }
  const { isShown } = await $.prompt.suggest({ text });
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
    say($, `/${MENU_COMMAND}: ${config.error}`);
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
  const model = buildMenu({ roster: st.roster, shippedError: st.shippedError, customCharactersDir: { isSet: Boolean(st.options.customCharactersDir), error: st.customCharactersDirError }, originals });
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
    say($, `/${MENU_COMMAND}: can't pick ${item.label}: ${item.error}`);
    return;
  }
  let note = '';
  if (item.pick.kind === 'original') {
    if (!menu.soul) {
      say($, `/${MENU_COMMAND}: can't pick ${item.label}: its soul was not found`);
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

/** A model result as log fields: never the whole text. */
function shape(r: ModelCompleteResult | 'timeout'): LogFields {
  if (r === 'timeout') return { timeout: true };
  return r.isAnswered ? { isAnswered: true, length: r.text.length, head: r.text.slice(0, 80) } : { isAnswered: false, reason: r.reason };
}

/**
 * One /buddy question of `c` to its outcome, always visible: an answer, or
 * "{name} couldn't answer: {reason}" in the bubble. `model` answers
 * from persona, rememberedExchanges (what `c` remembered before this question), the main
 * chat's last chatTurnsToRead turns (`chatTurnsToReadText`) and question, whether or not
 * the main turn is running. One deadline, from the question's start, covers
 * the rememberedExchanges read, the settings and the completion.
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
  const ms = Math.max(0, COMPLETE_DEADLINE_MS - (Date.now() - started));
  let cleared = false;
  let said = '';
  let reason = '';
  let usage: Record<string, number> = {};
  // The answer belongs to the one asked: a character switched in meanwhile never says it.
  let shown = true;
  let late = false;
  try {
    const r: ModelCompleteResult | 'timeout' = await within(
      sleeper($),
      (async (): Promise<ModelCompleteResult | 'timeout'> => {
        const t0 = await $.clock.now();
        // The rememberedExchanges and the settings do not wait on each other.
        const [rememberedExchanges, settings] = await Promise.all([readRememberedExchanges(st, $, c, ms), callSettings(st, $, 'ask.settings')]);
        // Past the deadline already: no completion is sent that nobody waits for.
        if (late) return 'timeout' as const;
        // A completion does not see the chat: the chatTurnsToRead turns tell it where the chat stands.
        const prompt = questionPrompt(question, rememberedExchanges, chatTurnsToReadText(st.turns));
        lg($, 'debug', 'ask.prompt', { length: prompt.length });
        // Abandoned the margin past the deadline, however late it is sent.
        const send = async (): Promise<ModelCompleteResult> =>
          $.model.complete({ ...settings, system: oneLineSystem(c.persona), prompt, maxTokens: QUESTION_MAX_TOKENS, timeoutMs: requestTimeoutMs(ms, (await $.clock.now()) - t0) });
        const first = await send();
        const leftMs = ms - ((await $.clock.now()) - t0);
        if (late || !retriesEmpty(first, leftMs)) return first;
        // The model returned no words and the question is still open: asked once more, its outcome counting both calls.
        lg($, 'debug', 'ask.retry', { reason: 'empty reply', leftMs });
        const again = await send();
        return { ...again, usage: sumUsage(first.usage, again.usage) } as ModelCompleteResult;
      })(),
      ms,
    );
    late = r === 'timeout';
    lg($, 'debug', 'ask.result', shape(r));
    // What the call cost and how much it read from the prompt cache.
    usage = r !== 'timeout' && 'usage' in r ? usageFields(r.usage) : {};
    const text = r !== 'timeout' && r.isAnswered ? oneLine(r.text) : '';
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
    reason = message(error);
    log($, 'a /buddy question', error);
    shown = failAnswer(b, reason, c.id);
  } finally {
    st.asking = null;
    endQuestion(b);
  }
  if (cleared) {
    warn($, 'ask.dropped', `${c.name}'s answer was dropped: the conversation it was asked in ended`, { asker: c.id });
    lg($, 'info', 'ask.outcome', { outcome: 'dropped', reason, ms: Date.now() - started, ...usage });
    refresh(st, $);
    return;
  }
  const hidden = !shown && st.hidden;
  if (!shown && !hidden) warn($, 'ask.dropped', `${c.name}'s answer was dropped: ${b.character.name} is drawn now`, { asker: c.id, drawn: b.character.id });
  lg($, 'info', 'ask.outcome', { outcome: hidden ? 'hidden' : !shown ? 'dropped' : said ? 'answered' : 'failed', ...(reason ? { reason } : {}), ms: Date.now() - started, ...usage });
  // One exchange: the question with its answer as shown, or the question alone.
  rememberExchange(st, $, c.id, said && shown ? { kind: 'question', question, answer: said } : { kind: 'question', question });
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
        // The thinking line at once; ask reads the rememberedExchanges, the question joining it with its answer.
        beginQuestion(b, Math.random);
        refresh(st, $);
        ask(st, $, action.text, c).catch((error) => {
          st.asking = null;
          log($, 'a /buddy question', error);
          endQuestion(b);
          failAnswer(b, message(error), c.id);
          refresh(st, $);
        });
        const trouble = st.rememberedExchangesError;
        st.rememberedExchangesError = '';
        return { text: `Asked ${c.name}.${trouble ? ` (Its rememberedExchanges: ${trouble})` : ''}` };
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
    rememberedExchanges: null,
    rememberedExchangesChain: Promise.resolve(),
    rememberedExchangesError: '',
    rememberedExchangesHangSaid: false,
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
    inheritFailed: new Set(),
    mainEffort: undefined,
    prompts: NO_PROMPTS,
    mainTurn: undefined,
    conversation: 0,
    turns: [],
    warned: false,
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

  // What entered, once it did: a prompt a lower hook dropped starts no turn and is never filed.
  on('prompt.submit', async ($, e, next) => {
    const r = await next(e);
    onPromptSubmit(st, $, e, r);
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

  on('turn.complete', async ($, e, next) => {
    const r = await next(e);
    onTurnComplete(st, $, e);
    return r;
  });

  // The main chat's effort reaches the plugin only on its requests: recorded, then the stream passes through untouched.
  on('turn.step', async function* ($, e, next) {
    onTurnStep(st, $, e);
    return yield* next(e);
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
