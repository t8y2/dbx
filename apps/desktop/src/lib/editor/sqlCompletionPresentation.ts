export interface CompletionLabelPresentation {
  label: string;
  displayLabel?: string;
  sortText?: string;
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
