// What a main turn did, as the buddy remembers it: one short line per step,
// never a tool's output or a diff. A shell command is its own description
// (Claude writes one for nearly every Bash call); a file tool is its verb and
// the file's name, one entry per verb listing every file; bookkeeping tools
// (tasks, tool search, wakeups) are dropped. No I/O: the adapter hands each
// main-loop tool call to actionOf, the brain keeps the turn's actions, and
// didOf folds them when the turn is remembered.

/** The most steps kept of one turn: past it the first few and the last stay, the middle is counted. */
export const DID_MAX = 12;
/** The first steps kept when a turn has more than DID_MAX. */
export const DID_HEAD = 4;
/** How long one step may be. */
export const DID_TEXT_CAP = 80;
/** How many files one verb names before the rest are counted. */
export const DID_FILES_MAX = 6;

/** One step: a line of its own, or a file under a verb, gathered with the turn's other files under that verb. */
export type Action = { text: string } | { verb: FileVerb; file: string };
export type FileVerb = 'read' | 'edited' | 'wrote' | 'searched';

/** Tools that say nothing of the work: the buddy never hears of them. */
const BOOKKEEPING: readonly string[] = [
  'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput', 'TodoWrite',
  'Monitor', 'ScheduleWakeup', 'ReadNotifications', 'ListAgents', 'EnterWorktree', 'ExitWorktree', 'EnterPlanMode', 'KillShell', 'BashOutput',
];

const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const fileName = (v: unknown): string => str(v).replace(/\/+$/, '').split('/').pop() ?? '';

/** A shell command without its leading `cd`s, every path cut to its last part, at most 50 characters. */
function shortCommand(command: string): string {
  const c = command.replace(/^(cd \S+ *(&&|;) *)+/, '').replace(/(?:\/[\w.~-]+)+\/([\w.-]+)/g, '$1');
  return c.length > 50 ? `${c.slice(0, 49)}…` : c;
}

/**
 * A main-loop tool call as one step: `call` the tool.call event (its tool and
 * arguments, flat), `failed` when it was denied or errored. Null for a
 * bookkeeping tool, or a file tool with no file.
 */
export function actionOf(call: { tool: string; [argument: string]: unknown }, failed: boolean): Action | null {
  const text = (t: string): Action | null => (t ? { text: failed ? `${t} (failed)` : t } : null);
  const file = (verb: FileVerb, f: string): Action | null => (f ? { verb, file: f } : null);
  switch (call.tool) {
    case 'Bash':
      return text(str(call.description) || (str(call.command) ? `ran ${shortCommand(str(call.command))}` : ''));
    case 'Read':
      return file('read', fileName(call.file_path));
    case 'Edit':
    case 'MultiEdit':
      return file('edited', fileName(call.file_path));
    case 'NotebookEdit':
      return file('edited', fileName(call.notebook_path));
    case 'Write':
      return file('wrote', fileName(call.file_path));
    case 'Grep':
    case 'Glob':
      return file('searched', str(call.pattern).slice(0, 40));
    case 'Agent':
    case 'Task':
      return text(str(call.description) ? `agent: ${str(call.description)}` : 'ran an agent');
    case 'Skill':
      return text(`skill ${str(call.skill)}`.trim());
    case 'WebSearch':
      return text(`searched the web: ${str(call.query).slice(0, 60)}`);
    case 'WebFetch':
      return text(`fetched ${str(call.url).replace(/^https?:\/\/([^/]+).*$/, '$1')}`);
    case 'SendMessage':
      return text(`messaged ${str(call.to) || str(call.recipient) || 'an agent'}`);
    case 'AskUserQuestion':
      return text('asked the user');
  }
  if (BOOKKEEPING.includes(call.tool)) return null;
  // An MCP tool by its own name, its server dropped: mcp__professor__chat_new is "chat new".
  if (call.tool.startsWith('mcp__')) return text(call.tool.split('__').slice(2).join(' ').replace(/_/g, ' '));
  return text(call.tool);
}

/**
 * The turn's steps as the buddy reads them, in order: a file verb once, where
 * its first file came, naming each file once; a step said twice in a row
 * once; each at most DID_TEXT_CAP; past DID_MAX the first DID_HEAD and the
 * last stay around a count of the rest.
 */
export function didOf(actions: readonly Action[]): string[] {
  const files = new Map<FileVerb, string[]>();
  const order: Action[] = [];
  for (const a of actions) {
    if ('verb' in a) {
      const list = files.get(a.verb);
      if (!list) {
        files.set(a.verb, [a.file]);
        order.push(a);
      } else if (!list.includes(a.file)) list.push(a.file);
    } else {
      const last = order.at(-1);
      if (!last || !('text' in last) || last.text !== a.text) order.push(a);
    }
  }
  const lines = order.map((o) => {
    if ('text' in o) return o.text;
    const list = files.get(o.verb) ?? [];
    const more = list.length > DID_FILES_MAX ? ` +${list.length - DID_FILES_MAX}` : '';
    return `${o.verb} ${list.slice(0, DID_FILES_MAX).join(', ')}${more}`;
  }).map((l) => (l.length > DID_TEXT_CAP ? `${l.slice(0, DID_TEXT_CAP - 1)}…` : l));
  if (lines.length <= DID_MAX) return lines;
  const tail = DID_MAX - DID_HEAD - 1;
  return [...lines.slice(0, DID_HEAD), `… ${lines.length - DID_HEAD - tail} more`, ...lines.slice(-tail)];
}
