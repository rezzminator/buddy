// The chat's own folder: where the buddy keeps what belongs to one chat,
// beside the chat's transcript. Claude Code writes a session's transcript to
// {config}/projects/{project}/{session id}.jsonl and its subagents and tool
// results into the folder {session id}/ beside it; the buddy's memory
// (memory.json, and memory.md, the same memory for a person to read), the
// pending away wait (away.json) and round files (round-001.txt...) go into that folder's
// buddy/, so reopening the chat finds them, and deleting the chat deletes them.
// {project} is the project's path with every character but a letter or digit
// made '-'; a path too long for that is named otherwise, so the adapter first
// looks for the transcript itself. No I/O: the adapter lists and reads.

import { configDir, type ConfigEnv } from './config-source.ts';

/** The chat folder's own subfolder the buddy writes into. */
export const BUDDY_FOLDER = 'buddy';
/** The file of the buddy's memory of this chat, in BUDDY_FOLDER. */
export const MEMORY_FILE = 'memory.json';
/** The file of what the drawn character reads of that memory, for a person to read, beside MEMORY_FILE. */
export const MEMORY_TEXT_FILE = 'memory.md';
/** The file of the chat's pending away wait (promptWhenIdle), kept so a reload or a restart arms it again, beside MEMORY_FILE. */
export const AWAY_FILE = 'away.json';

/** The folder of every project's transcripts; null when neither CLAUDE_CONFIG_DIR nor HOME is set. */
export function projectsDir(env: ConfigEnv): string | null {
  const dir = configDir(env);
  return dir === null ? null : `${dir}/projects`;
}

/** A project's folder name under projectsDir, as Claude Code makes it from the project's path. */
export function projectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

/** A session id safe to name a folder with: a uuid, or letters, digits, '-' and '_'. */
export function isSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/** The transcript of session `sessionId` in project folder `slug`. */
export function transcriptPath(projects: string, slug: string, sessionId: string): string {
  return `${projects}/${slug}/${sessionId}.jsonl`;
}

/** The buddy's folder in the chat's own folder, beside its transcript. */
export function buddyFolder(projects: string, slug: string, sessionId: string): string {
  return `${projects}/${slug}/${sessionId}/${BUDDY_FOLDER}`;
}
