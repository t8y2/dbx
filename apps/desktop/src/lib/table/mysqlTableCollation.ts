import type { QueryResult } from "@/types/database";
import { mysqlUtf8Literal, quoteMysqlTableIdentifier } from "@/lib/table/mysqlTableEngine";

/** Server-side inventories for the object browser's inline charset / collation pickers. */
export const MYSQL_CHARACTER_SETS_SQL = "SHOW CHARACTER SET";
export const MYSQL_COLLATIONS_SQL = "SHOW COLLATION";

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
  return {
    charset: mysqlTableCharsetFromCollation(collation),
    collation,
  };
}

export function mysqlTableCharsetFromCollation(value: string | null | undefined): string {
  const collation = value?.trim() ?? "";
  if (collation === "binary") return "binary";
  const separator = collation.indexOf("_");
  return separator > 0 ? collation.slice(0, separator) : "";
}

/** MySQL reports the `utf8` charset as `utf8mb3` in collation names, so both spellings compare equal. */
function normalizeMysqlCharsetName(value: string): string {
  const charset = value.trim().toLowerCase();
  return charset === "utf8" ? "utf8mb3" : charset;
}

function validMysqlCharsetIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_]+$/.test(value);
}

export function mysqlTableCollationBelongsToCharset(collation: string, charset: string): boolean {
  const name = collation.trim();
  if (!name || !charset.trim()) return false;
  return normalizeMysqlCharsetName(mysqlTableCharsetFromCollation(name)) === normalizeMysqlCharsetName(charset);
}

/**
 * `ALTER TABLE ... DEFAULT CHARACTER SET` for the object browser's inline charsets.
 * Mirrors the server-side builder (`mysql_table_charset.rs`): only the table defaults
 * change, existing columns keep their own character set.
 * Returns undefined when either name would need quoting, or when the collation does not
 * belong to the charset — those values come from `SHOW COLLATION`, so the only way to
 * hit them is a tampered option list.
 */
export function mysqlTableCharsetChangeSql(options: { database?: string | null; table: string; charset: string; collation?: string | null }): string | undefined {
  const charset = options.charset.trim();
  if (!validMysqlCharsetIdentifier(charset)) return undefined;
  const table = options.table.trim();
  if (!table) return undefined;
  const collation = options.collation?.trim() ?? "";
  if (collation && (!validMysqlCharsetIdentifier(collation) || !mysqlTableCollationBelongsToCharset(collation, charset))) return undefined;
  const database = options.database?.trim();
  const target = database ? `${quoteMysqlTableIdentifier(database)}.${quoteMysqlTableIdentifier(table)}` : quoteMysqlTableIdentifier(table);
  return `ALTER TABLE ${target} DEFAULT CHARACTER SET ${charset}${collation ? ` COLLATE ${collation}` : ""}`;
}
