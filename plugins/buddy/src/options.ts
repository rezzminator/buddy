// The plugin's userConfig, resolved to typed values with the manifest's
// defaults; a bad value is ignored by name and listed, never silently.

import { isMainLoop } from './brain.ts';
import { configDir, type ConfigEnv } from './config-source.ts';
import { LOG_LEVELS, type LogLevel } from './log.ts';
import { MEMORY_DEFAULT, MEMORY_MAX } from './memory.ts';
import { TURN_WINDOW, TURN_WINDOW_MAX } from './prompts.ts';

/** How hard the buddy's model thinks: the engine's ModelEffort values. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** quipModel's and effort's value for "whatever the main chat has", resolved at every call. */
export const INHERIT = 'inherit';
/** The model an inherited quipModel falls back to when the main chat's cannot be read. */
export const INHERIT_FALLBACK_MODEL = 'opus';
export type AmbiguousWidth = 'narrow' | 'wide';
export const AMBIGUOUS_WIDTHS: readonly AmbiguousWidth[] = ['narrow', 'wide'];

export type Options = {
  character: string;
  characterDir: string;
  motion: boolean;
  /** The end-of-turn call writes the buddy's line, shown in the bubble. */
  quips: boolean;
  /** The model of the buddy's lines, suggestions and questions: the end-of-turn call and every /buddy question; 'inherit' = the main chat's (resolveModel). */
  quipModel: string;
  /** How hard quipModel thinks on each of those calls; 'inherit' = the main chat's (resolveEffort). */
  effort: Effort | typeof INHERIT;
  /** The least seconds between two lines; 0 = every answered turn. */
  quipCooldownSec: number;
  /** The end-of-turn call writes the next-prompt suggestion, and the harness's own is held back, shown only when the buddy has none. */
  suggestions: boolean;
  /** How many recent exchanges the buddy remembers per session and character; 0 = off. */
  memory: number;
  /** How many of the main chat's latest answered turns a completion reads, 1 to TURN_WINDOW_MAX: questions and the end-of-turn call. */
  contextTurns: number;
  /** The plugin log's level: error, info or debug. */
  logLevel: LogLevel;
  /** The plugin log's file, `~` and `$CLAUDE_CONFIG_DIR` not yet expanded (logPath); '' = no log file (errors still go to the debug log). */
  logFile: string;
  /** How many columns an East Asian ambiguous-width character takes: narrow 1, wide 2. */
  ambiguousWidth: AmbiguousWidth;
  errors: string[];
};

export const DEFAULTS: Omit<Options, 'errors'> = {
  character: 'duck',
  characterDir: '',
  motion: true,
  quips: true,
  quipModel: 'opus',
  effort: 'low',
  quipCooldownSec: 0,
  suggestions: true,
  memory: MEMORY_DEFAULT,
  contextTurns: TURN_WINDOW,
  logLevel: 'info',
  logFile: '$CLAUDE_CONFIG_DIR/buddy/buddy.log',
  ambiguousWidth: 'narrow',
};

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

