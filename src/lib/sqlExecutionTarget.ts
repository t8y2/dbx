export function resolveExecutableSql(fullSql: string, selectedSql: string): string {
  const trimmedSelection = selectedSql.trim();
  return trimmedSelection ? trimmedSelection : fullSql;
}
