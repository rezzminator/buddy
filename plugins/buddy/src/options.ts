// The plugin's options, read from its own config file (configFilePath), parsed
// (parseConfigFile) and resolved to typed values with the defaults. Values are
// JSON's own types: a boolean is true or false, a number a number. A bad value,
// an unknown key or a bad file is listed by name, never silently, and the
// default is used for it; the valid keys still apply.

import { isMainLoop } from './brain.ts';
import { configDir, type ConfigEnv } from './config-source.ts';
import { LOG_LEVELS, type LogLevel } from './log.ts';
import { CHAT_TURNS_TO_READ_DEFAULT, CHAT_TURNS_TO_READ_MAX } from './chatTurnsToRead.ts';
import { AMBIGUOUS_CHARACTER_WIDTHS, type AmbiguousCharacterWidth } from './width.ts';

/** How hard the buddy's model thinks: the engine's ModelEffort values. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** model's and effort's value for "whatever the main chat has", resolved at every call. */
export const INHERIT = 'inherit';
/** The model an inherited model falls back to when the main chat's cannot be read. */
export const INHERIT_FALLBACK_MODEL = 'opus';

export type Options = {
  character: string;
  customCharactersDir: string;
  walkOverPromptBar: boolean;
  /** The end-of-turn call writes the buddy's commentAfterEachTurn, shown in the bubble. */
  commentAfterEachTurn: boolean;
  /** The model of commentAfterEachTurn, suggestNextPrompt and every /buddy question: the end-of-turn call and every /buddy question; 'inherit' = the main chat's (resolveModel). */
  model: string;
  /** How hard model thinks on each of those calls; 'inherit' = the main chat's (resolveEffort). */
  effort: Effort | typeof INHERIT;
  /** The least seconds between two commentAfterEachTurn; 0 = every answered turn. */
  secondsBetweenComments: number;
  /** The end-of-turn call writes suggestNextPrompt, and the harness's own suggestion is held back, shown only when the buddy has none. */
  suggestNextPrompt: boolean;
  /** The end-of-turn call may write a prompt the buddy sends the main chat itself (PROMPT_TO_MAIN_CHAT), at most one per prompt of the user's. */
  promptToMainChat: boolean;
  /** After 30 idle minutes, one model call asks whether Claude needs a push; a push reaches Claude as the buddy's prompt. */
  promptWhenIdle: boolean;
  /** The buddy's memory: how many of the main chat's latest answered turns it remembers, with what it and the user said around them, 1 to CHAT_TURNS_TO_READ_MAX; every question and end-of-turn call reads it. */
  chatTurnsToRead: number;
  /** The plugin log's level: error, info or debug. */
  logLevel: LogLevel;
  /** The plugin log's file, `~` and `$CLAUDE_CONFIG_DIR` not yet expanded (logPath); '' = no log file (errors still go to the debug log). */
  logFile: string;
  /** Each round (one main-chat turn, and every model call the buddy made after it, verbatim) is written as its own file into the chat's own folder, beside its transcript (src/chatFolder.ts). */
  saveRounds: boolean;
  /** How many columns an East Asian ambiguous-width character takes: narrow 1, wide 2. */
  ambiguousCharacterWidth: AmbiguousCharacterWidth;
  errors: string[];
};

export const DEFAULTS: Omit<Options, 'errors'> = {
  character: 'duck',
  customCharactersDir: '',
  walkOverPromptBar: true,
  commentAfterEachTurn: true,
  model: 'opus',
  effort: 'low',
  secondsBetweenComments: 0,
  suggestNextPrompt: true,
  promptToMainChat: true,
  promptWhenIdle: false,
  chatTurnsToRead: CHAT_TURNS_TO_READ_DEFAULT,
  logLevel: 'info',
  logFile: '$CLAUDE_CONFIG_DIR/buddy/buddy.log',
  saveRounds: true,
  ambiguousCharacterWidth: 'narrow',
};

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

type Problem = { key: string; why: string; kept?: string };

/** What locates the config file. */
export type ConfigFileEnv = { HOME?: string; XDG_CONFIG_HOME?: string };
export const CONFIG_FILE_SUFFIX = 'buddy/config.json';

