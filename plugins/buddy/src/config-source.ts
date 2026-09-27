import { CONFIG_NAME, newestFirst } from './original.ts';

// Where Claude Code keeps its config, and which files near it are backups
// worth reading. Measured on Claude Code 2.1.283: with CLAUDE_CONFIG_DIR set,
// `$CLAUDE_CONFIG_DIR/.claude.json` and `$CLAUDE_CONFIG_DIR/backups/`, nothing
// under HOME; without it, `$HOME/.claude.json` and `$HOME/.claude/backups/`.
// With CLAUDE_CONFIG_DIR set, HOME's files are another account's and are never
// looked at. Pure.

/** Beside the config file, or in its `backups` folder. */
export type Where = 'beside' | 'folder';
/** A place to list for backups, and how it is shown: `~` or `$CLAUDE_CONFIG_DIR`, never the full path. */
export type BackupDir = { dir: string; shown: string; where: Where };
export type ConfigSources = { configFile: string; shownConfig: string; backupDirs: BackupDir[] };
export type ConfigEnv = { HOME?: string; CLAUDE_CONFIG_DIR?: string };

const ENV_DIR = '$CLAUDE_CONFIG_DIR';

/** `dir` without trailing slashes; a root `/` becomes `''`, which joins as `/name`. */
function base(dir: string): string {
  return dir.replace(/\/+$/, '');
}

function sources(root: string, backups: string, shown: string, shownBackups: string): ConfigSources {
  return {
    configFile: `${root}/${CONFIG_NAME}`,
    shownConfig: `${shown}/${CONFIG_NAME}`,
    backupDirs: [
      { dir: root || '/', shown, where: 'beside' },
      { dir: `${root}/${backups}`, shown: shownBackups, where: 'folder' },
    ],
  };
}

/** Claude Code's config folder: CLAUDE_CONFIG_DIR, else ~/.claude; an empty value is unset; null when neither is set. */
export function configDir(env: ConfigEnv): string | null {
  if (env.CLAUDE_CONFIG_DIR) return base(env.CLAUDE_CONFIG_DIR);
  if (env.HOME) return `${base(env.HOME)}/.claude`;
  return null;
}

/** The config file and the places its backups live: CLAUDE_CONFIG_DIR first, else HOME; an empty value is unset. */
export function configSources(env: ConfigEnv): ConfigSources | { error: string } {
  if (env.CLAUDE_CONFIG_DIR) return sources(base(env.CLAUDE_CONFIG_DIR), 'backups', ENV_DIR, `${ENV_DIR}/backups`);
  if (env.HOME) return sources(base(env.HOME), '.claude/backups', '~', '~/.claude/backups');
  return { error: `couldn't find ${CONFIG_NAME}: neither CLAUDE_CONFIG_DIR nor HOME is set` };
}

/** A listed file: `size` from `$.fs.list`, `mtimeMs` from `$.fs.stat` once it is known. */
export type Listed = { name: string; where: Where; kind?: string; size?: number; mtimeMs?: number };
export type BackupLimits = { maxCount: number; maxBytes: number };
export type DroppedBackup = { name: string; where: Where; reason: string };

const MB = 1024 * 1024;
export const BACKUP_LIMITS: BackupLimits = { maxCount: 10, maxBytes: 5 * MB };

const PREFIX = `${CONFIG_NAME}.`;
const NAME = CONFIG_NAME.replace(/\./g, '\\.');
/** Beside the config: `.backup`, `.backup.{n}`, `.bak`, `.bak-*`, `.pre-*`. */
const BESIDE = new RegExp(`^${NAME}\\.(?:backup(?:\\.\\d+)?|bak(?:-.+)?|pre-.+)$`);
/** In the backups folder: `.backup.*`, what Claude Code writes there. */
const FOLDER = new RegExp(`^${NAME}\\.backup\\..+$`);

function mb(bytes: number): string {
  return String(Number((bytes / MB).toFixed(1)));
}

/** Why a listed file is not read, or null when it may be; undefined when it is not a `.claude.json.*` file beside the config at all. */
function dropReason(e: Listed, maxBytes: number): string | null | undefined {
  if (e.where === 'beside' && !e.name.startsWith(PREFIX)) return undefined;
  if (e.kind === 'dir') return 'a folder';
  if (e.name.includes('.tmp.')) return 'an unfinished write (.tmp)';
  if (!(e.where === 'beside' ? BESIDE : FOLDER).test(e.name)) return 'not a backup name';
  if (e.size === 0) return 'empty (0 bytes)';
  if (e.size !== undefined && e.size > maxBytes) return `too big to read (${(e.size / MB).toFixed(1)} MB, the cap is ${mb(maxBytes)} MB)`;
  return null;
}

/**
 * The backups worth reading, newest first (by `mtimeMs`, then name; no time
 * sorts last), at most `maxCount` of them; `dropped` says why each other
 * `.claude.json.*` file was left, by name only. Unrelated files beside the
 * config are ignored. Idempotent, so a first pass over `$.fs.list` sizes can
 * precede the `$.fs.stat` that dates what it kept.
 */
export function backupCandidates<T extends Listed>(listing: readonly T[], limits: BackupLimits = BACKUP_LIMITS): { keep: T[]; dropped: DroppedBackup[] } {
  const dropped: DroppedBackup[] = [];
  const ok: T[] = [];
  for (const e of listing) {
    const reason = dropReason(e, limits.maxBytes);
    if (reason === null) ok.push(e);
    else if (reason !== undefined) dropped.push({ name: e.name, where: e.where, reason });
  }
  const time = (e: T) => ({ name: e.name, mtimeMs: e.mtimeMs ?? Number.NEGATIVE_INFINITY });
  ok.sort((a, b) => newestFirst(time(a), time(b)));
  const count = Math.max(0, limits.maxCount);
  for (const e of ok.slice(count)) dropped.push({ name: e.name, where: e.where, reason: `past the newest ${count}` });
  return { keep: ok.slice(0, count), dropped };
}
