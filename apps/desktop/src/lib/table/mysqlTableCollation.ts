import type { QueryResult } from "@/types/database";
import { mysqlUtf8Literal } from "@/lib/table/mysqlTableEngine";

export interface MysqlTableCharsetMetadata {
  charset: string;
  collation: string;
}

/**
 * Reads the table's default collation. MySQL reports the *effective* collation on every
 * character column and never records whether it was written out explicitly, so a column
 * matching this value is one that simply inherits the table default. The structure editor
 * passes it to the SQL builder, which then leaves the redundant `CHARACTER SET`/`COLLATE`
 * clauses out of the generated DDL — the column metadata itself keeps the real values so
 * the charset and collation pickers can show what the column currently uses.
 */
export function mysqlTableCollationSql(database: string, table: string): string {
  return ["SELECT TABLE_COLLATION AS table_collation", "FROM information_schema.TABLES", `WHERE TABLE_SCHEMA = ${mysqlUtf8Literal(database)}`, `  AND TABLE_NAME = ${mysqlUtf8Literal(table)}`, "LIMIT 1"].join("\n");
}

/** Empty string when the server reported nothing usable — MySQL returns NULL for views. */
export function parseMysqlTableCollation(result: QueryResult | undefined): string {
  if (!result) return "";
  const index = result.columns.findIndex((column) => column.trim().toLowerCase() === "table_collation");
  if (index < 0) return "";
  const value = result.rows[0]?.[index];
  return value === null || value === undefined ? "" : String(value).trim();
}

/**
 * MySQL does not expose a separate table character-set column in
 * information_schema.TABLES. The default collation implies the character set
 * (for example, utf8mb4_0900_ai_ci belongs to utf8mb4).
 */
export function parseMysqlTableCharset(result: QueryResult | undefined): MysqlTableCharsetMetadata {
  const collation = parseMysqlTableCollation(result);
  const separator = collation.indexOf("_");
  return {
    charset: separator > 0 ? collation.slice(0, separator) : "",
    collation,
  };
}
