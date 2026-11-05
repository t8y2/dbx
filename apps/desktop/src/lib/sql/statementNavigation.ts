import type { SqlTextRange } from "@/lib/sql/sqlStatementRanges";

export type StatementNavigationDirection = "previous" | "next" | "start";

/**
 * Resolve the caret position for the statement-navigation commands.
 *
 * - `previous`: inside a statement, jump to that statement's start first; when
 *   the caret already sits on a statement start, jump to the previous start.
 * - `next`: jump to the start of the following statement.
 * - `start`: jump to the start of the statement under the caret. From the gap
 *   between two statements, jump to the following statement.
 *
 * Returns `null` when the caret is already at the requested boundary or no
 * such statement exists, so the keymap binding can report "not handled" and
 * leave other editor bindings alone.
 */
export function statementNavigationTarget(ranges: readonly SqlTextRange[], cursor: number, direction: StatementNavigationDirection): number | null {
  if (ranges.length === 0) return null;

  // Last range starting at or before the caret. `-1` means the caret sits
  // before the first statement (leading comments/whitespace).
  let index = -1;
  for (let i = 0; i < ranges.length; i += 1) {
    if (ranges[i].from > cursor) break;
    index = i;
  }

  if (index === -1) {
    return direction === "previous" ? null : ranges[0].from;
  }

  const current = ranges[index];
  const insideCurrent = cursor <= current.to;

  if (direction === "next") {
    return ranges[index + 1]?.from ?? null;
  }

  if (direction === "start") {
    if (!insideCurrent) return ranges[index + 1]?.from ?? null;
    return current.from === cursor ? null : current.from;
  }

  // previous
  if (!insideCurrent) return current.from;
  if (cursor > current.from) return current.from;
  return ranges[index - 1]?.from ?? null;
}
