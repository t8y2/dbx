export interface CompletionLabelPresentation {
  label: string;
  displayLabel?: string;
  sortText?: string;
}

export interface CompletionSortItem {
  label: string;
  sortText?: string;
  type?: string;
}

export function completionLabelPresentation(label: string, filterText?: string): CompletionLabelPresentation {
  const normalizedFilterText = filterText?.trim();
  if (!normalizedFilterText || label.toLowerCase().startsWith(normalizedFilterText.toLowerCase())) return { label };
  return {
    label: `${normalizedFilterText} ${label}`,
    displayLabel: label,
    sortText: label,
  };
}

export function compareSqlCompletions(a: CompletionSortItem, b: CompletionSortItem, sortColumnsAlphabetically: boolean): number {
  if (!sortColumnsAlphabetically && a.type === "column" && b.type === "column") return 0;
  return (a.sortText || a.label).localeCompare(b.sortText || b.label);
}
