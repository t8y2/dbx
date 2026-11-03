/** Normalize the user's excluded-completion list: trim, drop blanks, dedupe case-insensitively. */
export function normalizeExcludedCompletionItems(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n|,/) : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of source) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export function excludedCompletionLabelSet(items: readonly string[] | undefined): Set<string> {
  return new Set((items ?? []).map((item) => item.toLowerCase()));
}

/**
 * Drop completion items whose label matches an excluded entry
 * (case-insensitive). Batch column-selection action markers are never
 * filtered: they are interactive controls, not suggestions.
 */
export function filterExcludedCompletions<T extends { label: string; batchColumnSelectionAction?: boolean }>(items: readonly T[], excluded: ReadonlySet<string>): T[] {
  if (excluded.size === 0) return items as T[];
  return items.filter((item) => item.batchColumnSelectionAction === true || !excluded.has(item.label.toLowerCase()));
}