/** A base directory as the path's head: absolute, trailing slashes dropped (the root `/` heads as ''); undefined when unset or relative. */
function baseDir(dir: string | undefined): string | undefined {
  return dir?.startsWith('/') ? dir.replace(/\/+$/, '') : undefined;
}

/** Where the config file lives: `$XDG_CONFIG_HOME/buddy/config.json` when XDG_CONFIG_HOME is set and absolute, else `$HOME/.config/buddy/config.json` when HOME is absolute. */
export function configFilePath(env: ConfigFileEnv): { path: string } | { error: string } {
  const xdg = baseDir(env.XDG_CONFIG_HOME);
  if (xdg !== undefined) return { path: `${xdg}/${CONFIG_FILE_SUFFIX}` };
  const home = baseDir(env.HOME);
  if (home !== undefined) return { path: `${home}/.config/${CONFIG_FILE_SUFFIX}` };
  return { error: `no config file: neither XDG_CONFIG_HOME nor HOME is an absolute path to place ${CONFIG_FILE_SUFFIX} under` };
}

function kindOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
}

/** The config file's text as the raw options: a JSON object, else none and one error naming the file; its keys are checked by resolveOptions. */
export function parseConfigFile(text: string, path: string): { raw: Record<string, unknown>; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { raw: {}, errors: [`config file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}; using the defaults`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { raw: {}, errors: [`config file ${path} must hold a JSON object, not ${kindOf(parsed)}; using the defaults`] };
  return { raw: parsed as Record<string, unknown>, errors: [] };
}

/** The settings sources an old `pluginConfigs` entry can sit in, as `$.settings.read({ source })` names them. */
export const SETTINGS_SOURCES = ['user', 'project', 'local', 'flag', 'policy'] as const;

/**
 * The option keys of every `pluginConfigs` entry for buddy (`buddy@{marketplace}`)
 * in these settings, in first-seen order: what an install before 3.0.0 left
 * behind. Claude Code hands `register` only the options a manifest declares, and
 * buddy declares none, so the settings are where a leftover entry shows.
 */
export function leftoverOptionKeys(settings: readonly Readonly<Record<string, unknown>>[]): string[] {
  const keys = new Set<string>();
  for (const source of settings) {
    const configs = source.pluginConfigs;
    if (typeof configs !== 'object' || configs === null || Array.isArray(configs)) continue;
    for (const [id, entry] of Object.entries(configs)) {
      if (id.split('@')[0] !== 'buddy' || typeof entry !== 'object' || entry === null) continue;
      const options = (entry as { options?: unknown }).options;
      if (typeof options === 'object' && options !== null && !Array.isArray(options)) for (const key of Object.keys(options)) keys.add(key);
    }
  }
  return [...keys];
}

/** The warning for the option keys of an old `pluginConfigs` entry: they are never applied. undefined when there are none. */
export function staleOptionsWarning(keys: readonly string[], path: string): string | undefined {
  if (keys.length === 0) return undefined;
  return `pluginConfigs options (${keys.join(', ')}) are no longer read and not applied: buddy reads ${path} instead; move them there and remove the pluginConfigs entry`;
}

/**
 * The options: `raw` is the config file's parsed object, `fileErrors` what
 * reading it already reported. A bad or unknown key is listed by name and its
 * option takes the default.
 */
export function resolveOptions(raw: Record<string, unknown>, fileErrors: readonly string[] = []): Options {
  const { o, problems } = resolve(raw);
  const shown = (p: Problem) => `option ${p.key} ignored: ${p.why}${p.kept ? `; ${p.kept}` : ''}`;
  const unknown = Object.keys(raw).filter((k) => !Object.hasOwn(DEFAULTS, k)).map((key) => ({ key, why: 'not a buddy option' }));
  o.errors = [...fileErrors, ...[...problems, ...unknown].map(shown)];
  return o;
}

/**
 * The session's options: the config file's (`file`, as the adapter read it) and
 * nothing else. `leftover` is the option keys of an old `pluginConfigs` entry:
 * said once, after the file's errors, never applied.
 */
export function sessionOptions(file: { raw: Record<string, unknown>; errors: readonly string[]; path: string }, leftover: readonly string[]): Options {
  const stale = staleOptionsWarning(leftover, file.path);
  return resolveOptions(file.raw, stale === undefined ? file.errors : [...file.errors, stale]);
}

function resolve(raw: Record<string, unknown>): { o: Options; problems: Problem[] } {
  const o: Options = { ...DEFAULTS, errors: [] };
  const problems: Problem[] = [];
  const bad = (key: string, why: string, kept?: string) => problems.push({ key, why, kept });
  const { character, customCharactersDir, walkOverPromptBar, commentAfterEachTurn, model, effort, secondsBetweenComments, suggestNextPrompt, promptToMainChat, promptWhenIdle, chatTurnsToRead, logLevel, logFile, saveRounds, ambiguousCharacterWidth } = raw;
  if (character !== undefined && character !== '') {
    if (typeof character === 'string') o.character = character.trim().toLowerCase();
    else bad('character', 'not a string');
  }
  if (customCharactersDir !== undefined && customCharactersDir !== '') {
    if (typeof customCharactersDir === 'string') o.customCharactersDir = customCharactersDir.trim();
    else bad('customCharactersDir', 'not a string');
  }
  if (walkOverPromptBar !== undefined) {
    const b = bool(walkOverPromptBar);
    if (b === undefined) bad('walkOverPromptBar', `${JSON.stringify(walkOverPromptBar)} is not true or false`);
    else o.walkOverPromptBar = b;
  }
  if (commentAfterEachTurn !== undefined) {
    const b = bool(commentAfterEachTurn);
    if (b === undefined) bad('commentAfterEachTurn', `${JSON.stringify(commentAfterEachTurn)} is not true or false`);
    else o.commentAfterEachTurn = b;
  }
  if (suggestNextPrompt !== undefined) {
    const b = bool(suggestNextPrompt);
    if (b === undefined) bad('suggestNextPrompt', `${JSON.stringify(suggestNextPrompt)} is not true or false`);
    else o.suggestNextPrompt = b;
  }
  if (promptToMainChat !== undefined) {
    const b = bool(promptToMainChat);
    if (b === undefined) bad('promptToMainChat', `${JSON.stringify(promptToMainChat)} is not true or false`);
    else o.promptToMainChat = b;
  }
  if (promptWhenIdle !== undefined) {
    const b = bool(promptWhenIdle);
    if (b === undefined) bad('promptWhenIdle', `${JSON.stringify(promptWhenIdle)} is not true or false`);
    else o.promptWhenIdle = b;
  }
  if (saveRounds !== undefined) {
    const b = bool(saveRounds);
    if (b === undefined) bad('saveRounds', `${JSON.stringify(saveRounds)} is not true or false`);
    else o.saveRounds = b;
  }
  if (model !== undefined && model !== '') {
    if (typeof model === 'string') o.model = model.trim().toLowerCase() === INHERIT ? INHERIT : model.trim();
    else bad('model', 'not a string');
  }
  if (effort !== undefined && effort !== '') {
    const e = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
    if (e === INHERIT) o.effort = INHERIT;
    else if ((EFFORTS as readonly string[]).includes(e)) o.effort = e as Effort;
    else bad('effort', `${JSON.stringify(effort)} is not low, medium, high, xhigh, max or inherit`);
  }
  if (secondsBetweenComments !== undefined) {
    const n = secondsBetweenComments;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) o.secondsBetweenComments = n;
    else bad('secondsBetweenComments', `${JSON.stringify(secondsBetweenComments)} is not a number of seconds`);
  }
  if (chatTurnsToRead !== undefined) {
    const n = chatTurnsToRead;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= CHAT_TURNS_TO_READ_MAX) o.chatTurnsToRead = n;
    else bad('chatTurnsToRead', `${JSON.stringify(chatTurnsToRead)} is not a whole number from 1 to ${CHAT_TURNS_TO_READ_MAX}`, `reading ${CHAT_TURNS_TO_READ_DEFAULT}`);
  }
  if (logLevel !== undefined && logLevel !== '') {
    const l = typeof logLevel === 'string' ? logLevel.trim().toLowerCase() : '';
    if ((LOG_LEVELS as readonly string[]).includes(l)) o.logLevel = l as LogLevel;
    else bad('logLevel', `${JSON.stringify(logLevel)} is not error, info or debug`);
  }
  if (ambiguousCharacterWidth !== undefined && ambiguousCharacterWidth !== '') {
    const w = typeof ambiguousCharacterWidth === 'string' ? ambiguousCharacterWidth.trim().toLowerCase() : '';
    if ((AMBIGUOUS_CHARACTER_WIDTHS as readonly string[]).includes(w)) o.ambiguousCharacterWidth = w as AmbiguousCharacterWidth;
    else bad('ambiguousCharacterWidth', `${JSON.stringify(ambiguousCharacterWidth)} is not narrow or wide`);
  }
  // Unlike the others, an empty logFile means something: no log file.
  if (logFile !== undefined) {
    if (typeof logFile === 'string') o.logFile = logFile.trim();
    else bad('logFile', 'not a string');
  }
  return { o, problems };
}

