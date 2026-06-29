import type { SqlCompletionColumn, SqlCompletionTable } from "@/lib/sqlCompletion";
import { getSqlCompletionContext } from "@/lib/sqlCompletion";
import { executableStatementRanges, type SqlTextRange } from "@/lib/sqlStatementRanges";
import type { DatabaseType, SqlColumnReference, SqlReferenceAnalysis, SqlTableReference, SqlTextSpan } from "@/types/database";

export interface SqlSemanticDiagnostic {
  span: SqlTextSpan;
  message: string;
  severity: "error" | "warning";
}

export interface SqlSemanticDiagnosticSchema {
  tables: SqlCompletionTable[];
  columnsByTable: Map<string, SqlCompletionColumn[]>;
  missingTables?: Set<string>;
  loadedColumnTables?: Set<string>;
  sql?: string;
}

export interface SqlSemanticDiagnosticVisibleRange {
  from: number;
  to: number;
}

export function sqlSemanticDiagnosticRangesForViewport(sql: string, visibleRanges: readonly SqlSemanticDiagnosticVisibleRange[], databaseType?: DatabaseType): SqlTextRange[] {
  const statements = executableStatementRanges(sql, databaseType);
  if (statements.length === 0 || visibleRanges.length === 0) return [];

  const selected: SqlTextRange[] = [];
  const seen = new Set<string>();
  for (const statement of statements) {
    if (!visibleRanges.some((visibleRange) => rangesIntersect(statement, visibleRange))) continue;
    const key = `${statement.from}:${statement.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ from: statement.from, to: statement.to, sql: sql.slice(statement.from, statement.to) });
  }
  return selected;
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

  for (const table of tables) {
    if (!schema.missingTables?.has(tableReferenceKey(table))) continue;
    diagnostics.push({
      span: table.span,
      message: `Unknown table ${displayTableName(table)}`,
      severity: "error",
    });
  }

  for (const column of analysis.columns) {
    const table = resolveColumnTable(column, tables, knownTables, schema.sql);
    if (!table) continue;
    if (schema.missingTables?.has(tableReferenceKey(table))) continue;

    const columns = columnsForTable(table, schema.columnsByTable, schema.loadedColumnTables);
    if (!columns) continue;

    const columnNames = new Set(columns.map((item) => normalizeName(item.name)));
    if (columnNames.has(normalizeName(column.name))) continue;

    const displayName = column.qualifier ? `${column.qualifier}.${column.name}` : column.name;
    diagnostics.push({
      span: column.span,
      message: `Unknown column ${displayName}`,
      severity: "error",
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
  if (options.databaseType === "mongodb" || options.databaseType === "elasticsearch" || options.databaseType === "qdrant" || options.databaseType === "milvus" || options.databaseType === "weaviate" || options.databaseType === "chromadb" || options.databaseType === "redis") return false;
  const context = getSqlCompletionContext(sql, cursor);
  if (context.exclusiveColumnSuggestions) return false;
  if (context.qualifier) return false;
  if ((context.suggestTables || context.exclusiveTableSuggestions) && isCursorAfterTableTrigger(sql, cursor)) return false;
  return true;
}

export function isSqlSemanticDiagnosticInputContext(sql: string, cursor: number, options: { databaseType?: DatabaseType } = {}): boolean {
  if (options.databaseType === "mongodb" || options.databaseType === "elasticsearch" || options.databaseType === "qdrant" || options.databaseType === "milvus" || options.databaseType === "weaviate" || options.databaseType === "chromadb" || options.databaseType === "redis") return false;
  const context = getSqlCompletionContext(sql, cursor);
  return context.exclusiveColumnSuggestions || !!context.qualifier || ((context.suggestTables || context.exclusiveTableSuggestions) && isCursorAfterTableTrigger(sql, cursor));
}

function resolveColumnTable(column: SqlColumnReference, tables: SqlTableReference[], knownTables: Map<string, SqlTableReference>, sql?: string): SqlTableReference | null {
  const candidateTables = sql ? tablesInSameStatement(tables, column, sql) : tables;
  if (column.qualifier) {
    return tableLookupFor(candidateTables).get(normalizeName(column.qualifier)) ?? (sql ? null : (knownTables.get(normalizeName(column.qualifier)) ?? null));
  }
  if (candidateTables.length !== 1) return null;
  return candidateTables[0];
}

function tableLookupFor(tables: SqlTableReference[]): Map<string, SqlTableReference> {
  const lookup = new Map<string, SqlTableReference>();
  for (const table of tables) {
    lookup.set(normalizeName(table.name), table);
    if (table.alias) lookup.set(normalizeName(table.alias), table);
    if (table.schema) lookup.set(normalizeName(`${table.schema}.${table.name}`), table);
  }
  return lookup;
}

function tablesInSameStatement(tables: SqlTableReference[], column: SqlColumnReference, sql: string): SqlTableReference[] {
  const columnOffset = spanStartOffset(sql, column.span);
  if (columnOffset == null) return tables;
  return tables.filter((table) => {
    const tableOffset = spanStartOffset(sql, table.span);
    return tableOffset != null && statementIndexAt(sql, tableOffset) === statementIndexAt(sql, columnOffset);
  });
}

function spanStartOffset(sql: string, span: SqlTextSpan): number | null {
  if (!span.start_line || !span.start_column) return null;
  const lines = sql.split(/\r?\n/);
  const lineIndex = span.start_line - 1;
  if (lineIndex < 0 || lineIndex >= lines.length) return null;
  let offset = 0;
  for (let index = 0; index < lineIndex; index++) offset += lines[index].length + 1;
  return Math.min(offset + span.start_column - 1, offset + lines[lineIndex].length);
}

function statementIndexAt(sql: string, offset: number): number {
  let statementIndex = 0;
  for (let index = 0; index < Math.min(offset, sql.length); index++) {
    if (sql[index] === ";") statementIndex++;
  }
  return statementIndex;
}

function columnsForTable(table: SqlTableReference, columnsByTable: Map<string, SqlCompletionColumn[]>, loadedColumnTables?: Set<string>): SqlCompletionColumn[] | null {
  const keys = table.schema ? [`${table.schema}.${table.name}`, table.name] : [table.name, ...keysWithTableName(columnsByTable, table.name)];
  for (const key of keys) {
    const normalizedKey = normalizeName(key);
    const columns = columnsByTable.get(key) ?? columnsByTable.get(normalizedKey);
    if (!columns) continue;
    if (columns.length > 0 || loadedColumnTables?.has(normalizedKey)) return columns;
  }
  if (loadedColumnTables?.has(tableReferenceKey(table))) return [];
  return null;
}

function keysWithTableName(columnsByTable: Map<string, SqlCompletionColumn[]>, tableName: string): string[] {
  const suffix = `.${normalizeName(tableName)}`;
  return [...columnsByTable.keys()].filter((key) => normalizeName(key).endsWith(suffix));
}

function rangesIntersect(left: SqlSemanticDiagnosticVisibleRange, right: SqlSemanticDiagnosticVisibleRange): boolean {
  return left.from < right.to && right.from < left.to;
}

export function tableReferenceKey(table: Pick<SqlTableReference, "name" | "schema">): string {
  return normalizeName(table.schema ? `${table.schema}.${table.name}` : table.name);
}

function displayTableName(table: SqlTableReference): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function isCursorAfterTableTrigger(sql: string, cursor: number): boolean {
  const beforeCursor = sql.slice(0, cursor).trimEnd();
  return /\b(from|join|update|into|table)(?:\s+[\w$`"'[\].]*)?$/i.test(beforeCursor);
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
