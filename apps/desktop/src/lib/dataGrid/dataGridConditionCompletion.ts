import type { DataGridConditionColumnOption } from "@/composables/useDataGridConditionEditor";
import { codeMirrorSqlDialect } from "@/lib/database/jdbcDialect";
import { ORACLE_COMPAT_IDENTIFIER_DATABASES, quoteSqlIdentifier } from "@/lib/sql/sqlCompletion";
import { sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";
import type { ColumnInfo, DatabaseType } from "@/types/database";

export interface DataGridFilterColumn {
  name: string;
  columnInfo?: ColumnInfo;
}

export interface DataGridFilterColumnsOptions {
  databaseType?: DatabaseType;
  context?: "results" | "table-data";
  urlParams?: string;
  connectionString?: string;
  tableColumns: readonly ColumnInfo[];
  resultColumns: readonly string[];
  resultColumnTypes?: readonly (string | null | undefined)[];
}

export function dataGridFilterColumns(options: DataGridFilterColumnsOptions): DataGridFilterColumn[] {
  const physicalColumns = options.tableColumns.map((columnInfo) => ({ name: columnInfo.name, columnInfo }));
  if (!usesImplicitIoTDBTreeTime(options)) return physicalColumns;
  return [{ name: "Time" }, ...physicalColumns];
}

function usesImplicitIoTDBTreeTime(options: DataGridFilterColumnsOptions): boolean {
  return (
    options.databaseType === "iotdb" &&
    options.context === "table-data" &&
    iotdbSqlDialect(options.urlParams, options.connectionString) !== "table" &&
    options.resultColumns[0] === "Time" &&
    /^TIMESTAMP\((ms|us|ns)\)$/i.test(options.resultColumnTypes?.[0]?.trim() ?? "") &&
    !options.tableColumns.some((column) => column.name.toLowerCase() === "time")
  );
}

function iotdbSqlDialect(urlParams: string | undefined, connectionString: string | undefined): string | undefined {
  const merged = new Map<string, string>();
  addIoTDBConnectionParams(merged, connectionString?.split("?", 2)[1]?.split("#", 1)[0]);
  addIoTDBConnectionParams(merged, urlParams);
  return (merged.get("sql_dialect") || merged.get("dialect"))?.trim().toLowerCase();
}

function addIoTDBConnectionParams(target: Map<string, string>, raw: string | undefined) {
  const params = new URLSearchParams((raw ?? "").trim().replace(/^\?/, ""));
  for (const [key, value] of params) target.set(key.toLowerCase(), value);
}

export function dataGridConditionColumnOptions(columns: readonly DataGridConditionColumnOption[], databaseType?: DatabaseType): DataGridConditionColumnOption[] {
  // Oracle-family identifier quoting needs the completion apply dialect; the
  // CodeMirror syntax dialect has no Oracle entry and falls back to MySQL,
  // which never quotes, so case-sensitive columns would insert unresolvable.
  const dialect = databaseType !== undefined && ORACLE_COMPAT_IDENTIFIER_DATABASES.has(databaseType) ? "oracle" : codeMirrorSqlDialect(databaseType);
  return columns.map((column) => {
    const name = typeof column === "string" ? column : column.name;
    const insertText = quoteSqlIdentifier(name, dialect);
    const comment = typeof column === "string" ? undefined : column.comment;
    return { name, insertText, ...(comment !== undefined ? { comment } : {}) };
  });
}

export function dataGridConditionIdentifierQuote(databaseType?: DatabaseType, runtimeQuote?: string): string | undefined {
  if (runtimeQuote !== undefined) return runtimeQuote || undefined;
  return sqlSemanticDialectFor({ databaseType }).identifierQuotes[0]?.open;
}