export function resolveOptions(raw: Record<string, unknown>): Options {
  const o: Options = { ...DEFAULTS, errors: [] };
  const bad = (key: string, why: string) => o.errors.push(`option ${key} ignored: ${why}`);
  const { character, characterDir, motion, quips, quipModel, effort, quipCooldownSec, suggestions, memory, contextTurns, logLevel, logFile, ambiguousWidth } = raw;
  if (character !== undefined && character !== '') {
    if (typeof character === 'string') o.character = character.trim().toLowerCase();
    else bad('character', 'not a string');
  }
  if (characterDir !== undefined && characterDir !== '') {
    if (typeof characterDir === 'string') o.characterDir = characterDir.trim();
    else bad('characterDir', 'not a string');
  }
  if (motion !== undefined) {
    const b = bool(motion);
    if (b === undefined) bad('motion', `${JSON.stringify(motion)} is not true or false`);
    else o.motion = b;
  }
  if (quips !== undefined) {
    const b = bool(quips);
    if (b === undefined) bad('quips', `${JSON.stringify(quips)} is not true or false`);
    else o.quips = b;
  }
  if (suggestions !== undefined) {
    const b = bool(suggestions);
    if (b === undefined) bad('suggestions', `${JSON.stringify(suggestions)} is not true or false`);
    else o.suggestions = b;
  }
  if (quipModel !== undefined && quipModel !== '') {
    if (typeof quipModel === 'string') o.quipModel = quipModel.trim().toLowerCase() === INHERIT ? INHERIT : quipModel.trim();
    else bad('quipModel', 'not a string');
  }
  if (effort !== undefined && effort !== '') {
    const e = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
    if (e === INHERIT) o.effort = INHERIT;
    else if ((EFFORTS as readonly string[]).includes(e)) o.effort = e as Effort;
    else bad('effort', `${JSON.stringify(effort)} is not low, medium, high, xhigh, max or inherit`);
  }
  if (quipCooldownSec !== undefined && quipCooldownSec !== '') {
    const n = typeof quipCooldownSec === 'number' ? quipCooldownSec : Number(quipCooldownSec);
    if (Number.isFinite(n) && n >= 0) o.quipCooldownSec = n;
    else bad('quipCooldownSec', `${JSON.stringify(quipCooldownSec)} is not a number of seconds`);
  }
  if (memory !== undefined && memory !== '') {
    const n = typeof memory === 'number' ? memory : typeof memory === 'string' ? Number(memory) : NaN;
    if (!Number.isInteger(n) || n < 0) bad('memory', `${JSON.stringify(memory)} is not a whole number of exchanges; remembering ${MEMORY_DEFAULT}`);
    else if (n > MEMORY_MAX) {
      o.memory = MEMORY_MAX;
      o.errors.push(`option memory capped: ${n} is above ${MEMORY_MAX}; remembering ${MEMORY_MAX}`);
    } else o.memory = n;
  }
  if (contextTurns !== undefined && contextTurns !== '') {
    const n = typeof contextTurns === 'number' ? contextTurns : typeof contextTurns === 'string' ? Number(contextTurns) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= TURN_WINDOW_MAX) o.contextTurns = n;
    else bad('contextTurns', `${JSON.stringify(contextTurns)} is not a whole number from 1 to ${TURN_WINDOW_MAX}; reading ${TURN_WINDOW}`);
  }
  if (logLevel !== undefined && logLevel !== '') {
    const l = typeof logLevel === 'string' ? logLevel.trim().toLowerCase() : '';
    if ((LOG_LEVELS as readonly string[]).includes(l)) o.logLevel = l as LogLevel;
    else bad('logLevel', `${JSON.stringify(logLevel)} is not error, info or debug`);
  }
  if (ambiguousWidth !== undefined && ambiguousWidth !== '') {
    const w = typeof ambiguousWidth === 'string' ? ambiguousWidth.trim().toLowerCase() : '';
    if ((AMBIGUOUS_WIDTHS as readonly string[]).includes(w)) o.ambiguousWidth = w as AmbiguousWidth;
    else bad('ambiguousWidth', `${JSON.stringify(ambiguousWidth)} is not narrow or wide`);
  }
  // Unlike the others, an empty logFile means something: no log file.
  if (logFile !== undefined) {
    if (typeof logFile === 'string') o.logFile = logFile.trim();
    else bad('logFile', 'not a string');
  }
  return o;
}

/** The model a call runs on: the option, or for 'inherit' the main chat's, INHERIT_FALLBACK_MODEL when that is unknown. */
export function resolveModel(option: string, sessionModel: string | undefined): string {
  if (option !== INHERIT) return option;
  const model = sessionModel?.trim() ?? '';
  return model || INHERIT_FALLBACK_MODEL;
}

/** The main chat's effort as its latest request (turn.step) carried it: a level, a number, or undefined (no request yet, or a model without effort). */
export type ObservedEffort = Effort | number | undefined;

/** The effort recorded after a model request: a main-loop request's (no agentId) replaces it, even when absent; a subagent's leaves it. */
export function observeEffort(recorded: ObservedEffort, step: { agentId?: string; effort?: Effort | number }): ObservedEffort {
  return isMainLoop(step.agentId) ? step.effort : recorded;
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
