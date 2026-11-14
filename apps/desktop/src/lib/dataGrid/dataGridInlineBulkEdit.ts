export interface DataGridInlineBulkEditKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export function dataGridDirectCellEditValue(event: DataGridInlineBulkEditKeyEvent): string | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return undefined;
  if (Array.from(event.key).length !== 1) return undefined;
  if (event.keyCode === 229 && !/^[\x20-\x7E]$/.test(event.key)) return undefined;
  return event.key;
}

export function dataGridInlineBulkEditValue(event: DataGridInlineBulkEditKeyEvent, selectedCellCount: number): string | undefined {
  if (selectedCellCount <= 1) return undefined;
  if (event.key === "Enter") return "";
  return dataGridDirectCellEditValue(event);
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
