export const IMPORT_SKIP_TARGET = "";

export function normalizeImportColumnName(name: string): string {
  return name.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function autoMapImportColumns(sourceColumns: string[], targetColumns: string[]): Record<string, string> {
  const exactTargets = new Map(targetColumns.map((column) => [column, column]));
  const normalizedTargets = new Map(targetColumns.map((column) => [normalizeImportColumnName(column), column]));

  return Object.fromEntries(
    sourceColumns.map((source) => [
      source,
      exactTargets.get(source) ?? normalizedTargets.get(normalizeImportColumnName(source)) ?? IMPORT_SKIP_TARGET,
    ]),
  );
}
