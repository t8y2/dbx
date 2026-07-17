import type { DatabaseType } from "@/types/database";

export interface SqlSemanticSpan {
  start: number;
  end: number;
}

export type SqlSemanticConfidence = "high" | "medium" | "low";

export type SqlSemanticStatementKind = "select" | "insert" | "update" | "delete" | "call" | "unknown";

export type SqlSemanticTokenKind = "word" | "quoted_identifier" | "string" | "number" | "comment" | "parameter" | "punctuation" | "operator";

export interface SqlSemanticToken {
  kind: SqlSemanticTokenKind;
  text: string;
  normalized: string;
  span: SqlSemanticSpan;
  depth: number;
  quote?: string;
}

export interface SqlSemanticIdentifierPart {
  raw: string;
  name: string;
  span: SqlSemanticSpan;
  quote?: string;
}

export interface SqlSemanticQualifiedName {
  parts: SqlSemanticIdentifierPart[];
  span: SqlSemanticSpan;
}

export type SqlSemanticRowSourceKind = "table" | "cte" | "subquery" | "table_function" | "mutation_target" | "unknown";

export interface SqlSemanticMetadataTarget {
  database?: string;
  schema?: string;
  table?: string;
  packageName?: string;
}

export interface SqlSemanticProjection {
  name: string;
  sourceExpression: string;
  span: SqlSemanticSpan;
  alias?: string;
  aliasSpan?: SqlSemanticSpan;
}

export interface SqlSemanticRowSource {
  id: string;
  kind: SqlSemanticRowSourceKind;
  name: string;
  qualifiedName?: SqlSemanticQualifiedName;
  qualifierParts: string[];
  alias?: string;
  aliasSpan?: SqlSemanticSpan;
  sourceSpan: SqlSemanticSpan;
  columns?: string[];
  columnAliases?: string[];
  metadataTarget?: SqlSemanticMetadataTarget;
  unresolved?: boolean;
}

export interface SqlSemanticClauseSpans {
  select?: SqlSemanticSpan;
  from?: SqlSemanticSpan;
  where?: SqlSemanticSpan;
  groupBy?: SqlSemanticSpan;
  having?: SqlSemanticSpan;
  orderBy?: SqlSemanticSpan;
  limit?: SqlSemanticSpan;
  insertColumns?: SqlSemanticSpan;
  updateSet?: SqlSemanticSpan;
}

export interface SqlSemanticScope {
  id: string;
  kind: SqlSemanticStatementKind | "subquery" | "cte";
  span: SqlSemanticSpan;
  parentId?: string;
  rowSources: SqlSemanticRowSource[];
  projections: SqlSemanticProjection[];
  clauseSpans: SqlSemanticClauseSpans;
}

export type SqlSemanticCursorKind = "table" | "schema" | "catalog" | "routine" | "column" | "alias_column" | "insert_column" | "update_column" | "delete_target" | "join_condition" | "star" | "keyword" | "suppressed";

export interface SqlSemanticCursorIntent {
  kind: SqlSemanticCursorKind;
  prefix: string;
  replacementRange: SqlSemanticSpan;
  qualifierParts: string[];
  targetSourceId?: string;
  expectedObjectKinds: Array<"database" | "schema" | "table" | "view" | "routine" | "procedure" | "function" | "column">;
  confidence: SqlSemanticConfidence;
  fallbackReason?: string;
}

export interface SqlSemanticStatement {
  kind: SqlSemanticStatementKind;
  span: SqlSemanticSpan;
  text: string;
}

export interface SqlSemanticDiagnostic {
  message: string;
  span: SqlSemanticSpan;
  severity: "info" | "warning" | "error";
}

export interface SqlSemanticModel {
  databaseType?: DatabaseType;
  dialectId: string;
  sql: string;
  cursor: number;
  statement: SqlSemanticStatement;
  tokens: SqlSemanticToken[];
  scopes: SqlSemanticScope[];
  rowSources: SqlSemanticRowSource[];
  projections: SqlSemanticProjection[];
  cursorIntent: SqlSemanticCursorIntent;
  diagnostics: SqlSemanticDiagnostic[];
}

export interface SqlSemanticBuildOptions {
  databaseType?: DatabaseType;
  dialect?: "mysql" | "postgres" | "sqlserver";
}
