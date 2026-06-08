import {
  DEFAULT_SQL_FORMATTER_SETTINGS,
  sqlFormatterOptions,
  type SqlFormatterSettings,
} from "@/lib/sqlFormatterConfig";

export type SqlFormatDialect = "mysql" | "postgres" | "sqlite" | "sqlserver" | "generic";

export const MAX_SQL_FORMAT_CHARS = 1_000_000;

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

export async function formatSqlText(
  sql: string,
  dialect: SqlFormatDialect = "generic",
  settings: SqlFormatterSettings = DEFAULT_SQL_FORMATTER_SETTINGS,
): Promise<string> {
  if (!sql.trim()) return sql;
  if (sql.length > MAX_SQL_FORMAT_CHARS) {
    throw new Error("SQL is too large to format safely.");
  }

  const { format } = await import("sql-formatter");
  return format(sql, {
    language: formatterLanguage(dialect),
    ...sqlFormatterOptions(settings),
  });
}
