import type { SqlCompletionColumn, SqlCompletionTable } from "@/lib/sqlCompletion";
import { getSqlCompletionContext } from "@/lib/sqlCompletion";
import { executableStatementRanges, isOraclePlSqlStatement, type SqlTextRange } from "@/lib/sqlStatementRanges";
import type { DatabaseType, SqlColumnReference, SqlReferenceAnalysis, SqlReferenceScope, SqlTableReference, SqlTextSpan } from "@/types/database";

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
    if (isOraclePlSqlStatement(statement.sql, databaseType)) continue;
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
  const scopesById = scopesByIdMap(analysis.scopes);

  for (const table of tables) {
    knownTables.set(normalizeName(table.name), table);
    if (table.alias) knownTables.set(normalizeName(table.alias), table);
    if (table.schema) knownTables.set(normalizeName(`${table.schema}.${table.name}`), table);
  }

  for (const table of tables) {
    if (!schema.missingTables?.has(tableReferenceKey(table))) continue;
    diagnostics.push({
      span: trimSqlTextSpanWhitespace(schema.sql, table.span),
      message: `Unknown table ${displayTableName(table)}`,
      severity: "error",
    });
  }

  for (const column of analysis.columns) {
    const table = resolveColumnTable(column, tables, knownTables, schema.sql, scopesById);
    if (!table) continue;
    if (schema.missingTables?.has(tableReferenceKey(table))) continue;

    const columns = columnsForTable(table, schema.columnsByTable, schema.loadedColumnTables);
    if (!columns) continue;

    const columnNames = new Set(columns.map((item) => normalizeName(item.name)));
    if (columnNames.has(normalizeName(column.name))) continue;

    const displayName = column.qualifier ? `${column.qualifier}.${column.name}` : column.name;
    diagnostics.push({
      span: trimSqlTextSpanWhitespace(schema.sql, column.span),
      message: `Unknown column ${displayName}`,
      severity: "error",
    });
  }

  return diagnostics;
}

function trimSqlTextSpanWhitespace(sql: string | undefined, span: SqlTextSpan): SqlTextSpan {
  if (!sql) return span;
  const range = sqlTextSpanToOffsetRange(sql, span);
  if (!range) return span;

  let from = range.from;
  let to = range.to;
  while (from < to && /\s/.test(sql[from] ?? "")) from += 1;
  while (to > from && /\s/.test(sql[to - 1] ?? "")) to -= 1;
  if (from === range.from && to === range.to) return span;

  const start = offsetToSqlTextStartPosition(sql, from);
  const end = offsetToSqlTextEndPosition(sql, to);
  if (!start || !end) return span;
  return {
    start_line: start.line,
    start_column: start.column,
    end_line: end.line,
    end_column: Math.max(end.column, start.column),
  };
}

function sqlTextSpanToOffsetRange(sql: string, span: SqlTextSpan): { from: number; to: number } | null {
  if (!span.start_line || !span.start_column) return null;
  const from = sqlTextPositionToOffset(sql, span.start_line, span.start_column - 1);
  const to = sqlTextPositionToOffset(sql, Math.max(span.end_line, span.start_line), Math.max(span.end_column, span.start_column));
  if (from == null || to == null || to <= from) return null;
  return { from, to };
}

function sqlTextPositionToOffset(sql: string, line: number, column: number): number | null {
  const lines = sql.split(/\r?\n/);
  if (line < 1 || line > lines.length) return null;
  let offset = 0;
  for (let index = 0; index < line - 1; index += 1) {
    offset += lines[index].length + 1;
  }
  return Math.min(offset + Math.max(column, 0), offset + lines[line - 1].length);
}

function offsetToSqlTextStartPosition(sql: string, offset: number): { line: number; column: number } | null {
  const position = offsetToLineColumn(sql, offset);
  return position ? { line: position.line, column: position.column + 1 } : null;
}

function offsetToSqlTextEndPosition(sql: string, offset: number): { line: number; column: number } | null {
  return offsetToLineColumn(sql, offset);
}

function offsetToLineColumn(sql: string, offset: number): { line: number; column: number } | null {
  if (offset < 0 || offset > sql.length) return null;
  const lines = sql.split(/\r?\n/);
  let remaining = offset;
  for (let index = 0; index < lines.length; index += 1) {
    const lineLength = lines[index].length;
    if (remaining <= lineLength) {
      return { line: index + 1, column: remaining };
    }
    remaining -= lineLength + 1;
  }
  const lastLine = lines[lines.length - 1] ?? "";
  return { line: lines.length, column: lastLine.length };
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

function resolveColumnTable(column: SqlColumnReference, tables: SqlTableReference[], knownTables: Map<string, SqlTableReference>, sql?: string, scopesById?: Map<number, SqlReferenceScope>): SqlTableReference | null {
  const candidateTables = candidateTablesForColumn(tables, column, sql, scopesById);
  if (column.qualifier) {
    return tableLookupFor(candidateTables).get(normalizeName(column.qualifier)) ?? (sql ? null : (knownTables.get(normalizeName(column.qualifier)) ?? null));
  }
  if (candidateTables.length !== 1) return null;
  return candidateTables[0];
}

function candidateTablesForColumn(tables: SqlTableReference[], column: SqlColumnReference, sql?: string, scopesById?: Map<number, SqlReferenceScope>): SqlTableReference[] {
  const scoped = tablesInVisibleScopes(tables, column, scopesById);
  if (scoped) return scoped;
  return sql ? tablesInSameStatement(tables, column, sql) : tables;
}

function tablesInVisibleScopes(tables: SqlTableReference[], column: SqlColumnReference, scopesById?: Map<number, SqlReferenceScope>): SqlTableReference[] | null {
  if (column.scope_id == null || !scopesById || scopesById.size === 0) return null;
  if (!column.qualifier) {
    const currentScopeTables = tables.filter((table) => table.scope_id === column.scope_id);
    if (currentScopeTables.length > 0) return currentScopeTables;
  }
  const visibleScopeIds = scopeAndParents(column.scope_id, scopesById);
  if (visibleScopeIds.size === 0) return null;
  return tables.filter((table) => table.scope_id != null && visibleScopeIds.has(table.scope_id));
}

function scopeAndParents(scopeId: number, scopesById: Map<number, SqlReferenceScope>): Set<number> {
  const ids = new Set<number>();
  let current: number | undefined = scopeId;
  while (current != null && !ids.has(current)) {
    ids.add(current);
    const scope = scopesById.get(current);
    current = scope?.parent_id ?? undefined;
  }
  return ids;
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

function scopesByIdMap(scopes: readonly SqlReferenceScope[] | undefined): Map<number, SqlReferenceScope> {
  const map = new Map<number, SqlReferenceScope>();
  for (const scope of scopes ?? []) map.set(scope.id, scope);
  return map;
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
