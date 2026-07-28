export function assertCompleteDatabaseCategories(optionValues: readonly string[], categoryOptionValues: readonly (readonly string[])[]) {
  const available = new Set(optionValues);
  const categorized = categoryOptionValues.flat();
  const categorizedSet = new Set(categorized);
  const duplicates = categorized.filter((value, index) => categorized.indexOf(value) !== index);
  const missing = optionValues.filter((value) => !categorizedSet.has(value));
  const unknown = categorized.filter((value) => !available.has(value));

  if (duplicates.length || missing.length || unknown.length) {
    throw new Error(`Invalid database categories: duplicates=${[...new Set(duplicates)].join(",")}; missing=${missing.join(",")}; unknown=${[...new Set(unknown)].join(",")}`);
  }
}

export function databaseSelectionForCategory(currentValue: string, categoryOptionValues: readonly string[]): string | undefined {
  return categoryOptionValues.includes(currentValue) ? currentValue : categoryOptionValues[0];
}