/** The model a call runs on: the option, or for 'inherit' the main chat's, INHERIT_FALLBACK_MODEL when that is unknown. */
export function resolveModel(option: string, sessionModel: string | undefined): string {
  if (option !== INHERIT) return option;
  const model = sessionModel?.trim() ?? '';
  return model || INHERIT_FALLBACK_MODEL;
}

/** The main chat's effort as its latest request (turn.step) carried it: a level, a number, or undefined (no request yet, or a model without effort). */
export type ObservedEffort = Effort | number | undefined;

/**
 * The effort recorded after a model request: a step of the running main turn
 * (`mainTurn`, turn.start's id; no agentId) replaces it, even when absent; a
 * subagent's, or any step outside that turn (an engine side request, or none
 * running), leaves it.
 */
export function observeEffort(recorded: ObservedEffort, step: { turnId: string; agentId?: string; effort?: Effort | number }, mainTurn: string | undefined): ObservedEffort {
  return isMainLoop(step.agentId) && mainTurn !== undefined && step.turnId === mainTurn ? step.effort : recorded;
}

/** The effort a call sends: the option, or for 'inherit' the level of the main chat's latest request; a number, none, or no request yet sends none, so the model's default applies. */
export function resolveEffort(option: Effort | typeof INHERIT, observed: ObservedEffort): Effort | undefined {
  if (option !== INHERIT) return option;
  return typeof observed === 'string' && (EFFORTS as readonly string[]).includes(observed) ? observed : undefined;
}

