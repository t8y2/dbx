export function ensureSqlStatementTerminator(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) return "";
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

export function buildSingleDdlExportFileContent(sql: string): string {
  const statement = ensureSqlStatementTerminator(sql);
  return statement ? `${statement}\n` : "";
}

export function joinExportedDdls(ddls: readonly string[]): string {
  const statements = ddls.map(ensureSqlStatementTerminator).filter(Boolean);
  return statements.length ? `${statements.join("\n\n")}\n` : "";
}
