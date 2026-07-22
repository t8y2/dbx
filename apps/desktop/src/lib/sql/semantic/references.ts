import type { SqlCompletionReferencedTable } from "@/lib/sql/sqlCompletion";
import type { SqlSemanticModel, SqlSemanticRowSource, SqlSemanticSpan } from "@/lib/sql/semantic/types";
import type { SqlReferenceAnalysis, SqlTableReference, SqlTextSpan } from "@/types/database";

export type SqlSemanticTableReference = SqlTableReference & {
  columns?: string[];
  semanticSourceId?: string;
  semanticSourceKind?: SqlSemanticRowSource["kind"];
};

export interface SqlSemanticNavigationTarget {
  name: string;
  database?: string;
  schema?: string;
  alias?: string;
  columns?: string[];
  source: SqlSemanticRowSource;
}

function offsetToLineColumn(sql: string, offset: number): { line: number; column: number } {
  const safeOffset = Math.max(0, Math.min(offset, sql.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < safeOffset; index += 1) {
    if (sql[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: safeOffset - lineStart };
}

function semanticSpanToSqlTextSpan(sql: string, span: SqlSemanticSpan): SqlTextSpan {
  const start = offsetToLineColumn(sql, span.start);
  const end = offsetToLineColumn(sql, Math.max(span.end, span.start));
  return {
    start_line: start.line,
    start_column: start.column + 1,
    end_line: end.line,
    end_column: Math.max(end.column, start.column + 1),
  };
}

function normalized(value: string | null | undefined): string {
  let result = value ?? "";
  while (result && '`"['.includes(result[0])) result = result.slice(1);
  while (result && '`"]'.includes(result[result.length - 1])) result = result.slice(0, -1);
  return result.toLowerCase();
}

function sourceSchema(source: SqlSemanticRowSource): string | undefined {
  return source.metadataTarget?.schema ?? source.qualifierParts[source.qualifierParts.length - 1];
}

function sourceDatabase(source: SqlSemanticRowSource): string | undefined {
  return source.metadataTarget?.database;
}

function sourceTableName(source: SqlSemanticRowSource): string {
  return source.metadataTarget?.table ?? source.name;
}

function sourceReferenceKey(source: SqlSemanticTableReference): string {
  return [normalized(source.database), normalized(source.schema), normalized(source.name), normalized(source.alias), source.span.start_line, source.span.start_column].join(":");
}

function existingScopeId(analysis: SqlReferenceAnalysis): number {
  return analysis.tables[0]?.scope_id ?? analysis.columns[0]?.scope_id ?? 0;
}

export function sqlSemanticTableReferences(model: SqlSemanticModel, scopeId = 0): SqlSemanticTableReference[] {
  if (model.cursorIntent.kind === "suppressed" || model.cursorIntent.confidence === "low") return [];
  return model.rowSources
    .filter((source) => source.kind !== "unknown")
    .map((source) => {
      const span = source.qualifiedName?.span ?? source.aliasSpan ?? source.sourceSpan;
      const schema = sourceSchema(source);
      return {
        name: sourceTableName(source),
        database: sourceDatabase(source),
        schema,
        alias: source.alias,
        span: semanticSpanToSqlTextSpan(model.sql, span),
        scope_id: scopeId,
        columns: source.columns?.length ? [...source.columns] : undefined,
        semanticSourceId: source.id,
        semanticSourceKind: source.kind,
      };
    });
}

export function mergeSqlSemanticReferenceAnalysis(analysis: SqlReferenceAnalysis, model: SqlSemanticModel): SqlReferenceAnalysis {
  const semanticTables = sqlSemanticTableReferences(model, existingScopeId(analysis));
  if (semanticTables.length === 0) return analysis;

  const merged = new Map<string, SqlSemanticTableReference>();
  for (const table of analysis.tables as SqlSemanticTableReference[]) {
    merged.set(sourceReferenceKey(table), table);
  }

  for (const table of semanticTables) {
    const existing = [...merged.values()].find((candidate) => {
      if (normalized(candidate.name) !== normalized(table.name)) return false;
      if (candidate.database && table.database && normalized(candidate.database) !== normalized(table.database)) return false;
      if (candidate.alias && table.alias && normalized(candidate.alias) !== normalized(table.alias)) return false;
      if (candidate.schema && table.schema && normalized(candidate.schema) !== normalized(table.schema)) return false;
      return true;
    });
    if (existing) {
      existing.database = existing.database ?? table.database;
      existing.schema = existing.schema ?? table.schema;
      existing.alias = existing.alias ?? table.alias;
      existing.columns = existing.columns ?? table.columns;
      existing.semanticSourceId = existing.semanticSourceId ?? table.semanticSourceId;
    } else {
      merged.set(sourceReferenceKey(table), table);
    }
  }

  return {
    ...analysis,
    tables: [...merged.values()],
  };
}

export function sqlSemanticCompletionReferenceTables(model: SqlSemanticModel): SqlCompletionReferencedTable[] {
  return sqlSemanticTableReferences(model).map((table) => ({
    name: table.name,
    database: table.database ?? undefined,
    schema: table.schema ?? undefined,
    alias: table.alias ?? undefined,
    columns: table.columns,
  }));
}

export function resolveSqlSemanticNavigationTarget(model: SqlSemanticModel, identifierParts: readonly string[]): SqlSemanticNavigationTarget | null {
  if (model.cursorIntent.kind === "suppressed" || model.cursorIntent.confidence === "low" || identifierParts.length === 0) return null;
  const normalizedParts = identifierParts.map(normalized).filter(Boolean);
  const name = normalizedParts[normalizedParts.length - 1];
  const qualifier = normalizedParts.length > 1 ? normalizedParts[normalizedParts.length - 2] : undefined;
  const database = normalizedParts.length > 2 ? normalizedParts[normalizedParts.length - 3] : undefined;

  const source =
    model.rowSources.find((candidate) => {
      const candidateName = normalized(sourceTableName(candidate));
      const candidateAlias = normalized(candidate.alias);
      const candidateDatabase = normalized(sourceDatabase(candidate));
      const candidateSchema = normalized(sourceSchema(candidate));
      if (qualifier) {
        if (!database && candidateAlias && candidateAlias === qualifier) return true;
        return candidateName === name && (!candidateSchema || candidateSchema === qualifier) && (!database || !candidateDatabase || candidateDatabase === database);
      }
      return candidateName === name || candidateAlias === name;
    }) ?? null;

  if (!source) return null;
  const schema = sourceSchema(source);
  return {
    name: sourceTableName(source),
    database: sourceDatabase(source),
    schema,
    alias: source.alias,
    columns: source.columns,
    source,
  };
}
