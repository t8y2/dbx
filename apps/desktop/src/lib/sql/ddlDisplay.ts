import { requiresDamengIdentifierQuote, requiresMysqlIdentifierQuote, requiresOracleIdentifierQuote, requiresPostgresIdentifierQuote } from "@/lib/sql/sqlIdentifier";
import { tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { SqlFormatDialect } from "@/lib/sql/sqlFormatter";

const SIMPLE_SQLSERVER_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function canRenderUnquoted(identifier: string, dialect: SqlFormatDialect): boolean {
  switch (dialect) {
    case "mysql":
    case "clickhouse":
      return !requiresMysqlIdentifierQuote(identifier);
    case "postgres":
    case "sqlite":
    case "duckdb":
    case "generic":
      return !requiresPostgresIdentifierQuote(identifier);
    case "dameng":
      return !requiresDamengIdentifierQuote(identifier);
    case "oracle":
      return !requiresOracleIdentifierQuote(identifier);
    case "sqlserver":
      return SIMPLE_SQLSERVER_IDENTIFIER.test(identifier) && !requiresMysqlIdentifierQuote(identifier.toLowerCase());
    default:
      return false;
  }
}

/** Removes dialect identifier quotes from safe names while preserving strings, comments, and unsafe names. */
export function omitDdlIdentifierQuotes(sql: string, dialect: SqlFormatDialect): string {
  const tokens = tokenizeSqlSemantic(sql, dialect === "sqlserver" ? "sqlserver" : dialect);
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  for (const token of tokens) {
    if (token.kind !== "quoted_identifier") continue;
    const identifier = unquoteSqlSemanticIdentifier(token);
    if (canRenderUnquoted(identifier, dialect)) replacements.push({ start: token.span.start, end: token.span.end, value: identifier });
  }

  let result = sql;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index]!;
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}
