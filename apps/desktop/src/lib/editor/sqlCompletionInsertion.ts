export type SqlCompletionItemType = "keyword" | "table" | "column" | "snippet" | "function" | "schema" | "variable" | "sequence" | "property" | "text";

// `;` is deliberately absent: a statement terminator is never glued to the token
// in front of it, and accepting `BETWEEN` before an existing `;` used to insert
// `BETWEEN;`, leaving the user no way to keep typing the operand.
const COMPLETION_SPACE_BLOCKING_CHARACTERS = new Set([",", ":", ")", "]", "}", "'", '"']);

// Only horizontal whitespace already separates the accepted token from what
// follows on this line. A line break does not: the completion still ends the
// line's token, so skipping the space there made "补全后自动添加空格" depend on
// whatever happened to sit on the next line — the reported #12934 failure when
// a statement is followed by a newline or when editing in the middle of a
// multi-statement editor.
const HORIZONTAL_WHITESPACE = /^[ \t]$/;

export function appendSqlCompletionSpace(insertText: string, options: { enabled: boolean; itemType: SqlCompletionItemType; nextCharacter?: string }): string {
  if (!options.enabled || options.itemType === "property" || options.itemType === "text" || options.itemType === "schema" || options.itemType === "variable" || options.itemType === "sequence" || options.itemType === "snippet" || options.itemType === "function") return insertText;
  if (!insertText || /\s$/.test(insertText) || insertText.endsWith(".")) return insertText;

  const nextCharacter = options.nextCharacter ?? "";
  if (HORIZONTAL_WHITESPACE.test(nextCharacter) || COMPLETION_SPACE_BLOCKING_CHARACTERS.has(nextCharacter)) return insertText;

  // Avoid producing `table AS t,` or `column)` when the cursor is before SQL punctuation.
  return `${insertText} `;
}
