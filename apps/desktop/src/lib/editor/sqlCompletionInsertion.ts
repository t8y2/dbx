import type { EditorState } from "@codemirror/state";

export type SqlCompletionReplaceRange = { from: number; to: number };

export type SqlCompletionItemType = "keyword" | "table" | "column" | "snippet" | "function" | "schema" | "variable" | "sequence" | "property" | "text";

// `;` is deliberately absent: a statement terminator is never glued to the token
// in front of it, and accepting `BETWEEN` before an existing `;` used to insert
// `BETWEEN;`, leaving the user no way to keep typing the operand.
//
// Newlines and statement boundaries should also not suppress the auto-space;
// only an existing space/tab or punctuation should prevent it.
const COMPLETION_SPACE_BLOCKING_CHARACTERS = new Set([",", ":", ")", "]", "}", "'", '"']);

export function appendSqlCompletionSpace(insertText: string, options: { enabled: boolean; itemType: SqlCompletionItemType; nextCharacter?: string }): string {
  if (!options.enabled || options.itemType === "property" || options.itemType === "text" || options.itemType === "schema" || options.itemType === "variable" || options.itemType === "sequence" || options.itemType === "snippet" || options.itemType === "function") return insertText;
  if (!insertText || /\s$/.test(insertText) || insertText.endsWith(".")) return insertText;

  const nextCharacter = options.nextCharacter ?? "";
  if (/^[ \t]/.test(nextCharacter) || COMPLETION_SPACE_BLOCKING_CHARACTERS.has(nextCharacter)) return insertText;

  // Avoid producing `table AS t,` or `column)` when the cursor is before SQL punctuation.
  return `${insertText} `;
}

/**
 * CodeMirror's snippet apply replaces only the main selection. A rectangular
 * (column) edit types the trigger prefix into every line, so accepting the
 * snippet should expand it on the other cursors too — but only while each one
 * still sits directly after that exact typed prefix. Cursors with different
 * text are left alone so unrelated lines are never overwritten (#14096).
 *
 * Returned ranges are ordered from the end of the document backwards: callers
 * can apply them in order without remapping the positions of earlier ranges.
 */
export function additionalSnippetApplyTargets(state: EditorState, from: number, to: number): SqlCompletionReplaceRange[] {
  if (state.selection.ranges.length < 2) return [];
  const typedPrefix = state.sliceDoc(from, to);
  if (!typedPrefix) return [];
  const mainIndex = state.selection.mainIndex;
  const targets: SqlCompletionReplaceRange[] = [];
  state.selection.ranges.forEach((range, index) => {
    if (index === mainIndex) return;
    const targetFrom = range.from - typedPrefix.length;
    if (targetFrom < 0 || state.sliceDoc(targetFrom, range.from) !== typedPrefix) return;
    targets.push({ from: targetFrom, to: range.from });
  });
  return targets.sort((left, right) => right.from - left.from);
}