/** Stands for Claude Code's config folder at the start of logFile: CLAUDE_CONFIG_DIR, or ~/.claude when it is unset. */
export const CONFIG_DIR_TOKEN = '$CLAUDE_CONFIG_DIR';

/**
 * Where the plugin log goes: '' for no file; a leading `$CLAUDE_CONFIG_DIR`
 * is the config folder, as Claude Code resolves it, so accounts never share
 * the default log; a leading `~` is HOME; any other path as given.
 */
export function logPath(logFile: string, env: ConfigEnv): { path: string } | { error: string } {
  if (logFile === CONFIG_DIR_TOKEN || logFile.startsWith(`${CONFIG_DIR_TOKEN}/`)) {
    const dir = configDir(env);
    return dir === null ? { error: `no log file: neither CLAUDE_CONFIG_DIR nor HOME is set to place ${logFile}` } : { path: dir + logFile.slice(CONFIG_DIR_TOKEN.length) };
  }
  if (!logFile.startsWith('~')) return { path: logFile };
  const path = expandHome(logFile, env.HOME);
  return path.startsWith('~') ? { error: `no HOME to expand ${logFile}` } : { path };
}

/** `~` or `~/...` against the home directory; anything else as given. */
export function expandHome(dir: string, home: string | undefined): string {
  if (!home || !(dir === '~' || dir.startsWith('~/'))) return dir;
  return home.replace(/\/$/, '') + dir.slice(1);
}
