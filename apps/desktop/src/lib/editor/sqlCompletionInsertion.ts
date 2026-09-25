export type SqlCompletionItemType = "keyword" | "table" | "column" | "snippet" | "function" | "schema" | "variable" | "property" | "text";

// `;` is deliberately absent: a statement terminator is never glued to the token
// in front of it, and accepting `BETWEEN` before an existing `;` used to insert
// `BETWEEN;`, leaving the user no way to keep typing the operand.
const COMPLETION_SPACE_BLOCKING_CHARACTERS = new Set([",", ":", ")", "]", "}", "'", '"']);

export function appendSqlCompletionSpace(insertText: string, options: { enabled: boolean; itemType: SqlCompletionItemType; nextCharacter?: string }): string {
  if (!options.enabled || options.itemType === "property" || options.itemType === "text" || options.itemType === "schema" || options.itemType === "variable" || options.itemType === "snippet" || options.itemType === "function") return insertText;
  if (!insertText || /\s$/.test(insertText) || insertText.endsWith(".")) return insertText;

  const nextCharacter = options.nextCharacter ?? "";
  if (/\s/.test(nextCharacter) || COMPLETION_SPACE_BLOCKING_CHARACTERS.has(nextCharacter)) return insertText;

  // Avoid producing `table AS t,` or `column)` when the cursor is before SQL punctuation.
  return `${insertText} `;
}
