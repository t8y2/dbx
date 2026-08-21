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
