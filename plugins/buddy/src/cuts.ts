// How the buddy shortens what it reads: every view is a truncation, never a
// summary, and every cut is marked `[cut]` where the text was taken out, so
// the model knows a gap is a cut and not something missing (CHARACTER_RULE).
// The sizes come from a truncation experiment over real reports: what a cut
// keeps of a report's facts at each budget.

/** The mark left where a text was cut. */
export const CUT = '[cut]';

/** `text` whole when it fits `head` and `tail`, else its first `head` and last `tail` characters around ` [cut] `; cutting it again keeps it. */
export function ends(text: string, head: number, tail: number): string {
  return text.length > head + tail + CUT.length + 2 ? `${text.slice(0, head)} ${CUT} ${text.slice(text.length - tail)}` : text;
}

/** How much of an agent's report is kept from its start and from its end. */
export const REPORT_HEAD = 600;
export const REPORT_TAIL = 200;
/** Past this many characters a report is large, and keeps more of its start and end: 600/200 keeps a tenth of a large report's facts, 2400/800 over a quarter. */
export const REPORT_LARGE_AT = 10_000;
export const REPORT_LARGE_HEAD = 2400;
export const REPORT_LARGE_TAIL = 800;

/** An agent's report, from its return or a task notification, cut to its start and end: more of both when it is large. */
export function cutReport(report: string): string {
  return report.length > REPORT_LARGE_AT ? ends(report, REPORT_LARGE_HEAD, REPORT_LARGE_TAIL) : ends(report, REPORT_HEAD, REPORT_TAIL);
}

/** How much of a signed cross-chat message's body is kept from its start and from its end. */
export const SIGNED_HEAD = 600;
export const SIGNED_TAIL = 200;

/** How many of a brief's last nonempty lines are kept after its first line, and the bound on what that leaves. */
export const BRIEF_LAST_LINES = 3;
export const BRIEF_HEAD = 900;
export const BRIEF_TAIL = 300;

/**
 * An agent's brief as the buddy reads it: its first line, where the ask is,
 * and its last BRIEF_LAST_LINES nonempty lines, where the return is asked
 * for, around a `[cut]` line, when that is shorter than the brief; then
 * bounded by BRIEF_HEAD and BRIEF_TAIL, for a huge first line.
 */
export function cutBrief(brief: string): string {
  const lines = brief.split('\n');
  const first = lines[0] ?? '';
  const last = lines.slice(1).filter((l) => l.trim() !== '').slice(-BRIEF_LAST_LINES);
  const kept = [first, CUT, ...last].join('\n');
  return ends(kept.length < brief.length ? kept : brief, BRIEF_HEAD, BRIEF_TAIL);
}
