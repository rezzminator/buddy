// The plugin's userConfig, resolved to typed values with the manifest's
// defaults; a bad value is ignored by name and listed, never silently.

import { configDir, type ConfigEnv } from './config-source.ts';
import { LOG_LEVELS, type LogLevel } from './log.ts';
import { MEMORY_DEFAULT, MEMORY_MAX } from './memory.ts';

export type QuestionMode = 'fork' | 'complete' | 'off';
export type AmbiguousWidth = 'narrow' | 'wide';
export const AMBIGUOUS_WIDTHS: readonly AmbiguousWidth[] = ['narrow', 'wide'];
export const QUESTION_MODES: readonly QuestionMode[] = ['fork', 'complete', 'off'];

export type Options = {
  character: string;
  characterDir: string;
  motion: boolean;
  questionMode: QuestionMode;
  /** The end-of-turn call writes the buddy's line, shown in the bubble. */
  quips: boolean;
  /** The model of the end-of-turn call and of questions that do not fork. */
  quipModel: string;
  /** The least seconds between two lines; 0 = every answered turn. */
  quipCooldownSec: number;
  /** The end-of-turn call writes the next-prompt suggestion, and the harness's own is held back, shown only when the buddy has none. */
  suggestions: boolean;
  /** How many recent exchanges the buddy remembers per session and character; 0 = off. */
  memory: number;
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
  questionMode: 'fork',
  quips: true,
  quipModel: 'haiku',
  quipCooldownSec: 0,
  suggestions: true,
  memory: MEMORY_DEFAULT,
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
  const { character, characterDir, motion, questionMode, quips, quipModel, quipCooldownSec, suggestions, memory, logLevel, logFile, ambiguousWidth } = raw;
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
  if (questionMode !== undefined && questionMode !== '') {
    const m = typeof questionMode === 'string' ? questionMode.trim().toLowerCase() : '';
    if ((QUESTION_MODES as readonly string[]).includes(m)) o.questionMode = m as QuestionMode;
    else bad('questionMode', `${JSON.stringify(questionMode)} is not fork, complete or off`);
  }
  if (quipModel !== undefined && quipModel !== '') {
    if (typeof quipModel === 'string') o.quipModel = quipModel.trim();
    else bad('quipModel', 'not a string');
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
