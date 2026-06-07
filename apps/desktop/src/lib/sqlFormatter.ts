export type SqlFormatDialect = "mysql" | "postgres" | "sqlite" | "sqlserver" | "generic";

function formatterLanguage(dialect: SqlFormatDialect) {
  switch (dialect) {
    case "mysql":
      return "mysql";
    case "postgres":
      return "postgresql";
    case "sqlite":
      return "sqlite";
    case "sqlserver":
      return "transactsql";
    default:
      return "sql";
  }
}

export async function formatSqlText(sql: string, dialect: SqlFormatDialect = "generic"): Promise<string> {
  if (!sql.trim()) return sql;
  const { format } = await import("sql-formatter");
  return format(sql, {
    language: formatterLanguage(dialect),
    keywordCase: "upper",
  });
}
