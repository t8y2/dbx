import type { SqlCompletionColumn, SqlCompletionTable } from "@/lib/sqlCompletion";
import { getSqlCompletionContext } from "@/lib/sqlCompletion";
import type { DatabaseType, SqlColumnReference, SqlReferenceAnalysis, SqlTableReference, SqlTextSpan } from "@/types/database";

export interface SqlSemanticDiagnostic {
  span: SqlTextSpan;
  message: string;
  severity: "error" | "warning";
}

export interface SqlSemanticDiagnosticSchema {
  tables: SqlCompletionTable[];
  columnsByTable: Map<string, SqlCompletionColumn[]>;
}

export function buildSqlSemanticDiagnostics(analysis: SqlReferenceAnalysis, schema: SqlSemanticDiagnosticSchema): SqlSemanticDiagnostic[] {
  const diagnostics: SqlSemanticDiagnostic[] = [];
  const tables = analysis.tables.filter((table) => table.name.trim());
  const knownTables = new Map<string, SqlTableReference>();

  for (const table of tables) {
    knownTables.set(normalizeName(table.name), table);
    if (table.alias) knownTables.set(normalizeName(table.alias), table);
    if (table.schema) knownTables.set(normalizeName(`${table.schema}.${table.name}`), table);
  }

  for (const column of analysis.columns) {
    const table = resolveColumnTable(column, tables, knownTables);
    if (!table) continue;

    const columns = columnsForTable(table, schema.columnsByTable);
    if (!columns) continue;

    const columnNames = new Set(columns.map((item) => normalizeName(item.name)));
    if (columnNames.has(normalizeName(column.name))) continue;

    const displayName = column.qualifier ? `${column.qualifier}.${column.name}` : column.name;
    diagnostics.push({
      span: column.span,
      message: `Unknown column ${displayName}`,
      severity: "warning",
    });
  }

  return diagnostics;
}

export function buildSqlParserErrorDiagnostic(error: unknown, sql: string): SqlSemanticDiagnostic | null {
  const message = errorMessage(error);
  const location = /\bat Line:\s*(\d+),\s*Column:\s*(\d+)\b/i.exec(message);
  if (!location) return null;

  const startLine = Number.parseInt(location[1], 10);
  const startColumn = Number.parseInt(location[2], 10);
  if (!Number.isFinite(startLine) || !Number.isFinite(startColumn) || startLine < 1 || startColumn < 1) return null;

  const lineText = sql.split(/\r?\n/)[startLine - 1] ?? "";
  const startIndex = Math.max(startColumn - 1, 0);
  const token = /^[\w$]+/.exec(lineText.slice(startIndex))?.[0];
  const tokenLength = Math.max(token?.length ?? 1, 1);

  return {
    span: {
      start_line: startLine,
      start_column: startColumn,
      end_line: startLine,
      end_column: startColumn + tokenLength - 1,
    },
    message,
    severity: "error",
  };
}

export function areSqlSemanticDiagnosticsEqual(left: readonly SqlSemanticDiagnostic[], right: readonly SqlSemanticDiagnostic[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return !!other && item.message === other.message && item.severity === other.severity && item.span.start_line === other.span.start_line && item.span.start_column === other.span.start_column && item.span.end_line === other.span.end_line && item.span.end_column === other.span.end_column;
  });
}

export function shouldRunSqlSemanticDiagnostics(sql: string, cursor: number, options: { databaseType?: DatabaseType } = {}): boolean {
  if (options.databaseType === "mongodb" || options.databaseType === "elasticsearch" || options.databaseType === "redis") return false;
  const context = getSqlCompletionContext(sql, cursor);
  if (context.suggestTables || context.exclusiveTableSuggestions || context.exclusiveColumnSuggestions) return false;
  if (context.qualifier) return false;
  return true;
}

function resolveColumnTable(column: SqlColumnReference, tables: SqlTableReference[], knownTables: Map<string, SqlTableReference>): SqlTableReference | null {
  if (column.qualifier) {
    return knownTables.get(normalizeName(column.qualifier)) ?? null;
  }
  if (tables.length !== 1) return null;
  return tables[0];
}

function columnsForTable(table: SqlTableReference, columnsByTable: Map<string, SqlCompletionColumn[]>): SqlCompletionColumn[] | null {
  const keys = table.schema ? [`${table.schema}.${table.name}`, table.name] : [table.name];
  for (const key of keys) {
    const columns = columnsByTable.get(key) ?? columnsByTable.get(normalizeName(key));
    // Empty metadata usually means the upstream schema lookup was inconclusive,
    // so avoid surfacing a false "unknown column" warning.
    if (columns && columns.length > 0) return columns;
  }
  return null;
}

function normalizeName(value: string): string {
  let normalized = value;
  while (normalized && `"'\`[]`.includes(normalized[0])) normalized = normalized.slice(1);
  while (normalized && `"'\`[]`.includes(normalized[normalized.length - 1])) normalized = normalized.slice(0, -1);
  return normalized.toLowerCase();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
