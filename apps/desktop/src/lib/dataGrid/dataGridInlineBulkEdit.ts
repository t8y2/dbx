export interface DataGridInlineBulkEditKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export function dataGridInlineBulkEditValue(event: DataGridInlineBulkEditKeyEvent, selectedCellCount: number): string | undefined {
  if (selectedCellCount <= 1 || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) return undefined;
  if (event.key === "Enter") return "";
  return event.key !== "Process" && Array.from(event.key).length === 1 ? event.key : undefined;
}

/**
 * Bulk-edit dialog contract (placeholder "Value, or NULL"): empty input and the
 * bare keyword `NULL` stage SQL NULL. Every other input is kept as typed so a
 * text column can still receive the literal word via quoted/user-specific input
 * outside this dialog path.
 */
export function bulkEditInputToSqlValue(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.toUpperCase() === "NULL") return null;
  return input;
}
