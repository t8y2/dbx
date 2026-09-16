export async function formatSqlSnapshotForSave(sqlSnapshot: string, currentSql: () => string, format: (sql: string) => Promise<string>, applyFormatted: (sql: string) => void): Promise<string> {
  const formatted = await format(sqlSnapshot);
  if (currentSql() !== sqlSnapshot) return currentSql();
  if (formatted !== sqlSnapshot) applyFormatted(formatted);
  return formatted;
}
